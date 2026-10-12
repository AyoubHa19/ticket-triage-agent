import { words } from "./text.ts";

/** Anything that turns texts into unit-length vectors. A hosted embedding model plugs in here. */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface HashingEmbedderOptions {
  dim?: number;
  ngram?: number;
}

/**
 * Dependency-free subword embedder: signed feature hashing of whole words and character n-grams,
 * IDF-weighted once `fit` has seen the corpus, L2-normalised (so cosine similarity = dot product).
 *
 * What it is: a lexical-subword model. It handles compounds ("doorbell" shares n-grams with
 * "door"), inflection and small typos, which whole-word BM25 cannot.
 * What it is NOT: a semantic model. It does not know that a sofa is "bulky waste".
 * For that, implement `Embedder` with a hosted embedding model; nothing else has to change.
 */
export class HashingEmbedder implements Embedder {
  private readonly dim: number;
  private readonly ngram: number;
  private idf = new Map<string, number>();
  private maxIdf = 1;

  constructor(options: HashingEmbedderOptions = {}) {
    this.dim = options.dim ?? 1024;
    this.ngram = options.ngram ?? 3;
  }

  private features(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    const add = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);
    for (const word of words(text)) {
      add(`w:${word}`);
      const padded = `^${word}$`;
      for (let i = 0; i + this.ngram <= padded.length; i++) add(`n:${padded.slice(i, i + this.ngram)}`);
    }
    return counts;
  }

  /** Learn per-feature IDF from the corpus so that ubiquitous n-grams ("ung", "en$") stop dominating. */
  fit(corpus: readonly string[]): void {
    const df = new Map<string, number>();
    for (const text of corpus) {
      for (const feature of this.features(text).keys()) df.set(feature, (df.get(feature) ?? 0) + 1);
    }
    const n = corpus.length;
    this.idf = new Map([...df].map(([feature, count]) => [feature, Math.log(1 + n / count)]));
    this.maxIdf = Math.log(1 + n);
  }

  private vector(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    for (const [feature, tf] of this.features(text)) {
      const hash = fnv1a(feature);
      const weight = (1 + Math.log(tf)) * (this.idf.get(feature) ?? this.maxIdf);
      vec[hash % this.dim]! += (hash >>> 16) & 1 ? weight : -weight;
    }
    const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
    return norm === 0 ? vec : vec.map((x) => x / norm);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }
}

/** Cosine similarity of two unit vectors, clamped at 0 (hashing can produce small negatives). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(0, dot);
}
