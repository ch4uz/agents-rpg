import type { CharacterId } from '../engine/ids.js';

/**
 * Description of an attack roll the engine needs values for. The orchestrator
 * fills this in with the validated pool sizes (already including engagement
 * bonus dice, cover armor, etc.) plus enough identity to label the browser's
 * VS header without a second snapshot round-trip.
 */
export interface AttackRollSpec {
  requestId: string;
  attacker: {
    actorId: CharacterId;
    poolSize: number;
    name: string;
    characterKind: 'hero' | 'monster' | 'npc' | 'dm';
    archetype: string | null;
    sprite: string | null;
  };
  defender: {
    actorId: CharacterId;
    poolSize: number;
    name: string;
    characterKind: 'hero' | 'monster' | 'npc' | 'dm';
    archetype: string | null;
    sprite: string | null;
  };
  /**
   * Present for a single-pool CHECK roll (ability_test / attack_object) rather
   * than an opposed attack. The attacker rolls `attacker.poolSize` dice against
   * the fixed `difficulty` (no opposing pool — `defender.poolSize` is 0 and the
   * defender frame is just a "skill check" label). Verdict = top die ≥ difficulty.
   */
  check?: { difficulty: number; describe?: string };
}

/** Settled face values from the external roll source. Lengths MUST equal the
 *  pool sizes the spec asked for; otherwise the orchestrator falls back to
 *  the seeded engine dice. */
export interface AttackRollResult {
  attackerFaces: number[];
  defenderFaces: number[];
}

/**
 * Outsource a dice roll to an external source — typically the browser's 3D
 * physics simulation. Returning `null` means "I cannot roll" (no canvas,
 * no client, timeout, malformed reply); the orchestrator then falls back
 * to the engine's deterministic `Dice` so headless / CLI / AI-only paths
 * keep working unchanged.
 *
 * Implementations should be idempotent on the request side — repeated calls
 * with the same `requestId` should resolve to the same promise — and tolerant
 * of disconnects: a dropped client must never hang the orchestrator forever.
 */
export interface RollProvider {
  requestAttackRoll(spec: AttackRollSpec): Promise<AttackRollResult | null>;
}
