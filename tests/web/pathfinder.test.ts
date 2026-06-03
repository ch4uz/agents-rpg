import { describe, it, expect } from 'vitest';
import { findPath, findReachable, type MoveField } from '../../web/components/pathfinder.js';

/**
 * The browser pathfinder delegates to the engine's `Grid` (8-connected, walls
 * /rock impassable, every live character — enemies AND allies — blocks transit
 * and end). These tests pin that parity — they assert DIAGONAL movement and
 * that living characters of either side are impassable, NOT the old
 * 4-connected behaviour (and NOT the retired walk-through-allies rule).
 */

const open = (gridW: number, gridH: number, over?: Partial<MoveField>): MoveField => ({
  gridW, gridH, walls: [], rock: [], enemies: [], allies: [], ...over,
});
const has = (cells: ReadonlyArray<{ x: number; y: number }>, x: number, y: number) =>
  cells.some((c) => c.x === x && c.y === y);

describe('findPath (engine-parity, 8-connected)', () => {
  it('returns the start cell alone when from === to', () => {
    expect(findPath({ x: 2, y: 3 }, { x: 2, y: 3 }, open(5, 5), 4)).toEqual([{ x: 2, y: 3 }]);
  });

  it('finds a straight 3-step path on an open grid', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 3, y: 0 }, open(5, 5), 4);
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  });

  it('takes a diagonal shortcut (8-connected): (0,0)→(2,2) in 2 steps', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, open(5, 5), 4);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(3); // start + 2 diagonal steps
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path![2]).toEqual({ x: 2, y: 2 });
  });

  it('routes diagonally around a wall: (0,0)→(2,0) past a wall at (1,0)', () => {
    // 8-connected: (0,0)→(1,1)→(2,0) is length 3 (vs 5 on a 4-connected grid).
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, open(5, 5, { walls: [{ x: 1, y: 0 }] }), 4);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(3);
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
  });

  it('returns null when destination is out of bounds', () => {
    expect(findPath({ x: 0, y: 0 }, { x: 5, y: 0 }, open(5, 5), 8)).toBeNull();
  });

  it('returns null when the destination is itself a wall', () => {
    expect(findPath({ x: 0, y: 0 }, { x: 1, y: 0 }, open(5, 5, { walls: [{ x: 1, y: 0 }] }), 4)).toBeNull();
  });

  it('returns null when the path would exceed the move budget', () => {
    // 5 cells of distance, budget 4 → unreachable even diagonally on a row.
    expect(findPath({ x: 0, y: 0 }, { x: 5, y: 0 }, open(10, 10), 4)).toBeNull();
  });

  it('returns null when the destination is walled off on all EIGHT neighbours', () => {
    // 8-connected: the diagonal neighbours must be walled too, or a path slips
    // through a corner (the engine does NOT prevent corner-cutting).
    const walls = [
      { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 },
      { x: 3, y: 4 },                 { x: 5, y: 4 },
      { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 },
    ];
    expect(findPath({ x: 0, y: 0 }, { x: 4, y: 4 }, open(10, 10, { walls }), 20)).toBeNull();
  });

  it('cannot path through a live enemy, but can reach past it diagonally', () => {
    // Enemy at (1,1) blocks that cell; (0,0)→(1,0)→(2,1) detours around it.
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, open(5, 5, { enemies: [{ x: 1, y: 1 }] }), 4);
    expect(path).not.toBeNull();
    expect(path!.some((c) => c.x === 1 && c.y === 1)).toBe(false); // never steps on the enemy
  });

  it('cannot path through a live ally (blocks transit and end, like an enemy)', () => {
    // 1-row corridor: the only route to (2,0) runs over the ally at (1,0),
    // which now blocks transit — so both the pass-through and the end are null.
    const ally = open(3, 1, { allies: [{ x: 1, y: 0 }] });
    expect(findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, ally, 4)).toBeNull(); // can't pass through
    expect(findPath({ x: 0, y: 0 }, { x: 1, y: 0 }, ally, 4)).toBeNull(); // can't END on ally
  });

  it('detours around a live ally when the grid affords a diagonal route', () => {
    // Open grid: ally at (1,0) is impassable, but (2,0) is still reachable via
    // (0,0)→(1,1)→(2,0). The chosen path must never step on the ally.
    const ally = open(5, 5, { allies: [{ x: 1, y: 0 }] });
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, ally, 4);
    expect(path).not.toBeNull();
    expect(path!.some((c) => c.x === 1 && c.y === 0)).toBe(false); // never steps on the ally
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
  });
});

describe('findReachable (engine-parity, 8-connected)', () => {
  it('returns all 8 neighbours for budget 1 on an open grid', () => {
    const reach = findReachable({ x: 2, y: 2 }, open(5, 5), 1);
    expect(reach).toHaveLength(8);
    expect(reach).toEqual(expect.arrayContaining([
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
      { x: 1, y: 2 },                 { x: 3, y: 2 },
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    ]));
  });

  it('excludes the start cell and wall cells', () => {
    const reach = findReachable({ x: 0, y: 0 }, open(5, 5, { walls: [{ x: 1, y: 0 }] }), 2);
    expect(has(reach, 0, 0)).toBe(false); // start excluded
    expect(has(reach, 1, 0)).toBe(false); // wall excluded
    expect(has(reach, 0, 1)).toBe(true);  // reachable
    expect(has(reach, 1, 1)).toBe(true);  // reachable diagonally
  });

  it('respects edges of the grid (corner has 3 neighbours diagonally)', () => {
    const reach = findReachable({ x: 0, y: 0 }, open(3, 3), 1);
    expect(reach).toHaveLength(3);
    expect(reach).toEqual(expect.arrayContaining([
      { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
    ]));
  });

  it('cannot reach past a live ally that blocks the only corridor', () => {
    // 1-row corridor with ally at (1,0): a living teammate blocks transit, so
    // neither the ally's cell nor anything beyond it is reachable.
    const reach = findReachable({ x: 0, y: 0 }, open(3, 1, { allies: [{ x: 1, y: 0 }] }), 4);
    expect(has(reach, 1, 0)).toBe(false); // can't end on the ally
    expect(has(reach, 2, 0)).toBe(false); // and can't pass through to here
  });

  it('cannot reach past a live enemy that blocks the only corridor', () => {
    const reach = findReachable({ x: 0, y: 0 }, open(3, 1, { enemies: [{ x: 1, y: 0 }] }), 4);
    expect(has(reach, 1, 0)).toBe(false); // enemy cell blocked
    expect(has(reach, 2, 0)).toBe(false); // and nothing beyond it (no detour in a 1-row grid)
  });
});
