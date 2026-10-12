import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashingEmbedder, cosine } from "./embed.ts";

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("HashingEmbedder", () => {
  it("returns unit vectors of the configured dimension, deterministically", async () => {
    const e = new HashingEmbedder({ dim: 256 });
    const [a, b] = await e.embed(["heating service in winter", "heating service in winter"]);
    assert.equal(a!.length, 256);
    assert.ok(Math.abs(norm(a!) - 1) < 1e-9);
    assert.deepEqual(a, b);
  });

  it("returns a zero vector (not NaN) for text with no usable words", async () => {
    const [v] = await new HashingEmbedder().embed(["what is this?"]);
    assert.ok(v!.every((x) => x === 0));
  });

  it("places a compound word closer to its parts than to an unrelated word", async () => {
    const e = new HashingEmbedder();
    const [compound, part, unrelated] = await e.embed(["doorbell", "door", "radiator"]);
    assert.ok(cosine(compound!, part!) > cosine(compound!, unrelated!) + 0.1);
  });

  it("tolerates a small typo", async () => {
    const e = new HashingEmbedder();
    const [clean, typo, other] = await e.embed(["radiator", "radaitor", "mailbox"]);
    assert.ok(cosine(clean!, typo!) > cosine(clean!, other!));
  });

  it("IDF fitting down-weights features that occur everywhere", async () => {
    const corpus = ["heating service", "heating emergency", "heating thermostat", "mailbox key"];
    const plain = new HashingEmbedder();
    const fitted = new HashingEmbedder();
    fitted.fit(corpus);

    const [qp, a0, a3] = await plain.embed(["heating key", corpus[0]!, corpus[3]!]);
    const [qf, b0, b3] = await fitted.embed(["heating key", corpus[0]!, corpus[3]!]);
    const marginPlain = cosine(qp!, a3!) - cosine(qp!, a0!);
    const marginFitted = cosine(qf!, b3!) - cosine(qf!, b0!);
    assert.ok(marginFitted > marginPlain, "the distinctive term (key) should count for more once IDF is learned");
  });
});

describe("cosine", () => {
  it("is 1 for identical unit vectors, 0 for orthogonal ones, and never negative", () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1, 0], [-1, 0]), 0);
  });
});
