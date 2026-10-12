import type { KnowledgeIndex, SearchMode } from "./index.ts";

export interface EvalQuery {
  id: string;
  query: string;
  /** The section that answers the query, or null if the knowledge base has no answer (query should be refused). */
  expected: { doc: string; heading: string } | null;
}

export interface AbstentionPoint {
  threshold: number;
  /** Unanswerable queries whose best hit fell below the threshold (correct refusals). */
  refusedUnanswerable: number;
  /** Answerable queries whose best hit fell below the threshold (wrong refusals). */
  refusedAnswerable: number;
}

export interface ModeReport {
  mode: SearchMode;
  answerable: number;
  unanswerable: number;
  hitAt1: number;
  hitAt3: number;
  /** Mean reciprocal rank over the top 5, answerable queries only. */
  mrr: number;
  /** Probability that a random answerable query's best hit outscores a random unanswerable query's (0.5 = no signal). */
  relevanceAuc: number;
  abstention: AbstentionPoint[];
  misses: { id: string; query: string; expected: string; top1: string; rank: number | null }[];
}

const label = (doc: string, heading: string) => `${doc} > ${heading}`;

/** Mann-Whitney formulation of ROC-AUC; ties count half. */
export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return 0;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

export async function evaluateRetrieval(
  index: KnowledgeIndex,
  queries: readonly EvalQuery[],
  modes: readonly SearchMode[] = ["bm25", "vector", "hybrid"],
  thresholds: readonly number[] = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4],
): Promise<ModeReport[]> {
  const reports: ModeReport[] = [];

  for (const mode of modes) {
    let hit1 = 0;
    let hit3 = 0;
    let rrSum = 0;
    const misses: ModeReport["misses"] = [];
    const answerableTop: number[] = [];
    const unanswerableTop: number[] = [];

    for (const q of queries) {
      const hits = await index.search(q.query, { k: 5, mode });
      const topRelevance = hits[0]?.relevance ?? 0;

      if (q.expected === null) {
        unanswerableTop.push(topRelevance);
        continue;
      }
      answerableTop.push(topRelevance);
      const position = hits.findIndex((h) => h.docId === q.expected!.doc && h.heading === q.expected!.heading);
      const rank = position === -1 ? null : position + 1;
      if (rank === 1) hit1++;
      if (rank !== null && rank <= 3) hit3++;
      if (rank !== null) rrSum += 1 / rank;
      if (rank !== 1) {
        const top = hits[0];
        misses.push({
          id: q.id,
          query: q.query,
          expected: label(q.expected.doc, q.expected.heading),
          top1: top ? label(top.docId, top.heading) : "(no results)",
          rank,
        });
      }
    }

    const n = answerableTop.length;
    reports.push({
      mode,
      answerable: n,
      unanswerable: unanswerableTop.length,
      hitAt1: n === 0 ? 0 : hit1 / n,
      hitAt3: n === 0 ? 0 : hit3 / n,
      mrr: n === 0 ? 0 : rrSum / n,
      relevanceAuc: auc(answerableTop, unanswerableTop),
      abstention: thresholds.map((threshold) => ({
        threshold,
        refusedUnanswerable: unanswerableTop.filter((r) => r < threshold).length,
        refusedAnswerable: answerableTop.filter((r) => r < threshold).length,
      })),
      misses,
    });
  }
  return reports;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderRetrievalMarkdown(reports: readonly ModeReport[]): string {
  const first = reports[0];
  if (!first) return "";
  const lines = [
    `Queries: ${first.answerable} answerable, ${first.unanswerable} with no answer in the knowledge base.`,
    "",
    "| Retriever | Hit@1 | Hit@3 | MRR@5 | Relevance AUC |",
    "|---|---|---|---|---|",
    ...reports.map((r) => `| ${r.mode} | ${pct(r.hitAt1)} | ${pct(r.hitAt3)} | ${r.mrr.toFixed(3)} | ${r.relevanceAuc.toFixed(2)} |`),
    "",
    "Refusal sweep (a query is refused when its best hit's relevance is below the threshold):",
    "",
    "| Retriever | Threshold | Correctly refused (unanswerable) | Wrongly refused (answerable) |",
    "|---|---|---|---|",
    ...reports.flatMap((r) =>
      r.abstention.map(
        (a) => `| ${r.mode} | ${a.threshold.toFixed(2)} | ${a.refusedUnanswerable}/${r.unanswerable} | ${a.refusedAnswerable}/${r.answerable} |`,
      ),
    ),
  ];

  for (const r of reports) {
    lines.push("", `### ${r.mode}: answerable queries not ranked first`);
    if (r.misses.length === 0) lines.push("(none)");
    for (const m of r.misses) {
      lines.push(`- ${m.id} "${m.query}" -> expected ${m.expected} (rank ${m.rank ?? ">5"}), got ${m.top1}`);
    }
  }
  return lines.join("\n");
}
