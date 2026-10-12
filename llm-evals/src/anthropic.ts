import { ProviderError, classifyHttpStatus } from "./router.ts";
import type { Pricing, Provider, ProviderRequest, ProviderResponse } from "./router.ts";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  pricing?: Pricing;
  /** Override for tests or proxies. */
  baseUrl?: string;
  name?: string;
  fetchImpl?: typeof fetch;
}

interface MessagesApiResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * Minimal Anthropic Messages API client over plain fetch (no SDK), so the retry/fallback
 * behaviour is exercised against real HTTP in tests and the project has no runtime dependencies.
 */
export function anthropicProvider(options: AnthropicProviderOptions): Provider {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: options.name ?? `anthropic:${options.model}`,
    model: options.model,
    ...(options.pricing ? { pricing: options.pricing } : {}),

    async call(req: ProviderRequest): Promise<ProviderResponse> {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: req.maxTokens ?? 512,
            temperature: req.temperature ?? 0,
            system: req.system,
            messages: [{ role: "user", content: req.prompt }],
          }),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (error) {
        throw new ProviderError(error instanceof Error ? error.message : "network error", { kind: "retryable" });
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new ProviderError(detail || response.statusText, {
          kind: classifyHttpStatus(response.status),
          status: response.status,
          ...(parseRetryAfterMs(response.headers.get("retry-after")) !== undefined
            ? { retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))! }
            : {}),
        });
      }

      const data = (await response.json()) as MessagesApiResponse;
      const text = (data.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      return {
        text,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
