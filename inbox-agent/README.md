# inbox-agent

A ticket-triage agent for property management. For each incoming message it decides one of two things:
**reply automatically, grounded in the knowledge base**, or **hand over to a human with a reason**.

```
ticket
  -> classify (LLM, JSON, one retry)
  -> policy on raw text + classification   ---> escalate (safety, legal, injection, emergency,
  -> retrieve from knowledge base                       low confidence, repeat contact, human-only category)
  -> policy: is the answer grounded?        ---> escalate (no_kb_support)
  -> draft (LLM, must cite excerpts)
  -> policy on the draft                    ---> escalate (promised money / legal entitlement)
  -> reply with citations
```

## Design decisions

- **The LLM never has the last word on whether to automate.** Safety, legal-threat and prompt-injection checks run
  on the raw ticket text, independent of the model's classification (`policy.ts`). A wrong classification, or a
  model that was successfully prompt-injected, cannot suppress an escalation. Test: a gas-smell ticket the model
  calls routine at 0.99 confidence still escalates, and the drafting call is never made.
- **Over-escalate on safety.** The term lists are deliberately broad (`smoke` also matches "smoke detector
  beeping"). An unnecessary handoff is cheap; an automated reply to a gas leak is not. The eval in `llm-evals`
  measures both sides.
- **Failure goes to a human.** Invalid model JSON gets one retry, then escalates. A provider outage escalates
  and still carries any raw-text findings (a burst pipe reported during an outage is still flagged).
- **Automatic replies must be grounded.** The drafting prompt only allows facts from numbered excerpts and
  requires the model to say which it used (`usedSources`). No sources means `no_kb_support`. Citations in the
  result come from those indices, so a reply can be traced to a knowledge-base section.
- **Drafts are checked too.** A reply that promises a refund, a guarantee or a legal entitlement is escalated
  even if everything before it passed.
- **Untrusted text is data.** Ticket text is wrapped in tags the ticket cannot close (tag-like text is
  replaced before it reaches the prompt), the system prompt says to ignore instructions inside it, and
  instruction-like text ("ignore all previous instructions...") escalates on its own.
- **Domain glossary in the system prompt** (`prompts.ts`): terms such as "your flat" vs "common parts"
  change who pays for a repair, and a model reading them as everyday words gets it wrong. Procedures that are
  only needed for some tickets belong in the knowledge base instead.
- **Convex shape** (`convex/`): an inbound message schedules the agent inside the same transaction; the agent runs as
  an action; results are recorded by a mutation that is idempotent per message via a `by_message` index, so a
  retried job cannot reply twice.

## Run

```bash
node --test "src/**/*.test.ts"   # 54 tests, no install needed
node src/demo.ts                 # five sample tickets
```

The demo uses a scripted stand-in for the LLM unless `ANTHROPIC_API_KEY` is set (live path unverified, see below).
The stand-in is keyword rules, not a model. It exists to show the pipeline and the policy decisions.

## Not verified here

`src/ai-sdk-adapter.ts` (Vercel AI SDK v5) and `convex/` were written without registry access, so they have
never been run or type-checked. Run `npm install && npm run typecheck` and `npx convex dev` before relying on them.

## Known limitations

- The policy is lexical. `llm-evals` shows the gaps: "a pipe has burst" (the list has "burst pipe"), an injury
  with an ambulance, and a rent cut phrased as "I am cutting my rent" are not caught by the term lists alone.
- Billing disputes that demand money back are not escalated by any rule. That is a product decision to make
  explicitly, not an oversight to hide.
- The model's self-reported confidence is a weak signal. Use it as one input, never the only guard.
- `InMemoryKb` is a toy keyword retriever for tests; use `kb-search` for anything real.
- Thresholds (`minConfidence`, `minKbScore`) are defaults, not calibrated values.
