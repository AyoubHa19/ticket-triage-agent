/**
 * Adapter from the Vercel AI SDK to the tiny `LanguageModel` interface the agent uses.
 *
 * NOTE: this file was written against the AI SDK v5 API but has NOT been executed or type-checked
 * in the environment this project was built in (no npm registry access there). Run
 * `npm install && npm run typecheck` locally; it is excluded from tsconfig.json until then.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { GenerateRequest, GenerateResult, LanguageModel } from "./model.ts";

export function aiSdkModel(modelId: string = process.env.AGENT_MODEL ?? "claude-haiku-5-5"): LanguageModel {
  return {
    async generate({ system, prompt }: GenerateRequest): Promise<GenerateResult> {
      const result = await generateText({
        model: anthropic(modelId),
        system,
        prompt,
        temperature: 0,
        maxRetries: 2,
      });
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  };
}
