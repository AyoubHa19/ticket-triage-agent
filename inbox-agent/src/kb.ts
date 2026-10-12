import { fold } from "./policy.ts";
import type { KbHit, KnowledgeBase } from "./types.ts";

export interface KbDoc {
  title: string;
  heading: string;
  text: string;
}

const STOPWORDS = new Set(
  "the a an and or not is are was be do does to of for with on in at my our your it this that what when where how can please hello thanks".split(" "),
);

function tokens(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Tiny keyword-overlap knowledge base used by tests and the demo. The production-grade retriever
 * (chunking, BM25 + vectors, rank fusion) lives in the sibling `kb-search` project and plugs in
 * through the same `KnowledgeBase` interface.
 */
export class InMemoryKb implements KnowledgeBase {
  private readonly docs: KbDoc[];

  constructor(docs: KbDoc[]) {
    this.docs = docs;
  }

  async search(query: string, k = 3): Promise<KbHit[]> {
    const queryTokens = new Set(tokens(query));
    if (queryTokens.size === 0) return [];

    return this.docs
      .map((doc) => {
        const docTokens = new Set(tokens(`${doc.title} ${doc.heading} ${doc.text}`));
        let overlap = 0;
        for (const t of queryTokens) if (docTokens.has(t)) overlap++;
        // Normalise by a fixed small denominator so a handful of matching words already counts as strong.
        const score = Math.min(1, overlap / Math.min(queryTokens.size, 4));
        return { docTitle: doc.title, heading: doc.heading, text: doc.text, score };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
