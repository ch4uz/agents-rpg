import { describe, it, expect } from 'vitest';
import type { PlayerAction, DmAction } from '../../src/engine/action.js';
import { asCharacterId, asItemId } from '../../src/engine/ids.js';

describe('action types compile and discriminate', () => {
  it('a PlayerAction can be narrowed by kind', () => {
    const a: PlayerAction = { kind: 'normal_attack', targetId: asCharacterId('rat-1') };
    if (a.kind === 'normal_attack') {
      expect(a.targetId).toBe('rat-1');
    } else {
      throw new Error('unexpected branch');
    }
  });

  it('a DmAction can be narrowed', () => {
    const a: DmAction = { kind: 'narrate', text: 'hello' };
    if (a.kind === 'narrate') {
      expect(a.text).toBe('hello');
    }
  });

  it('use_item carries optional target', () => {
    const a: PlayerAction = {
      kind: 'use_item',
      itemId: asItemId('potion'),
      targetId: asCharacterId('h1'),
    };
    expect(a.kind).toBe('use_item');
  });
});
