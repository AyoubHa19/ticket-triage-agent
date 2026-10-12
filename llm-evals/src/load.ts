import { readFileSync } from "node:fs";
import { parseDataset } from "./dataset.ts";
import type { DatasetItem } from "./dataset.ts";

/** Node-only loader, kept out of dataset.ts so the eval core also runs in a browser. */
export function loadDataset(path: string | URL): DatasetItem[] {
  return parseDataset(readFileSync(path, "utf8"));
}
