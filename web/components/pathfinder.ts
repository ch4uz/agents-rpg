import { Grid, type GridCell } from '../../src/engine/grid.js';

export interface Cell { x: number; y: number }

/**
 * Everything the browser needs to reconstruct the engine's movement grid +
 * MoveContext for ONE acting character. The highlight (`findReachable`) and the
 * path it submits (`findPath`) then call the engine's OWN `Grid.reachable` /
 * `Grid.shortestPath`, so the browser highlight is identical to what the server
 * will accept — 8-connected, walls/rock impassable, every live character
 * (enemies AND allies) blocks transit and end (you cannot move through a living
 * teammate or foe), KO'd corpses fully passable. There is no parallel BFS to
 * drift from the engine.
 */
export interface MoveField {
  gridW: number;
  gridH: number;
  /** Live (un-smashed) scene obstacles → full-block `wall` cells. */
  walls: ReadonlyArray<Cell>;
  /** Indestructible cave rock (`map.wallCells`) → `rock` cells. */
  rock?: ReadonlyArray<Cell>;
  /** Live enemy positions (opposite kind): block transit AND end. */
  enemies: ReadonlyArray<Cell>;
  /** Live ally positions (same kind, not self): block transit AND end. */
  allies: ReadonlyArray<Cell>;
}

const key = (c: Cell): string => `${c.x},${c.y}`;
const parse = (k: string): Cell => {
  const [x, y] = k.split(',').map(Number) as [number, number];
  return { x, y };
};

/**
 * Rebuild the engine Grid for `field`, matching `buildSceneGrid`: floor
 * everywhere, `wallCells` → rock, then obstacles → wall (obstacles override
 * rock on a shared cell, the destructible layer).
 */
const buildGrid = (field: MoveField): Grid => {
  const cells: GridCell[][] = Array.from({ length: field.gridH }, () =>
    Array.from({ length: field.gridW }, () => ({ kind: 'floor' as const })),
  );
  const inBounds = (c: Cell): boolean =>
    c.x >= 0 && c.x < field.gridW && c.y >= 0 && c.y < field.gridH;
  for (const r of field.rock ?? []) if (inBounds(r)) cells[r.y]![r.x] = { kind: 'rock' };
  for (const w of field.walls)     if (inBounds(w)) cells[w.y]![w.x] = { kind: 'wall' };
  return new Grid(cells);
};

const contextOf = (field: MoveField) => ({
  enemyPositions: new Set(field.enemies.map(key)),
  allyPositions: new Set(field.allies.map(key)),
});

/**
 * Every cell the actor at `from` could legally end its move on this turn —
 * the "walkable" highlight. Delegates to the engine `Grid.reachable`, so the
 * highlight matches the server's move validation exactly. The start cell and
 * any cell behind a live character (ally or enemy) are excluded — living
 * characters block the path, so you can neither cross nor end on them. A
 * smashed-obstacle cell or a KO'd corpse cell IS included (the engine lets you
 * end on them).
 */
export const findReachable = (from: Cell, field: MoveField, budget: number): Cell[] =>
  [...buildGrid(field).reachable(from, budget, contextOf(field))].map(parse);

/**
 * Shortest engine-legal path from `from` to `to` within `budget`, or null when
 * none exists. Delegates to `Grid.shortestPath`; the returned path is
 * guaranteed acceptable by the server's `move` validation (same 8-connected
 * enemy/ally/wall/budget contract). Returns `[from]` when from === to (the
 * caller checks length before submitting).
 */
export const findPath = (
  from: Cell, to: Cell, field: MoveField, budget: number,
): Cell[] | null => buildGrid(field).shortestPath(from, to, budget, contextOf(field));

/**
 * True iff `from` has unobstructed line of sight to `to` on `field`'s grid.
 * Delegates to the engine's own `Grid.lineOfSight` (supercover walk, blocked
 * by walls/rock), so the browser's ranged-special target gating matches the
 * server's `resolveSplitTargets` LoS check exactly. Obstacle cells are built
 * as full-block `wall`s here (matching `buildSceneGrid`), so they block sight
 * just as they do on the server.
 */
export const hasLineOfSight = (from: Cell, to: Cell, field: MoveField): boolean =>
  !buildGrid(field).lineOfSight(from, to).blocked;
