import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { hasLineOfSight, type Cell, type MoveField } from './pathfinder.js';

/**
 * Multi-target split-special (warrior whirlwind / hunter split-shot) dice
 * allocation — the pure logic behind Layout's special-mode state machine.
 *
 * The human assigns the actor's whole melee/ranged pool across one or more
 * targets (each target ≥ 1 die, the dice summing to the pool); the engine's
 * `resolveSplitTargets` then resolves one opposed sub-attack per target. These
 * helpers compute which targets are legal and accumulate the per-target dice,
 * so Layout only does DOM/dispatch glue. Kept DOM-free for unit testing.
 */

/** The slice of `SpecialTargeting` (mode 'split') Layout drives a session with. */
export interface SplitPlan {
  attackKind: 'melee' | 'ranged';
  pool: number;
  range: number;
  requiresLos: boolean;
}

/** One target's assigned dice. Order is preserved (assignment order). */
export interface Allocation {
  id: string;
  dice: number;
}

const cheb = (a: Cell, b: Cell): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Ids of every character the actor may legally aim this split special at —
 * matching the engine's `resolveSplitTargets` validity: living, not self,
 * in range (melee = EXACT adjacency, ranged = within range), and (ranged only)
 * with line of sight. Allies are NOT excluded, mirroring the engine, which
 * only forbids self + KO'd targets — so friendly-fire splits stay possible.
 */
export const splitTargetIds = (
  me: RedactedCharacter,
  characters: ReadonlyArray<RedactedCharacter>,
  plan: SplitPlan,
  field: MoveField,
): string[] => {
  const from = me.pos;
  if (!from) return [];
  const out: string[] = [];
  for (const c of characters) {
    if (String(c.id) === String(me.id)) continue;
    if (!c.pos) continue;
    if (c.health.status === 'KO') continue;
    const d = cheb(from, c.pos);
    if (plan.attackKind === 'melee') {
      if (d !== plan.range) continue;
    } else if (d > plan.range) {
      continue;
    }
    if (plan.requiresLos && !hasLineOfSight(from, c.pos, field)) continue;
    out.push(String(c.id));
  }
  return out;
};

export const allocTotal = (alloc: ReadonlyArray<Allocation>): number =>
  alloc.reduce((sum, a) => sum + a.dice, 0);

/** Dice still to assign before the pool is spent. */
export const budgetLeft = (alloc: ReadonlyArray<Allocation>, pool: number): number =>
  Math.max(0, pool - allocTotal(alloc));

/**
 * Add one die to `id`, capped at `pool`. Returns a fresh array (never mutates).
 * A no-op once the pool is fully assigned, so a stray click can't over-allocate.
 */
export const addDie = (
  alloc: ReadonlyArray<Allocation>,
  id: string,
  pool: number,
): Allocation[] => {
  const out = alloc.map((a) => ({ ...a }));
  if (allocTotal(out) >= pool) return out;
  const hit = out.find((a) => a.id === id);
  if (hit) hit.dice += 1;
  else out.push({ id, dice: 1 });
  return out;
};

/**
 * Remove one die from `id` (dropping the entry entirely at zero). Returns a
 * fresh array; a no-op if `id` has no dice assigned.
 */
export const removeDie = (
  alloc: ReadonlyArray<Allocation>,
  id: string,
): Allocation[] => {
  const out: Allocation[] = [];
  for (const a of alloc) {
    if (a.id !== id) { out.push({ ...a }); continue; }
    if (a.dice > 1) out.push({ id: a.id, dice: a.dice - 1 });
  }
  return out;
};

/**
 * The `diceSplit` params map for a (typically full) allocation — keys are
 * targetIds, values the per-target dice. Mirrors what the LLM `special_action`
 * tool supplies, so the engine's shape/sum checks pass.
 */
export const diceSplitParams = (
  alloc: ReadonlyArray<Allocation>,
): Record<string, number> =>
  Object.fromEntries(alloc.map((a) => [a.id, a.dice]));
