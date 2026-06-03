import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';
import { resolveAttack, resolveAbilityTest } from '../../src/engine/resolution.js';
import type { AttackKind } from '../../src/engine/character.js';

const ctx = {
  attackerPool: 2,
  defenderArmor: 2,
  attackKind: 'melee' as AttackKind,
  modifiers: { extraAttackDice: 0, extraArmorDice: 0, damageMod: 0 },
};

describe('resolveAttack', () => {
  it('returns structured result with rolls and hit boolean', () => {
    const dice = new Dice('hits-1');
    const result = resolveAttack(dice, ctx);
    expect(result).toHaveProperty('hit');
    expect(result).toHaveProperty('attackRoll');
    expect(result).toHaveProperty('armorRoll');
    expect(result.attackRoll).toHaveLength(2);
    expect(result.armorRoll).toHaveLength(2);
    if (result.hit) {
      expect(result.damage).toBe(1);
    } else {
      expect(result.damage).toBe(0);
    }
  });

  it('ties go to attacker (hit)', () => {
    for (let i = 0; i < 100; i++) {
      const d = new Dice(`s${i}`);
      const r = resolveAttack(d, ctx);
      if (Dice.highestDie(r.attackRoll) === Dice.highestDie(r.armorRoll) && Dice.highestDie(r.attackRoll) > 0) {
        expect(r.hit).toBe(true);
        return;
      }
    }
    throw new Error('no tie found in 100 iterations');
  });

  it('extraAttackDice adds to attacker pool', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, modifiers: { extraAttackDice: 1, extraArmorDice: 0, damageMod: 0 } });
    expect(r.attackRoll).toHaveLength(3);
  });

  it('extraArmorDice (cover) adds to defender pool', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, modifiers: { extraAttackDice: 0, extraArmorDice: 1, damageMod: 0 } });
    expect(r.armorRoll).toHaveLength(3);
  });

  it('empty attacker pool always misses (highestDie 0 < anything)', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, attackerPool: 0 });
    expect(r.hit).toBe(false);
  });

  it('damageMod increases damage on hit', () => {
    for (let i = 0; i < 100; i++) {
      const d = new Dice(`hit-${i}`);
      const r = resolveAttack(d, { ...ctx, modifiers: { extraAttackDice: 5, extraArmorDice: 0, damageMod: 2 } });
      if (r.hit) {
        expect(r.damage).toBe(3); // 1 base + 2 mod
        return;
      }
    }
    throw new Error('no hit in 100 iterations with stacked attacker pool');
  });

  describe('provided rolls (physics-as-truth)', () => {
    it('uses the provided faces verbatim instead of rolling the dice', () => {
      // A `Dice` that would throw if asked to roll — proves the engine never
      // consults it when faces are provided.
      const exploding = { rollPool: () => { throw new Error('should not roll'); } } as unknown as Dice;
      const r = resolveAttack(exploding, ctx, { attackRoll: [4, 2], armorRoll: [6] });
      expect(r.attackRoll).toEqual([4, 2]);
      expect(r.armorRoll).toEqual([6]);
      expect(r.attackerTop).toBe(4);
      expect(r.defenderTop).toBe(6);
      expect(r.hit).toBe(false); // 4 < 6 → miss, exactly what the player saw
    });

    it('computes a hit when the provided attacker top meets or beats the defender top', () => {
      const dice = new Dice('unused');
      const r = resolveAttack(dice, ctx, { attackRoll: [6, 1], armorRoll: [5] });
      expect(r.hit).toBe(true); // 6 >= 5
      expect(r.damage).toBe(1);
    });

    it('matches the browser-side verdict rule for a defender with no armor dice', () => {
      const dice = new Dice('unused');
      const r = resolveAttack(dice, { ...ctx, defenderArmor: 0 }, { attackRoll: [3, 2], armorRoll: [] });
      expect(r.defenderTop).toBe(0);
      expect(r.hit).toBe(true); // 3 >= 0 && 3 > 0
    });
  });
});

describe('resolveAbilityTest', () => {
  it('uses 1 base + characteristic + skill bonus + item bonus', () => {
    const r = resolveAbilityTest(new Dice('x'), {
      characteristicPool: 2,
      hasSkill: true,
      hasItem: true,
      difficulty: 5,
    });
    expect(r.roll).toHaveLength(5); // 1 + 2 + 1 + 1
  });

  it('success when top die >= difficulty', () => {
    for (let i = 0; i < 200; i++) {
      const d = new Dice(`abil-${i}`);
      const r = resolveAbilityTest(d, { characteristicPool: 5, hasSkill: false, hasItem: false, difficulty: 4 });
      const expected = Dice.highestDie(r.roll) >= 4;
      expect(r.success).toBe(expected);
    }
  });
});
