import { describe, it, expect } from 'vitest';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { MoveField } from '../../web/components/pathfinder.js';
import { inNormalAttackRange, normalAttackTargetIds } from '../../web/components/attack-range.js';

/**
 * Client-side normal-attack range gating. Mirrors the engine's
 * `computeNormalAttackContext` / `previewAttackObject` so the browser highlights
 * exactly the targets the server will accept (Chebyshev range + LoS for
 * non-melee) — see `special-alloc.test.ts` for the split-special analogue.
 */

const ch = (
  id: string, x: number, y: number,
  kind: 'melee' | 'ranged' | 'magic' = 'melee', range = 1,
  status: 'normal' | 'prone' | 'KO' | 'immobilized' = 'normal',
): RedactedCharacter =>
  ({
    id, name: id, kind: 'monster', pos: { x, y },
    health: { total: 3, damage: 0, status },
    normalAttack: { kind, range },
  } as unknown as RedactedCharacter);

const openField = (w: number, h: number, walls: Array<{ x: number; y: number }> = []): MoveField =>
  ({ gridW: w, gridH: h, walls, enemies: [], allies: [] });

describe('inNormalAttackRange — engine-accurate normal-attack reach', () => {
  it('melee (range 1): adjacent cells in range, distance ≥ 2 out', () => {
    const me = ch('me', 5, 5, 'melee', 1);
    const field = openField(10, 10);
    expect(inNormalAttackRange(me, { x: 5, y: 6 }, field)).toBe(true);  // orthogonal, dist 1
    expect(inNormalAttackRange(me, { x: 6, y: 6 }, field)).toBe(true);  // diagonal, Chebyshev 1
    expect(inNormalAttackRange(me, { x: 5, y: 7 }, field)).toBe(false); // dist 2
    expect(inNormalAttackRange(me, { x: 8, y: 5 }, field)).toBe(false); // dist 3
  });

  it('ranged (range 6): within range in, beyond out — no LoS gate on open ground', () => {
    const me = ch('me', 0, 0, 'ranged', 6);
    const field = openField(12, 4);
    expect(inNormalAttackRange(me, { x: 6, y: 0 }, field)).toBe(true);  // dist 6
    expect(inNormalAttackRange(me, { x: 7, y: 0 }, field)).toBe(false); // dist 7
  });

  it('ranged: a wall on the line of sight blocks the shot even when in range', () => {
    const me = ch('me', 0, 0, 'ranged', 6);
    const field = openField(8, 8, [{ x: 2, y: 0 }]);
    expect(inNormalAttackRange(me, { x: 4, y: 0 }, field)).toBe(false); // occluded by (2,0)
    expect(inNormalAttackRange(me, { x: 0, y: 4 }, field)).toBe(true);  // clear column
  });

  it('melee: a wall on the line does NOT block (melee never checks LoS)', () => {
    const me = ch('me', 0, 0, 'melee', 1);
    const field = openField(8, 8, [{ x: 1, y: 1 }]);
    // The adjacent cell IS the wall cell here, but range is all melee needs.
    expect(inNormalAttackRange(me, { x: 1, y: 1 }, field)).toBe(true);
  });
});

describe('normalAttackTargetIds — character target list', () => {
  it('melee: only adjacent living non-self targets', () => {
    const me = ch('me', 5, 5, 'melee', 1);
    const adjacent = ch('a', 5, 6, 'melee', 1);
    const diagonal = ch('b', 6, 6, 'melee', 1);
    const far = ch('c', 5, 7, 'melee', 1);          // dist 2 — out
    const deadAdj = ch('d', 4, 5, 'melee', 1, 'KO'); // adjacent but KO'd — out
    const ids = normalAttackTargetIds(me, [me, adjacent, diagonal, far, deadAdj], openField(10, 10));
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('ranged: within range + clear LoS, excludes out-of-range, self, and KO', () => {
    const me = ch('me', 0, 0, 'ranged', 6);
    const near = ch('n', 4, 0, 'ranged', 6);  // dist 4 ≤ 6
    const edge = ch('e', 6, 0, 'ranged', 6);  // dist 6 ≤ 6
    const over = ch('o', 7, 0, 'ranged', 6);  // dist 7 > 6 — out
    const ids = normalAttackTargetIds(me, [me, near, edge, over], openField(12, 4));
    expect(ids.sort()).toEqual(['e', 'n']);
  });

  it('includes allies (friendly fire stays legal — only self + KO are filtered)', () => {
    const me = ch('me', 5, 5, 'melee', 1);
    const ally = { ...ch('ally', 5, 6, 'melee', 1), kind: 'hero' } as RedactedCharacter;
    const ids = normalAttackTargetIds(me, [me, ally], openField(10, 10));
    expect(ids).toEqual(['ally']);
  });
});
