import { describe, it, expect } from 'vitest';
import { isEngaged } from '../../src/engine/engaged.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const ch = (id: string, x: number, y: number, kind: 'hero' | 'monster' = 'hero'): Character => ({
  id: asCharacterId(id),
  name: id,
  kind,
  ...(kind === 'hero' ? { archetype: 'warrior' as const } : {}),
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('noop'), name: 'noop', description: '' },
  bonusAbility:  { id: asEffectId('noop'), name: 'noop', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('isEngaged', () => {
  it('returns false when only the attacker is adjacent to the target', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const target   = ch('m1', 1, 0, 'monster');
    const others: Character[] = [];
    expect(isEngaged(target, [attacker, ...others], 'hero')).toBe(false);
  });

  it('returns true when target is adjacent to ≥2 attacker-team members (incl. attacker)', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const ally     = ch('h2', 1, 1, 'hero');
    const target   = ch('m1', 1, 0, 'monster');
    expect(isEngaged(target, [attacker, ally], 'hero')).toBe(true);
  });

  it('does not count KO\'d teammates as engaging', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const ally     = { ...ch('h2', 1, 1, 'hero'), health: { total: 3, damage: 3, status: 'KO' as const } };
    const target   = ch('m1', 1, 0, 'monster');
    expect(isEngaged(target, [attacker, ally], 'hero')).toBe(false);
  });

  it('counts at least 2 monsters when the attacker team is monsters', () => {
    const attacker = ch('m1', 0, 0, 'monster');
    const ally     = ch('m2', 1, 1, 'monster');
    const target   = ch('h1', 1, 0, 'hero');
    expect(isEngaged(target, [attacker, ally], 'monster')).toBe(true);
  });

  it('returns false when target has no position', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const target   = { ...ch('m1', 1, 0, 'monster'), pos: null };
    expect(isEngaged(target, [attacker], 'hero')).toBe(false);
  });
});
