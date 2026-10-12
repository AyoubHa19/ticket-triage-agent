import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { KnowledgeIndex } from "./index.ts";
import { loadMarkdownDir } from "./load.ts";
import { SEARCH_TOOL_NAME, createSearchTool } from "./tool.ts";
import type { SearchToolSuccess } from "./tool.ts";

describe("search_knowledge_base tool", () => {
  let index: KnowledgeIndex;
  before(async () => {
    index = await KnowledgeIndex.build(loadMarkdownDir(new URL("../docs/", import.meta.url)));
  });

  it("declares a JSON Schema the model can follow", () => {
    const tool = createSearchTool(index);
    assert.equal(tool.name, SEARCH_TOOL_NAME);
    assert.deepEqual(tool.inputSchema.required, ["query"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.max_results.maximum, 5);
  });

  it("returns cited, relevance-scored results for an answerable question", async () => {
    const out = (await createSearchTool(index).execute({ query: "Can I have a barbecue on the balcony?" })) as SearchToolSuccess;
    assert.equal(out.note, undefined);
    assert.equal(out.results[0]!.source, "House rules > Balconies and barbecues");
    assert.match(out.results[0]!.text, /Charcoal/);
    assert.ok(out.results.length <= 3);
  });

  it("honours max_results", async () => {
    const out = (await createSearchTool(index).execute({ query: "heating", max_results: 1 })) as SearchToolSuccess;
    assert.equal(out.results.length, 1);
  });

  it("returns no results and an explicit instruction when nothing relevant exists", async () => {
    const out = (await createSearchTool(index).execute({ query: "Recipe for cheesecake" })) as SearchToolSuccess;
    assert.deepEqual(out.results, []);
    assert.match(out.note ?? "", /Do not answer from general knowledge/);
  });

  it("applies a configurable relevance threshold", async () => {
    const strict = createSearchTool(index, { minRelevance: 0.99 });
    const out = (await strict.execute({ query: "When is the technician coming for the heating service?" })) as SearchToolSuccess;
    assert.deepEqual(out.results, []);
  });

  it("reports invalid input as data instead of throwing, so the model can correct itself", async () => {
    const tool = createSearchTool(index);
    const bad: unknown[] = [null, "text", {}, { query: "" }, { query: "   " }, { query: 5 }, { query: "x".repeat(501) },
      { query: "ok", max_results: 0 }, { query: "ok", max_results: 99 }, { query: "ok", max_results: "3" }];
    for (const input of bad) {
      const out = await tool.execute(input);
      assert.ok("error" in out, `expected an error for ${JSON.stringify(input)}`);
    }
  });
});
