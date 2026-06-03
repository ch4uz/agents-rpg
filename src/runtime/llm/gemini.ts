import type {
  LlmClient, LlmCompleteRequest, LlmResponse, LlmStreamCallbacks, ParsedToolUse,
} from './llm-client.js';
import { LlmCallError, LlmAbortedError } from './llm-client.js';
import { sanitizeThinking } from './thinking-sanitizer.js';

/**
 * Gemini implementation of the provider-agnostic {@link LlmClient} seam, a peer
 * of {@link import('./anthropic.js').AnthropicLlmClient}. It targets the Google
 * Gen AI SDK (`@google/genai`, `ai.models.generateContent`).
 *
 * Like the Anthropic client it defines its OWN minimal view of the SDK request
 * / response shapes (`GeminiGenerateParams` / `GeminiSdkResponse`) rather than
 * importing the package's types, so the file has no compile-time dependency on
 * `@google/genai` — the real SDK is wired in lazily by `bin/play.ts` and tests
 * mock the `generate` fn with a plain object. Provider differences vs Anthropic:
 *
 * - **History as text, no tool round-trip.** The prompt builder collapses the
 *   whole conversation into `user`-role text every ReACT step (no assistant /
 *   tool_use / tool_result threading), so we never emit Gemini `functionCall`
 *   parts back into history and `thoughtSignature` is irrelevant here.
 * - **Caching is implicit — and matches on the CONTENTS prefix.** Anthropic
 *   marks segments with `cache_control: ephemeral`; Gemini caches the request
 *   prefix automatically (min 4,096 tokens on 3.5 Flash / 3.1 Pro). The docs'
 *   guidance is "put large and common contents at the BEGINNING of your
 *   prompt" — i.e. the `contents` array; whether `systemInstruction`
 *   participates in prefix matching is undocumented, and live runs that kept
 *   the big stable system band there measured ~0 cache hits. So this client
 *   FOLDS the system band into the FIRST `contents` message (a leading
 *   user-role turn — the text already reads as instructions) and sends no
 *   `systemInstruction` at all. The `PromptSegment.cacheable` flag itself is
 *   ignored on this path — system-band → cached-snapshot → volatile-tail
 *   ORDERING is what earns the implicit-cache hit. We still surface
 *   `cachedContentTokenCount` as `cacheReadTokens` so the manifest's
 *   `cacheHitRatio` keeps working.
 * - **No "exactly one tool" toggle.** Anthropic has `disable_parallel_tool_use`;
 *   Gemini only has function-calling MODE (AUTO/ANY/NONE). We send AUTO and let
 *   the agent's existing ">1 tool call → rule_violation retry" path handle the
 *   rare parallel reply. `allowParallelTools` thus has no direct knob; it is a
 *   no-op here.
 */

export interface GeminiSdkResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        /** True when the part is a thought summary (Gemini's `includeThoughts`). */
        thought?: boolean;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
    /** STOP | MAX_TOKENS | SAFETY | RECITATION | ... */
    finishReason?: string;
  }>;
  usageMetadata?: {
    /** Total prompt tokens — INCLUDES cached tokens. */
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    /** Tokens spent on the model's internal "thoughts" (separate from candidates). */
    thoughtsTokenCount?: number;
  };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  /** Raw JSON Schema passthrough — `@google/genai` accepts the existing tool
   *  `input_schema` here, mutually exclusive with the `Type`-enum `parameters`. */
  parametersJsonSchema: Record<string, unknown>;
}

export interface GeminiGenerateParams {
  model: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  config: {
    systemInstruction?: string;
    maxOutputTokens?: number;
    /** Client-side cancel; the SDK wires it to the underlying fetch. */
    abortSignal?: AbortSignal;
    thinkingConfig?: { includeThoughts: boolean; thinkingBudget?: number };
    tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
    toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE' } };
  };
}

export type GeminiGenerateFn = (params: GeminiGenerateParams) => Promise<GeminiSdkResponse>;

/**
 * Streaming analogue of {@link GeminiGenerateFn}: the SDK's
 * `generateContentStream`, yielding partial {@link GeminiSdkResponse} chunks.
 * Function calls arrive as WHOLE parts within a chunk (Gemini doesn't
 * fragment them); `usageMetadata` is cumulative, last chunk wins.
 */
export type GeminiGenerateStreamFn = (
  params: GeminiGenerateParams,
) => Promise<AsyncIterable<GeminiSdkResponse>> | AsyncIterable<GeminiSdkResponse>;

export interface GeminiLlmClientConfig {
  generate: GeminiGenerateFn;
  /**
   * Optional streaming transport. When present, `completeStream` fires the
   * {@link LlmStreamCallbacks} live; when absent it falls back to the batch
   * `generate` and replays the callbacks at the end (uniform contract — see
   * the Anthropic client).
   */
  generateStream?: GeminiGenerateStreamFn;
  /** Override sleep for tests. Default: setTimeout-backed. */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;        // default 8
  baseDelayMs?: number;       // default 250
  maxDelayMs?: number;        // default 16000
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  // The SDK surfaces HTTP failures as ApiError with a numeric `status`; some
  // transports expose it as `code`. Treat 429 (rate limit) and any 5xx as
  // transient — matches the Anthropic client's policy.
  const status = (e as { status?: number; code?: number }).status
    ?? (e as { code?: number }).code;
  return status === 429 || (typeof status === 'number' && status >= 500);
};

/** Recognise the abort the SDK / fetch surfaces when `abortSignal` fires. */
const isAbortError = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
};

export class GeminiLlmClient implements LlmClient {
  private readonly cfg: Required<Omit<GeminiLlmClientConfig, 'generateStream'>>
    & { generateStream?: GeminiGenerateStreamFn };

  constructor(cfg: GeminiLlmClientConfig) {
    this.cfg = {
      generate: cfg.generate,
      ...(cfg.generateStream ? { generateStream: cfg.generateStream } : {}),
      sleepFn: cfg.sleepFn ?? defaultSleep,
      maxRetries: cfg.maxRetries ?? 8,
      baseDelayMs: cfg.baseDelayMs ?? 250,
      maxDelayMs: cfg.maxDelayMs ?? 16000,
    };
  }

  private buildParams(req: LlmCompleteRequest): GeminiGenerateParams {
    // System band: concatenate every segment and LEAD `contents` with it (see
    // the header comment — implicit caching matches the contents prefix, so
    // the big stable block must sit there, not in `systemInstruction`).
    const systemText = req.system.map((s) => s.text).join('\n\n');

    return {
      model: req.model,
      // contents = [system band] + the builder's messages, mapped 1:1
      // (preserving the cached-snapshot / volatile-tail split so the implicit
      // cache can match the stable prefix). `assistant` would map to `model`,
      // but the builder never emits one.
      contents: [
        ...(systemText.length > 0
          ? [{ role: 'user' as const, parts: [{ text: systemText }] }]
          : []),
        ...req.messages.map((m) => ({
          role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: m.content.map((c) => ({ text: c.text })),
        })),
      ],
      config: {
        maxOutputTokens: req.maxTokens,
        ...(req.thinking && {
          // budgetTokens 0 = "thinking explicitly off" (see LlmCompleteRequest).
          // Gemini models think by default, so off must be SENT as budget 0 —
          // omitting the config would leave dynamic thinking on.
          thinkingConfig: req.thinking.budgetTokens === 0
            ? { includeThoughts: false, thinkingBudget: 0 }
            : {
                includeThoughts: true,
                // Omit thinkingBudget when unset → Gemini chooses automatically.
                ...(req.thinking.budgetTokens !== undefined && { thinkingBudget: req.thinking.budgetTokens }),
              },
        }),
        ...(req.tools.length > 0 && {
          tools: [{
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.input_schema,
            })),
          }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' as const } },
        }),
        ...(req.signal && { abortSignal: req.signal }),
      },
    };
  }

  async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
    const params = this.buildParams(req);

    // Pre-aborted signal: the human interjected before this call began.
    if (req.signal?.aborted) throw new LlmAbortedError();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const resp = await this.cfg.generate(params);
        return this.parseResponse(resp);
      } catch (e) {
        lastErr = e;
        // Interjection mid-flight: bail with a distinct error so the agent
        // unwinds its turn instead of treating it as a transient failure.
        if (req.signal?.aborted || isAbortError(e)) throw new LlmAbortedError();
        if (!isRetryable(e) || attempt === this.cfg.maxRetries) break;
        const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs);
        await this.cfg.sleepFn(delay);
      }
    }
    throw new LlmCallError('persistent Gemini call failure after retries', lastErr);
  }

  /**
   * Streaming variant (see {@link LlmClient.completeStream} and the Anthropic
   * client's doc for the shared contract). Gemini chunks carry WHOLE
   * functionCall parts, so each is applied via `onToolUse` as its chunk
   * arrives; thought-summary parts stream as deltas and are buffered into ONE
   * logical block, flushed (→ `onThinkingBlockDone`) just before the first
   * tool call — preserving thought-before-action order for the event log.
   * Same retry policy: transient errors retried only before the first
   * callback has surfaced anything.
   */
  async completeStream(req: LlmCompleteRequest, cb: LlmStreamCallbacks): Promise<LlmResponse> {
    if (!this.cfg.generateStream) {
      const resp = await this.complete(req);
      for (const t of resp.thinkingBlocks) cb.onThinkingBlockDone?.(t);
      for (const tu of resp.toolUses) await cb.onToolUse?.(tu);
      return resp;
    }
    const params = this.buildParams(req);
    if (req.signal?.aborted) throw new LlmAbortedError();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const surfaced = { value: false };
      try {
        const chunks = await this.cfg.generateStream(params);
        return await this.consumeStream(chunks, cb, surfaced);
      } catch (e) {
        lastErr = e;
        if (req.signal?.aborted || isAbortError(e)) throw new LlmAbortedError();
        if (surfaced.value || !isRetryable(e) || attempt === this.cfg.maxRetries) break;
        const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs);
        await this.cfg.sleepFn(delay);
      }
    }
    throw new LlmCallError('persistent Gemini call failure after retries', lastErr);
  }

  private async consumeStream(
    chunks: AsyncIterable<GeminiSdkResponse>,
    cb: LlmStreamCallbacks,
    surfaced: { value: boolean },
  ): Promise<LlmResponse> {
    const thinkingBlocks: string[] = [];
    const toolUses: ParsedToolUse[] = [];
    let pendingThought = '';
    let finishReason: string | undefined;
    let usageMeta: GeminiSdkResponse['usageMetadata'];

    // Buffered thought fragments become one logical block, sanitized at flush
    // (the leak markers the sanitizer trims can span fragment boundaries).
    const flushThought = (): void => {
      if (pendingThought.length === 0) return;
      const cleaned = sanitizeThinking(pendingThought);
      pendingThought = '';
      if (cleaned) {
        thinkingBlocks.push(cleaned);
        surfaced.value = true;
        cb.onThinkingBlockDone?.(cleaned);
      }
    };

    for await (const chunk of chunks) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought === true && part.text) {
          pendingThought += part.text;
          surfaced.value = true;
          cb.onThinkingDelta?.(part.text);
        } else if (part.functionCall) {
          flushThought();
          const tu: ParsedToolUse = {
            name: part.functionCall.name ?? '',
            input: part.functionCall.args ?? {},
          };
          toolUses.push(tu);
          surfaced.value = true;
          await cb.onToolUse?.(tu);
        }
        // Plain text parts are ignored, same as the batch path.
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      // usageMetadata is cumulative — the last chunk's totals win.
      if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
    }
    flushThought();

    return {
      thinkingBlocks,
      toolUses,
      stopReason: this.mapFinishReason(finishReason, toolUses.length),
      usage: this.mapUsage(usageMeta),
    };
  }

  private parseResponse(resp: GeminiSdkResponse): LlmResponse {
    const candidate = resp.candidates?.[0];
    const thinkingBlocks: string[] = [];
    const toolUses: ParsedToolUse[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought === true && part.text) {
        // Defensive: strip any summarizer meta-leak and drop empty blocks
        // (shared with the Anthropic path).
        const cleaned = sanitizeThinking(part.text);
        if (cleaned) thinkingBlocks.push(cleaned);
      } else if (part.functionCall) {
        toolUses.push({ name: part.functionCall.name ?? '', input: part.functionCall.args ?? {} });
      }
      // Plain (non-thought) text parts are ignored — the agent only consumes
      // thinking blocks + tool calls, same as the Anthropic client.
    }

    return {
      thinkingBlocks,
      toolUses,
      stopReason: this.mapFinishReason(candidate?.finishReason, toolUses.length),
      usage: this.mapUsage(resp.usageMetadata),
    };
  }

  private mapUsage(meta: GeminiSdkResponse['usageMetadata']): LlmResponse['usage'] {
    const u = meta ?? {};
    const cacheReadTokens = u.cachedContentTokenCount ?? 0;
    // promptTokenCount INCLUDES cached tokens; subtract so that
    // `inputTokens + cacheReadTokens === promptTokenCount`, matching how the
    // manifest computes totalInput (and the Anthropic split where input_tokens
    // excludes cache reads).
    const inputTokens = Math.max(0, (u.promptTokenCount ?? 0) - cacheReadTokens);
    // Anthropic's output_tokens includes thinking tokens; mirror that by adding
    // thoughtsTokenCount (Gemini reports it separately from candidates).
    const outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      // Implicit caching exposes no write-cost; explicit CachedContent isn't used.
      cacheWriteTokens: 0,
    };
  }

  private mapFinishReason(
    reason: string | undefined,
    toolCount: number,
  ): LlmResponse['stopReason'] {
    switch (reason) {
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
        return 'refusal';
      // 'STOP', undefined, and anything else: a normal completion. Gemini
      // reports STOP even when it emitted function calls, so disambiguate on
      // whether any tool call came back (the agent expects 'tool_use' then).
      default:
        return toolCount > 0 ? 'tool_use' : 'end_turn';
    }
  }
}
