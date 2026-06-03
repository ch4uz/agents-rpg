import { describe, it, expect } from 'vitest';
import { explosionCells } from '../../web/components/Explosion.js';

const key = (c: { x: number; y: number }): string => `${c.x},${c.y}`;

describe('explosionCells', () => {
  it('covers the full Chebyshev radius-1 square (9 cells) when fully in-bounds', () => {
    const cells = explosionCells({ x: 4, y: 4 }, 1, 13, 9);
    expect(cells).toHaveLength(9);
    expect(cells.map(key).sort()).toEqual(
      ['3,3', '3,4', '3,5', '4,3', '4,4', '4,5', '5,3', '5,4', '5,5'].sort(),
    );
  });

  it('clips cells that fall off the grid at a corner', () => {
    const cells = explosionCells({ x: 0, y: 0 }, 1, 8, 8);
    // Only the in-bounds quadrant of the 3x3 survives.
    expect(cells.map(key).sort()).toEqual(['0,0', '0,1', '1,0', '1,1'].sort());
  });

  it('clips cells off the right/bottom edge', () => {
    // Cask at (12,8) on a 13x9 grid (the SE-most cell) → only the NW 2x2 stays.
    const cells = explosionCells({ x: 12, y: 8 }, 1, 13, 9);
    expect(cells.map(key).sort()).toEqual(['11,7', '11,8', '12,7', '12,8'].sort());
  });

  it('scales to a larger radius (radius 2 → up to 25 cells)', () => {
    const cells = explosionCells({ x: 5, y: 5 }, 2, 13, 9);
    expect(cells).toHaveLength(25);
    // The origin is always included.
    expect(cells.map(key)).toContain('5,5');
    // A corner of the 5x5 footprint.
    expect(cells.map(key)).toContain('3,3');
    expect(cells.map(key)).toContain('7,7');
  });
});
