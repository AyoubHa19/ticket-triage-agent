import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Bm25Index } from "./bm25.ts";

const corpus = [
  "heating service appointment notice stairwell", // 0
  "lost key replacement fee signature", // 1
  "heating heating heating heating heating", // 2 - repeats one term
  "waste separation paper organic bins bin room ground floor collection calendar council yard basement", // 3 - long
];

describe("Bm25Index", () => {
  const index = new Bm25Index(corpus);

  it("ranks documents containing the query terms first and omits non-matching ones", () => {
    const hits = index.search("service heating");
    assert.equal(hits[0]!.index, 0);
    assert.ok(!hits.some((h) => h.index === 1 || h.index === 3));
  });

  it("rare terms weigh more than common ones", () => {
    assert.ok(index.idf("key") > index.idf("heat"));
  });

  it("saturates term frequency: five repeats do not score five times one occurrence", () => {
    const single = index.search("heating").find((h) => h.index === 0)!.score;
    const repeated = index.search("heating").find((h) => h.index === 2)!.score;
    assert.ok(repeated > single);
    assert.ok(repeated < single * 3);
  });

  it("returns nothing for an empty or entirely unseen query", () => {
    assert.deepEqual(index.search(""), []);
    assert.deepEqual(index.search("spaceship"), []);
  });

  it("respects k and orders deterministically on ties", () => {
    const twin = new Bm25Index(["alpha beta", "alpha beta"]);
    assert.deepEqual(twin.search("alpha", 1).map((h) => h.index), [0]);
  });
});

describe("Bm25Index.coverage", () => {
  const index = new Bm25Index(corpus);

  it("is 1 when the document contains every query term and 0 when it contains none", () => {
    assert.equal(index.coverage("heating service", 0), 1);
    assert.equal(index.coverage("heating service", 1), 0);
  });

  it("lies in [0, 1] and drops when a query term is unseen in the whole corpus", () => {
    const full = index.coverage("heating service", 0);
    const withUnknown = index.coverage("heating service spaceship", 0);
    assert.ok(withUnknown > 0 && withUnknown < full);
  });

  it("weights informative terms more than common ones", () => {
    const common = index.coverage("heating spaceship", 0); // matches common term, misses unseen one
    const rare = index.coverage("service spaceship", 0); // matches rarer term, misses unseen one
    assert.ok(rare >= common);
  });

  it("is 0 for an empty query or unknown document index", () => {
    assert.equal(index.coverage("", 0), 0);
    assert.equal(index.coverage("heating", 99), 0);
  });
});
