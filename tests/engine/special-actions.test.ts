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

describe('special_action: whirlwind-attack', () => {
  it('splits melee dice across two adjacent targets and resolves each separately', () => {
    const w  = hero('w', 1, 1);                         // melee 2
    const r1 = monster('r1', 1, 0);                     // adjacent N
    const r2 = monster('r2', 2, 1);                     // adjacent E
    const engine = makeEngine([w, r1, r2], 'whirl-pass');
    engine.beginNarrativeTurn(asCharacterId('w'));

    const r = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    expect(r.ok).toBe(true);

    const events = engine.flushEvents();
    const resolutions = events.filter((e) => e.type === 'resolution');
    expect(resolutions).toHaveLength(2);
    for (const res of resolutions) {
      expect((res as unknown as { public: { attackerTop: number } }).public.attackerTop).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies damage independently to each target on hit', () => {
    // Force a hit by giving rats armor 0 and warrior melee 2 split 1/1.
    const w  = hero('w', 1, 1);
    const r1 = monster('r1', 1, 0, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const r2 = monster('r2', 2, 1, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const engine = makeEngine([w, r1, r2], 'whirl-hit');
    engine.beginNarrativeTurn(asCharacterId('w'));

    engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    const events = engine.flushEvents();
    const stateChanges = events.filter((e) => e.type === 'state_change');
    expect(stateChanges).toHaveLength(2);
    const targetIds = stateChanges
      .map((sc) => {
        const changes = (sc as unknown as { changes: { id: string }[] }).changes;
        return changes[0]!.id;
      })
      .sort();
    expect(targetIds).toEqual(['r1', 'r2']);
  });
});

describe('special_action: split-shot', () => {
  it('splits ranged dice across two in-range targets with LOS', () => {
    const h = hero('h', 0, 0, {
      pools: { melee: 0, ranged: 2, magic: 0, armor: 2 },
      normalAttack: { kind: 'ranged', name: 'Bow', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split', description: '' },
    });
    const r1 = monster('r1', 5, 0);
    const r2 = monster('r2', 0, 5);
    const engine = makeEngine([h, r1, r2], 'split-pass');
    engine.beginNarrativeTurn(asCharacterId('h'));
    const r = engine.applyAction(asCharacterId('h'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    expect(r.ok).toBe(true);
    const events = engine.flushEvents();
    expect(events.filter((e) => e.type === 'resolution')).toHaveLength(2);
  });
});

describe('special_action: flame-burst', () => {
  it('hits every adjacent character (allies and enemies), 1 magic die each', () => {
    const w  = hero('w', 1, 1, {
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Burst', description: '' },
    });
    const ally = hero('a', 2, 1);
    const r1 = monster('r1', 1, 0);
    const r2 = monster('r2', 1, 2);
    const farRat = monster('r3', 5, 5);  // not adjacent — should NOT be hit
    const engine = makeEngine([w, ally, r1, r2, farRat], 'flame-pass');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), { kind: 'special_action' });
    expect(out.ok).toBe(true);

    const events = engine.flushEvents();
    const resolutions = events.filter((e) => e.type === 'resolution');
    // ally + r1 + r2 = 3 adjacent characters
    expect(resolutions).toHaveLength(3);
  });

  it('skips KO\'d adjacent characters', () => {
    const w  = hero('w', 1, 1, {
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Burst', description: '' },
    });
    const dead = monster('d', 1, 0, { health: { total: 1, damage: 1, status: 'KO' as const } });
    const r1 = monster('r1', 2, 1);
    const engine = makeEngine([w, dead, r1], 'flame-skip');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), { kind: 'special_action' });
    expect(out.ok).toBe(true);
    const resolutions = engine.flushEvents().filter((e) => e.type === 'resolution');
    expect(resolutions).toHaveLength(1);  // only r1
  });
});

describe('special_action: pack-attack', () => {
  it('rolls actor.pools.melee + 1 dice when target is engaged by ≥ 2 monsters', () => {
    const r1 = monster('r1', 0, 0);
    const r2 = monster('r2', 0, 1);
    const h  = hero('h', 1, 0);   // adjacent to r1 and r2
    const engine = makeEngine([r1, r2, h], 'pack-engaged');
    engine.beginNarrativeTurn(asCharacterId('r1'));
    const out = engine.applyAction(asCharacterId('r1'), {
      kind: 'special_action', targetIds: [asCharacterId('h')],
    });
    expect(out.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    // r1 melee 1 + engaged +1 = 2 dice
    expect(resolution.private.attackRoll.length).toBe(2);
  });

  it('rolls only actor.pools.melee dice when target is not engaged', () => {
    const r1 = monster('r1', 0, 0);
    const h  = hero('h', 1, 0);
    const engine = makeEngine([r1, h], 'pack-alone');
    engine.beginNarrativeTurn(asCharacterId('r1'));
    const out = engine.applyAction(asCharacterId('r1'), {
      kind: 'special_action', targetIds: [asCharacterId('h')],
    });
    expect(out.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(1);
  });
});

describe('special_action: physics-dice preview + provided faces', () => {
  type Res = { public: { hit: boolean; targetId: string; rollRequestId?: string }; private: { attackRoll: number[] } };

  it('previewSpecialAttacks enumerates one sub-attack per whirlwind target with the right pools', () => {
    const w  = hero('w', 1, 1);                                                  // melee 2
    const r1 = monster('r1', 1, 0, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const r2 = monster('r2', 2, 1, { pools: { melee: 1, ranged: 0, magic: 0, armor: 1 } });
    const engine = makeEngine([w, r1, r2], 'preview');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const p = engine.previewSpecialAttacks(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.subAttacks).toEqual([
        { targetId: 'r1', attackerPoolSize: 1, defenderArmorPoolSize: 0, attackKind: 'melee' },
        { targetId: 'r2', attackerPoolSize: 1, defenderArmorPoolSize: 1, attackKind: 'melee' },
      ]);
    }
  });

  it('previewSpecialAttacks reports zero sub-attacks for a single-effect (no opposed dice)', () => {
    const healer = hero('hl', 0, 0, {
      specialAction: { id: asEffectId('healing-touch'), name: 'Heal', description: '' },
    });
    const engine = makeEngine([healer], 'preview-single');
    engine.beginNarrativeTurn(asCharacterId('hl'));
    const p = engine.previewSpecialAttacks(asCharacterId('hl'), { kind: 'special_action', targetIds: [asCharacterId('hl')] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.subAttacks).toEqual([]);
  });

  it('previewSpecialAttacks surfaces the same rule_violation the handler would', () => {
    const w  = hero('w', 1, 1);
    const r1 = monster('r1', 1, 0);
    const engine = makeEngine([w, r1], 'preview-bad');
    engine.beginNarrativeTurn(asCharacterId('w'));
    // diceSplit sum (1) ≠ melee pool (2)
    const p = engine.previewSpecialAttacks(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r1')], params: { diceSplit: { r1: 1 } },
    });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.reason).toBe('invalid-split-sum');
  });

  it('whirlwind resolves each sub-attack against its provided faces and echoes rollRequestId', () => {
    const w  = hero('w', 1, 1);                                                  // melee 2
    const r1 = monster('r1', 1, 0, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const r2 = monster('r2', 2, 1, { pools: { melee: 1, ranged: 0, magic: 0, armor: 1 } });
    const engine = makeEngine([w, r1, r2], 'provided');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    }, {
      providedSpecialRolls: [
        { attackRoll: [6], armorRoll: [], requestId: 'rs-1' },   // r1 (armor 0): top 6 → hit
        { attackRoll: [1], armorRoll: [6], requestId: 'rs-2' },  // r2 (armor 1): top 1 vs 6 → miss
      ],
    });
    expect(out.ok).toBe(true);

    const res = engine.flushEvents().filter((e) => e.type === 'resolution') as unknown as Res[];
    const byTarget = Object.fromEntries(res.map((r) => [r.public.targetId, r]));
    expect(byTarget['r1']!.private.attackRoll).toEqual([6]);   // used verbatim, not seeded
    expect(byTarget['r1']!.public.hit).toBe(true);
    expect(byTarget['r1']!.public.rollRequestId).toBe('rs-1');
    expect(byTarget['r2']!.public.hit).toBe(false);
    expect(byTarget['r2']!.public.rollRequestId).toBe('rs-2');
  });

  it('falls back to seeded dice for a sub-attack whose provided faces do not fit (and omits its rollRequestId)', () => {
    const w  = hero('w', 1, 1);
    const r1 = monster('r1', 1, 0, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const r2 = monster('r2', 2, 1, { pools: { melee: 1, ranged: 0, magic: 0, armor: 1 } });
    const engine = makeEngine([w, r1, r2], 'provided-mixed');
    engine.beginNarrativeTurn(asCharacterId('w'));
    engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    }, {
      providedSpecialRolls: [
        { attackRoll: [6, 6], armorRoll: [], requestId: 'rs-bad' }, // wrong length → ignored
        { attackRoll: [5], armorRoll: [2], requestId: 'rs-ok' },    // fits → used
      ],
    });
    const res = engine.flushEvents().filter((e) => e.type === 'resolution') as unknown as Res[];
    const byTarget = Object.fromEntries(res.map((r) => [r.public.targetId, r]));
    // r1 fell back to the seed: still rolled exactly 1 die, no echoed request id.
    expect(byTarget['r1']!.private.attackRoll.length).toBe(1);
    expect(byTarget['r1']!.public.rollRequestId).toBeUndefined();
    // r2 used the provided faces.
    expect(byTarget['r2']!.private.attackRoll).toEqual([5]);
    expect(byTarget['r2']!.public.rollRequestId).toBe('rs-ok');
  });

  it('pack-attack preview folds the engagement bonus into the pool size', () => {
    const r1 = monster('r1', 0, 0);
    const r2 = monster('r2', 0, 1);
    const h  = hero('h', 1, 0);   // engaged by r1 and r2
    const engine = makeEngine([r1, r2, h], 'pack-preview');
    engine.beginNarrativeTurn(asCharacterId('r1'));
    const p = engine.previewSpecialAttacks(asCharacterId('r1'), {
      kind: 'special_action', targetIds: [asCharacterId('h')],
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.subAttacks).toEqual([
        { targetId: 'h', attackerPoolSize: 2, defenderArmorPoolSize: 2, attackKind: 'melee' }, // melee 1 + engaged 1
      ]);
    }
  });
});
