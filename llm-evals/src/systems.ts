import { parseClassification } from "../../inbox-agent/src/agent.ts";
import { assessTicket, fold, scanRawText } from "../../inbox-agent/src/policy.ts";
import { CLASSIFY_SYSTEM, classifyPrompt } from "../../inbox-agent/src/prompts.ts";
import type { Category, Ticket } from "../../inbox-agent/src/types.ts";
import { toTicket } from "./dataset.ts";
import type { Router } from "./router.ts";
import type { EvalSystem } from "./runner.ts";

/** Deliberately naive first-match keyword rules: a floor any LLM has to beat. */
const KEYWORD_RULES: { category: Category; pattern: RegExp }[] = [
  { category: "keys", pattern: /\bkeys?\b/ },
  { category: "billing", pattern: /service charge|statement|accounts|invoice|billing/ },
  { category: "move", pattern: /move in|moving in|move out|moving out|handover|viewing/ },
  { category: "maintenance", pattern: /heating|radiator|maintenance|servic|doorbell|lamp|\blight\b|\blift\b|elevator|detector|chimney/ },
  { category: "damage", pattern: /water|pipe|mould|leak|damage|\bgas\b|smoke|fire|sparks|window|door|\bstep|stair/ },
];

export function keywordCategory(ticket: Ticket): Category {
  if (scanRawText(ticket).includes("legal_threat")) return "legal";
  const text = fold(`${ticket.subject}\n${ticket.body}`);
  return KEYWORD_RULES.find((rule) => rule.pattern.test(text))?.category ?? "general";
}

/**
 * No-LLM baseline: keyword category + the real deterministic escalation policy from inbox-agent
 * (raw-text safety/legal/injection scan, repeat contacts, human-only categories).
 */
export function policyOnlySystem(): EvalSystem {
  return {
    name: "policy-only (no LLM)",
    async predict(item) {
      const ticket = toTicket(item);
      const category = keywordCategory(ticket);
      const reasons = assessTicket(ticket, { category, urgency: "normal", confidence: 1, summary: "" });
      return { category, escalate: reasons.length > 0, costUsd: 0 };
    },
  };
}

/**
 * LLM triage: the same classify prompt + policy as stage 1 of the inbox agent. It measures the
 * triage decision only (retrieval and drafting can add further escalations in the full pipeline).
 */
export function llmSystem(name: string, router: Router): EvalSystem {
  return {
    name,
    async predict(item) {
      const ticket = toTicket(item);
      const out = await router.generate({ system: CLASSIFY_SYSTEM, prompt: classifyPrompt(ticket, false), maxTokens: 300 });
      const classification = parseClassification(out.text);
      const reasons = assessTicket(ticket, classification);
      return { category: classification?.category ?? "invalid", escalate: reasons.length > 0, costUsd: out.costUsd };
    },
  };
}
