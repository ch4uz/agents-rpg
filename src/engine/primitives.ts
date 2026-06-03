export interface Square {
  readonly x: number;
  readonly y: number;
}

export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export const squaresEqual = (a: Square, b: Square): boolean => a.x === b.x && a.y === b.y;

export const manhattanDistance = (a: Square, b: Square): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Chebyshev distance counts diagonals as one step — matches HeroKids movement
 * (4 squares per turn including diagonals).
 */
export const chebyshevDistance = (a: Square, b: Square): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
