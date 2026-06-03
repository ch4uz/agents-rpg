import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';

describe('Dice (mulberry32 PRNG)', () => {
  it('produces identical sequences from the same seed', () => {
    const a = new Dice('seed-A');
    const b = new Dice('seed-A');
    expect(a.rollPool(5)).toEqual(b.rollPool(5));
  });

  it('produces different sequences for different seeds', () => {
    const a = new Dice('seed-A');
    const b = new Dice('seed-B');
    expect(a.rollPool(20)).not.toEqual(b.rollPool(20));
  });

  it('rollPool(0) returns []', () => {
    expect(new Dice('x').rollPool(0)).toEqual([]);
  });

  it('rollPool(N) returns N ints in 1..6', () => {
    const rolls = new Dice('x').rollPool(100);
    expect(rolls).toHaveLength(100);
    for (const r of rolls) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
  });

  it('highestDie returns the max of a roll', () => {
    expect(Dice.highestDie([1, 4, 6, 2])).toBe(6);
    expect(Dice.highestDie([3])).toBe(3);
  });

  it('highestDie returns 0 for empty pool (no dice = automatic miss)', () => {
    expect(Dice.highestDie([])).toBe(0);
  });

  it('rollPool advances state (consecutive calls differ)', () => {
    const d = new Dice('x');
    const first = d.rollPool(5);
    const second = d.rollPool(5);
    expect(first).not.toEqual(second);
  });
});
