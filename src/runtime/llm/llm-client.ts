/**
 * Provider-agnostic LLM seam. Two implementations: AnthropicLlmClient (real
 * network) and ScriptedLlmClient (deterministic test double). The orchestrator
 * and agents only see this interface.
 */

export interface PromptSegment {
  text: string;
  /** When true, the implementation marks this segment with cache_control: ephemeral. */
  cacheable: boolean;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  /** A list of content blocks. We use text-only blocks; tool_use blocks come back in the response. */
  content: Array<{ type: 'text'; text: string; cacheable?: boolean }>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;        // JSON Schema for the tool's input
}

export interface ParsedToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  thinkingBlocks: string[];
  toolUses: ParsedToolUse[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: LlmUsage;
}

export interface LlmCompleteRequest {
  system: PromptSegment[];
  messages: AnthropicMessage[];
  tools: ToolSchema[];
  /**
   * Extended-thinking control. `budgetTokens: 0` means EXPLICITLY DISABLE
   * thinking — the Anthropic client omits the `thinking` block entirely (its
   * API minimum is 1024, so 0 can't be sent literally) and the Gemini client
   * sends `thinkingBudget: 0` (Gemini models think by default, so omission is
   * NOT off there). Light banter calls (off-turn reactions, OOC replies, DM
   * outcome reacts) use 0: thinking tokens dominate their latency and a
   * one-line quip doesn't need a plan.
   */
  thinking?: { type: 'enabled'; budgetTokens?: number };
  model: string;
  maxTokens: number;
  /**
   * When true, allow the model to emit multiple tool calls in a single response.
   * Defaults to false (the ReACT main loop applies one tool per step). Reserved
   * for call sites that need multi-tool replies in a single round-trip; the
   * anthropic client maps it to `disable_parallel_tool_use = !allowParallelTools`.
   */
  allowParallelTools?: boolean;
  /**
   * Optional cancellation signal. When the human interjects off-turn (sends
   * text "to Game" / "to DM" while another agent or the DM is generating), the
   * orchestrator fires a per-turn AbortController so the in-flight LLM call is
   * cancelled rather than wasted. AnthropicLlmClient forwards it to the SDK and
   * throws `LlmAbortedError` (no retry) the moment it fires; the agent unwinds
   * its ReACT loop and the orchestrator re-dispatches the actor's turn (now with
   * the human's message in history). ScriptedLlmClient ignores it — tests never
   * interject, so behaviour is unchanged.
   */
  signal?: AbortSignal;
}

/**
 * Callbacks for the optional streaming variant of an LLM call. All are
 * optional; the stream is fully consumed regardless and the assembled
 * {@link LlmResponse} is still returned at the end (same contract as
 * `complete()`), so callers can mix streamed side-effects with the existing
 * post-response logic.
 */
export interface LlmStreamCallbacks {
  /** Incremental thinking text, in generation order. Raw (un-sanitized) —
   *  meant for live UI display only, never for the event log. */
  onThinkingDelta?(text: string): void;
  /**
   * A thinking block COMPLETED. `text` is the full block. Fired before any
   * tool call streams in (providers emit thinking before tool use), so the
   * caller can emit the atomic `thought` event ahead of the actions it led
   * to — preserving log order.
   */
  onThinkingBlockDone?(text: string): void;
  /**
   * A tool call COMPLETED in the stream (name + fully parsed input). AWAITED
   * by the client before pulling further events, so a slow consumer (dice
   * round-trip, beat gate) naturally backpressures the iterator — ordering of
   * applied actions is guaranteed. The same tool call is ALSO present in the
   * returned LlmResponse.toolUses; callers that apply on-stream must track
   * how many they already consumed.
   */
  onToolUse?(tu: ParsedToolUse): Promise<void> | void;
}

export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<LlmResponse>;
  /**
   * Optional streaming variant: same request/response contract as
   * `complete()`, but fires {@link LlmStreamCallbacks} as content arrives so
   * the game can update live while the model is still generating. Implemented
   * by the real providers (falling back internally to `complete()` when no
   * underlying stream transport is wired); absent on ScriptedLlmClient, so
   * tests keep batch semantics.
   */
  completeStream?(req: LlmCompleteRequest, cb: LlmStreamCallbacks): Promise<LlmResponse>;
}

export class LlmCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LlmCallError';
  }
}

/**
 * Thrown when an in-flight LLM call is cancelled via `LlmCompleteRequest.signal`
 * (a human interjection). Distinct from `LlmCallError` so the agent can tell an
 * intentional interrupt apart from a genuine network failure and unwind its turn
 * cleanly instead of emitting a rule_violation / budget-exhausted fallback.
 */
export class LlmAbortedError extends Error {
  constructor() {
    super('LLM call aborted by interjection');
    this.name = 'LlmAbortedError';
  }
}
