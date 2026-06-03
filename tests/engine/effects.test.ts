import { describe, it, expect } from 'vitest';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';

describe('EffectRegistry', () => {
  it('register and retrieve an effect by id', () => {
    const reg = new EffectRegistry();
    reg.register('heal-full', { kind: 'consumable', apply: () => ({ changes: [{ kind: 'heal', characterId: 'x', amount: Infinity }] }) });
    expect(reg.has('heal-full')).toBe(true);
    expect(reg.get('heal-full').apply({ actor: undefined as never })).toEqual({
      changes: [{ kind: 'heal', characterId: 'x', amount: Infinity }],
    });
  });

  it('get throws on missing effectId', () => {
    const reg = new EffectRegistry();
    expect(() => reg.get('nope')).toThrow(/unknown effect/i);
  });

  it('register throws on duplicate effectId', () => {
    const reg = new EffectRegistry();
    reg.register('x', { kind: 'consumable', apply: () => ({ changes: [{ kind: 'noop' }] }) });
    expect(() => reg.register('x', { kind: 'consumable', apply: () => ({ changes: [{ kind: 'noop' }] }) })).toThrow();
  });

  it('registerCoreEffects installs the v1 catalog effects', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    expect(reg.has('heal-full')).toBe(true);
    expect(reg.has('bomb-blast')).toBe(true);
    expect(reg.has('healing-touch')).toBe(true);
    expect(reg.has('reaping-strike')).toBe(true);
    expect(reg.has('teamwork')).toBe(true);
    expect(reg.has('evasive-maneuver')).toBe(true);
    expect(reg.has('whirlwind-attack')).toBe(true);
    expect(reg.has('split-shot')).toBe(true);
    expect(reg.has('flame-burst')).toBe(true);
    expect(reg.has('pack-attack')).toBe(true);
    expect(reg.has('coward')).toBe(true);
    expect(reg.has('power-surge')).toBe(true);
    expect(reg.has('potion-brewer')).toBe(true);
    expect(reg.has('tangled')).toBe(true);
  });
});

describe('bonus-passive effects', () => {
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  const woundedMage = { health: { damage: 1 } } as never;
  const fullMage = { health: { damage: 0 } } as never;

  it('power-surge adds an attack die only when wounded AND magic', () => {
    expect(reg.get('power-surge').apply({ actor: woundedMage, params: { attackKind: 'magic' } }).changes)
      .toEqual([{ kind: 'attack-mod', extraDice: 1 }]);
    // wounded but a non-magic attack → no bonus
    expect(reg.get('power-surge').apply({ actor: woundedMage, params: { attackKind: 'melee' } }).changes)
      .toEqual([{ kind: 'noop' }]);
    // magic but at full health → no bonus
    expect(reg.get('power-surge').apply({ actor: fullMage, params: { attackKind: 'magic' } }).changes)
      .toEqual([{ kind: 'noop' }]);
  });

  it('tangled adds an armor die only when defending a melee attack', () => {
    expect(reg.get('tangled').apply({ actor: fullMage, params: { defendingAttackKind: 'melee' } }).changes)
      .toEqual([{ kind: 'armor-mod', extraDice: 1 }]);
    expect(reg.get('tangled').apply({ actor: fullMage, params: { defendingAttackKind: 'ranged' } }).changes)
      .toEqual([{ kind: 'noop' }]);
    expect(reg.get('tangled').apply({ actor: fullMage, params: { defendingAttackKind: 'magic' } }).changes)
      .toEqual([{ kind: 'noop' }]);
  });

  it('evasive-maneuver (Hunter) yields a 1-square move bonus', () => {
    expect(reg.get('evasive-maneuver').apply({ actor: fullMage }).changes)
      .toEqual([{ kind: 'move-bonus', squares: 1 }]);
  });
});
