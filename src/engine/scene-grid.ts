import { Grid, type GridCell } from './grid.js';
import type { Scene } from './adventure.js';

/**
 * Construct a Grid from a Scene, honoring `map.obstacles[]` and
 * `map.wallCells[]`. An obstacle becomes a `cover-wall` cell when it is flagged
 * `cover: true` (a SOLID cover obstacle — blocks movement like a barrel stack
 * does, but does NOT block line of sight: a shot fired across it lands and
 * grants the target +1 armor) and a full-blocking `wall` cell otherwise (the
 * default barrier — barrel barricades, the rat-tunnel breach — which blocks
 * movement AND sight). Both kinds are destructible via `attack_object`. Every
 * `wallCells` entry becomes an indestructible `rock` cell — the carved
 * cave/ledge terrain — which blocks like a wall but cannot be smashed.
 * `decorations[]` and `exits[]` cells remain `floor`.
 */
export const buildSceneGrid = (scene: Scene): Grid => {
  const { width, height, obstacles, wallCells } = scene.map;
  const inBounds = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height;
  const cells: GridCell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ kind: 'floor' as const })),
  );
  for (const r of wallCells ?? []) {
    if (inBounds(r.x, r.y)) cells[r.y]![r.x] = { kind: 'rock' };
  }
  // Obstacles override rock on a shared cell — they're the destructible layer.
  // `cover` obstacles are solid cover (`cover-wall`: block movement, shoot-through);
  // the rest are full barriers (`wall`: block movement AND sight).
  for (const o of obstacles) {
    if (inBounds(o.x, o.y)) cells[o.y]![o.x] = { kind: o.cover ? 'cover-wall' : 'wall' };
  }
  return new Grid(cells);
};
