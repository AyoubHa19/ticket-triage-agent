/**
 * End-to-end wiring test: the real retriever (this project) behind the real agent pipeline
 * (../inbox-agent), with a scripted model standing in for the LLM. It verifies the contract between
 * the two projects: grounded excerpts reach the drafting prompt, and an unanswerable question ends
 * in a handoff.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runInboxAgent } from "../../inbox-agent/src/agent.ts";
import { ScriptedModel } from "../../inbox-agent/src/model.ts";
import { DEFAULT_POLICY } from "../../inbox-agent/src/policy.ts";
import type { Ticket } from "../../inbox-agent/src/types.ts";
import { KnowledgeIndex } from "./index.ts";
import { loadMarkdownDir } from "./load.ts";

// minKbScore is specific to a retriever's score scale; 0.30 is read off the refusal sweep in
// results/latest.md and is NOT a validated operating point.
const policy = { ...DEFAULT_POLICY, minKbScore: 0.3 };

const classification = JSON.stringify({ category: "maintenance", urgency: "normal", confidence: 0.9, summary: "Routine question." });

function ticket(over: Partial<Ticket>): Ticket {
  return { id: "t", subject: "", body: "", senderRole: "tenant", previousContacts: 0, ...over };
}

describe("inbox agent + kb-search", () => {
  let kb: ReturnType<KnowledgeIndex["asKnowledgeBase"]>;
  before(async () => {
    kb = (await KnowledgeIndex.build(loadMarkdownDir(new URL("../docs/", import.meta.url)))).asKnowledgeBase();
  });

  it("grounds the draft in the retrieved section and cites it", async () => {
    const model = new ScriptedModel((req) =>
      req.system.startsWith("TASK: CLASSIFY")
        ? classification
        : JSON.stringify({ reply: "The date is posted two weeks in advance.", usedSources: [1] }),
    );
    const result = await runInboxAgent(
      ticket({ subject: "Heating service", body: "When is the technician coming for the heating service?" }),
      { model, kb, policy },
    );

    assert.equal(result.decision.action, "reply");
    if (result.decision.action === "reply") assert.deepEqual(result.decision.citations, ["Heating > Maintenance appointments"]);
    assert.match(model.calls[1]!.prompt, /notice in the stairwell/, "the real KB excerpt reached the drafting prompt");
  });

  it("hands over a question the knowledge base cannot answer, without drafting", async () => {
    const model = new ScriptedModel(() => classification);
    const result = await runInboxAgent(ticket({ subject: "Question", body: "Recipe for cheesecake" }), { model, kb, policy });

    assert.equal(result.decision.action, "escalate");
    if (result.decision.action === "escalate") assert.deepEqual(result.decision.reasons, ["no_kb_support"]);
    assert.equal(result.modelCalls, 1);
  });
});
