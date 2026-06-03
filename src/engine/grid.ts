import { type Square, chebyshevDistance } from './primitives.js';

export type GridCell =
  | { kind: 'floor' }
  | { kind: 'wall' }
  | { kind: 'rock' }
  | { kind: 'obstacle' }
  | { kind: 'cover-wall' };

/**
 * True when a cell blocks MOVEMENT. `wall` (destructible scene barriers, e.g.
 * the central barrel-barricade), `rock` (indestructible cave terrain from
 * `map.wallCells`), and `cover-wall` (a destructible SOLID-COVER obstacle — a
 * barrel stack you cannot walk through but CAN shoot past) all stop you. A plain
 * `obstacle` cell is walkable (+1 step cost) low cover and does NOT block.
 * (`wall`/`cover-wall` are smashable via `attack_object`; `rock` is not.)
 */
export const blocksMovement = (cell: GridCell): boolean =>
  cell.kind === 'wall' || cell.kind === 'rock' || cell.kind === 'cover-wall';

/**
 * True when a cell blocks LINE OF SIGHT (a ranged/magic shot cannot pass). Only
 * the opaque barriers — `wall` and `rock` — block sight. `obstacle` and
 * `cover-wall` are see-through: a shot fired across them lands but grants the
 * target cover (+1 armor die). Deliberately NARROWER than `blocksMovement`, so a
 * `cover-wall` stops a walker yet still lets an archer fire through for the bonus.
 */
export const blocksSight = (cell: GridCell): boolean =>
  cell.kind === 'wall' || cell.kind === 'rock';

/** Cells that grant the engine's +1-armor cover bonus to a shot crossing them. */
export const grantsCover = (cell: GridCell): boolean =>
  cell.kind === 'obstacle' || cell.kind === 'cover-wall';

/**
 * True when a cell holds a DESTRUCTIBLE scene obstacle that `attack_object` /
 * `push_object` can target — the `wall`, `obstacle`, and `cover-wall` kinds.
 * Excludes `rock` (indestructible cave terrain) and `floor`.
 */
export const isDestructibleObstacleCell = (cell: GridCell): boolean =>
  cell.kind === 'wall' || cell.kind === 'obstacle' || cell.kind === 'cover-wall';

export interface MoveContext {
  /** Squares currently occupied by live enemies (block transit AND end). */
  enemyPositions: ReadonlySet<string>;
  /**
   * Squares currently occupied by live allies. Like enemies, they block both
   * transit and the destination — you cannot move through a living teammate.
   * (KO'd corpses are excluded by the caller, so they remain walk-through.)
   */
  allyPositions: ReadonlySet<string>;
}

export interface SightResult {
  blocked: boolean;
  cover: boolean;
}

const key = (s: Square): string => `${s.x},${s.y}`;

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

export class Grid {
  readonly width: number;
  readonly height: number;

  constructor(private readonly cells: GridCell[][]) {
    this.height = cells.length;
    this.width = cells[0]?.length ?? 0;
  }

  inBounds(s: Square): boolean {
    return s.x >= 0 && s.x < this.width && s.y >= 0 && s.y < this.height;
  }

  cellAt(s: Square): GridCell {
    if (!this.inBounds(s)) return { kind: 'wall' };
    return this.cells[s.y]![s.x]!;
  }

  /**
   * Flip a wall or obstacle cell to floor. Used when an obstacle is destroyed
   * mid-scene (e.g. a hero smashes a barrel). No-op when the cell is already
   * floor or out of bounds. The grid is otherwise treated as read-only; this
   * is the single sanctioned mutation, gated by `GameEngine.applyAction`.
   */
  clearCell(s: Square): void {
    if (!this.inBounds(s)) return;
    const row = this.cells[s.y]!;
    const c = row[s.x]!;
    if (c.kind === 'floor') return;
    row[s.x] = { kind: 'floor' };
  }

  /**
   * Set a cell's kind. The sanctioned counterpart to `clearCell`, used when a
   * `push_object` relocates an obstacle onto a (currently floor) destination —
   * the caller pairs `setCell(dest, sourceCell)` with `clearCell(source)`. Like
   * `clearCell`, gated by `GameEngine.applyAction`; no-op out of bounds.
   */
  setCell(s: Square, cell: GridCell): void {
    if (!this.inBounds(s)) return;
    this.cells[s.y]![s.x] = cell;
  }

  isAdjacent(a: Square, b: Square): boolean {
    if (a.x === b.x && a.y === b.y) return false;
    return chebyshevDistance(a, b) === 1;
  }

  /**
   * Set of squares reachable from `start` within `budget` movement.
   * Live characters block — allies AND enemies are impassable, so you can
   * neither move through nor end on either. Walls block. Obstacles cost +1 to
   * enter. (KO'd corpses are excluded from the context, so they stay walkable.)
   */
  reachable(start: Square, budget: number, ctx: MoveContext): Set<string> {
    const dist = new Map<string, number>();
    dist.set(key(start), 0);
    const queue: Square[] = [start];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curDist = dist.get(key(cur))!;

      for (const [dx, dy] of NEIGHBORS) {
        const nx = cur.x + dx!;
        const ny = cur.y + dy!;
        const next: Square = { x: nx, y: ny };
        const k = key(next);
        if (!this.inBounds(next)) continue;

        const cell = this.cellAt(next);
        if (blocksMovement(cell)) continue;
        // Live characters block every cell — no passing through a teammate or foe.
        if (ctx.enemyPositions.has(k)) continue;
        if (ctx.allyPositions.has(k)) continue;

        const stepCost = cell.kind === 'obstacle' ? 2 : 1;
        const newDist = curDist + stepCost;
        if (newDist > budget) continue;

        const known = dist.get(k);
        if (known !== undefined && known <= newDist) continue;

        dist.set(k, newDist);
        queue.push(next);
      }
    }

    // Drop the start square (staying put is not "reaching" a new cell).
    dist.delete(key(start));
    return new Set(dist.keys());
  }

  /**
   * Shortest 8-connected path from `from` to `to`, respecting the same
   * passability rules as `reachable` (walls block, and every live character —
   * allies AND enemies — blocks all cells, so the path can neither cross nor
   * end on one; obstacles cost +1 to enter on top of the base step cost).
   * Returns the full path including both endpoints, or null if no path within
   * `budget` exists.
   *
   * The returned path is guaranteed to be accepted by `GameEngine.applyAction`
   * with `kind: 'move'` (same enemy/ally/wall/budget contract). When `from`
   * and `to` are the same square, returns `[from]` (engine will reject this
   * as too short, but the AI checks length before submitting).
   */
  shortestPath(
    from: Square, to: Square, budget: number, ctx: MoveContext,
  ): Square[] | null {
    if (!this.inBounds(to)) return null;
    if (from.x === to.x && from.y === to.y) return [from];
    const startKey = key(from);
    const dist = new Map<string, number>([[startKey, 0]]);
    const parent = new Map<string, Square | null>([[startKey, null]]);
    const queue: Square[] = [from];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curDist = dist.get(key(cur))!;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cur.x + dx!;
        const ny = cur.y + dy!;
        const next: Square = { x: nx, y: ny };
        const k = key(next);
        if (!this.inBounds(next)) continue;
        const cell = this.cellAt(next);
        if (blocksMovement(cell)) continue;
        // Live characters (allies AND enemies) block every cell, transit or end.
        if (ctx.enemyPositions.has(k)) continue;
        if (ctx.allyPositions.has(k)) continue;

        const stepCost = cell.kind === 'obstacle' ? 2 : 1;
        const newDist = curDist + stepCost;
        if (newDist > budget) continue;

        const known = dist.get(k);
        if (known !== undefined && known <= newDist) continue;
        dist.set(k, newDist);
        parent.set(k, cur);
        queue.push(next);
      }
    }

    const destKey = key(to);
    if (!dist.has(destKey)) return null;
    const out: Square[] = [];
    let cur: Square | null = to;
    while (cur) {
      out.unshift(cur);
      cur = parent.get(key(cur)) ?? null;
    }
    return out;
  }

  /**
   * Line-of-sight via supercover line walk. Opaque cells (`wall` / `rock`) in
   * intermediate squares block; `obstacle` and `cover-wall` cells grant cover
   * (do not block). The endpoints themselves do not contribute (you can shoot
   * something hiding behind a barrel — or a foe standing on a cover-wall cell).
   * Note this uses `blocksSight`, NOT `blocksMovement`: a `cover-wall` stops a
   * walker but a shot still passes through it for the cover bonus.
   */
  lineOfSight(from: Square, to: Square): SightResult {
    const path = this.supercover(from, to);
    let cover = false;
    // Skip endpoints (first and last).
    for (let i = 1; i < path.length - 1; i++) {
      const cell = this.cellAt(path[i]!);
      if (blocksSight(cell)) return { blocked: true, cover: false };
      if (grantsCover(cell)) cover = true;
    }
    return { blocked: false, cover };
  }

  private supercover(a: Square, b: Square): Square[] {
    const out: Square[] = [];
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1;
    const sy = a.y < b.y ? 1 : -1;
    let err = dx - dy;
    out.push({ x, y });
    while (x !== b.x || y !== b.y) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx)  { err += dx; y += sy; }
      out.push({ x, y });
    }
    return out;
  }
}
