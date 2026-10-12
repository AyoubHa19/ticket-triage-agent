import type { KnowledgeIndex } from "./index.ts";

/**
 * The knowledge base as an agent tool. Written as a plain object (name, description, JSON Schema,
 * execute) so it maps 1:1 onto any tool-calling API; wrapping it for the Vercel AI SDK or the raw
 * Anthropic API is a few lines.
 *
 * Tool-design choices:
 *  - Never throws on bad input: it returns { error } so the model can read it and retry.
 *  - When nothing relevant is found it returns NO results plus an explicit instruction, instead of
 *    handing the model weak snippets it might build a confident-sounding answer from.
 *  - Each result carries a human-readable `source`, which the agent can cite or show to a person.
 */

export interface SearchToolOptions {
  /** Best-hit relevance below this means "no answer in the knowledge base". Retriever-specific: calibrate it. */
  minRelevance?: number;
  maxResultsCap?: number;
}

export interface SearchToolSuccess {
  results: { source: string; text: string; relevance: number }[];
  note?: string;
}

export interface SearchToolError {
  error: string;
}

export const SEARCH_TOOL_NAME = "search_knowledge_base";

export function createSearchTool(index: KnowledgeIndex, options: SearchToolOptions = {}) {
  const minRelevance = options.minRelevance ?? 0.25;
  const cap = options.maxResultsCap ?? 5;

  return {
    name: SEARCH_TOOL_NAME,
    description:
      "Search the company knowledge base (house rules, procedures, FAQs). Use it before answering any " +
      "question about how the property management works. Write the query as a short natural-language " +
      "question or key phrase in the language of the question.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'heating service appointment'." },
        max_results: { type: "integer", minimum: 1, maximum: cap, description: "How many articles to return (default 3)." },
      },
      required: ["query"],
      additionalProperties: false,
    },

    async execute(input: unknown): Promise<SearchToolSuccess | SearchToolError> {
      if (typeof input !== "object" || input === null) return { error: "Input must be an object with a 'query' string." };
      const { query, max_results } = input as { query?: unknown; max_results?: unknown };

      if (typeof query !== "string" || query.trim() === "") return { error: "'query' must be a non-empty string." };
      if (query.length > 500) return { error: "'query' is too long (max 500 characters). Use a shorter query." };
      if (max_results !== undefined && (!Number.isInteger(max_results) || (max_results as number) < 1 || (max_results as number) > cap)) {
        return { error: `'max_results' must be an integer between 1 and ${cap}.` };
      }

      const hits = await index.search(query, { k: (max_results as number | undefined) ?? 3 });
      const best = hits[0]?.relevance ?? 0;
      if (best < minRelevance) {
        return {
          results: [],
          note:
            "No sufficiently relevant article found. Do not answer from general knowledge: tell the person " +
            "that you will pass the question to a colleague.",
        };
      }
      return {
        results: hits.map((h) => ({ source: `${h.docTitle} > ${h.heading}`, text: h.text, relevance: Number(h.relevance.toFixed(2)) })),
      };
    },
  };
}
