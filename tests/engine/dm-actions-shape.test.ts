import { describe, it, expect } from 'vitest';
import type { DmAction } from '../../src/engine/action.js';
import { asCharacterId } from '../../src/engine/ids.js';

describe('DmAction', () => {
  it('accepts npc_action shape', () => {
    const a: DmAction = {
      kind: 'npc_action',
      npcId: asCharacterId('mira-1'),
      action: { kind: 'say', text: 'Help!' },
    };
    expect(a.kind).toBe('npc_action');
  });

  it('accepts reveal_npc shape', () => {
    const a: DmAction = {
      kind: 'reveal_npc',
      npcTypeId: 'mira',
      pos: { x: 0, y: 0 },
      characterId: asCharacterId('mira-1'),
      allegiance: 'neutral',
    };
    expect(a.kind).toBe('reveal_npc');
  });
});
