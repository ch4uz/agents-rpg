import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const grid8x8 = (): Grid =>
  new Grid(Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));

const hero = (id: string, x: number, y: number, overrides: Partial<Character> = {}): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'Whirlwind', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [], boons: [], skills: [],
  ...overrides,
});

const monster = (id: string, x: number, y: number, overrides: Partial<Character> = {}): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
  health: { total: 1, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: 'Pack', description: '' },
  bonusAbility:  { id: asEffectId('coward'), name: 'Cow', description: '' },
  inventory: [], boons: [], skills: [],
  ...overrides,
});

const makeEngine = (chars: Character[], seed = 'wirl'): GameEngine => {
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({ seed, grid: grid8x8(), characters: chars, effects: reg });
};

describe('special_action: whirlwind validation', () => {
  it('targets-required when targetIds is empty', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val1');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [], params: { diceSplit: {} },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('targets-required');
  });

  it('target-not-adjacent when target is two squares away', () => {
    const w = hero('w', 1, 1); const r = monster('r', 4, 4);
    const engine = makeEngine([w, r], 'val2');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('target-not-adjacent');
  });

  it('invalid-split-sum when split does not sum to actor.pools.melee', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val3');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 5 } },
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    if (out.error.reason === 'invalid-split-sum') {
      expect(out.error.expected).toBe(2);
      expect(out.error.actual).toBe(5);
    } else {
      throw new Error(`expected invalid-split-sum, got ${JSON.stringify(out.error)}`);
    }
  });

  it('invalid-split-shape when diceSplit keys mismatch targetIds', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val4');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { wrong: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('invalid-split-shape');
  });
});

describe('special_action: split-shot validation', () => {
  it('target-out-of-range when target is past range 6', () => {
    const h = hero('h', 0, 0, {
      pools: { melee: 0, ranged: 2, magic: 0, armor: 2 },
      normalAttack: { kind: 'ranged', name: 'Bow', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split', description: '' },
    });
    const r = monster('r', 7, 0);
    const engine = makeEngine([h, r], 'split-fail');
    engine.beginNarrativeTurn(asCharacterId('h'));
    const out = engine.applyAction(asCharacterId('h'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('target-out-of-range');
  });
});
