import { describe, it, expect } from 'vitest';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { MoveField } from '../../web/components/pathfinder.js';
import {
  splitTargetIds,
  addDie,
  removeDie,
  allocTotal,
  budgetLeft,
  diceSplitParams,
  type SplitPlan,
  type Allocation,
} from '../../web/components/special-alloc.js';

const ch = (
  id: string, x: number, y: number,
  status: 'normal' | 'prone' | 'KO' | 'immobilized' = 'normal',
): RedactedCharacter =>
  ({ id, name: id, kind: 'monster', pos: { x, y }, health: { total: 3, damage: 0, status } } as unknown as RedactedCharacter);

const openField = (w: number, h: number, walls: Array<{ x: number; y: number }> = []): MoveField =>
  ({ gridW: w, gridH: h, walls, enemies: [], allies: [] });

const MELEE: SplitPlan = { attackKind: 'melee', pool: 2, range: 1, requiresLos: false };
const RANGED: SplitPlan = { attackKind: 'ranged', pool: 2, range: 6, requiresLos: true };

describe('splitTargetIds — engine-accurate target validity', () => {
  it('melee whirlwind: only EXACTLY-adjacent living non-self targets', () => {
    const me = ch('me', 5, 5);
    const adjacent = ch('a', 5, 6); // dist 1
    const diagonal = ch('b', 6, 6); // dist 1 (Chebyshev)
    const far = ch('c', 5, 7);      // dist 2 — out
    const dead = ch('d', 4, 5, 'KO'); // adjacent but KO'd — out
    const ids = splitTargetIds(me, [me, adjacent, diagonal, far, dead], MELEE, openField(10, 10));
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('ranged split-shot: within range, excludes out-of-range and self', () => {
    const me = ch('me', 0, 0);
    const near = ch('n', 4, 0);  // dist 4 ≤ 6
    const edge = ch('e', 6, 0);  // dist 6 ≤ 6
    const over = ch('o', 7, 0);  // dist 7 > 6 — out
    const ids = splitTargetIds(me, [me, near, edge, over], RANGED, openField(12, 4));
    expect(ids.sort()).toEqual(['e', 'n']);
  });

  it('ranged split-shot: a wall between actor and target blocks line of sight', () => {
    const me = ch('me', 0, 0);
    const behindWall = ch('w', 4, 0); // wall at (2,0) sits on the line
    const clear = ch('k', 0, 4);      // clear column
    const field = openField(8, 8, [{ x: 2, y: 0 }]);
    const ids = splitTargetIds(me, [me, behindWall, clear], RANGED, field);
    expect(ids).toEqual(['k']); // 'w' is occluded by the wall
  });
});

describe('dice allocation accumulation', () => {
  it('addDie accumulates per target and never exceeds the pool', () => {
    let a: Allocation[] = [];
    a = addDie(a, 'x', 2);
    expect(a).toEqual([{ id: 'x', dice: 1 }]);
    a = addDie(a, 'y', 2);
    expect(allocTotal(a)).toBe(2);
    a = addDie(a, 'x', 2); // pool already spent — no-op
    expect(allocTotal(a)).toBe(2);
    expect(a).toEqual([{ id: 'x', dice: 1 }, { id: 'y', dice: 1 }]);
  });

  it('two dice can stack onto a single target', () => {
    let a: Allocation[] = [];
    a = addDie(a, 'x', 2);
    a = addDie(a, 'x', 2);
    expect(a).toEqual([{ id: 'x', dice: 2 }]);
    expect(diceSplitParams(a)).toEqual({ x: 2 });
  });

  it('removeDie decrements and drops the entry at zero', () => {
    let a: Allocation[] = [{ id: 'x', dice: 2 }, { id: 'y', dice: 1 }];
    a = removeDie(a, 'x');
    expect(a).toEqual([{ id: 'x', dice: 1 }, { id: 'y', dice: 1 }]);
    a = removeDie(a, 'y');
    expect(a).toEqual([{ id: 'x', dice: 1 }]);
    a = removeDie(a, 'z'); // unknown id — no-op
    expect(a).toEqual([{ id: 'x', dice: 1 }]);
  });

  it('budgetLeft reports remaining dice and never goes negative', () => {
    expect(budgetLeft([], 2)).toBe(2);
    expect(budgetLeft([{ id: 'x', dice: 1 }], 2)).toBe(1);
    expect(budgetLeft([{ id: 'x', dice: 2 }], 2)).toBe(0);
    expect(budgetLeft([{ id: 'x', dice: 3 }], 2)).toBe(0);
  });

  it('diceSplitParams maps preserved target order to dice counts', () => {
    expect(diceSplitParams([{ id: 'a', dice: 1 }, { id: 'b', dice: 1 }])).toEqual({ a: 1, b: 1 });
  });
});
