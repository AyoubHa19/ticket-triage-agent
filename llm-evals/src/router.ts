/**
 * LLM router: retries with exponential backoff + full jitter, fallback across providers,
 * a per-provider circuit breaker, per-attempt timeouts, and usage/cost accounting.
 *
 * Failure policy (what a status code means for the *request*, not just the provider):
 *  - retryable      (429, 408, 5xx incl. 529 overloaded, network errors, timeouts): back off and retry,
 *                   then fall back to the next provider.
 *  - skip_provider  (401/403: bad key or no access): retrying is pointless, but another provider may work.
 *  - fatal          (other 4xx: the request itself is invalid): every provider would reject it, so fail
 *                   immediately instead of burning retries and money.
 */

export interface ProviderRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** USD per million tokens. No defaults on purpose: prices change, so callers must supply them. */
export interface Pricing {
  inPerMTok: number;
  outPerMTok: number;
}

export interface Provider {
  name: string;
  model: string;
  pricing?: Pricing;
  call(req: ProviderRequest): Promise<ProviderResponse>;
}

export type FailureKind = "retryable" | "skip_provider" | "fatal";

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: FailureKind;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, opts: { kind: FailureKind; status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "ProviderError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function classifyHttpStatus(status: number): FailureKind {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retryable";
  if (status === 401 || status === 403) return "skip_provider";
  return "fatal";
}

export class AllProvidersFailedError extends Error {
  readonly failures: { provider: string; error: string }[];

  constructor(failures: { provider: string; error: string }[]) {
    super(`All providers failed: ${failures.map((f) => `${f.provider} (${f.error})`).join("; ")}`);
    this.name = "AllProvidersFailedError";
    this.failures = failures;
  }
}

export interface RouterOptions {
  /** Attempts per provider before falling back. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Consecutive exhausted providers before the breaker opens. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  // Injectable for deterministic tests:
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface RouterResult {
  text: string;
  provider: string;
  model: string;
  /** Attempts across all providers for this call (1 = first try succeeded). */
  attempts: number;
  /** How many providers were given up on before the one that answered. */
  fallbacks: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** null when the answering provider has no pricing configured. */
  costUsd: number | null;
}

export interface ProviderUsage {
  attempts: number;
  successes: number;
  failures: number;
  retries: number;
  skippedByBreaker: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over successful calls; null if the provider has no pricing configured. */
  costUsd: number | null;
  totalLatencyMs: number;
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

export function computeCost(pricing: Pricing | undefined, inputTokens: number, outputTokens: number): number | null {
  if (!pricing) return null;
  return (inputTokens * pricing.inPerMTok + outputTokens * pricing.outPerMTok) / 1_000_000;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Unknown errors (network resets, DNS, aborted sockets) are treated as transient.
  return new ProviderError(message, { kind: "retryable" });
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError(`timed out after ${timeoutMs}ms`, { kind: "retryable" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Router {
  private readonly providers: readonly Provider[];
  private readonly opts: Required<RouterOptions>;
  private readonly breakers = new Map<string, BreakerState>();
  private readonly stats = new Map<string, ProviderUsage>();

  constructor(providers: readonly Provider[], options: RouterOptions = {}) {
    if (providers.length === 0) throw new Error("Router needs at least one provider");
    this.providers = providers;
    this.opts = {
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 250,
      maxDelayMs: options.maxDelayMs ?? 4000,
      timeoutMs: options.timeoutMs ?? 30_000,
      breakerThreshold: options.breakerThreshold ?? 3,
      breakerCooldownMs: options.breakerCooldownMs ?? 30_000,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
    for (const p of providers) {
      this.breakers.set(p.name, { consecutiveFailures: 0, openUntil: 0 });
      this.stats.set(p.name, {
        attempts: 0, successes: 0, failures: 0, retries: 0, skippedByBreaker: 0,
        inputTokens: 0, outputTokens: 0, costUsd: p.pricing ? 0 : null, totalLatencyMs: 0,
      });
    }
  }

  usage(): Record<string, ProviderUsage> {
    return Object.fromEntries([...this.stats].map(([name, s]) => [name, { ...s }]));
  }

  totalCostUsd(): number | null {
    let total = 0;
    for (const s of this.stats.values()) {
      if (s.costUsd === null) return null;
      total += s.costUsd;
    }
    return total;
  }

  private backoffDelay(attempt: number): number {
    const ceiling = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.opts.random() * ceiling); // "full jitter"
  }

  async generate(req: Omit<ProviderRequest, "signal">): Promise<RouterResult> {
    const o = this.opts;
    const failures: { provider: string; error: string }[] = [];
    let totalAttempts = 0;
    let fallbacks = 0;

    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name)!;
      const stats = this.stats.get(provider.name)!;

      if (breaker.openUntil > o.now()) {
        stats.skippedByBreaker++;
        failures.push({ provider: provider.name, error: "circuit open" });
        fallbacks++;
        continue;
      }
      // After the cooldown the breaker is "half-open": a single probe, no retries.
      const halfOpen = breaker.consecutiveFailures >= o.breakerThreshold;
      const maxAttempts = halfOpen ? 1 : o.maxAttempts;
      let lastError = "unknown";

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        totalAttempts++;
        stats.attempts++;
        const started = o.now();
        try {
          const response = await withTimeout((signal) => provider.call({ ...req, signal }), o.timeoutMs);
          const latencyMs = o.now() - started;
          const costUsd = computeCost(provider.pricing, response.inputTokens, response.outputTokens);

          stats.successes++;
          stats.inputTokens += response.inputTokens;
          stats.outputTokens += response.outputTokens;
          stats.totalLatencyMs += latencyMs;
          if (stats.costUsd !== null && costUsd !== null) stats.costUsd += costUsd;
          breaker.consecutiveFailures = 0;

          return {
            text: response.text,
            provider: provider.name,
            model: provider.model,
            attempts: totalAttempts,
            fallbacks,
            latencyMs,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costUsd,
          };
        } catch (raw) {
          const error = toProviderError(raw);
          stats.failures++;
          stats.totalLatencyMs += o.now() - started;
          lastError = error.status ? `${error.status} ${error.message}` : error.message;

          if (error.kind === "fatal") throw error; // the request is invalid for every provider
          if (error.kind === "skip_provider") break;

          const isLast = attempt === maxAttempts;
          const waitTooLong = error.retryAfterMs !== undefined && error.retryAfterMs > o.maxDelayMs;
          if (isLast || waitTooLong) break;

          stats.retries++;
          await o.sleep(Math.max(this.backoffDelay(attempt), error.retryAfterMs ?? 0));
        }
      }

      failures.push({ provider: provider.name, error: lastError });
      fallbacks++;
      breaker.consecutiveFailures++;
      if (breaker.consecutiveFailures >= o.breakerThreshold) {
        breaker.openUntil = o.now() + o.breakerCooldownMs;
      }
    }

    throw new AllProvidersFailedError(failures);
  }
}
