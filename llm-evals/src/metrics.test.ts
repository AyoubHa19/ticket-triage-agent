import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accuracy, binaryMetrics, percentile } from "./metrics.ts";

describe("binaryMetrics", () => {
  it("computes the confusion matrix, precision, recall and F1", () => {
    // 3 TP, 1 FP, 2 FN, 4 TN
    const pairs = [
      ...Array(3).fill({ expected: true, predicted: true }),
      { expected: false, predicted: true },
      ...Array(2).fill({ expected: true, predicted: false }),
      ...Array(4).fill({ expected: false, predicted: false }),
    ];
    const m = binaryMetrics(pairs);
    assert.deepEqual({ tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn }, { tp: 3, fp: 1, fn: 2, tn: 4 });
    assert.equal(m.precision, 3 / 4);
    assert.equal(m.recall, 3 / 5);
    assert.ok(Math.abs(m.f1 - (2 * 0.75 * 0.6) / (0.75 + 0.6)) < 1e-12);
  });

  it("returns zeros instead of NaN on degenerate input", () => {
    for (const m of [
      binaryMetrics([]),
      binaryMetrics([{ expected: false, predicted: false }]),
      binaryMetrics([{ expected: true, predicted: false }]),
    ]) {
      assert.equal(m.precision, 0);
      assert.equal(m.f1, 0);
      assert.ok(!Number.isNaN(m.recall));
    }
  });
});

describe("accuracy", () => {
  it("is the share of exact matches, and 0 for no data", () => {
    assert.equal(accuracy([{ expected: "a", predicted: "a" }, { expected: "b", predicted: "c" }]), 0.5);
    assert.equal(accuracy([]), 0);
  });
});

describe("percentile (nearest rank)", () => {
  const values = [15, 20, 35, 40, 50];
  it("matches the textbook nearest-rank examples", () => {
    assert.equal(percentile(values, 30), 20);
    assert.equal(percentile(values, 40), 20);
    assert.equal(percentile(values, 50), 35);
    assert.equal(percentile(values, 100), 50);
  });
  it("does not depend on input order and handles tiny inputs", () => {
    assert.equal(percentile([50, 15, 40, 20, 35], 50), 35);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 95), 0);
  });
});
