import { mkdirSync, writeFileSync } from "node:fs";
import { anthropicProvider } from "./anthropic.ts";
import { loadDataset } from "./load.ts";
import { renderMarkdown, evaluateSystem } from "./runner.ts";
import type { EvalSystem, SystemReport } from "./runner.ts";
import { Router } from "./router.ts";
import { llmSystem, policyOnlySystem } from "./systems.ts";

/**
 * Usage:
 *   node src/run-eval.ts                      # no-LLM baseline only
 *   ANTHROPIC_API_KEY=... node src/run-eval.ts
 *   EVAL_MODELS='[{"model":"claude-haiku-5-5","inPerMTok":1,"outPerMTok":5}]' ANTHROPIC_API_KEY=... node src/run-eval.ts
 *
 * Prices are never assumed: pass inPerMTok/outPerMTok (USD per million tokens, from the provider's
 * pricing page) to get a cost column; otherwise cost shows as n/a.
 */
interface ModelSpec {
  model: string;
  inPerMTok?: number;
  outPerMTok?: number;
}

const dataset = loadDataset(new URL("../data/tickets.jsonl", import.meta.url));
const systems: EvalSystem[] = [policyOnlySystem()];

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey) {
  const specs = JSON.parse(process.env.EVAL_MODELS ?? '[{"model":"claude-haiku-5-5"},{"model":"claude-sonnet-5-5"}]') as ModelSpec[];
  for (const spec of specs) {
    const pricing =
      spec.inPerMTok !== undefined && spec.outPerMTok !== undefined
        ? { inPerMTok: spec.inPerMTok, outPerMTok: spec.outPerMTok }
        : undefined;
    const provider = anthropicProvider({ apiKey, model: spec.model, ...(pricing ? { pricing } : {}) });
    systems.push(llmSystem(`llm:${spec.model}`, new Router([provider])));
  }
} else {
  console.log("ANTHROPIC_API_KEY is not set: running the no-LLM baseline only.\n");
}

const reports: SystemReport[] = [];
for (const system of systems) reports.push(await evaluateSystem(system, dataset, { concurrency: 4 }));

const markdown = renderMarkdown(reports, dataset);
console.log(markdown);

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(new URL("../results/latest.md", import.meta.url), `${markdown}\n`);
