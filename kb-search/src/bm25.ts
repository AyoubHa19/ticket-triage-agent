import { tokenize } from "./text.ts";

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25Hit {
  index: number;
  score: number;
}

/**
 * Okapi BM25 over pre-tokenised documents, with the +1 IDF variant (never negative).
 * Also exposes IDF-weighted query coverage: the share of the query's informative terms (by IDF
 * mass) that a document contains. Unlike a raw BM25 score it is bounded to [0, 1], so it can be
 * used to decide "is this result relevant at all?" (see index.ts).
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly docTerms: Map<string, number>[] = [];
  private readonly docLengths: number[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly avgLength: number;

  constructor(texts: readonly string[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;

    for (const text of texts) {
      const tokens = tokenize(text);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.docTerms.push(counts);
      this.docLengths.push(tokens.length);
      for (const term of counts.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const total = this.docLengths.reduce((a, b) => a + b, 0);
    this.avgLength = texts.length === 0 ? 0 : total / texts.length;
  }

  get size(): number {
    return this.docTerms.length;
  }

  /** Unseen terms get the highest IDF: a query word the corpus has never seen is maximally informative. */
  idf(term: string): number {
    const n = this.size;
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  queryTerms(query: string): string[] {
    return [...new Set(tokenize(query))];
  }

  search(query: string, k = 10): Bm25Hit[] {
    const terms = this.queryTerms(query);
    const hits: Bm25Hit[] = [];

    for (let i = 0; i < this.docTerms.length; i++) {
      const counts = this.docTerms[i]!;
      const length = this.docLengths[i]!;
      let score = 0;
      for (const term of terms) {
        const tf = counts.get(term);
        if (!tf) continue;
        const norm = 1 - this.b + this.b * (length / (this.avgLength || 1));
        score += this.idf(term) * ((tf * (this.k1 + 1)) / (tf + this.k1 * norm));
      }
      if (score > 0) hits.push({ index: i, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, k);
  }

  /** IDF-weighted fraction of the query's terms present in document `index`; 0 for an empty query. */
  coverage(query: string, index: number): number {
    const terms = this.queryTerms(query);
    if (terms.length === 0) return 0;
    const counts = this.docTerms[index];
    if (!counts) return 0;
    let found = 0;
    let total = 0;
    for (const term of terms) {
      const weight = this.idf(term);
      total += weight;
      if (counts.has(term)) found += weight;
    }
    return total === 0 ? 0 : found / total;
  }
}
