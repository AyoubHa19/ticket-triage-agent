import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDataset } from "./dataset.ts";
import type { DatasetItem } from "./dataset.ts";
import { evaluateSystem, renderMarkdown } from "./runner.ts";
import type { EvalSystem } from "./runner.ts";

function item(id: string, over: Partial<DatasetItem> = {}): DatasetItem {
  return {
    id,
    subject: `subject ${id}`,
    body: "body",
    senderRole: "tenant",
    previousContacts: 0,
    category: "general",
    shouldEscalate: false,
    ...over,
  };
}

const dataset = [
  item("a", { category: "damage", shouldEscalate: true }),
  item("b", { category: "damage", shouldEscalate: true }),
  item("c", { category: "keys", shouldEscalate: false }),
  item("d", { category: "keys", shouldEscalate: false }),
];

describe("evaluateSystem", () => {
  it("scores categories and escalation, lists the misses, and sums cost", async () => {
    const system: EvalSystem = {
      name: "fake",
      async predict(i) {
        // a: right on both. b: category right but escalation missed. c: unnecessary escalation. d: wrong category.
        const table: Record<string, { category: string; escalate: boolean }> = {
          a: { category: "damage", escalate: true },
          b: { category: "damage", escalate: false },
          c: { category: "keys", escalate: true },
          d: { category: "general", escalate: false },
        };
        return { ...table[i.id]!, costUsd: 0.001 };
      },
    };
    const report = await evaluateSystem(system, dataset);

    assert.equal(report.categoryAccuracy, 3 / 4);
    assert.deepEqual(report.missedEscalations, ["b"]);
    assert.deepEqual(report.unnecessaryEscalations, ["c"]);
    assert.equal(report.escalation.recall, 0.5);
    assert.equal(report.escalation.precision, 0.5);
    assert.ok(Math.abs((report.totalCostUsd ?? 0) - 0.004) < 1e-12);
    assert.ok(Math.abs((report.costPer1kTickets ?? 0) - 1) < 1e-9);
  });

  it("scores a throwing system fail-safe (escalate) and counts the errors", async () => {
    const system: EvalSystem = {
      name: "broken",
      async predict(i) {
        if (i.id === "b") throw new Error("provider down");
        return { category: i.category, escalate: i.shouldEscalate };
      },
    };
    const report = await evaluateSystem(system, dataset);

    assert.equal(report.errors, 1);
    const b = report.items.find((r) => r.id === "b")!;
    assert.equal(b.predictedEscalate, true);
    assert.equal(b.predictedCategory, "error");
    assert.equal(b.error, "provider down");
    assert.equal(report.categoryAccuracy, 3 / 4);
    assert.deepEqual(report.missedEscalations, []);
  });

  it("keeps results in dataset order under concurrency and measures latency with the injected clock", async () => {
    let tick = 0;
    const system: EvalSystem = {
      name: "slow-ish",
      async predict(i) {
        await new Promise((r) => setTimeout(r, i.id === "a" ? 15 : 1));
        return { category: i.category, escalate: i.shouldEscalate };
      },
    };
    const report = await evaluateSystem(system, dataset, { concurrency: 4, now: () => (tick += 10) });

    assert.deepEqual(report.items.map((r) => r.id), ["a", "b", "c", "d"]);
    assert.ok(report.items.every((r) => r.latencyMs > 0));
    assert.equal(report.totalCostUsd, null, "no cost info => null, not 0");
    assert.equal(report.costPer1kTickets, null);
  });
});

describe("renderMarkdown", () => {
  it("renders a table row and the named misses", async () => {
    const system: EvalSystem = { name: "fake", async predict() { return { category: "keys", escalate: false }; } };
    const report = await evaluateSystem(system, dataset);
    const md = renderMarkdown([report], dataset);

    assert.match(md, /\| fake \| 50\.0% \| 0\.0% \|/);
    assert.match(md, /- a: subject a/);
    assert.match(md, /\$\/1k tickets/);
    assert.match(md, /n\/a/);
  });
});

describe("parseDataset", () => {
  const valid = JSON.stringify({
    id: "x", subject: "s", body: "b", senderRole: "tenant", previousContacts: 0,
    category: "keys", shouldEscalate: false,
  });

  it("accepts a valid line and ignores blank lines", () => {
    assert.equal(parseDataset(`${valid}\n\n`).length, 1);
  });

  it("rejects bad input with the line number", () => {
    assert.throws(() => parseDataset("{nope"), /line 1: invalid JSON/);
    assert.throws(() => parseDataset(valid.replace('"keys"', '"pizza"')), /unknown category/);
    assert.throws(() => parseDataset(valid.replace("false", '"no"')), /shouldEscalate must be boolean/);
    assert.throws(() => parseDataset(`${valid}\n${valid}`), /line 2: duplicate id x/);
    assert.throws(() => parseDataset(valid.replace('"previousContacts":0', '"previousContacts":-1')), /previousContacts/);
  });
});
