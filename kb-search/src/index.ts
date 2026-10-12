import { Bm25Index } from "./bm25.ts";
import { chunkMarkdown } from "./chunk.ts";
import type { Chunk, ChunkOptions, SourceDoc } from "./chunk.ts";
import { HashingEmbedder, cosine } from "./embed.ts";
import type { Embedder } from "./embed.ts";

export type SearchMode = "bm25" | "vector" | "hybrid";

export interface Hit {
  chunkId: string;
  docId: string;
  docTitle: string;
  heading: string;
  text: string;
  /** 0..1, see `relevanceOf`. Used to decide whether a hit may ground an answer at all. */
  relevance: number;
  /** IDF-weighted share of the query's terms found in this chunk (0..1). */
  lexicalCoverage: number;
  /** Cosine similarity between query and chunk embeddings (0..1). */
  cosine: number;
}

export interface SearchOptions {
  k?: number;
  mode?: SearchMode;
}

export interface BuildOptions extends ChunkOptions {
  embedder?: Embedder;
}

/** Reciprocal Rank Fusion constant from the original paper (Cormack et al., 2009). */
const RRF_K = 60;
/** How deep each retriever looks before fusion. */
const CANDIDATES = 20;

export class KnowledgeIndex {
  readonly chunks: readonly Chunk[];
  private readonly bm25: Bm25Index;
  private readonly embedder: Embedder;
  private readonly vectors: number[][];

  private constructor(chunks: Chunk[], bm25: Bm25Index, embedder: Embedder, vectors: number[][]) {
    this.chunks = chunks;
    this.bm25 = bm25;
    this.embedder = embedder;
    this.vectors = vectors;
  }

  static async build(docs: readonly SourceDoc[], options: BuildOptions = {}): Promise<KnowledgeIndex> {
    const chunks = docs.flatMap((doc) => chunkMarkdown(doc, options));
    const texts = chunks.map((c) => c.indexText);

    const embedder = options.embedder ?? new HashingEmbedder();
    if (embedder instanceof HashingEmbedder) embedder.fit(texts);

    return new KnowledgeIndex(chunks, new Bm25Index(texts), embedder, await embedder.embed(texts));
  }

  async search(query: string, options: SearchOptions = {}): Promise<Hit[]> {
    const k = options.k ?? 5;
    const mode = options.mode ?? "hybrid";
    const [queryVector] = await this.embedder.embed([query]);
    const qv = queryVector ?? [];

    const lexical = this.bm25.search(query, CANDIDATES).map((h) => h.index);
    const semantic = this.vectors
      .map((v, index) => ({ index, score: cosine(qv, v) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, CANDIDATES)
      .map((h) => h.index);

    let ranked: number[];
    if (mode === "bm25") ranked = lexical;
    else if (mode === "vector") ranked = semantic;
    else ranked = fuse([lexical, semantic]);

    return ranked.slice(0, k).map((index) => this.toHit(query, qv, index));
  }

  private toHit(query: string, queryVector: readonly number[], index: number): Hit {
    const chunk = this.chunks[index]!;
    const lexicalCoverage = this.bm25.coverage(query, index);
    const cos = cosine(queryVector, this.vectors[index]!);
    return {
      chunkId: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      heading: chunk.heading,
      text: chunk.text,
      relevance: relevanceOf(lexicalCoverage, cos),
      lexicalCoverage,
      cosine: cos,
    };
  }

  /** Same shape the inbox agent's `KnowledgeBase` interface expects, so the two projects plug together. */
  asKnowledgeBase(mode: SearchMode = "hybrid") {
    return {
      search: async (query: string, k = 3) =>
        (await this.search(query, { k, mode })).map((h) => ({
          docTitle: h.docTitle,
          heading: h.heading,
          text: h.text,
          score: h.relevance,
        })),
    };
  }
}

/** Reciprocal Rank Fusion: score(d) = sum over rankings of 1 / (k + rank). Rank-based, so scales never need aligning. */
export function fuse(rankings: readonly (readonly number[])[]): number[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((index, position) => {
      scores.set(index, (scores.get(index) ?? 0) + 1 / (RRF_K + position + 1));
    });
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
}

/**
 * Absolute relevance in [0, 1]. Rank fusion tells you the ORDER of results but not whether the best
 * one is any good (rank 1 is rank 1 even for an unanswerable question), so a separate absolute signal
 * is needed to decide whether to answer at all.
 */
export function relevanceOf(lexicalCoverage: number, cosineSimilarity: number): number {
  return Math.max(lexicalCoverage, cosineSimilarity);
}
