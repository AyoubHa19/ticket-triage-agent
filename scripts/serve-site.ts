/**
 * Minimal static server for previewing _site/ locally (ES modules do not load from file://).
 * Usage: node scripts/build-site.ts && node scripts/serve-site.ts   (PORT defaults to 4173)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../_site/", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = normalize(join(dir, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(normalize(dir))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res
      .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" })
      .end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`Serving _site/ on http://localhost:${port}`));
