import type {
  LlmClient, LlmCompleteRequest, LlmResponse, LlmStreamCallbacks, ParsedToolUse, ToolSchema,
} from './llm-client.js';
import { LlmCallError, LlmAbortedError } from './llm-client.js';
import { sanitizeThinking } from './thinking-sanitizer.js';

export interface AnthropicSdkResponse {
  content: Array<
    | { type: 'thinking'; thinking: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicCreateArgs {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{
    role: 'user' | 'assistant';
    content: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  }>;
  tools?: ToolSchema[];
  /**
   * When `disable_parallel_tool_use` is true the model emits exactly one tool
   * call per response — the default for our ReACT main loop. Callers can flip
   * it to false via `allowParallelTools` on the request when they need
   * multi-tool replies in a single round-trip. (audit F22)
   */
  tool_choice?: { type: 'auto'; disable_parallel_tool_use: boolean };
  thinking?: { type: 'enabled'; budget_tokens?: number };
}

/**
 * `options` carries the per-call request options the Anthropic SDK accepts as
 * its second argument — currently just an `AbortSignal` so an interjection can
 * cancel the in-flight HTTP request. bin/play.ts forwards it to
 * `sdk.messages.create(body, options)`. Optional + back-compatible: existing
 * test doubles that take only `args` keep working.
 */
export type AnthropicCreateFn = (
  args: AnthropicCreateArgs,
  options?: { signal?: AbortSignal },
) => Promise<AnthropicSdkResponse>;

/**
 * Minimal view of the SDK's raw streaming events (`messages.create` with
 * `stream: true`). Only the fields this client reads are modeled; unknown
 * event types are ignored, so SDK additions don't break parsing.
 */
export type AnthropicStreamEvent =
  | { type: 'message_start'; message?: { usage?: Partial<AnthropicSdkResponse['usage']> } }
  | { type: 'content_block_start'; index: number;
      content_block: { type: 'thinking' | 'text' | 'tool_use'; name?: string; id?: string } }
  | { type: 'content_block_delta'; index: number;
      delta:
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: Partial<AnthropicSdkResponse['usage']>;
      delta?: { stop_reason?: AnthropicSdkResponse['stop_reason'] } }
  | { type: 'message_stop' };

/** Streaming analogue of {@link AnthropicCreateFn}: the SDK call with
 *  `stream: true`, yielding raw SSE events. */
export type AnthropicStreamFn = (
  args: AnthropicCreateArgs,
  options?: { signal?: AbortSignal },
) => Promise<AsyncIterable<AnthropicStreamEvent>> | AsyncIterable<AnthropicStreamEvent>;

export interface AnthropicLlmClientConfig {
  create: AnthropicCreateFn;
  /**
   * Optional streaming transport (the SDK call with `stream: true`). When
   * present, `completeStream` parses the event stream and fires the
   * {@link LlmStreamCallbacks} live; when absent, `completeStream` quietly
   * falls back to the batch `create` (callbacks fire once at the end), so
   * callers never need to feature-detect.
   */
  stream?: AnthropicStreamFn;
  /** Override sleep for tests. Default: setTimeout-backed. */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;        // default 5
  baseDelayMs?: number;       // default 250
  maxDelayMs?: number;        // default 4000
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const status = (e as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
};

/** Recognise the abort the SDK / fetch surfaces when the request's AbortSignal
 *  fires. The Anthropic SDK throws `APIUserAbortError`; the underlying fetch
 *  throws a DOMException/Error named `AbortError`. Match either by name. */
const isAbortError = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
};

export class AnthropicLlmClient implements LlmClient {
  private readonly cfg: Required<Omit<AnthropicLlmClientConfig, 'stream'>>
    & { stream?: AnthropicStreamFn };

  constructor(cfg: AnthropicLlmClientConfig) {
    this.cfg = {
      create: cfg.create,
      ...(cfg.stream ? { stream: cfg.stream } : {}),
      sleepFn: cfg.sleepFn ?? defaultSleep,
      // 8 retries × backoff 0.25→16s sums to ~50s — long enough to ride out a
      // 529 Overloaded burst from Anthropic without giving up the run.
      maxRetries: cfg.maxRetries ?? 8,
      baseDelayMs: cfg.baseDelayMs ?? 250,
      maxDelayMs: cfg.maxDelayMs ?? 16000,
    };
  }

  private buildArgs(req: LlmCompleteRequest): AnthropicCreateArgs {
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system.map((s) => s.cacheable
        ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: s.text },
      ),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((c) => c.cacheable
          ? { type: 'text', text: c.text, cache_control: { type: 'ephemeral' } }
          : { type: 'text', text: c.text },
        ),
      })),
      ...(req.tools.length > 0 && {
        tools: req.tools,
        tool_choice: {
          type: 'auto' as const,
          disable_parallel_tool_use: !req.allowParallelTools,
        },
      }),
      // budgetTokens 0 = "thinking explicitly off" (see LlmCompleteRequest):
      // the API minimum is 1024, so off is expressed by omitting the block.
      ...(req.thinking && req.thinking.budgetTokens !== 0
        && { thinking: { type: 'enabled' as const, budget_tokens: req.thinking.budgetTokens ?? 2048 } }),
    };
  }

  async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
    const args = this.buildArgs(req);

    // A pre-aborted signal short-circuits before we even hit the network: the
    // human interjected before this call started, so there's nothing to wait on.
    if (req.signal?.aborted) throw new LlmAbortedError();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const resp = await this.cfg.create(args, req.signal ? { signal: req.signal } : undefined);
        return this.parseResponse(resp);
      } catch (e) {
        lastErr = e;
        // An interjection fired mid-flight: bail immediately (no retry) with a
        // distinct error so the agent unwinds its turn instead of treating it
        // as a transient network failure. Covers both "signal flipped during
        // the call" and SDK-surfaced abort errors.
        if (req.signal?.aborted || isAbortError(e)) throw new LlmAbortedError();
        if (!isRetryable(e) || attempt === this.cfg.maxRetries) break;
        const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs);
        await this.cfg.sleepFn(delay);
      }
    }
    throw new LlmCallError('persistent LLM call failure after retries', lastErr);
  }

  /**
   * Streaming variant of `complete()` (see {@link LlmClient.completeStream}).
   * With a `stream` transport wired, parses the raw SSE events and fires the
   * callbacks LIVE: thinking deltas as they generate, each tool call the
   * moment its input JSON completes (awaited — a slow consumer backpressures
   * the iterator, so apply order is guaranteed). Without one, falls back to
   * the batch `complete()` and replays the callbacks once at the end, so the
   * caller's streamed-apply logic runs uniformly either way.
   *
   * RETRY POLICY: a transient failure is retried only while NOTHING has been
   * surfaced to the caller — once any callback fired, the caller may have
   * applied an action or logged a thought, and a wholesale retry would
   * double-apply. After first contact, errors propagate immediately.
   */
  async completeStream(req: LlmCompleteRequest, cb: LlmStreamCallbacks): Promise<LlmResponse> {
    if (!this.cfg.stream) {
      const resp = await this.complete(req);
      for (const t of resp.thinkingBlocks) cb.onThinkingBlockDone?.(t);
      for (const tu of resp.toolUses) await cb.onToolUse?.(tu);
      return resp;
    }
    const args = this.buildArgs(req);
    if (req.signal?.aborted) throw new LlmAbortedError();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const surfaced = { value: false };
      try {
        const events = await this.cfg.stream(args, req.signal ? { signal: req.signal } : undefined);
        return await this.consumeStream(events, cb, surfaced);
      } catch (e) {
        lastErr = e;
        if (req.signal?.aborted || isAbortError(e)) throw new LlmAbortedError();
        if (surfaced.value || !isRetryable(e) || attempt === this.cfg.maxRetries) break;
        const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs);
        await this.cfg.sleepFn(delay);
      }
    }
    throw new LlmCallError('persistent LLM call failure after retries', lastErr);
  }

  /** Drain the SSE event stream, firing callbacks and assembling the final
   *  LlmResponse. `surfaced.value` flips before the first callback so the
   *  retry loop knows the caller has seen content. */
  private async consumeStream(
    events: AsyncIterable<AnthropicStreamEvent>,
    cb: LlmStreamCallbacks,
    surfaced: { value: boolean },
  ): Promise<LlmResponse> {
    const thinkingBlocks: string[] = [];
    const toolUses: ParsedToolUse[] = [];
    /** In-flight content blocks, keyed by stream index. */
    const open = new Map<number, { kind: string; name?: string; text: string; json: string }>();
    let stopReason: AnthropicSdkResponse['stop_reason'] = 'end_turn';
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    // Merge a partial usage payload, skipping undefined fields (message_start
    // carries the input/cache side; message_delta carries output_tokens).
    const mergeUsage = (u?: Partial<AnthropicSdkResponse['usage']>): void => {
      if (!u) return;
      for (const k of Object.keys(usage) as Array<keyof typeof usage>) {
        const v = u[k];
        if (typeof v === 'number') usage[k] = v;
      }
    };

    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start':
          mergeUsage(ev.message?.usage);
          break;
        case 'content_block_start':
          open.set(ev.index, {
            kind: ev.content_block.type, text: '', json: '',
            ...(ev.content_block.name !== undefined ? { name: ev.content_block.name } : {}),
          });
          break;
        case 'content_block_delta': {
          const blk = open.get(ev.index);
          if (!blk) break;
          if (ev.delta.type === 'thinking_delta') {
            blk.text += ev.delta.thinking;
            surfaced.value = true;
            cb.onThinkingDelta?.(ev.delta.thinking);
          } else if (ev.delta.type === 'input_json_delta') {
            blk.json += ev.delta.partial_json;
          } else if (ev.delta.type === 'text_delta') {
            blk.text += ev.delta.text;
          }
          break;
        }
        case 'content_block_stop': {
          const blk = open.get(ev.index);
          if (!blk) break;
          open.delete(ev.index);
          if (blk.kind === 'thinking') {
            const cleaned = sanitizeThinking(blk.text);
            if (cleaned) {
              thinkingBlocks.push(cleaned);
              surfaced.value = true;
              cb.onThinkingBlockDone?.(cleaned);
            }
          } else if (blk.kind === 'tool_use') {
            let input: Record<string, unknown> = {};
            if (blk.json.trim().length > 0) {
              try { input = JSON.parse(blk.json) as Record<string, unknown>; } catch { input = {}; }
            }
            const tu: ParsedToolUse = { name: blk.name ?? '', input };
            toolUses.push(tu);
            surfaced.value = true;
            await cb.onToolUse?.(tu);
          }
          break;
        }
        case 'message_delta':
          mergeUsage(ev.usage);
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          break;
        // message_stop / unknown events: nothing to do.
      }
    }

    return {
      thinkingBlocks,
      toolUses,
      stopReason: stopReason === 'stop_sequence' ? 'end_turn' : stopReason,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
      },
    };
  }

  private parseResponse(resp: AnthropicSdkResponse): LlmResponse {
    const thinkingBlocks: string[] = [];
    const toolUses: ParsedToolUse[] = [];
    for (const block of resp.content) {
      if (block.type === 'thinking') {
        // Strip thinking-summarizer meta-leaks before surfacing as a `thought`;
        // drop the block entirely if nothing genuine remains.
        const cleaned = sanitizeThinking(block.thinking);
        if (cleaned) thinkingBlocks.push(cleaned);
      } else if (block.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
    }
    return {
      thinkingBlocks,
      toolUses,
      stopReason: resp.stop_reason === 'stop_sequence' ? 'end_turn' : resp.stop_reason,
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
