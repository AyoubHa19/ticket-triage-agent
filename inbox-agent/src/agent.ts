import { extractJsonObject } from "./json.ts";
import type { LanguageModel } from "./model.ts";
import {
  assessDraft,
  assessKb,
  assessTicket,
  buildHandoffNote,
  DEFAULT_POLICY,
  scanRawText,
} from "./policy.ts";
import type { PolicyConfig } from "./policy.ts";
import {
  CLASSIFY_SYSTEM,
  DRAFT_SYSTEM,
  classifyPrompt,
  draftPrompt,
} from "./prompts.ts";
import { CATEGORIES, URGENCIES } from "./types.ts";
import type {
  Classification,
  Decision,
  EscalationReason,
  KbHit,
  KnowledgeBase,
  RunResult,
  Ticket,
  TraceStep,
} from "./types.ts";

export interface AgentDeps {
  model: LanguageModel;
  kb: KnowledgeBase;
  policy?: PolicyConfig;
  /** How many knowledge-base excerpts to give the drafting step. */
  kbTopK?: number;
}

const MAX_REPLY_CHARS = 2000;

export function parseClassification(text: string): Classification | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const category = CATEGORIES.find((c) => c === obj.category);
  const urgency = URGENCIES.find((u) => u === obj.urgency);
  const confidence = obj.confidence;
  const summary = obj.summary;

  if (!category || !urgency) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  if (typeof summary !== "string" || summary.trim() === "") return null;
  return { category, urgency, confidence, summary: summary.trim() };
}

export interface ParsedDraft {
  reply: string;
  /** 1-based indices into the excerpts given to the model. */
  usedSources: number[];
}

export function parseDraft(text: string, excerptCount: number): ParsedDraft | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.reply !== "string" || obj.reply.length > MAX_REPLY_CHARS) return null;
  if (!Array.isArray(obj.usedSources)) return null;

  const usedSources: number[] = [];
  for (const entry of obj.usedSources) {
    if (!Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > excerptCount) return null;
    usedSources.push(entry as number);
  }
  return { reply: obj.reply.trim(), usedSources: [...new Set(usedSources)] };
}

function escalate(
  ticket: Ticket,
  classification: Classification | null,
  reasons: EscalationReason[],
): Decision {
  const unique = [...new Set(reasons)];
  return { action: "escalate", reasons: unique, handoffNote: buildHandoffNote(ticket, classification, unique) };
}

/**
 * Pipeline: classify -> policy (raw text + classification) -> retrieve -> policy (grounding)
 * -> draft -> policy (commitments). Every "no" short-circuits to a human with an explicit reason,
 * and any model failure also ends in a handoff, never in a silent automatic reply.
 */
export async function runInboxAgent(ticket: Ticket, deps: AgentDeps): Promise<RunResult> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const trace: TraceStep[] = [];
  let modelCalls = 0;
  let classification: Classification | null = null;
  let hits: KbHit[] = [];

  const finish = (decision: Decision): RunResult => ({ decision, classification, hits, trace, modelCalls });

  try {
    // 1. Classify (one retry if the output is not valid JSON).
    for (let attempt = 0; attempt < 2 && classification === null; attempt++) {
      modelCalls++;
      const out = await deps.model.generate({
        system: CLASSIFY_SYSTEM,
        prompt: classifyPrompt(ticket, attempt > 0),
      });
      classification = parseClassification(out.text);
      if (classification === null) trace.push({ step: "classify", detail: `invalid output (attempt ${attempt + 1})` });
    }
    trace.push({
      step: "classify",
      detail: classification
        ? `${classification.category}/${classification.urgency} confidence=${classification.confidence}`
        : "failed",
    });

    // 2. Policy on raw text + classification. Runs even when classification failed.
    const ticketReasons = assessTicket(ticket, classification, policy);
    trace.push({ step: "policy:ticket", detail: ticketReasons.join(", ") || "ok" });
    if (ticketReasons.length > 0) return finish(escalate(ticket, classification, ticketReasons));

    // 3. Retrieve and check grounding.
    hits = await deps.kb.search(`${ticket.subject}\n${ticket.body}`, deps.kbTopK ?? 3);
    const kbReasons = assessKb(hits, policy);
    trace.push({ step: "retrieve", detail: `${hits.length} hits, best=${Math.max(0, ...hits.map((h) => h.score)).toFixed(2)}` });
    if (kbReasons.length > 0) return finish(escalate(ticket, classification, kbReasons));

    // 4. Draft (one retry if invalid JSON).
    let draft = null as ReturnType<typeof parseDraft>;
    for (let attempt = 0; attempt < 2 && draft === null; attempt++) {
      modelCalls++;
      const out = await deps.model.generate({
        system: DRAFT_SYSTEM,
        prompt: draftPrompt(ticket, hits, attempt > 0),
      });
      draft = parseDraft(out.text, hits.length);
      if (draft === null) trace.push({ step: "draft", detail: `invalid output (attempt ${attempt + 1})` });
    }
    if (draft === null) return finish(escalate(ticket, classification, ["draft_failed"]));

    // 5. The model itself may decide the excerpts do not answer the question: that is ungrounded.
    if (draft.reply === "" || draft.usedSources.length === 0) {
      trace.push({ step: "draft", detail: "ungrounded (empty reply or no sources)" });
      return finish(escalate(ticket, classification, ["no_kb_support"]));
    }

    // 6. Post-draft policy.
    const draftReasons = assessDraft(draft.reply);
    trace.push({ step: "policy:draft", detail: draftReasons.join(", ") || "ok" });
    if (draftReasons.length > 0) return finish(escalate(ticket, classification, draftReasons));

    const citations = draft.usedSources.map((n) => {
      const hit = hits[n - 1];
      return hit ? `${hit.docTitle} > ${hit.heading}` : "";
    });
    return finish({ action: "reply", reply: draft.reply, citations: citations.filter(Boolean) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace.push({ step: "error", detail: message });
    // The provider failed, but raw-text findings (e.g. a gas leak) must still reach the human.
    return finish(escalate(ticket, classification, ["model_error", ...scanRawText(ticket)]));
  }
}
