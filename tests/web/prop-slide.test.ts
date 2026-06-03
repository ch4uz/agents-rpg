import { describe, it, expect } from 'vitest';
import { detectPushedObstacle } from '../../web/components/prop-slide.js';

const cells = (...xy: [number, number][]): Set<string> =>
  new Set(xy.map(([x, y]) => `${x},${y}`));
const obs = (...xy: [number, number][]) => xy.map(([x, y]) => ({ x, y }));

describe('detectPushedObstacle', () => {
  it('detects a clean push: one cell out (not destroyed) + one cell in', () => {
    // Cask at (4,5) shoved to (5,5); the stalagmite wall is unchanged.
    const prev = cells([4, 5], [6, 3], [6, 4], [6, 5]);
    const curr = obs([5, 5], [6, 3], [6, 4], [6, 5]);
    expect(detectPushedObstacle(prev, curr, [])).toEqual({ from: { x: 4, y: 5 }, to: { x: 5, y: 5 } });
  });

  it('returns null for a destruction (the vanished cell is destroyed, not moved)', () => {
    // Cask at (5,5) detonates and demolishes (6,4),(6,5),(6,6) — all destroyed.
    const prev = cells([5, 5], [6, 3], [6, 4], [6, 5], [6, 6], [6, 7]);
    const curr = obs([6, 3], [6, 7]);
    const destroyed = obs([5, 5], [6, 4], [6, 5], [6, 6]);
    expect(detectPushedObstacle(prev, curr, destroyed)).toBeNull();
  });

  it('returns null when nothing moved', () => {
    const prev = cells([4, 5], [6, 3]);
    const curr = obs([4, 5], [6, 3]);
    expect(detectPushedObstacle(prev, curr, [])).toBeNull();
  });

  it('returns null for an ambiguous multi-cell change (no single from/to pair)', () => {
    const prev = cells([4, 5], [4, 6]);
    const curr = obs([5, 5], [5, 6]);
    expect(detectPushedObstacle(prev, curr, [])).toBeNull();
  });

  it('returns null on first sight (no previous cells)', () => {
    expect(detectPushedObstacle(new Set(), obs([4, 5], [6, 3]), [])).toBeNull();
  });
});
