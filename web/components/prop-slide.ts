export interface CellXY {
  x: number;
  y: number;
}

/**
 * Detect a single obstacle that was PUSHED (relocated one cell) between two
 * prop-layer renders, so the Board can tween its sprite from the old cell to the
 * new one instead of snapping.
 *
 * A push relocates exactly one live obstacle: its old cell disappears from the
 * obstacle set WITHOUT being destroyed (the `from`), and one new cell appears
 * (the `to`). Returns null for:
 *  - a destruction (the vanished cell is in `destroyed` — the cask/spire is gone, not moved),
 *  - a no-op (positions unchanged), or
 *  - any ambiguous multi-cell change (more than one cell in or out).
 *
 * Pure — unit-tested independently of Pixi.
 */
export const detectPushedObstacle = (
  prevCells: ReadonlySet<string>,
  currObstacles: ReadonlyArray<{ x: number; y: number }>,
  destroyed: ReadonlyArray<{ x: number; y: number }>,
): { from: CellXY; to: CellXY } | null => {
  const curr = new Set(currObstacles.map((o) => `${o.x},${o.y}`));
  const dead = new Set(destroyed.map((d) => `${d.x},${d.y}`));
  const from = [...prevCells].filter((c) => !curr.has(c) && !dead.has(c));
  const to = [...curr].filter((c) => !prevCells.has(c));
  if (from.length !== 1 || to.length !== 1) return null;
  const [fx, fy] = from[0]!.split(',').map(Number) as [number, number];
  const [tx, ty] = to[0]!.split(',').map(Number) as [number, number];
  return { from: { x: fx, y: fy }, to: { x: tx, y: ty } };
};
