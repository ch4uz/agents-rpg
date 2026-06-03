/**
 * Pure helpers that turn a `resolution` or `combat_started` event into the
 * concrete dice values the 3D overlay should land on.
 *
 * The engine emits the full roll pool in `event.private.{attackRoll,armorRoll}`,
 * but the WS visibility filter strips `private` for non-actor viewers. For
 * those rolls we still know the pool size (from the actor's character sheet)
 * and the TOP face (from `event.public.{attackerTop,defenderTop}`). We
 * fabricate filler dice ≤ top, deterministically seeded by the event's
 * logical step counter `t`, so two re-renders agree.
 *
 * The TOP die of each list MUST be the engine's reported top — the 3D
 * overlay shows that die with a highlight (current RollPanel CSS rule).
 * Filler dice fill out the rest of the pool with values ≤ top.
 *
 * Filler values are NOT load-bearing for game state. They exist purely so
 * the visible pool count matches the actor's stat.
 */
import type { Face } from './DiceMesh.js';
import type { DiceSkin } from './DiceSkins.js';

/**
 * 32-bit integer hash → 1..max. Same construction as RollPanel's `seededDie`
 * to preserve filler value compatibility for any test fixtures that may pin
 * the prior behavior.
 */
const seededDie = (seed: number, maxInclusive: number): number => {
  if (maxInclusive <= 1) return 1;
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return (x % maxInclusive) + 1;
};

/**
 * Build an array of face values for one pool. If `actualRoll` is present
 * (private not stripped), return it verbatim with the top die first; else
 * fabricate filler dice ≤ top, deterministically seeded.
 *
 * Output length is always `Math.max(1, poolSize)` (a pool of zero returns
 * an empty array — see armor 0 monsters).
 */
export const buildPool = (
  top: number,
  poolSize: number,
  seedBase: number,
  actualRoll: ReadonlyArray<number> | null,
): Face[] => {
  if (poolSize <= 0) return [];
  if (actualRoll && actualRoll.length === poolSize) {
    // Reorder so the top die is first (matches highlight contract).
    const idx = actualRoll.indexOf(top);
    const rest = actualRoll.filter((_, i) => i !== idx);
    const ordered = idx >= 0 ? [top, ...rest] : [...actualRoll];
    return ordered.map((v) => clampFace(v));
  }
  const out: Face[] = [clampFace(top)];
  for (let i = 1; i < poolSize; i++) {
    out.push(clampFace(seededDie(seedBase + i * 31, Math.max(1, top))));
  }
  return out;
};

const clampFace = (v: number): Face => {
  if (v < 1) return 1;
  if (v > 6) return 6;
  return Math.floor(v) as Face;
};

/**
 * Public roll-dispatch payload — the shape the overlay accepts. Two lanes
 * (`attacker` on the left, `defender` on the right) for duel rolls; a single
 * lane for initiative / ability checks (passed via `attacker` only).
 *
 * Optional `*Skins` arrays are parallel to the face arrays — element `i`
 * applies to the die at index `i` in the same lane. If absent or shorter
 * than the face array, the missing dice render with no tint (default white).
 */
export interface RollDispatch {
  /** Logical step counter — keys the overlay's roll lifetime. */
  t: number;
  attacker: Face[];
  defender: Face[];
  attackerSkins?: ReadonlyArray<DiceSkin>;
  defenderSkins?: ReadonlyArray<DiceSkin>;
}

/** Pure factory for a duel-roll dispatch (attack resolution). Both lanes
 *  accept a single skin applied uniformly to every die in that lane —
 *  appropriate for attacks where every die in a pool belongs to the same
 *  character. */
export const dispatchAttackRoll = (params: {
  t: number;
  attackerTop: number;
  attackerPool: number;
  attackerActual: ReadonlyArray<number> | null;
  attackerSkin?: DiceSkin;
  defenderTop: number;
  defenderArmorPool: number;
  defenderActual: ReadonlyArray<number> | null;
  defenderSkin?: DiceSkin;
}): RollDispatch => {
  const attackerFaces = buildPool(params.attackerTop, params.attackerPool, params.t * 1009, params.attackerActual);
  const defenderFaces = buildPool(params.defenderTop, params.defenderArmorPool, params.t * 2017, params.defenderActual);
  const aSkin = params.attackerSkin;
  const dSkin = params.defenderSkin;
  return {
    t: params.t,
    attacker: attackerFaces,
    defender: defenderFaces,
    ...(aSkin && { attackerSkins: attackerFaces.map(() => aSkin) }),
    ...(dSkin && { defenderSkins: defenderFaces.map(() => dSkin) }),
  };
};

/** Pure factory for a single-lane roll (initiative or ability check). The
 *  `skins` array lets each die carry its own owner's skin — used by
 *  initiative, where each die belongs to a different combatant. */
export const dispatchSingleRoll = (params: {
  t: number;
  top: number;
  poolSize: number;
  actual: ReadonlyArray<number> | null;
  skins?: ReadonlyArray<DiceSkin>;
}): RollDispatch => {
  const faces = buildPool(params.top, params.poolSize, params.t * 1009, params.actual);
  return {
    t: params.t,
    attacker: faces,
    defender: [],
    ...(params.skins && { attackerSkins: params.skins }),
  };
};
