import type {
  LlmClient,
  LlmCompleteRequest,
  LlmResponse,
  ParsedToolUse,
} from './llm-client.js';

export interface ScriptedMatch {
  /** Subset of request fields to match. Any field listed must equal the corresponding request field. */
  model?: string;
  /** Free-form tag passed via the request (e.g. ScriptedLlmClient lets callers attach `tag`). */
  tag?: string;
}

export interface ScriptedEntry {
  match: ScriptedMatch;
  response: Partial<LlmResponse> & { toolUses: ParsedToolUse[] };
}

/**
 * Deterministic FIFO matcher. Each complete() call pops the first matching entry.
 * Callers can attach an optional `tag` field to the request for fine-grained matching.
 */
export class ScriptedLlmClient implements LlmClient {
  private entries: ScriptedEntry[];
  /** Total calls served, for diagnostics. */
  callsServed = 0;

  constructor(entries: ScriptedEntry[]) {
    this.entries = [...entries];
  }

  remaining(): number {
    return this.entries.length;
  }

  async complete(req: LlmCompleteRequest & { tag?: string }): Promise<LlmResponse> {
    const idx = this.entries.findIndex((e) => this.matches(e.match, req));
    if (idx === -1) {
      throw new Error(
        `no scripted response matched request (model=${req.model}, tag=${req.tag ?? 'none'}, ${this.entries.length} entries left)`,
      );
    }
    const entry = this.entries.splice(idx, 1)[0]!;
    this.callsServed += 1;
    return {
      thinkingBlocks: entry.response.thinkingBlocks ?? [],
      toolUses: entry.response.toolUses,
      stopReason: entry.response.stopReason ?? 'tool_use',
      usage: entry.response.usage ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    };
  }

  private matches(m: ScriptedMatch, req: LlmCompleteRequest & { tag?: string }): boolean {
    if (m.model !== undefined && m.model !== req.model) return false;
    if (m.tag !== undefined && m.tag !== req.tag) return false;
    return true;
  }
}
