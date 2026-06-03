import { describe, it, expect } from 'vitest';
import { ScriptedLlmClient } from '../../../src/runtime/llm/scripted.js';

const minimalReq = (extra?: Partial<{ model: string }>) => ({
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [],
  model: extra?.model ?? 'claude-sonnet-4-6',
  maxTokens: 1024,
});

describe('ScriptedLlmClient', () => {
  it('returns the first matching response and removes it', async () => {
    const client = new ScriptedLlmClient([
      { match: { model: 'claude-sonnet-4-6' }, response: { toolUses: [{ name: 'narrate', input: { text: 'a' } }] } },
      { match: {},                              response: { toolUses: [{ name: 'narrate', input: { text: 'b' } }] } },
    ]);

    const r1 = await client.complete(minimalReq());
    expect(r1.toolUses[0]?.input).toEqual({ text: 'a' });

    const r2 = await client.complete(minimalReq());
    expect(r2.toolUses[0]?.input).toEqual({ text: 'b' });
  });

  it('matches on tag arbitrary properties supplied via tag()', async () => {
    const client = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'move', input: { path: [] } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'x' } }] } },
    ]);

    const r = await client.complete({ ...minimalReq(), tag: 'dm' } as never);
    expect(r.toolUses[0]?.name).toBe('narrate');
  });

  it('throws when no match is found', async () => {
    const client = new ScriptedLlmClient([{ match: { model: 'other' }, response: { toolUses: [] } }]);
    await expect(client.complete(minimalReq())).rejects.toThrow(/no scripted response matched/i);
  });

  it('attaches default usage and stopReason when omitted', async () => {
    const client = new ScriptedLlmClient([
      { match: {}, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const r = await client.complete(minimalReq());
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(r.stopReason).toBe('tool_use');
    expect(r.thinkingBlocks).toEqual([]);
  });
});
