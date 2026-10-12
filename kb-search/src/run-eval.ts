import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateRetrieval, renderRetrievalMarkdown } from "./eval.ts";
import type { EvalQuery } from "./eval.ts";
import { KnowledgeIndex } from "./index.ts";
import { loadMarkdownDir } from "./load.ts";

const index = await KnowledgeIndex.build(loadMarkdownDir(new URL("../docs/", import.meta.url)));
const queries = JSON.parse(readFileSync(new URL("../data/queries.json", import.meta.url), "utf8")) as EvalQuery[];

const markdown = [
  `Knowledge base: ${index.chunks.length} chunks from ${new Set(index.chunks.map((c) => c.docId)).size} documents.`,
  renderRetrievalMarkdown(await evaluateRetrieval(index, queries)),
].join("\n\n");

console.log(markdown);
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(new URL("../results/latest.md", import.meta.url), `${markdown}\n`);
