/**
 * Deterministic d6 roller. Uses mulberry32 — chosen for byte-identical
 * output across platforms (Node, browser, any JS runtime). Replay
 * determinism is the requirement; PRNG quality is secondary.
 */
export class Dice {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? Dice.hashSeed(seed) : seed >>> 0;
  }

  /** djb2-ish string hash → uint32 */
  private static hashSeed(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Mulberry32 — returns float in [0, 1). Mutates internal state. */
  private next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Roll N d6, returns array of integers in [1, 6]. */
  rollPool(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(1 + Math.floor(this.next() * 6));
    }
    return out;
  }

  /** Roll a single d6. */
  rollD6(): number {
    return 1 + Math.floor(this.next() * 6);
  }

  /** Highest die in a pool. Empty pool → 0 (used as "automatic miss"). */
  static highestDie(pool: readonly number[]): number {
    if (pool.length === 0) return 0;
    let max = pool[0]!;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i]! > max) max = pool[i]!;
    }
    return max;
  }
}
