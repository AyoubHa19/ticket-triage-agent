/**
 * The only thing the agent needs from an LLM. Keeping this interface tiny means the core logic
 * is testable without network access, and the provider (Vercel AI SDK, raw HTTP, ...) is swappable.
 */
export interface GenerateRequest {
  system: string;
  prompt: string;
}

export interface GenerateResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LanguageModel {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Test double: the handler decides what each call returns (or throws). */
export class ScriptedModel implements LanguageModel {
  readonly calls: GenerateRequest[] = [];
  private readonly handler: (req: GenerateRequest, callIndex: number) => string | Promise<string>;

  constructor(handler: (req: GenerateRequest, callIndex: number) => string | Promise<string>) {
    this.handler = handler;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const index = this.calls.length;
    this.calls.push(req);
    const text = await this.handler(req, index);
    return { text };
  }
}
