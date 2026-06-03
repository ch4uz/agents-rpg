import { describe, it, expect } from 'vitest';
import {
  buildPool,
  dispatchAttackRoll,
  dispatchSingleRoll,
} from '../../web/components/three/DiceDispatcher.js';

describe('buildPool', () => {
  it('returns empty array when pool size is 0 (no armor pool case)', () => {
    expect(buildPool(0, 0, 42, null)).toEqual([]);
  });

  it('puts the engine top face first when no actual roll is provided', () => {
    const pool = buildPool(5, 3, 42, null);
    expect(pool.length).toBe(3);
    expect(pool[0]).toBe(5);
    for (const v of pool.slice(1)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('is deterministic in seed (same seedBase → same filler values)', () => {
    const a = buildPool(4, 4, 999, null);
    const b = buildPool(4, 4, 999, null);
    expect(a).toEqual(b);
  });

  it('uses the actual roll verbatim when provided, top die first', () => {
    const pool = buildPool(5, 3, 42, [2, 5, 3]);
    expect(pool[0]).toBe(5);
    // The remaining dice are the other two values, order preserved.
    expect(pool.slice(1).sort()).toEqual([2, 3]);
  });

  it('falls back to filler when actual roll length disagrees with poolSize', () => {
    // Defensive: if the visibility filter strips one entry, the pool count
    // takes precedence over the actual array.
    const pool = buildPool(5, 4, 100, [2, 5]);
    expect(pool.length).toBe(4);
    expect(pool[0]).toBe(5);
  });

  it('clamps faces outside 1..6 to the legal range', () => {
    expect(buildPool(9, 1, 0, [9])).toEqual([6]);
    expect(buildPool(1, 1, 0, [0])).toEqual([1]);
  });
});

describe('dispatchAttackRoll', () => {
  it('maps a resolution event payload to two lanes', () => {
    const d = dispatchAttackRoll({
      t: 17,
      attackerTop: 5,
      attackerPool: 3,
      attackerActual: [3, 5, 1],
      defenderTop: 2,
      defenderArmorPool: 1,
      defenderActual: [2],
    });
    expect(d.t).toBe(17);
    expect(d.attacker[0]).toBe(5);
    expect(d.attacker.length).toBe(3);
    expect(d.defender).toEqual([2]);
  });

  it('produces an empty defender lane when armor pool is 0', () => {
    const d = dispatchAttackRoll({
      t: 4,
      attackerTop: 3,
      attackerPool: 2,
      attackerActual: null,
      defenderTop: 0,
      defenderArmorPool: 0,
      defenderActual: null,
    });
    expect(d.defender).toEqual([]);
  });
});

describe('dispatchSingleRoll', () => {
  it('puts everything in the attacker lane (initiative / ability)', () => {
    const d = dispatchSingleRoll({
      t: 9,
      top: 6,
      poolSize: 4,
      actual: [4, 6, 2, 5],
    });
    expect(d.t).toBe(9);
    expect(d.attacker[0]).toBe(6);
    expect(d.attacker.length).toBe(4);
    expect(d.defender).toEqual([]);
  });
});
