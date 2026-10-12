# llm-evals

Two things an agent team needs once there is more than one prompt and one model: a **router** that keeps
calls working when providers misbehave and tells you what they cost, and an **eval harness** that tells you
whether a change made the agent better or worse.

## Router (`src/router.ts`)

| Situation | Behaviour |
|---|---|
| 429, 408, 5xx (including 529 overloaded), network error, timeout | Retry with exponential backoff and full jitter, honour `Retry-After`, then fall back to the next provider |
| `Retry-After` longer than the maximum wait | Do not wait; fall back immediately |
| 401 / 403 | Retrying is pointless, but another provider may work: skip to the fallback |
| Other 4xx (invalid request) | Fail immediately. Every provider would reject it, so do not spend retries or money |
| A provider keeps failing | Circuit breaker opens, the provider is skipped until the cooldown, then gets exactly one probe |
| Every call | Tokens, latency, retries and cost are tracked per provider (cost is `null` unless you supply prices; prices are never assumed) |

`src/anthropic.ts` is a small Messages API client over plain `fetch`, so the router is tested against real HTTP
(local server returning 429, 529, 401, 400, 503 and `Retry-After`). It has not been run against the live API.

## Eval harness (`src/runner.ts`, `data/tickets.jsonl`)

37 hand-labelled tickets: 17 that a property manager would want a human on, 20 routine ones.
Gold labels are `category` and `shouldEscalate`, written by judgement before running any system on them.

- **Escalation recall** is the safety metric: the share of tickets that needed a human and got one.
  `1 - recall` is the rate of cases wrongly handled automatically.
- **Escalation precision** is the cost metric: how many handoffs were necessary.
- A system that throws is scored fail-safe (escalate), counted separately as an error, and never hidden.
- Reports list the exact missed and unnecessary tickets, not just rates.

### Results: no-LLM baseline (real run)

Keyword category rules plus the deterministic policy from `inbox-agent`:

| System | Category acc. | Escalation recall | Escalation precision | F1 | Missed | Unnecessary |
|---|---|---|---|---|---|---|
| policy-only (no LLM) | 86.5% | 70.6% | 92.3% | 0.80 | 5/17 | 1/20 |

Missed (needed a human): `t02` "a pipe has burst" (the term list has "burst pipe"), `t08` rent cut phrased as
"I am cutting my rent", `t11` service-charge dispute demanding 480 EUR back, `t15` fall in the stairwell with an
ambulance, `t16` owner challenging a resolution as unlawful. Unnecessary: `t25` smoke-detector battery beeping.

These are **known gaps found by the eval, not fixed by tuning**. They are pinned in `src/systems.test.ts`, so
changing the policy forces a conscious update. The honest reading: lexical rules are a good floor for safety
and legal wording and miss paraphrases. Whether an LLM classifier closes the gap is exactly what the live run is
for, and `t11` (billing dispute) needs a product decision, because no category currently triggers a handoff.

## Run

```bash
node --test "src/**/*.test.ts"          # 38 tests, no install needed
node src/run-eval.ts                    # baseline only
ANTHROPIC_API_KEY=... node src/run-eval.ts
# with prices (USD per million tokens, from the provider's pricing page) for a cost column:
EVAL_MODELS='[{"model":"claude-haiku-5-5","inPerMTok":1,"outPerMTok":5}]' ANTHROPIC_API_KEY=... node src/run-eval.ts
```

The example prices above are placeholders to show the format, not real prices. The live run evaluates the
triage stage (classification plus policy), not retrieval or drafting.

## Limitations

- 37 tickets is enough to catch regressions and show failure modes, not to rank two close models.
- Latency and cost for live models are only meaningful from a live run; the baseline's are trivially about zero.
- Labels reflect one person's judgement of what needs a human.
- `src/systems.ts` and `src/dataset.ts` import from `../../inbox-agent` by relative path, so keep the folders together.
