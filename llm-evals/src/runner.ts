import { accuracy, binaryMetrics, percentile } from "./metrics.ts";
import type { BinaryMetrics } from "./metrics.ts";
import type { DatasetItem } from "./dataset.ts";

export interface Prediction {
  category: string;
  escalate: boolean;
  costUsd?: number | null;
}

export interface EvalSystem {
  name: string;
  predict(item: DatasetItem): Promise<Prediction>;
}

export interface ItemResult {
  id: string;
  expectedCategory: string;
  predictedCategory: string;
  expectedEscalate: boolean;
  predictedEscalate: boolean;
  latencyMs: number;
  costUsd: number | null;
  error?: string;
}

export interface SystemReport {
  system: string;
  items: ItemResult[];
  categoryAccuracy: number;
  escalation: BinaryMetrics;
  errors: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** null when no cost information was available for any item. */
  totalCostUsd: number | null;
  costPer1kTickets: number | null;
  missedEscalations: string[];
  unnecessaryEscalations: string[];
}

export interface RunOptions {
  concurrency?: number;
  now?: () => number;
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs one system over the dataset. A system that throws is scored fail-safe: the production
 * agent hands a ticket to a human when the model fails, so an error counts as "escalate" (and
 * as a wrong category), and is also reported separately so it cannot hide.
 */
export async function evaluateSystem(
  system: EvalSystem,
  dataset: readonly DatasetItem[],
  options: RunOptions = {},
): Promise<SystemReport> {
  const now = options.now ?? Date.now;

  const items = await mapPool(dataset, options.concurrency ?? 4, async (item): Promise<ItemResult> => {
    const started = now();
    try {
      const p = await system.predict(item);
      return {
        id: item.id,
        expectedCategory: item.category,
        predictedCategory: p.category,
        expectedEscalate: item.shouldEscalate,
        predictedEscalate: p.escalate,
        latencyMs: now() - started,
        costUsd: p.costUsd ?? null,
      };
    } catch (error) {
      return {
        id: item.id,
        expectedCategory: item.category,
        predictedCategory: "error",
        expectedEscalate: item.shouldEscalate,
        predictedEscalate: true,
        latencyMs: now() - started,
        costUsd: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const costs = items.map((i) => i.costUsd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
  const latencies = items.map((i) => i.latencyMs);

  return {
    system: system.name,
    items,
    categoryAccuracy: accuracy(items.map((i) => ({ expected: i.expectedCategory, predicted: i.predictedCategory }))),
    escalation: binaryMetrics(items.map((i) => ({ expected: i.expectedEscalate, predicted: i.predictedEscalate }))),
    errors: items.filter((i) => i.error !== undefined).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    totalCostUsd,
    costPer1kTickets: totalCostUsd === null ? null : (totalCostUsd / items.length) * 1000,
    missedEscalations: items.filter((i) => i.expectedEscalate && !i.predictedEscalate).map((i) => i.id),
    unnecessaryEscalations: items.filter((i) => !i.expectedEscalate && i.predictedEscalate).map((i) => i.id),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderMarkdown(reports: readonly SystemReport[], dataset: readonly DatasetItem[]): string {
  const byId = new Map(dataset.map((d) => [d.id, d]));
  const positives = dataset.filter((d) => d.shouldEscalate).length;

  const lines = [
    `Dataset: ${dataset.length} tickets (${positives} should be escalated, ${dataset.length - positives} should not).`,
    "",
    "| System | Category acc. | Escalation recall | Escalation precision | F1 | Missed escalations | Unnecessary escalations | Errors | p50 ms | p95 ms | $/1k tickets |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...reports.map((r) =>
      [
        r.system,
        pct(r.categoryAccuracy),
        pct(r.escalation.recall),
        pct(r.escalation.precision),
        r.escalation.f1.toFixed(2),
        `${r.escalation.fn}/${positives}`,
        `${r.escalation.fp}/${dataset.length - positives}`,
        String(r.errors),
        String(Math.round(r.latencyP50Ms)),
        String(Math.round(r.latencyP95Ms)),
        r.costPer1kTickets === null ? "n/a" : `$${r.costPer1kTickets.toFixed(2)}`,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    ),
  ];

  for (const r of reports) {
    const describe = (ids: string[]) =>
      ids.length === 0 ? ["  (none)"] : ids.map((id) => `  - ${id}: ${byId.get(id)?.subject ?? "?"}`);
    lines.push("", `### ${r.system}`, "Missed escalations (needed a human, handled automatically):", ...describe(r.missedEscalations));
    lines.push("Unnecessary escalations (handed to a human although routine):", ...describe(r.unnecessaryEscalations));
  }
  return lines.join("\n");
}
