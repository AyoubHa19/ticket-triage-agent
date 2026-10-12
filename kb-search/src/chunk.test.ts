import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkMarkdown } from "./chunk.ts";

describe("chunkMarkdown", () => {
  it("makes one chunk per section, with the document title and unique ids", () => {
    const chunks = chunkMarkdown({
      id: "doc",
      markdown: "# Title\n\n## One\nText one.\n\n## Two\nText two.\n",
    });
    assert.deepEqual(chunks.map((c) => [c.docTitle, c.heading, c.text]), [
      ["Title", "One", "Text one."],
      ["Title", "Two", "Text two."],
    ]);
    assert.equal(new Set(chunks.map((c) => c.id)).size, 2);
  });

  it("indexes title and heading together with the body", () => {
    const [chunk] = chunkMarkdown({ id: "d", markdown: "# Heating\n\n## Service\nPlease give access." });
    assert.match(chunk!.indexText, /Heating/);
    assert.match(chunk!.indexText, /Service/);
    assert.match(chunk!.indexText, /access/);
  });

  it("keeps text before the first sub-heading under 'Overview' and skips empty sections", () => {
    const chunks = chunkMarkdown({ id: "d", markdown: "# T\nIntro text.\n\n## Empty\n\n## Full\nBody." });
    assert.deepEqual(chunks.map((c) => c.heading), ["Overview", "Full"]);
  });

  it("nests ### sections under their parent heading", () => {
    const chunks = chunkMarkdown({ id: "d", markdown: "# T\n## A\n### B\nText." });
    assert.equal(chunks[0]!.heading, "A > B");
  });

  it("falls back to the doc id when there is no title", () => {
    assert.equal(chunkMarkdown({ id: "fallback", markdown: "## S\nBody." })[0]!.docTitle, "fallback");
  });

  it("splits long sections on paragraph boundaries, with one paragraph of overlap, and loses no text", () => {
    const paragraphs = ["Alpha " + "a".repeat(80), "Beta " + "b".repeat(80), "Gamma " + "c".repeat(80), "Delta " + "d".repeat(80)];
    const chunks = chunkMarkdown({ id: "d", markdown: `# T\n## S\n${paragraphs.join("\n\n")}` }, { maxChars: 200 });

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.heading === "S"));
    for (const p of paragraphs) assert.ok(chunks.some((c) => c.text.includes(p)), `missing: ${p.slice(0, 8)}`);
    const secondOverlapsFirst = paragraphs.some((p) => chunks[0]!.text.includes(p) && chunks[1]!.text.includes(p));
    assert.ok(secondOverlapsFirst, "adjacent chunks share a paragraph");
  });

  it("handles Windows line endings", () => {
    const chunks = chunkMarkdown({ id: "d", markdown: "# T\r\n\r\n## A\r\nBody text.\r\n" });
    assert.equal(chunks[0]!.text, "Body text.");
  });
});
