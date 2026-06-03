import { describe, it, expect } from 'vitest';
import { squaresEqual, manhattanDistance, chebyshevDistance } from '../../src/engine/primitives.js';

describe('primitives', () => {
  it('squaresEqual returns true for identical squares', () => {
    expect(squaresEqual({ x: 3, y: 5 }, { x: 3, y: 5 })).toBe(true);
  });
  it('squaresEqual returns false for different squares', () => {
    expect(squaresEqual({ x: 3, y: 5 }, { x: 3, y: 6 })).toBe(false);
  });
  it('manhattanDistance counts orthogonal steps', () => {
    expect(manhattanDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
  });
  it('chebyshevDistance counts diagonal-allowed steps (HeroKids movement)', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4);
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
  });
});
