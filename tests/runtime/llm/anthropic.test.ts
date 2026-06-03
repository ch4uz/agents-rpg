import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicLlmClient,
  type AnthropicCreateFn,
  type AnthropicSdkResponse,
  type AnthropicStreamEvent,
} from '../../../src/runtime/llm/anthropic.js';
import { LlmAbortedError } from '../../../src/runtime/llm/llm-client.js';

const okResponse = (toolName = 'narrate', input: Record<string, unknown> = { text: 'hi' }): AnthropicSdkResponse => ({
  content: [
    { type: 'thinking', thinking: 'plan thoughts' },
    { type: 'tool_use', id: 'tu_1', name: toolName, input },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
});

const minimalReq = () => ({
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi', cacheable: false }] }],
  tools: [],
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
});

describe('AnthropicLlmClient', () => {
  it('parses thinking + tool_use blocks and usage', async () => {
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });

    const r = await client.complete(minimalReq());
    expect(r.thinkingBlocks).toEqual(['plan thoughts']);
    expect(r.toolUses).toEqual([{ name: 'narrate', input: { text: 'hi' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 0 });
  });

  it('strips thinking-summarizer leaks and drops leak-only blocks', async () => {
    const resp: AnthropicSdkResponse = {
      content: [
        { type: 'thinking', thinking: 'I move to (4,2) and fire. Could you provide the next thinking chunk?' },
        { type: 'thinking', thinking: 'Please continue the rewritten thinking.' },
        { type: 'tool_use', id: 'tu_1', name: 'narrate', input: { text: 'hi' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const create = vi.fn().mockResolvedValue(resp) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });
    const r = await client.complete(minimalReq());
    // First block keeps its genuine prefix; second is leak-only and dropped.
    expect(r.thinkingBlocks).toEqual(['I move to (4,2) and fire.']);
  });

  it('marks cacheable system segments with cache_control: ephemeral', async () => {
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });
    await client.complete({
      ...minimalReq(),
      system: [{ text: 'sys-stable', cacheable: true }, { text: 'sys-volatile', cacheable: false }],
    });
    const arg = (create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.system[0]).toMatchObject({ type: 'text', text: 'sys-stable', cache_control: { type: 'ephemeral' } });
    expect(arg.system[1]).toMatchObject({ type: 'text', text: 'sys-volatile' });
    expect(arg.system[1].cache_control).toBeUndefined();
  });

  it('budgetTokens 0 disables thinking — no thinking block is sent', async () => {
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });
    await client.complete({ ...minimalReq(), thinking: { type: 'enabled', budgetTokens: 0 } });
    const arg = (create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // The API minimum budget is 1024, so "off" is expressed by omission.
    expect(arg.thinking).toBeUndefined();
  });

  it('default thinking budget is 2048 when enabled without a budget', async () => {
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });
    await client.complete({ ...minimalReq(), thinking: { type: 'enabled' } });
    const arg = (create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('retries on 429 with exponential backoff', async () => {
    let calls = 0;
    const create: AnthropicCreateFn = async () => {
      calls += 1;
      if (calls < 3) {
        const e: Error & { status?: number } = new Error('rate limited');
        e.status = 429;
        throw e;
      }
      return okResponse();
    };
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() /* speed up tests */ });
    const r = await client.complete(minimalReq());
    expect(r.toolUses).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('throws LlmCallError after 5 retries on persistent 5xx', async () => {
    const create: AnthropicCreateFn = async () => {
      const e: Error & { status?: number } = new Error('server error'); e.status = 500;
      throw e;
    };
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() });
    await expect(client.complete(minimalReq())).rejects.toThrow(/persistent/i);
  });

  it('forwards the request AbortSignal to the SDK create options', async () => {
    const captured: Array<{ signal?: AbortSignal } | undefined> = [];
    const create: AnthropicCreateFn = async (_args, options) => {
      captured.push(options);
      return okResponse();
    };
    const client = new AnthropicLlmClient({ create });
    const ac = new AbortController();
    await client.complete({ ...minimalReq(), signal: ac.signal });
    expect(captured[0]?.signal).toBe(ac.signal);
  });

  it('throws LlmAbortedError (no SDK call) when the signal is already aborted', async () => {
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });
    const ac = new AbortController();
    ac.abort();
    await expect(client.complete({ ...minimalReq(), signal: ac.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect((create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('throws LlmAbortedError WITHOUT retrying when an abort fires mid-call', async () => {
    let calls = 0;
    const ac = new AbortController();
    const create: AnthropicCreateFn = async () => {
      calls += 1;
      ac.abort();  // the human interjected while the request was in flight
      const e: Error & { name: string } = new Error('aborted'); e.name = 'AbortError';
      throw e;
    };
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() });
    await expect(client.complete({ ...minimalReq(), signal: ac.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect(calls).toBe(1);  // no retry on abort, unlike a 429/5xx
  });

  it('throws on refusal stopReason', async () => {
    const create: AnthropicCreateFn = async () => ({
      content: [], stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as AnthropicSdkResponse);
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() });
    const r = await client.complete(minimalReq());
    expect(r.stopReason).toBe('refusal');
    expect(r.toolUses).toEqual([]);
  });
});

describe('AnthropicLlmClient — completeStream', () => {
  /** A canonical streamed turn: thinking (2 deltas) then one tool call whose
   *  input JSON arrives in 2 fragments, with usage split across
   *  message_start (input side) and message_delta (output side). */
  const streamEvents = (): AnthropicStreamEvent[] => [
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 80 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'attack.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'normal_attack', id: 'tu_1' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'Id":"m1"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', usage: { output_tokens: 30 }, delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  async function* iterate(events: AnthropicStreamEvent[]): AsyncGenerator<AnthropicStreamEvent> {
    for (const e of events) yield e;
  }
  const failingCreate: AnthropicCreateFn = async () => { throw new Error('create must not be called'); };

  it('fires deltas, block-done, and tool callbacks in order and assembles the final response', async () => {
    const order: string[] = [];
    const client = new AnthropicLlmClient({
      create: failingCreate,
      stream: () => iterate(streamEvents()),
    });
    const r = await client.completeStream(minimalReq(), {
      onThinkingDelta: (t) => order.push(`delta:${t}`),
      onThinkingBlockDone: (t) => order.push(`block:${t}`),
      onToolUse: (tu) => { order.push(`tool:${tu.name}:${JSON.stringify(tu.input)}`); },
    });
    expect(order).toEqual([
      'delta:I should ',
      'delta:attack.',
      'block:I should attack.',                    // before the tool call — log order preserved
      'tool:normal_attack:{"targetId":"m1"}',      // fragmented JSON parsed whole
    ]);
    expect(r.thinkingBlocks).toEqual(['I should attack.']);
    expect(r.toolUses).toEqual([{ name: 'normal_attack', input: { targetId: 'm1' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 0 });
  });

  it('awaits onToolUse before continuing (backpressure preserves apply order)', async () => {
    let resolved = false;
    const client = new AnthropicLlmClient({
      create: failingCreate,
      stream: () => iterate(streamEvents()),
    });
    await client.completeStream(minimalReq(), {
      onToolUse: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    expect(resolved).toBe(true);  // the stream did not finish before the slow consumer
  });

  it('retries a transient failure BEFORE any content, never after', async () => {
    // First attempt: 429 before yielding anything → retried.
    let attempt = 0;
    const client = new AnthropicLlmClient({
      sleepFn: () => Promise.resolve(),
      create: failingCreate,
      stream: () => {
        attempt += 1;
        if (attempt === 1) { const e: Error & { status?: number } = new Error('rate'); e.status = 429; throw e; }
        return iterate(streamEvents());
      },
    });
    const r = await client.completeStream(minimalReq(), {});
    expect(attempt).toBe(2);
    expect(r.toolUses).toHaveLength(1);

    // Mid-stream failure AFTER content surfaced → propagates, no retry.
    let attempts2 = 0;
    async function* failsMidway(): AsyncGenerator<AnthropicStreamEvent> {
      attempts2 += 1;
      yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } };
      const e: Error & { status?: number } = new Error('flaked'); e.status = 500;
      throw e;
    }
    const client2 = new AnthropicLlmClient({
      sleepFn: () => Promise.resolve(),
      create: failingCreate,
      stream: () => failsMidway(),
    });
    await expect(client2.completeStream(minimalReq(), { onThinkingDelta: () => {} })).rejects.toThrow(/persistent/i);
    expect(attempts2).toBe(1);
  });

  it('falls back to the batch create() (replaying callbacks at the end) when no stream transport is wired', async () => {
    const order: string[] = [];
    const create = vi.fn().mockResolvedValue(okResponse()) as unknown as AnthropicCreateFn;
    const client = new AnthropicLlmClient({ create });  // no `stream`
    const r = await client.completeStream(minimalReq(), {
      onThinkingBlockDone: (t) => order.push(`block:${t}`),
      onToolUse: (tu) => { order.push(`tool:${tu.name}`); },
    });
    expect(order).toEqual(['block:plan thoughts', 'tool:narrate']);
    expect(r.toolUses).toHaveLength(1);
  });
});

describe('LLM request — parallel tool use flag (F22)', () => {
  const minimalReqWithTools = () => ({
    system: [{ text: 's', cacheable: false }],
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x', cacheable: false }] }],
    tools: [{ name: 'narrate', description: 'd', input_schema: { type: 'object', properties: {} } }],
    model: 'test', maxTokens: 100,
  });

  it('AnthropicLlmClient sets disable_parallel_tool_use=true by default', async () => {
    const captured: Array<{ tool_choice?: { disable_parallel_tool_use: boolean } }> = [];
    const fakeCreate: AnthropicCreateFn = async (args) => {
      captured.push(args);
      return {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'narrate', input: { text: 'x' } }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'tool_use',
      } as AnthropicSdkResponse;
    };
    const client = new AnthropicLlmClient({ create: fakeCreate, sleepFn: async () => {} });
    await client.complete(minimalReqWithTools());
    expect(captured[0]!.tool_choice!.disable_parallel_tool_use).toBe(true);
  });

  it('AnthropicLlmClient respects allowParallelTools=true', async () => {
    const captured: Array<{ tool_choice?: { disable_parallel_tool_use: boolean } }> = [];
    const fakeCreate: AnthropicCreateFn = async (args) => {
      captured.push(args);
      return {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'narrate', input: { text: 'x' } }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'tool_use',
      } as AnthropicSdkResponse;
    };
    const client = new AnthropicLlmClient({ create: fakeCreate, sleepFn: async () => {} });
    await client.complete({ ...minimalReqWithTools(), allowParallelTools: true });
    expect(captured[0]!.tool_choice!.disable_parallel_tool_use).toBe(false);
  });
});
