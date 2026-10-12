import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceDoc } from "./chunk.ts";

/** Node-only loader, kept out of index.ts so the retrieval core also runs in a browser. */
export function loadMarkdownDir(dir: string | URL): SourceDoc[] {
  const path = typeof dir === "string" ? dir : fileURLToPath(dir);
  return readdirSync(path)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ id: basename(f, ".md"), markdown: readFileSync(join(path, f), "utf8") }));
}
