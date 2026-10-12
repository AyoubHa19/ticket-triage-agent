import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { anthropicProvider } from "./anthropic.ts";
import { AllProvidersFailedError, ProviderError, Router } from "./router.ts";

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface Recorded {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

async function startServer(script: Scripted[]): Promise<{ server: Server; baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const step = script[Math.min(requests.length - 1, script.length - 1)]!;
      res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
      res.end(JSON.stringify(step.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

const success = (text: string) => ({
  status: 200,
  body: { content: [{ type: "text", text }], usage: { input_tokens: 120, output_tokens: 30 } },
});

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

const fastRouterOptions = { sleep: async () => {}, random: () => 0, maxAttempts: 3 };

describe("anthropicProvider over real HTTP", () => {
  it("sends the documented request shape and parses text + usage", async () => {
    const { server, baseUrl, requests } = await startServer([success("hello")]);
    servers.push(server);
    const provider = anthropicProvider({ apiKey: "test-key", model: "some-model", baseUrl });

    const result = await provider.call({ system: "be brief", prompt: "hi", maxTokens: 64 });

    assert.deepEqual(result, { text: "hello", inputTokens: 120, outputTokens: 30 });
    const req = requests[0]!;
    assert.equal(req.headers["x-api-key"], "test-key");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.body.model, "some-model");
    assert.equal(req.body.system, "be brief");
    assert.equal(req.body.max_tokens, 64);
    assert.deepEqual(req.body.messages, [{ role: "user", content: "hi" }]);
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    const { server, baseUrl } = await startServer([
      { status: 200, body: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }], usage: {} } },
    ]);
    servers.push(server);
    const result = await anthropicProvider({ apiKey: "k", model: "m", baseUrl }).call({ system: "", prompt: "" });
    assert.equal(result.text, "ab");
    assert.equal(result.inputTokens, 0);
  });

  it("maps status codes to failure kinds and reads Retry-After", async () => {
    const cases: { status: number; kind: string }[] = [
      { status: 429, kind: "retryable" },
      { status: 529, kind: "retryable" },
      { status: 401, kind: "skip_provider" },
      { status: 400, kind: "fatal" },
    ];
    for (const { status, kind } of cases) {
      const { server, baseUrl } = await startServer([{ status, headers: { "retry-after": "2" }, body: { error: { message: "nope" } } }]);
      servers.push(server);
      await assert.rejects(
        anthropicProvider({ apiKey: "k", model: "m", baseUrl }).call({ system: "", prompt: "" }),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(e.kind, kind, `status ${status}`);
          assert.equal(e.status, status);
          assert.equal(e.retryAfterMs, 2000);
          return true;
        },
      );
    }
  });

  it("treats a refused connection as retryable", async () => {
    const provider = anthropicProvider({ apiKey: "k", model: "m", baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(provider.call({ system: "", prompt: "" }), (e: unknown) => e instanceof ProviderError && e.kind === "retryable");
  });
});

describe("Router + anthropicProvider end to end", () => {
  it("recovers from 429 then 529 on the same provider", async () => {
    const { server, baseUrl, requests } = await startServer([
      { status: 429, headers: { "retry-after": "0" }, body: {} },
      { status: 529, body: {} },
      success("finally"),
    ]);
    servers.push(server);
    const router = new Router(
      [anthropicProvider({ apiKey: "k", model: "m", baseUrl, pricing: { inPerMTok: 1, outPerMTok: 5 } })],
      fastRouterOptions,
    );

    const result = await router.generate({ system: "s", prompt: "p" });

    assert.equal(result.text, "finally");
    assert.equal(result.attempts, 3);
    assert.equal(requests.length, 3);
    assert.equal(result.costUsd, (120 * 1 + 30 * 5) / 1_000_000);
  });

  it("falls back to a second endpoint when the first returns 401", async () => {
    const bad = await startServer([{ status: 401, body: {} }]);
    const good = await startServer([success("from fallback")]);
    servers.push(bad.server, good.server);
    const router = new Router(
      [
        anthropicProvider({ apiKey: "bad", model: "m1", baseUrl: bad.baseUrl, name: "primary" }),
        anthropicProvider({ apiKey: "good", model: "m2", baseUrl: good.baseUrl, name: "secondary" }),
      ],
      fastRouterOptions,
    );

    const result = await router.generate({ system: "s", prompt: "p" });

    assert.equal(result.provider, "secondary");
    assert.equal(bad.requests.length, 1, "401 is not retried");
  });

  it("does not hit the fallback for an invalid request (400)", async () => {
    const first = await startServer([{ status: 400, body: { error: { message: "bad" } } }]);
    const second = await startServer([success("never")]);
    servers.push(first.server, second.server);
    const router = new Router(
      [
        anthropicProvider({ apiKey: "k", model: "m", baseUrl: first.baseUrl, name: "one" }),
        anthropicProvider({ apiKey: "k", model: "m", baseUrl: second.baseUrl, name: "two" }),
      ],
      fastRouterOptions,
    );

    await assert.rejects(router.generate({ system: "s", prompt: "p" }), (e: unknown) => e instanceof ProviderError && e.status === 400);
    assert.equal(second.requests.length, 0);
  });

  it("reports AllProvidersFailedError when everything is down", async () => {
    const down = await startServer([{ status: 503, body: {} }]);
    servers.push(down.server);
    const router = new Router([anthropicProvider({ apiKey: "k", model: "m", baseUrl: down.baseUrl })], { ...fastRouterOptions, maxAttempts: 2 });
    await assert.rejects(router.generate({ system: "s", prompt: "p" }), (e: unknown) => e instanceof AllProvidersFailedError);
    assert.equal(down.requests.length, 2);
  });
});
