import { describe, it, expect } from 'vitest';
import { DM_TOOLS, parseDmToolInput } from '../../../src/runtime/prompt/tools.js';

describe('DM tools — NPC entries', () => {
  it('declares npc_action and reveal_npc', () => {
    const names = DM_TOOLS.map((t) => t.name);
    expect(names).toContain('npc_action');
    expect(names).toContain('reveal_npc');
  });

  it('parses an npc_action tool call into a DmAction', () => {
    const parsed = parseDmToolInput('npc_action', {
      npcId: 'mira-1',
      action: { kind: 'say', text: 'Hello' },
    });
    expect(parsed.kind).toBe('npc_action');
    if (parsed.kind === 'npc_action') {
      expect(parsed.npcId).toBe('mira-1');
      expect(parsed.action.kind).toBe('say');
    }
  });

  it('parses a reveal_npc tool call into a DmAction', () => {
    const parsed = parseDmToolInput('reveal_npc', {
      npcTypeId: 'mira',
      pos: { x: 0, y: 0 },
      characterId: 'mira-1',
      allegiance: 'neutral',
    });
    expect(parsed.kind).toBe('reveal_npc');
  });
});
