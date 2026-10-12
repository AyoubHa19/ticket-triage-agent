import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AllProvidersFailedError, ProviderError, Router, classifyHttpStatus, computeCost } from "./router.ts";
import type { Provider, ProviderResponse } from "./router.ts";

const ok = (text = "ok", inputTokens = 100, outputTokens = 20): ProviderResponse => ({ text, inputTokens, outputTokens });

/** Provider whose behaviour is a script: each entry is a response or an error to throw. */
function scripted(name: string, script: (ProviderResponse | ProviderError)[], pricing?: Provider["pricing"]): Provider & { calls: number } {
  const provider = {
    name,
    model: `${name}-model`,
    ...(pricing ? { pricing } : {}),
    calls: 0,
    async call() {
      const step = script[Math.min(provider.calls, script.length - 1)]!;
      provider.calls++;
      if (step instanceof ProviderError) throw step;
      return step;
    },
  };
  return provider;
}

const err429 = (retryAfterMs?: number) =>
  new ProviderError("rate limited", { kind: "retryable", status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
const err529 = () => new ProviderError("overloaded", { kind: "retryable", status: 529 });
const err401 = () => new ProviderError("bad key", { kind: "skip_provider", status: 401 });
const err400 = () => new ProviderError("invalid request", { kind: "fatal", status: 400 });

function harness(overrides: ConstructorParameters<typeof Router>[1] = {}) {
  const sleeps: number[] = [];
  let clock = 1_000;
  return {
    sleeps,
    advance: (ms: number) => { clock += ms; },
    options: {
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      random: () => 1, // jitter at its ceiling => deterministic delays
      now: () => clock,
      ...overrides,
    },
  };
}

describe("classifyHttpStatus", () => {
  it("maps statuses to failure kinds", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 529]) assert.equal(classifyHttpStatus(s), "retryable", String(s));
    for (const s of [401, 403]) assert.equal(classifyHttpStatus(s), "skip_provider", String(s));
    for (const s of [400, 404, 413, 422]) assert.equal(classifyHttpStatus(s), "fatal", String(s));
  });
});

describe("computeCost", () => {
  it("prices tokens per million and returns null without pricing", () => {
    assert.equal(computeCost({ inPerMTok: 1, outPerMTok: 5 }, 1000, 500), 0.0035);
    assert.equal(computeCost(undefined, 1000, 500), null);
  });
});

describe("Router retries", () => {
  it("retries a 429 with exponential backoff capped by maxDelayMs, then succeeds", async () => {
    const h = harness({ baseDelayMs: 250, maxDelayMs: 400 });
    const p = scripted("a", [err429(), err529(), ok("done")]);
    const router = new Router([p], { ...h.options, maxAttempts: 3 });

    const result = await router.generate({ system: "s", prompt: "p" });

    assert.equal(result.text, "done");
    assert.equal(result.attempts, 3);
    assert.equal(result.fallbacks, 0);
    // random() = 1 puts the jitter at its ceiling: min(400, 250 * 2^(n-1)) => 250, then 400 (capped from 500).
    assert.deepEqual(h.sleeps, [250, 400]);
    assert.equal(router.usage().a?.retries, 2);
    assert.equal(router.usage().a?.failures, 2);
    assert.equal(router.usage().a?.successes, 1);
  });

  it("honours Retry-After when it is longer than the computed backoff", async () => {
    const h = harness({ baseDelayMs: 10, maxDelayMs: 4000 });
    const router = new Router([scripted("a", [err429(1500), ok()])], h.options);
    await router.generate({ system: "s", prompt: "p" });
    assert.deepEqual(h.sleeps, [1500]);
  });

  it("does not wait for an absurd Retry-After: it falls back instead", async () => {
    const h = harness({ maxDelayMs: 4000 });
    const a = scripted("a", [err429(60_000)]);
    const b = scripted("b", [ok("from b")]);
    const result = await new Router([a, b], h.options).generate({ system: "s", prompt: "p" });

    assert.equal(result.provider, "b");
    assert.equal(a.calls, 1);
    assert.deepEqual(h.sleeps, []);
  });
});

describe("Router failure policy", () => {
  it("fails fast on a fatal 4xx without retrying or falling back", async () => {
    const h = harness();
    const a = scripted("a", [err400()]);
    const b = scripted("b", [ok()]);
    await assert.rejects(new Router([a, b], h.options).generate({ system: "s", prompt: "p" }), (e: unknown) => {
      return e instanceof ProviderError && e.status === 400;
    });
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 0);
  });

  it("skips a provider on 401 without retrying and uses the fallback", async () => {
    const h = harness();
    const a = scripted("a", [err401()]);
    const b = scripted("b", [ok("from b")]);
    const result = await new Router([a, b], h.options).generate({ system: "s", prompt: "p" });

    assert.equal(a.calls, 1);
    assert.equal(result.provider, "b");
    assert.equal(result.fallbacks, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("falls back after exhausting retries", async () => {
    const h = harness();
    const a = scripted("a", [err529()]);
    const b = scripted("b", [ok("from b")]);
    const result = await new Router([a, b], { ...h.options, maxAttempts: 3 }).generate({ system: "s", prompt: "p" });

    assert.equal(a.calls, 3);
    assert.equal(result.provider, "b");
    assert.equal(result.attempts, 4);
  });

  it("reports every provider's failure when all fail", async () => {
    const h = harness();
    const router = new Router([scripted("a", [err529()]), scripted("b", [err401()])], { ...h.options, maxAttempts: 2 });
    await assert.rejects(router.generate({ system: "s", prompt: "p" }), (e: unknown) => {
      assert.ok(e instanceof AllProvidersFailedError);
      assert.deepEqual(e.failures.map((f) => f.provider), ["a", "b"]);
      return true;
    });
  });

  it("treats a hung provider as a retryable timeout and falls back", async () => {
    const hung: Provider = { name: "hung", model: "m", call: () => new Promise<ProviderResponse>(() => {}) };
    const b = scripted("b", [ok("from b")]);
    const router = new Router([hung, b], { timeoutMs: 15, maxAttempts: 1, sleep: async () => {} });
    const result = await router.generate({ system: "s", prompt: "p" });
    assert.equal(result.provider, "b");
  });

  it("treats unknown thrown errors (e.g. connection reset) as retryable", async () => {
    const h = harness();
    let n = 0;
    const flaky: Provider = {
      name: "flaky",
      model: "m",
      async call() {
        if (n++ === 0) throw new Error("ECONNRESET");
        return ok("recovered");
      },
    };
    const result = await new Router([flaky], h.options).generate({ system: "s", prompt: "p" });
    assert.equal(result.text, "recovered");
    assert.equal(result.attempts, 2);
  });
});

describe("Router circuit breaker", () => {
  it("opens after consecutive exhausted calls, skips the provider, then probes once after the cooldown", async () => {
    const h = harness({ breakerThreshold: 2, breakerCooldownMs: 10_000, maxAttempts: 1 });
    const a = scripted("a", [err529(), err529(), ok("a is back")]);
    const b = scripted("b", [ok("from b")]);
    const router = new Router([a, b], h.options);

    await router.generate({ system: "s", prompt: "1" }); // a fails (1), falls back to b
    await router.generate({ system: "s", prompt: "2" }); // a fails (2) -> breaker opens
    assert.equal(a.calls, 2);

    await router.generate({ system: "s", prompt: "3" }); // a skipped
    assert.equal(a.calls, 2);
    assert.equal(router.usage().a?.skippedByBreaker, 1);

    h.advance(10_001); // cooldown over: half-open probe
    const result = await router.generate({ system: "s", prompt: "4" });
    assert.equal(a.calls, 3);
    assert.equal(result.provider, "a");

    await router.generate({ system: "s", prompt: "5" }); // closed again
    assert.equal(a.calls, 4);
  });

  it("a half-open probe gets exactly one attempt, and a failed probe re-opens the breaker", async () => {
    const h = harness({ breakerThreshold: 1, breakerCooldownMs: 5_000, maxAttempts: 3 });
    const a = scripted("a", [err529()]);
    const b = scripted("b", [ok()]);
    const router = new Router([a, b], h.options);

    await router.generate({ system: "s", prompt: "1" });
    assert.equal(a.calls, 3); // full retries while closed

    h.advance(5_001);
    await router.generate({ system: "s", prompt: "2" });
    assert.equal(a.calls, 4); // exactly one probe

    await router.generate({ system: "s", prompt: "3" });
    assert.equal(a.calls, 4); // open again
  });
});

describe("Router usage accounting", () => {
  it("accumulates tokens and cost per provider and in total", async () => {
    const h = harness();
    const pricing = { inPerMTok: 1, outPerMTok: 5 };
    const a = scripted("a", [ok("x", 1000, 500)], pricing);
    const router = new Router([a], h.options);

    const first = await router.generate({ system: "s", prompt: "p" });
    await router.generate({ system: "s", prompt: "p" });

    assert.equal(first.costUsd, 0.0035);
    assert.equal(router.usage().a?.inputTokens, 2000);
    assert.equal(router.usage().a?.outputTokens, 1000);
    assert.equal(router.totalCostUsd(), 0.007);
  });

  it("reports cost as null when any provider lacks pricing", async () => {
    const h = harness();
    const router = new Router([scripted("a", [ok()])], h.options);
    const result = await router.generate({ system: "s", prompt: "p" });
    assert.equal(result.costUsd, null);
    assert.equal(router.totalCostUsd(), null);
  });
});
