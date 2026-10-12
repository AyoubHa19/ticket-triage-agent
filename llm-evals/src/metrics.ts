export interface BinaryCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface BinaryMetrics extends BinaryCounts {
  /** tp / (tp + fp); 0 when nothing was predicted positive. */
  precision: number;
  /** tp / (tp + fn); 0 when there were no positives. */
  recall: number;
  f1: number;
}

/**
 * Positive class = "should be escalated to a human". Recall is the safety metric
 * (1 - recall = share of cases that needed a human but were handled automatically);
 * precision is the cost metric (how many handoffs were unnecessary).
 */
export function binaryMetrics(pairs: readonly { expected: boolean; predicted: boolean }[]): BinaryMetrics {
  const counts: BinaryCounts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const { expected, predicted } of pairs) {
    if (expected && predicted) counts.tp++;
    else if (!expected && predicted) counts.fp++;
    else if (expected && !predicted) counts.fn++;
    else counts.tn++;
  }
  const precision = counts.tp + counts.fp === 0 ? 0 : counts.tp / (counts.tp + counts.fp);
  const recall = counts.tp + counts.fn === 0 ? 0 : counts.tp / (counts.tp + counts.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...counts, precision, recall, f1 };
}

export function accuracy(pairs: readonly { expected: string; predicted: string }[]): number {
  if (pairs.length === 0) return 0;
  return pairs.filter((p) => p.expected === p.predicted).length / pairs.length;
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}
