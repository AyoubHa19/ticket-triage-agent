import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import type { Embedder } from "./embed.ts";
import { evaluateRetrieval } from "./eval.ts";
import type { EvalQuery } from "./eval.ts";
import { KnowledgeIndex, fuse, relevanceOf } from "./index.ts";
import { loadMarkdownDir } from "./load.ts";

const docs = loadMarkdownDir(new URL("../docs/", import.meta.url));
const queries = JSON.parse(readFileSync(new URL("../data/queries.json", import.meta.url), "utf8")) as EvalQuery[];

describe("fuse (reciprocal rank fusion)", () => {
  it("rewards agreement and breaks ties by index", () => {
    assert.deepEqual(fuse([[5, 1], [1]]), [1, 5]);
    // 0 and 2 each rank first once and last once; 1 is second in both. RRF favours the extremes slightly.
    assert.deepEqual(fuse([[0, 1, 2], [2, 1, 0]]), [0, 2, 1]);
  });

  it("handles empty rankings", () => {
    assert.deepEqual(fuse([[], []]), []);
    assert.deepEqual(fuse([[3], []]), [3]);
  });
});

describe("relevanceOf", () => {
  it("takes the stronger of the two signals", () => {
    assert.equal(relevanceOf(0.2, 0.5), 0.5);
    assert.equal(relevanceOf(0.7, 0.1), 0.7);
  });
});

describe("loadMarkdownDir", () => {
  it("loads every markdown file in name order, with ids from file names", () => {
    const ids = docs.map((d) => d.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.ok(ids.includes("heating") && ids.includes("moving-out"));
    assert.equal(ids.length, 9);
  });
});

describe("KnowledgeIndex on the sample knowledge base", () => {
  let index: KnowledgeIndex;
  before(async () => {
    index = await KnowledgeIndex.build(docs);
  });

  it("finds the right section for a direct question in every retrieval mode", async () => {
    for (const mode of ["bm25", "vector", "hybrid"] as const) {
      const [top] = await index.search("When is the technician coming for the heating service?", { mode });
      assert.equal(`${top!.docId}/${top!.heading}`, "heating/Maintenance appointments", mode);
    }
  });

  it("lets the vector side rescue a typo that shares no word with the corpus (BM25 returns nothing)", async () => {
    const query = "radaitor";
    assert.deepEqual(await index.search(query, { mode: "bm25" }), []);
    const [top] = await index.search(query, { mode: "hybrid" });
    assert.equal(top!.heading, "Radiator not getting warm");
  });

  it("ranks the exact section first where whole-word BM25 gets it second", async () => {
    const query = "When will I get my service charge statement?";
    const bm25 = await index.search(query, { mode: "bm25" });
    const hybrid = await index.search(query, { mode: "hybrid" });
    assert.notEqual(bm25[0]!.heading, "When the statement is sent");
    assert.equal(hybrid[0]!.heading, "When the statement is sent");
  });

  it("respects k and returns relevance signals in [0, 1]", async () => {
    const hits = await index.search("heating", { k: 2 });
    assert.equal(hits.length, 2);
    for (const h of hits) {
      for (const x of [h.relevance, h.lexicalCoverage, h.cosine]) assert.ok(x >= 0 && x <= 1);
    }
  });

  it("scores unrelated queries below clearly relevant ones", async () => {
    const [relevant] = await index.search("Can I have a barbecue on the balcony?");
    const [unrelated] = await index.search("Recipe for cheesecake");
    assert.ok(relevant!.relevance > unrelated!.relevance + 0.4);
  });

  it("exposes the shape the inbox agent's KnowledgeBase interface expects", async () => {
    const kb = index.asKnowledgeBase();
    const hits = await kb.search("When is the heating service?", 2);
    assert.equal(hits.length, 2);
    assert.deepEqual(Object.keys(hits[0]!).sort(), ["docTitle", "heading", "score", "text"]);
    assert.ok(hits[0]!.score > 0 && hits[0]!.score <= 1);
  });
});

describe("KnowledgeIndex with a custom embedder", () => {
  it("uses the supplied embedder for both documents and queries", async () => {
    const seen: string[] = [];
    // Toy embedder: 2-D "topic" vector. Dimension 0 = heating, 1 = keys.
    const embedder: Embedder = {
      async embed(texts) {
        seen.push(...texts);
        return texts.map((t) => {
          const v = [/heat/i.test(t) ? 1 : 0, /keys?/i.test(t) ? 1 : 0];
          const n = Math.hypot(v[0]!, v[1]!);
          return n === 0 ? v : v.map((x) => x / n);
        });
      },
    };
    const index = await KnowledgeIndex.build(docs, { embedder });
    const [top] = await index.search("heating broken", { mode: "vector", k: 1 });

    assert.equal(top!.docId, "heating");
    assert.ok(seen.includes("heating broken"), "the query went through the custom embedder");
    assert.ok(seen.length > 20, "all chunks were embedded by it");
  });
});

/**
 * Regression floors, not quality claims: the sample set has 27 answerable queries, so one query
 * is 3.7 points. If a change breaks these, look at results/latest.md before touching the numbers.
 */
describe("retrieval regression floors on data/queries.json", () => {
  it("keeps hit@3 high in every mode and MRR reasonable for hybrid", async () => {
    const index = await KnowledgeIndex.build(docs);
    const reports = await evaluateRetrieval(index, queries);
    for (const r of reports) assert.ok(r.hitAt3 >= 0.85, `${r.mode} hit@3 = ${r.hitAt3}`);
    const hybrid = reports.find((r) => r.mode === "hybrid")!;
    assert.ok(hybrid.mrr >= 0.8, `hybrid MRR = ${hybrid.mrr}`);
  });
});
