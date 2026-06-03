/**
 * Effects are pure descriptions of changes the engine should apply.
 * Each effect declares its kind (where it can fire) and an `apply`
 * function that takes a context and returns a structured result.
 *
 * The engine uses the result to update state and emit events. Effects
 * never mutate engine state directly — they return what should change.
 */

import type { Character } from './character.js';

export type EffectKind =
  | 'consumable'      // an item used as an action (potion, bomb)
  | 'special-action'  // a character's special action
  | 'bonus-passive'   // a character's bonus ability (passive trigger)
  | 'equipment'       // worn equipment (typically passive trigger)
  | 'boon';           // a one-shot favor, usable any time

export interface EffectContext {
  /** The character that triggered the effect (the actor). */
  actor: Character;
  /** Optional target, when the effect targets a specific character. */
  target?: Character;
  /** Free-form params from the action (e.g. split-attack distribution). */
  params?: Record<string, unknown>;
}

export type EffectChange =
  | { kind: 'heal'; characterId: string; amount: number }
  | { kind: 'damage'; characterId: string; amount: number }
  | { kind: 'attack-mod'; extraDice: number }
  /** Extra dice added to the DEFENDER's armor pool (e.g. Healer's Tangled). */
  | { kind: 'armor-mod'; extraDice: number }
  | { kind: 'free-attack'; targetId: string }
  | { kind: 'move-bonus'; squares: number }
  | { kind: 'noop' };

export interface EffectResult {
  changes: EffectChange[];
  /** Optional narration hint for the DM. */
  narration?: string;
}

export interface Effect {
  kind: EffectKind;
  apply(ctx: EffectContext): EffectResult;
}

export class EffectRegistry {
  private map = new Map<string, Effect>();

  register(id: string, effect: Effect): void {
    if (this.map.has(id)) throw new Error(`Effect id already registered: ${id}`);
    this.map.set(id, effect);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): Effect {
    const e = this.map.get(id);
    if (!e) throw new Error(`Unknown effect id: ${id}`);
    return e;
  }
}

/* ─── Core v1 effects ──────────────────────────────────────────────── */

export const registerCoreEffects = (reg: EffectRegistry): void => {
  // Consumables
  reg.register('heal-full', {
    kind: 'consumable',
    apply: ({ target, actor }) => ({
      changes: [{ kind: 'heal', characterId: (target ?? actor).id, amount: Infinity }],
      narration: `${(target ?? actor).name} drinks a potion and is fully healed.`,
    }),
  });

  reg.register('bomb-blast', {
    kind: 'consumable',
    apply: ({ target }) => ({
      // Engine resolves the actual to-hit roll; the effect just declares
      // that this is a 1-die magic-style attack — concrete attack resolution
      // is handled in resolution.ts via params.
      changes: [{ kind: 'noop' }],
      narration: `BA-BOOM! The bomb explodes around ${target?.name ?? 'the target'}.`,
    }),
  });

  // Special actions
  reg.register('healing-touch', {
    kind: 'special-action',
    apply: ({ target, actor }) => ({
      changes: [{ kind: 'heal', characterId: (target ?? actor).id, amount: 1 }],
      narration: `${actor.name} touches ${(target ?? actor).name}, mending one wound.`,
    }),
  });

  // Multi-target specials are dispatched directly by GameEngine.handleSpecialAction
  // (see src/engine/game-engine.ts). Their effect-registry entries return only
  // a narration so the registry's surface stays uniform; damage and resolution
  // are produced by the engine.
  reg.register('whirlwind-attack', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} sweeps a whirlwind of steel.`,
    }),
  });

  // Bonus passives
  reg.register('teamwork', {
    kind: 'bonus-passive',
    apply: ({ params }) => {
      const targetEngaged = params?.['targetEngaged'] === true;
      return {
        changes: targetEngaged ? [{ kind: 'attack-mod', extraDice: 1 }] : [{ kind: 'noop' }],
      };
    },
  });

  // The Hunter passive: "When you're damaged by an attack, you can immediately
  // move 1 square." Surfaces a 1-square move bonus; the engine performs the
  // reactive step (see GameEngine.maybeReactiveStep). Kept under its original
  // effect id; the hero catalog labels it "Hunter".
  reg.register('evasive-maneuver', {
    kind: 'bonus-passive',
    apply: () => ({
      changes: [{ kind: 'move-bonus', squares: 1 }],
      narration: 'A nimble dodge!',
    }),
  });

  // Power Surge: "When you are not at full health, your magic attacks gain 1
  // extra die." Gated on BOTH wounded AND a magic attack (the warlock is
  // always magic, but the gate keeps the rule honest if reused).
  reg.register('power-surge', {
    kind: 'bonus-passive',
    apply: ({ actor, params }) => {
      const wounded = actor.health.damage > 0;
      const isMagic = params?.['attackKind'] === 'magic';
      return {
        changes: wounded && isMagic ? [{ kind: 'attack-mod', extraDice: 1 }] : [{ kind: 'noop' }],
      };
    },
  });

  // Tangled (Healer): "When defending melee attacks, you gain 1 extra die to
  // your armor pool." A DEFENDER-side passive — the engine evaluates the
  // target's bonus with the incoming attack kind.
  reg.register('tangled', {
    kind: 'bonus-passive',
    apply: ({ params }) => {
      const defendingMelee = params?.['defendingAttackKind'] === 'melee';
      return {
        changes: defendingMelee ? [{ kind: 'armor-mod', extraDice: 1 }] : [{ kind: 'noop' }],
      };
    },
  });

  reg.register('coward', {
    kind: 'bonus-passive',
    apply: ({ params }) => ({
      changes: params?.['attackedSinceLastTurn'] === true
        ? [{ kind: 'move-bonus', squares: 2 }]
        : [{ kind: 'noop' }],
    }),
  });

  reg.register('pack-attack', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} closes in with the pack.`,
    }),
  });

  // split-shot is dispatched by GameEngine.handleSpecialAction; this entry
  // is kept for registry surface uniformity and narration fallback only.
  reg.register('split-shot', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} loses a fanned volley of arrows.`,
    }),
  });

  reg.register('flame-burst', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} explodes outward in a wave of flame.`,
    }),
  });

  reg.register('potion-brewer', {
    kind: 'bonus-passive',
    apply: () => ({ changes: [{ kind: 'noop' }] }),
  });

  // Equipment
  reg.register('reaping-strike', {
    kind: 'equipment',
    apply: ({ params }) => ({
      changes: params?.['justKOd'] === true
        ? [{ kind: 'free-attack', targetId: String(params['adjacentTargetId'] ?? '') }]
        : [{ kind: 'noop' }],
    }),
  });
};
