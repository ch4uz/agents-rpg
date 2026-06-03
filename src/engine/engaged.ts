import type { Character } from './character.js';
import { chebyshevDistance } from './primitives.js';

/**
 * A target is "engaged" by the attacker's team iff at least two non-KO'd
 * members of `allChars` whose `kind` matches `attackerKind` (including the
 * attacker themselves) are adjacent to the target. HeroKids manual p.12
 * references "engaged target" as the trigger for Teamwork (+1 hero attack
 * die) and Pack Attack (+1 monster attack die).
 *
 * Callers should pass the full character list; the function filters by
 * `attackerKind` internally.
 *
 * Symmetric: works the same way for the monster team.
 */
export const isEngaged = (
  target: Character,
  allChars: Iterable<Character>,
  attackerKind: 'hero' | 'monster' | 'npc',
): boolean => {
  if (!target.pos) return false;
  let adjacent = 0;
  for (const c of allChars) {
    if (c.kind !== attackerKind) continue;
    if (c.health.status === 'KO') continue;
    if (!c.pos) continue;
    if (chebyshevDistance(c.pos, target.pos) === 1) adjacent += 1;
    if (adjacent >= 2) return true;
  }
  return false;
};
