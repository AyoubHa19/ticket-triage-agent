import type {
  Category,
  Classification,
  EscalationReason,
  KbHit,
  Ticket,
} from "./types.ts";

/**
 * Escalation policy.
 *
 * Design rule: the LLM never has the last word on whether a ticket may be answered automatically.
 * Safety, legal and injection checks run on the RAW ticket text, independent of what the model
 * classified, so a misclassification (or a prompt-injected model) cannot suppress an escalation.
 * False positives (an unnecessary handoff) are cheap; false negatives (an automated reply to a
 * gas leak) are not, so the term lists are deliberately broad.
 */

export interface PolicyConfig {
  /** Below this self-reported confidence the ticket goes to a human. */
  minConfidence: number;
  /** From this many earlier contacts about the same issue, a human takes over. */
  repeatContactThreshold: number;
  /** Best knowledge-base hit must reach this normalised score to ground an automatic reply. */
  minKbScore: number;
  humanOnlyCategories: readonly Category[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  minConfidence: 0.75,
  repeatContactThreshold: 3,
  minKbScore: 0.35,
  humanOnlyCategories: ["legal"],
};

/** Lowercase, strip accents, drop hyphens, collapse whitespace. */
export function fold(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[-‐-―_]/g, "")
    .replace(/\s+/g, " ");
}

const SAFETY_TERMS = [
  "gas leak", "smell of gas", "gas smell", "smells of gas",
  "burning smell", "fire hazard", "on fire", "fire in", "fire alarm", "smoke",
  "carbon monoxide",
  "electric shock", "short circuit", "sparks",
  "burst pipe", "flooding", "flooded",
  "collapse",
  "lift is stuck", "stuck in the lift", "stuck in the elevator", "trapped",
  "emergency", "danger to life",
].map(fold);

const LEGAL_TERMS = [
  "lawyer", "attorney", "solicitor", "lawsuit", "sue you", "sue us", "court", "legal action",
  "rent reduction", "reduce the rent", "terminate", "termination", "without notice", "formal warning",
  "eviction", "damages claim", "tenants association", "tenants' association", "mediation", "arbitration",
  "liability",
].map(fold);

/** Everyday words that contain a legal term as a substring ("courtyard" contains "court"). Masked before the scan. */
const BENIGN_WORDS = ["courtyard", "courtesy", "courteous"].map(fold);

const INJECTION_PATTERNS: RegExp[] = [
  /(ignor|disregard|forget|overrid)\w*[^.\n]{0,40}(instruction|rule|prompt)/,
  /(system ?prompt|developer mode|jailbreak|you are now|new instructions)/,
];

const COMMITMENT_PATTERNS: RegExp[] = [
  /(refund|reimburs|compensat)/,
  /(cover\w*[^.]{0,30}\bcosts?\b|\bcosts?\b[^.]{0,30}\bcover)/,
  /(we (will|'ll) (cover|pay))/,
  /guarantee/,
  /(you are entitled|you have a right to|legally (obliged|required))/,
];

function containsAny(foldedText: string, foldedTerms: readonly string[]): boolean {
  return foldedTerms.some((term) => foldedText.includes(term));
}

function ticketText(ticket: Ticket): string {
  return BENIGN_WORDS.reduce((text, word) => text.replaceAll(word, " "), fold(`${ticket.subject}\n${ticket.body}`));
}

/** Checks that depend only on the raw ticket text. Safe to run before (or without) any LLM call. */
export function scanRawText(ticket: Ticket): EscalationReason[] {
  const text = ticketText(ticket);
  const reasons: EscalationReason[] = [];
  if (containsAny(text, SAFETY_TERMS)) reasons.push("safety_keyword");
  if (containsAny(text, LEGAL_TERMS)) reasons.push("legal_threat");
  if (INJECTION_PATTERNS.some((p) => p.test(text))) reasons.push("prompt_injection_suspected");
  return reasons;
}

/** Pre-retrieval checks: raw text + the model's classification. `classification` null = it failed. */
export function assessTicket(
  ticket: Ticket,
  classification: Classification | null,
  cfg: PolicyConfig = DEFAULT_POLICY,
): EscalationReason[] {
  const reasons = new Set<EscalationReason>(scanRawText(ticket));

  if (classification === null) {
    reasons.add("classification_failed");
  } else {
    if (classification.urgency === "emergency") reasons.add("emergency_urgency");
    if (cfg.humanOnlyCategories.includes(classification.category)) {
      reasons.add("category_requires_human");
    }
    if (classification.confidence < cfg.minConfidence) reasons.add("low_confidence");
  }

  if (ticket.previousContacts >= cfg.repeatContactThreshold) reasons.add("repeat_contact");
  return [...reasons];
}

/** An automatic reply must be grounded in the knowledge base. */
export function assessKb(hits: readonly KbHit[], cfg: PolicyConfig = DEFAULT_POLICY): EscalationReason[] {
  const best = hits.reduce((max, hit) => Math.max(max, hit.score), 0);
  return best >= cfg.minKbScore ? [] : ["no_kb_support"];
}

/** Post-draft checks: an automated reply must not make financial or legal commitments. */
export function assessDraft(draft: string): EscalationReason[] {
  const text = fold(draft);
  return COMMITMENT_PATTERNS.some((p) => p.test(text)) ? ["draft_makes_commitment"] : [];
}

const REASON_EXPLANATIONS: Record<EscalationReason, string> = {
  safety_keyword: "Possible safety issue (gas, fire, flooding, electrical, trapped person).",
  legal_threat: "Legal or contractual language (lawyer, rent reduction, termination, liability).",
  prompt_injection_suspected: "The message contains text that looks like instructions aimed at an AI.",
  emergency_urgency: "Classified as an emergency.",
  category_requires_human: "This category is handled by a person only.",
  low_confidence: "The classifier was not confident enough.",
  repeat_contact: "The sender has contacted us several times about this issue.",
  no_kb_support: "The knowledge base has no sufficiently relevant answer.",
  draft_makes_commitment: "The draft reply promised money, guarantees or legal entitlements.",
  classification_failed: "The model did not return a usable classification.",
  draft_failed: "The model did not return a usable draft.",
  model_error: "The model provider failed.",
};

export function explainReason(reason: EscalationReason): string {
  return REASON_EXPLANATIONS[reason];
}

export function buildHandoffNote(
  ticket: Ticket,
  classification: Classification | null,
  reasons: readonly EscalationReason[],
): string {
  const lines = [
    `Escalated: ${ticket.subject}`,
    ...(classification
      ? [
          `Category: ${classification.category} | Urgency: ${classification.urgency} | Confidence: ${classification.confidence.toFixed(2)}`,
          `Summary: ${classification.summary}`,
        ]
      : ["Category: unknown (classification unavailable)"]),
    `Sender: ${ticket.senderRole}${ticket.property ? ` | Property: ${ticket.property}` : ""} | Earlier contacts: ${ticket.previousContacts}`,
    "Why a human is needed:",
    ...reasons.map((r) => `- ${explainReason(r)}`),
  ];
  return lines.join("\n");
}
