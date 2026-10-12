import { CATEGORIES } from "../../inbox-agent/src/types.ts";
import type { Category, SenderRole, Ticket } from "../../inbox-agent/src/types.ts";

export interface DatasetItem {
  id: string;
  subject: string;
  body: string;
  senderRole: SenderRole;
  previousContacts: number;
  /** Gold label: what a property manager would file this under. */
  category: Category;
  /** Gold label: would a property manager want a human on this ticket? Labelled by judgement, not by the policy code. */
  shouldEscalate: boolean;
}

const ROLES: readonly SenderRole[] = ["tenant", "owner", "vendor", "unknown"];

export function parseDataset(jsonl: string): DatasetItem[] {
  const items: DatasetItem[] = [];
  const seen = new Set<string>();

  jsonl.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${index + 1}`;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }

    const str = (key: string): string => {
      const value = raw[key];
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
      return value;
    };
    const category = CATEGORIES.find((c) => c === raw.category);
    const senderRole = ROLES.find((r) => r === raw.senderRole);
    if (!category) throw new Error(`${where}: unknown category ${JSON.stringify(raw.category)}`);
    if (!senderRole) throw new Error(`${where}: unknown senderRole ${JSON.stringify(raw.senderRole)}`);
    if (typeof raw.shouldEscalate !== "boolean") throw new Error(`${where}: shouldEscalate must be boolean`);
    if (!Number.isInteger(raw.previousContacts) || (raw.previousContacts as number) < 0) {
      throw new Error(`${where}: previousContacts must be a non-negative integer`);
    }

    const id = str("id");
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);

    items.push({
      id,
      subject: str("subject"),
      body: str("body"),
      senderRole,
      previousContacts: raw.previousContacts as number,
      category,
      shouldEscalate: raw.shouldEscalate,
    });
  });
  return items;
}

export function toTicket(item: DatasetItem): Ticket {
  return {
    id: item.id,
    subject: item.subject,
    body: item.body,
    senderRole: item.senderRole,
    previousContacts: item.previousContacts,
  };
}
