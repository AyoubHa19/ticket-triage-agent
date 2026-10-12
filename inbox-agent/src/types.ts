export const CATEGORIES = [
  "damage", // leaks, broken windows, mould...
  "maintenance", // heating service, lift inspection...
  "billing", // service charge statements, invoices
  "legal", // rent reduction, termination, lawyers
  "move", // moving in/out, handover, viewings
  "keys",
  "general",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ["emergency", "high", "normal", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

export type SenderRole = "tenant" | "owner" | "vendor" | "unknown";

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  senderRole: SenderRole;
  property?: string;
  /** How many earlier messages this sender already sent about the same issue. */
  previousContacts: number;
}

export interface Classification {
  category: Category;
  urgency: Urgency;
  /** Model's self-reported confidence, 0..1. Treated as a weak signal, never as the only guard. */
  confidence: number;
  summary: string;
}

export interface KbHit {
  docTitle: string;
  heading: string;
  text: string;
  /** Normalised relevance, 0..1. */
  score: number;
}

export interface KnowledgeBase {
  search(query: string, k?: number): Promise<KbHit[]>;
}

export const ESCALATION_REASONS = [
  "safety_keyword",
  "legal_threat",
  "prompt_injection_suspected",
  "emergency_urgency",
  "category_requires_human",
  "low_confidence",
  "repeat_contact",
  "no_kb_support",
  "draft_makes_commitment",
  "classification_failed",
  "draft_failed",
  "model_error",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export type Decision =
  | { action: "reply"; reply: string; citations: string[] }
  | { action: "escalate"; reasons: EscalationReason[]; handoffNote: string };

export interface TraceStep {
  step: string;
  detail: string;
}

export interface RunResult {
  decision: Decision;
  classification: Classification | null;
  hits: KbHit[];
  trace: TraceStep[];
  /** Number of LLM calls made for this ticket (cost proxy). */
  modelCalls: number;
}
