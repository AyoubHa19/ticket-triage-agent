# Ticket triage agent: knows when to hand a ticket to a human

Three small, tested projects built around the problems a production agent team actually has to solve:
**when should the agent hand over to a human, how do you ground it in a knowledge base, and how do you
run the LLM layer reliably and measure whether a change made things better.**

The domain is property management (tickets from tenants and owners about heating, keys, service charges,
leaks), but nothing here depends on it except the sample data.

| Project | What it demonstrates | Tests |
|---|---|---|
| [`inbox-agent`](inbox-agent) | Ticket triage pipeline: classify, deterministic escalation policy, grounded draft, post-draft checks. Prompt-injection handling. Convex data model with idempotent runs. | 54 |
| [`llm-evals`](llm-evals) | LLM router (retry with jittered backoff, fallback, circuit breaker, timeouts, cost accounting) and an eval harness with a labelled ticket set. | 38 |
| [`kb-search`](kb-search) | Knowledge-base retrieval: heading-aware chunking, BM25, hashing embeddings, rank fusion, retrieval eval, agent tool with refusal behaviour. | 48 |

The three connect: `kb-search` plugs into `inbox-agent` through its `KnowledgeBase` interface (there is an
end-to-end test for it), and `llm-evals` scores the same escalation policy the agent runs.

## Live demo

**[Try it in the browser →](https://ayoubha19.github.io/ticket-triage-agent/)** Write a ticket and see whether the agent
replies or hands over (and why), compare the three retrievers on your own question, re-run both evals, and make
two simulated LLM providers fail to watch the router retry, fall back and open its circuit breaker.

The page runs the projects' own modules: `scripts/build-site.ts` strips the TypeScript types (no bundler, no
dependencies) and `.github/workflows/pages.yml` runs the tests and deploys on every push to `main`. No LLM runs in the
browser: a stand-in classifies with the keyword baseline and drafts by quoting the best knowledge-base excerpt.

```bash
node scripts/build-site.ts && node scripts/serve-site.ts   # http://localhost:4173
```

## Run it

Node 22.18 or newer. **No `npm install` is needed to run the tests or the evals**, because the core logic has
no runtime dependencies and Node runs TypeScript directly.

```bash
cd inbox-agent && node --test "src/**/*.test.ts" && node src/demo.ts
cd llm-evals   && node --test "src/**/*.test.ts" && node src/run-eval.ts
cd kb-search   && node --test "src/**/*.test.ts" && node src/run-eval.ts
```

`npm install` is only needed to type-check (`typescript`, `@types/node`) and to use the optional Vercel AI SDK
adapter and the Convex reference files.

## What has and has not been verified

Be precise about this when you talk about the project.

| Part | Status |
|---|---|
| Core logic of all three projects | 140 passing tests; `tsc --strict` clean |
| Router and Anthropic client | Tested against a local HTTP server that returns 429 / 529 / 401 / 400 / 200 and `Retry-After`. **Not** tested against the real Anthropic API. |
| `inbox-agent/src/ai-sdk-adapter.ts` | Written against the AI SDK v5 API. **Never executed or type-checked.** |
| `inbox-agent/convex/*` | Reference schema and functions. **Never executed or type-checked** (needs `npx convex dev`). |
| Live LLM results | **None yet.** `llm-evals` runs a real model when `ANTHROPIC_API_KEY` is set; the tables in the READMEs are the no-LLM baseline and the retrieval eval only. |

## Limits of the evidence

- Both datasets were written by hand (37 tickets, 34 queries) for these projects. Treat the numbers as
  regression baselines, not benchmarks. One query is about 3.7 points of hit rate.
- Labels were written before the policy was run on them, and the policy was **not** tuned on the set. The
  failures the eval found are documented as known gaps instead of being patched in.
- The tickets, queries and knowledge base were first written in German and later translated to English, with
  the labels unchanged. The no-LLM baseline found the same escalation gaps in both versions.
- The sample knowledge base is invented illustrative content, not legal advice.

## Mapping to the job ad

| The ad asks about | Where to look |
|---|---|
| "When should the agent escalate to a human? How do we make sure it sticks to the process?" | `inbox-agent/src/policy.ts`, `agent.ts` |
| Read requests "the way a property manager would"; system prompt vs skills | `inbox-agent/src/prompts.ts` (domain glossary) |
| Knowledge base search; tools vs prompts for retrieval | `kb-search/src/tool.ts`, `index.ts` |
| Pick the right model, retry when a provider fails, track usage, reduce cost, run evals | `llm-evals/src/router.ts`, `runner.ts` |
| Convex, queues and long-running workflows | `inbox-agent/convex/` (scheduler + idempotent mutation) |
