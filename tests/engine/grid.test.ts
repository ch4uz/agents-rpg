import { describe, it, expect } from 'vitest';
import { Grid, type GridCell, type MoveContext, blocksMovement, blocksSight } from '../../src/engine/grid.js';

const empty = (w: number, h: number): GridCell[][] =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => ({ kind: 'floor' as const })));

describe('Grid', () => {
  it('isAdjacent: 8-directional including diagonals', () => {
    const g = new Grid(empty(5, 5));
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 3, y: 3 })).toBe(true);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 2, y: 3 })).toBe(true);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 4, y: 4 })).toBe(false);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(false);
  });

  it('inBounds rejects out-of-range coords', () => {
    const g = new Grid(empty(3, 3));
    expect(g.inBounds({ x: 0, y: 0 })).toBe(true);
    expect(g.inBounds({ x: 2, y: 2 })).toBe(true);
    expect(g.inBounds({ x: -1, y: 0 })).toBe(false);
    expect(g.inBounds({ x: 3, y: 0 })).toBe(false);
  });

  it('reachable squares within budget exclude walls and enemies', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'wall' };
    const g = new Grid(cells);
    const ctx: MoveContext = {
      enemyPositions: new Set(['1,1']),
      allyPositions: new Set(),
    };
    const reach = g.reachable({ x: 0, y: 0 }, 2, ctx);
    expect(reach.has('0,0')).toBe(false);   // start excluded
    expect(reach.has('1,0')).toBe(true);
    expect(reach.has('2,2')).toBe(false);   // wall
    expect(reach.has('1,1')).toBe(false);   // enemy occupies, cannot end there
    expect(reach.has('3,3')).toBe(false);   // out of budget
  });

  it('reachable: a live ally blocks transit (cannot pass through a teammate)', () => {
    // 1-row corridor: the ally at (1,0) is the only route to (2,0). A living
    // teammate blocks both transit and the destination, so neither is reachable.
    const g = new Grid(empty(3, 1));
    const ctx: MoveContext = {
      enemyPositions: new Set(),
      allyPositions: new Set(['1,0']),
    };
    const reach = g.reachable({ x: 0, y: 0 }, 4, ctx);
    expect(reach.has('1,0')).toBe(false);   // can't end on the ally
    expect(reach.has('2,0')).toBe(false);   // and can't pass through to here
  });

  it('reachable: routes AROUND a live ally when the grid allows a detour', () => {
    // Open grid: the ally at (1,0) is impassable, but (2,0) is still reachable
    // by going around it diagonally (0,0)→(1,1)→(2,0).
    const g = new Grid(empty(5, 5));
    const ctx: MoveContext = {
      enemyPositions: new Set(),
      allyPositions: new Set(['1,0']),
    };
    const reach = g.reachable({ x: 0, y: 0 }, 4, ctx);
    expect(reach.has('1,0')).toBe(false);   // can't end on the ally
    expect(reach.has('2,0')).toBe(true);    // reachable via the diagonal detour
  });

  it('obstacles cost +1 movement to enter', () => {
    const cells = empty(5, 5);
    cells[0]![1] = { kind: 'obstacle' };  // (1,0) obstacle
    cells[1]![0] = { kind: 'wall' };      // (0,1) wall
    cells[1]![1] = { kind: 'wall' };      // (1,1) wall
    const g = new Grid(cells);
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    const reach = g.reachable({ x: 0, y: 0 }, 2, ctx);
    // (1,0) obstacle costs 2. Path to (2,0) would be (1,0)+1=3, exceeds budget 2.
    expect(reach.has('1,0')).toBe(true);
    expect(reach.has('2,0')).toBe(false);
  });

  it('lineOfSight: clear when no walls between', () => {
    const g = new Grid(empty(5, 5));
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: false, cover: false });
  });

  it('lineOfSight: walls block', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'wall' };
    const g = new Grid(cells);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: true, cover: false });
  });

  it('cover-wall blocks movement but NOT sight (solid cover: walk-stop, shoot-through)', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'cover-wall' }; // a solid cover barrel at (2,2)
    const g = new Grid(cells);
    // Impassable for movement — unlike a plain `obstacle`, you cannot walk onto
    // or through it. `blocksMovement` true; `reachable` excludes it.
    expect(blocksMovement(g.cellAt({ x: 2, y: 2 }))).toBe(true);
    expect(blocksSight(g.cellAt({ x: 2, y: 2 }))).toBe(false);
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    expect(g.reachable({ x: 1, y: 2 }, 3, ctx).has('2,2')).toBe(false);
    expect(g.shortestPath({ x: 1, y: 2 }, { x: 2, y: 2 }, 4, ctx)).toBeNull();
    // See-through for line of sight: a shot across it lands and grants cover.
    expect(g.lineOfSight({ x: 0, y: 2 }, { x: 4, y: 2 })).toEqual({ blocked: false, cover: true });
  });

  it('lineOfSight: obstacles grant cover but do not block', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'obstacle' };
    const g = new Grid(cells);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: false, cover: true });
  });

  it('shortestPath: returns full inclusive path on a clear grid', () => {
    const g = new Grid(empty(5, 5));
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    const path = g.shortestPath({ x: 0, y: 0 }, { x: 2, y: 2 }, 4, ctx);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 2 });
    // 8-connected diagonal: chebyshev distance 2 → length 3 (incl. endpoints).
    expect(path).toHaveLength(3);
  });

  it('shortestPath: returns null when destination is over budget', () => {
    const g = new Grid(empty(8, 8));
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    expect(g.shortestPath({ x: 0, y: 0 }, { x: 7, y: 7 }, 4, ctx)).toBeNull();
  });

  it('shortestPath: returns null when destination is an ally cell', () => {
    const g = new Grid(empty(5, 5));
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set(['2,2']) };
    expect(g.shortestPath({ x: 0, y: 0 }, { x: 2, y: 2 }, 4, ctx)).toBeNull();
  });

  it('shortestPath: returns null when a live ally blocks the only corridor', () => {
    // 1-row corridor: ally at (1,0) blocks transit, so (2,0) is unreachable.
    const g = new Grid(empty(3, 1));
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set(['1,0']) };
    expect(g.shortestPath({ x: 0, y: 0 }, { x: 2, y: 0 }, 4, ctx)).toBeNull();
  });

  it('shortestPath: detours around a live ally rather than crossing it', () => {
    const g = new Grid(empty(5, 5));
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set(['1,0']) };
    const path = g.shortestPath({ x: 0, y: 0 }, { x: 2, y: 0 }, 4, ctx);
    expect(path).not.toBeNull();
    expect(path!.some((s) => s.x === 1 && s.y === 0)).toBe(false); // never steps on the ally
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
  });

  it('shortestPath: routes around walls', () => {
    const cells = empty(5, 5);
    for (let y = 0; y < 5; y++) cells[y]![2] = { kind: 'wall' };
    cells[4]![2] = { kind: 'floor' };
    const g = new Grid(cells);
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    const path = g.shortestPath({ x: 0, y: 0 }, { x: 4, y: 0 }, 8, ctx);
    expect(path).not.toBeNull();
    // Must thread through the only gap at column-2.
    expect(path!.some((s) => s.x === 2 && s.y === 4)).toBe(true);
  });
});
