import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDataset } from "./load.ts";
import { evaluateSystem } from "./runner.ts";
import { policyOnlySystem } from "./systems.ts";

const dataset = loadDataset(new URL("../data/tickets.jsonl", import.meta.url));

describe("labelled dataset", () => {
  it("is non-trivial, and balanced enough to be informative", () => {
    assert.ok(dataset.length >= 30);
    const positives = dataset.filter((d) => d.shouldEscalate).length;
    assert.ok(positives >= 10 && dataset.length - positives >= 10);
    assert.ok(new Set(dataset.map((d) => d.category)).size >= 6);
  });
});

/**
 * Regression test for the deterministic policy on the labelled set.
 *
 * These are KNOWN GAPS, not goals: they were found by running the eval, and the dataset labels
 * were written by judgement before looking at the policy. If you change the policy and this set
 * changes, update this list AND the README table together. Do not "fix" them by editing labels.
 */
const KNOWN_MISSED_ESCALATIONS = ["t02", "t08", "t11", "t15", "t16"];
const KNOWN_UNNECESSARY_ESCALATIONS = ["t25"];

describe("policy-only baseline on the labelled set", () => {
  it("has exactly the documented gaps", async () => {
    const report = await evaluateSystem(policyOnlySystem(), dataset);
    assert.deepEqual(report.missedEscalations, KNOWN_MISSED_ESCALATIONS);
    assert.deepEqual(report.unnecessaryEscalations, KNOWN_UNNECESSARY_ESCALATIONS);
  });

  it("catches every explicit safety, legal-threat and injection case", async () => {
    const report = await evaluateSystem(policyOnlySystem(), dataset);
    const caught = (id: string) => report.items.find((r) => r.id === id)!.predictedEscalate;
    for (const id of ["t01", "t03", "t04", "t05", "t06", "t07", "t09", "t10", "t13", "t14", "t17"]) {
      assert.ok(caught(id), `${id} should be escalated`);
    }
  });

  it("escalates repeat contact even though the text alone looks routine", async () => {
    const report = await evaluateSystem(policyOnlySystem(), dataset);
    assert.ok(report.items.find((r) => r.id === "t12")!.predictedEscalate);
  });
});
