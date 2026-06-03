import { Dice } from './dice.js';
import type { AttackKind } from './character.js';

export interface AttackContext {
  attackerPool: number;       // base dice pool (melee/ranged/magic)
  defenderArmor: number;      // base armor pool
  attackKind: AttackKind;
  modifiers: AttackModifiers;
}

export interface AttackModifiers {
  /** +dice to attacker pool (engaged target, prone defender, persona effects, etc.) */
  extraAttackDice: number;
  /** +dice to defender armor (cover, magic resistance, etc.) */
  extraArmorDice: number;
  /** Damage offset (e.g. Retaliation +1, default 0) */
  damageMod: number;
}

export interface AttackResult {
  hit: boolean;
  damage: number;
  attackRoll: number[];
  armorRoll: number[];
  attackerTop: number;
  defenderTop: number;
}

/**
 * Optional pre-rolled face arrays. When present, the engine uses these
 * verbatim instead of asking `dice` to roll. Used when the client's 3D
 * physics is authoritative for the visible dice — the browser rolls,
 * reads the settled faces, sends them back, and the engine resolves
 * against those values rather than its seeded mulberry32.
 *
 * Arrays MUST match the effective pool sizes (attackerPool + extraAttackDice
 * for `attackRoll`; defenderArmor + extraArmorDice for `armorRoll`) or
 * the result is undefined.
 */
export interface ProvidedAttackRolls {
  attackRoll: readonly number[];
  armorRoll: readonly number[];
  /** Correlation id of the `roll_request` these faces answered. Surfaced on
   *  the resolution event's public payload (`rollRequestId`) so the browser
   *  can match the resolution back to the dice it already animated and skip
   *  re-rolling. Ignored by the resolution math itself. */
  requestId?: string;
}

export const resolveAttack = (
  dice: Dice,
  ctx: AttackContext,
  provided?: ProvidedAttackRolls,
): AttackResult => {
  const attackerDice = Math.max(0, ctx.attackerPool + ctx.modifiers.extraAttackDice);
  const armorDice = Math.max(0, ctx.defenderArmor + ctx.modifiers.extraArmorDice);

  const attackRoll = provided ? [...provided.attackRoll] : dice.rollPool(attackerDice);
  const armorRoll = provided ? [...provided.armorRoll] : dice.rollPool(armorDice);
  const attackerTop = Dice.highestDie(attackRoll);
  const defenderTop = Dice.highestDie(armorRoll);

  const hit = attackerTop >= defenderTop && attackerTop > 0;
  const damage = hit ? Math.max(0, 1 + ctx.modifiers.damageMod) : 0;

  return { hit, damage, attackRoll, armorRoll, attackerTop, defenderTop };
};

export interface AbilityTestContext {
  characteristicPool: number;
  hasSkill: boolean;
  hasItem: boolean;
  // DM-facing checks are constrained to 4 | 5 | 6, but the resolved difficulty
  // also carries `attack_object`'s easier fallback (3) for objects the DM
  // didn't assign a DC to. The math is `top >= difficulty`, so any positive
  // integer is valid here.
  difficulty: 3 | 4 | 5 | 6;
}

export interface AbilityTestResult {
  success: boolean;
  roll: number[];
  top: number;
}

/** Optional pre-rolled face array for an ability test. See `ProvidedAttackRolls`
 *  for the rationale; same client-physics-as-truth pattern. */
export interface ProvidedAbilityRoll {
  roll: readonly number[];
  /** Correlation id of the `roll_request` these faces answered. Echoed on the
   *  resolution's public payload (`rollRequestId`) — same role as on
   *  `ProvidedAttackRolls` — so the log proves the check was physics-rolled and
   *  the browser de-dups the legacy 2D dice. Ignored by the resolution math. */
  requestId?: string;
}

export const resolveAbilityTest = (
  dice: Dice,
  ctx: AbilityTestContext,
  provided?: ProvidedAbilityRoll,
): AbilityTestResult => {
  const total = 1 + ctx.characteristicPool + (ctx.hasSkill ? 1 : 0) + (ctx.hasItem ? 1 : 0);
  const roll = provided ? [...provided.roll] : dice.rollPool(total);
  const top = Dice.highestDie(roll);
  return { success: top >= ctx.difficulty, roll, top };
};
