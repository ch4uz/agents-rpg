import { describe, it, expect } from 'vitest';
import type { Character } from '../../src/engine/character.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';

describe('Character.kind', () => {
  it('accepts npc as a valid kind', () => {
    const npc: Character = {
      id: asCharacterId('mira-1'),
      name: 'Mira',
      kind: 'npc',
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      dex: 1,
      health: { total: 2, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('noop'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('noop'), name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    expect(npc.kind).toBe('npc');
  });

  it('RedactedCharacter accepts npc', () => {
    const rc: RedactedCharacter = {
      id: asCharacterId('mira-1'),
      name: 'Mira',
      kind: 'npc',
      pos: { x: 0, y: 0 },
      health: { total: 2, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      inventory: [], boons: [],
      normalAttack: { kind: 'melee', range: 1 },
      specialAction: { name: '', description: '' },
      bonusAbility:  { name: '', description: '' },
    };
    expect(rc.kind).toBe('npc');
  });
});
