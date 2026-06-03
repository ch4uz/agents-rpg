import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { hasLineOfSight, type Cell, type MoveField } from './pathfinder.js';

/**
 * Client-side normal-attack range gating — the pure logic behind Layout's
 * `attack` selection mode. Mirrors the engine's `computeNormalAttackContext`
 * (characters) and `previewAttackObject` (obstacles / props), so the targets
 * the browser highlights are EXACTLY the ones the server will accept. Without
 * this, the UI highlighted every living foe regardless of distance and an
 * out-of-range click round-tripped into a `rule_violation`.
 *
 * Kept DOM-free for unit testing, alongside `special-alloc.ts` (which already
 * gates the multi-target split specials this same way).
 */

const cheb = (a: Cell, b: Cell): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * True iff the actor `me` may land a NORMAL attack (or `attack_object`) on the
 * cell `to`: within `me.normalAttack.range` Chebyshev cells, and — for non-melee
 * (ranged / magic) attacks — with unobstructed line of sight. Cover, which the
 * engine folds into +1 defender armor rather than a block, does NOT gate
 * targeting, matching the server exactly so the highlight never hides a legal
 * shot. Returns false when the actor has no position.
 */
export const inNormalAttackRange = (
  me: RedactedCharacter,
  to: Cell,
  field: MoveField,
): boolean => {
  if (!me.pos) return false;
  if (cheb(me.pos, to) > me.normalAttack.range) return false;
  if (me.normalAttack.kind !== 'melee' && !hasLineOfSight(me.pos, to, field)) return false;
  return true;
};

/**
 * Ids of every character the actor may legally normal-attack — living, not
 * self, and `inNormalAttackRange`. Allies are NOT excluded (the engine permits
 * friendly fire; only self + KO'd are filtered), mirroring `splitTargetIds`.
 */
export const normalAttackTargetIds = (
  me: RedactedCharacter,
  characters: ReadonlyArray<RedactedCharacter>,
  field: MoveField,
): string[] => {
  const out: string[] = [];
  for (const c of characters) {
    if (String(c.id) === String(me.id)) continue;
    if (!c.pos) continue;
    if (c.health.status === 'KO') continue;
    if (!inNormalAttackRange(me, c.pos, field)) continue;
    out.push(String(c.id));
  }
  return out;
};
