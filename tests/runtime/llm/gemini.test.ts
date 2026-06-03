import { describe, it, expect, vi } from 'vitest';
import {
  GeminiLlmClient,
  type GeminiGenerateFn,
  type GeminiGenerateParams,
  type GeminiSdkResponse,
} from '../../../src/runtime/llm/gemini.js';
import { LlmAbortedError } from '../../../src/runtime/llm/llm-client.js';

const okResponse = (
  toolName = 'narrate',
  args: Record<string, unknown> = { text: 'hi' },
): GeminiSdkResponse => ({
  candidates: [{
    content: { parts: [
      { thought: true, text: 'plan thoughts' },
      { functionCall: { name: toolName, args } },
    ] },
    finishReason: 'STOP',
  }],
  usageMetadata: {
    promptTokenCount: 180,         // includes the 80 cached → input maps to 100
    candidatesTokenCount: 25,
    thoughtsTokenCount: 5,         // output maps to 25 + 5 = 30
    cachedContentTokenCount: 80,
  },
});

const minimalReq = () => ({
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi', cacheable: false }] }],
  tools: [],
  model: 'gemini-2.5-flash',
  maxTokens: 1024,
});

const reqWithTools = () => ({
  ...minimalReq(),
  thinking: { type: 'enabled' as const },
  tools: [{ name: 'narrate', description: 'd', input_schema: { type: 'object', properties: {} } }],
});

describe('GeminiLlmClient', () => {
  it('parses thought parts + functionCall and maps usage (cached split + thoughts in output)', async () => {
    const generate = vi.fn().mockResolvedValue(okResponse()) as unknown as GeminiGenerateFn;
    const client = new GeminiLlmClient({ generate });

    const r = await client.complete(minimalReq());
    expect(r.thinkingBlocks).toEqual(['plan thoughts']);
    expect(r.toolUses).toEqual([{ name: 'narrate', input: { text: 'hi' } }]);
    expect(r.stopReason).toBe('tool_use'); // STOP + a function call → tool_use
    expect(r.usage).toEqual({
      inputTokens: 100,        // promptTokenCount(180) - cached(80)
      outputTokens: 30,        // candidates(25) + thoughts(5)
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    });
  });

  it('LEADS contents with the system band (no systemInstruction) and maps tools to functionDeclarations w/ raw JSON schema', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });

    await client.complete({
      ...reqWithTools(),
      system: [{ text: 'sys-a', cacheable: true }, { text: 'sys-b', cacheable: false }],
      tools: [{ name: 'attack', description: 'hit', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    });

    const p = captured[0]!;
    // Implicit caching matches the CONTENTS prefix (and systemInstruction's
    // participation is undocumented), so the big stable system band must be
    // the FIRST contents message — not a systemInstruction.
    expect(p.config.systemInstruction).toBeUndefined();
    expect(p.contents[0]).toEqual({ role: 'user', parts: [{ text: 'sys-a\n\nsys-b' }] });
    expect(p.config.maxOutputTokens).toBe(1024);
    expect(p.config.thinkingConfig).toEqual({ includeThoughts: true });
    expect(p.config.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(p.config.tools![0]!.functionDeclarations[0]).toEqual({
      name: 'attack',
      description: 'hit',
      parametersJsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    // No thinking budget set → thinkingBudget omitted (Gemini auto-budgets).
    expect(p.config.thinkingConfig!.thinkingBudget).toBeUndefined();
  });

  it('maps user messages to user-role contents after the system band, and omits tools when none', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });
    await client.complete(minimalReq());
    const p = captured[0]!;
    expect(p.contents).toEqual([
      { role: 'user', parts: [{ text: 'sys' }] },
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    expect(p.config.tools).toBeUndefined();
    expect(p.config.toolConfig).toBeUndefined();
  });

  it('omits the leading system message when the system band is empty', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });
    await client.complete({ ...minimalReq(), system: [] });
    expect(captured[0]!.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('forwards the thinkingBudget when supplied', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });
    await client.complete({ ...minimalReq(), thinking: { type: 'enabled', budgetTokens: 4096 } });
    expect(captured[0]!.config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 4096 });
  });

  it('budgetTokens 0 SENDS thinkingBudget 0 (Gemini thinks by default; omission ≠ off)', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });
    await client.complete({ ...minimalReq(), thinking: { type: 'enabled', budgetTokens: 0 } });
    expect(captured[0]!.config.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 });
  });

  it('retries on 429 with exponential backoff', async () => {
    let calls = 0;
    const generate: GeminiGenerateFn = async () => {
      calls += 1;
      if (calls < 3) {
        const e: Error & { status?: number } = new Error('rate limited');
        e.status = 429;
        throw e;
      }
      return okResponse();
    };
    const client = new GeminiLlmClient({ generate, sleepFn: () => Promise.resolve() });
    const r = await client.complete(minimalReq());
    expect(r.toolUses).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('retries on a 5xx surfaced via `code` then throws LlmCallError when persistent', async () => {
    const generate: GeminiGenerateFn = async () => {
      const e: Error & { code?: number } = new Error('server error'); e.code = 503;
      throw e;
    };
    const client = new GeminiLlmClient({ generate, sleepFn: () => Promise.resolve() });
    await expect(client.complete(minimalReq())).rejects.toThrow(/persistent/i);
  });

  it('forwards the AbortSignal into config.abortSignal', async () => {
    const captured: GeminiGenerateParams[] = [];
    const generate: GeminiGenerateFn = async (params) => { captured.push(params); return okResponse(); };
    const client = new GeminiLlmClient({ generate });
    const ac = new AbortController();
    await client.complete({ ...minimalReq(), signal: ac.signal });
    expect(captured[0]!.config.abortSignal).toBe(ac.signal);
  });

  it('throws LlmAbortedError (no SDK call) when the signal is already aborted', async () => {
    const generate = vi.fn().mockResolvedValue(okResponse()) as unknown as GeminiGenerateFn;
    const client = new GeminiLlmClient({ generate });
    const ac = new AbortController();
    ac.abort();
    await expect(client.complete({ ...minimalReq(), signal: ac.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect((generate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('throws LlmAbortedError WITHOUT retrying when an abort fires mid-call', async () => {
    let calls = 0;
    const ac = new AbortController();
    const generate: GeminiGenerateFn = async () => {
      calls += 1;
      ac.abort();
      const e: Error & { name: string } = new Error('aborted'); e.name = 'AbortError';
      throw e;
    };
    const client = new GeminiLlmClient({ generate, sleepFn: () => Promise.resolve() });
    await expect(client.complete({ ...minimalReq(), signal: ac.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect(calls).toBe(1);
  });

  it('maps MAX_TOKENS and safety finishReasons', async () => {
    const make = (finishReason: string): GeminiSdkResponse => ({
      candidates: [{ content: { parts: [] }, finishReason }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const maxTok = new GeminiLlmClient({ generate: async () => make('MAX_TOKENS') });
    expect((await maxTok.complete(minimalReq())).stopReason).toBe('max_tokens');
    const safety = new GeminiLlmClient({ generate: async () => make('SAFETY') });
    const r = await safety.complete(minimalReq());
    expect(r.stopReason).toBe('refusal');
    expect(r.toolUses).toEqual([]);
  });

  it('maps STOP with no tool call to end_turn', async () => {
    const generate: GeminiGenerateFn = async () => ({
      candidates: [{ content: { parts: [{ text: 'just narration' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const client = new GeminiLlmClient({ generate });
    const r = await client.complete(minimalReq());
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolUses).toEqual([]);
    expect(r.thinkingBlocks).toEqual([]); // plain text part is not a thought → ignored
  });

  it('drops leak-only thought blocks and keeps the genuine prefix', async () => {
    const generate: GeminiGenerateFn = async () => ({
      candidates: [{ content: { parts: [
        { thought: true, text: 'I move to (4,2) and fire. Could you provide the next thinking chunk?' },
        { thought: true, text: 'Please continue the rewritten thinking.' },
        { functionCall: { name: 'narrate', args: { text: 'hi' } } },
      ] }, finishReason: 'STOP' }],
      usageMetadata: {},
    });
    const client = new GeminiLlmClient({ generate });
    const r = await client.complete(minimalReq());
    expect(r.thinkingBlocks).toEqual(['I move to (4,2) and fire.']);
  });
});

describe('GeminiLlmClient — completeStream', () => {
  type Chunk = GeminiSdkResponse;
  async function* iterate(chunks: Chunk[]): AsyncGenerator<Chunk> {
    for (const c of chunks) yield c;
  }
  const failingGenerate: GeminiGenerateFn = async () => { throw new Error('generate must not be called'); };

  /** Canonical streamed turn: two thought fragments across chunks, then a
   *  whole functionCall, with cumulative usage on the final chunk. */
  const chunks = (): Chunk[] => [
    { candidates: [{ content: { parts: [{ thought: true, text: 'I should ' }] } }] },
    { candidates: [{ content: { parts: [
      { thought: true, text: 'attack.' },
      { functionCall: { name: 'normal_attack', args: { targetId: 'm1' } } },
    ] } }] },
    { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 25, thoughtsTokenCount: 5, cachedContentTokenCount: 80 } },
  ];

  it('streams thought deltas, flushes ONE block before the tool call, and assembles the response', async () => {
    const order: string[] = [];
    const client = new GeminiLlmClient({
      generate: failingGenerate,
      generateStream: () => iterate(chunks()),
    });
    const r = await client.completeStream(minimalReq(), {
      onThinkingDelta: (t) => order.push(`delta:${t}`),
      onThinkingBlockDone: (t) => order.push(`block:${t}`),
      onToolUse: (tu) => { order.push(`tool:${tu.name}`); },
    });
    expect(order).toEqual([
      'delta:I should ',
      'delta:attack.',
      'block:I should attack.',   // buffered fragments → one block, flushed pre-tool
      'tool:normal_attack',
    ]);
    expect(r.thinkingBlocks).toEqual(['I should attack.']);
    expect(r.toolUses).toEqual([{ name: 'normal_attack', input: { targetId: 'm1' } }]);
    expect(r.stopReason).toBe('tool_use');
    // Same usage math as the batch path (cumulative metadata, last chunk wins).
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 0 });
  });

  it('retries before content only; falls back to batch generate when no stream transport', async () => {
    let attempt = 0;
    const client = new GeminiLlmClient({
      sleepFn: () => Promise.resolve(),
      generate: failingGenerate,
      generateStream: () => {
        attempt += 1;
        if (attempt === 1) { const e: Error & { status?: number } = new Error('rate'); e.status = 429; throw e; }
        return iterate(chunks());
      },
    });
    const r = await client.completeStream(minimalReq(), {});
    expect(attempt).toBe(2);
    expect(r.toolUses).toHaveLength(1);

    // Fallback: no generateStream → batch generate + callbacks replayed at the end.
    const order: string[] = [];
    const client2 = new GeminiLlmClient({ generate: async () => okResponse() });
    const r2 = await client2.completeStream(minimalReq(), {
      onThinkingBlockDone: (t) => order.push(`block:${t}`),
      onToolUse: (tu) => { order.push(`tool:${tu.name}`); },
    });
    expect(order).toEqual(['block:plan thoughts', 'tool:narrate']);
    expect(r2.toolUses).toHaveLength(1);
  });
});
