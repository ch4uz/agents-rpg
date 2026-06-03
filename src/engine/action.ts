import type {
  CharacterId,
  ItemId,
  EquipmentId,
  BoonId,
  SkillId,
  SceneId,
} from './ids.js';
import type { Square } from './primitives.js';
import type { AttackKind } from './character.js';

export type PlayerAction =
  | { kind: 'move'; path: Square[] }
  | { kind: 'normal_attack'; targetId: CharacterId }
  | { kind: 'special_action'; targetIds?: CharacterId[]; params?: Record<string, unknown> }
  | { kind: 'use_item'; itemId: ItemId; targetId?: CharacterId }
  | { kind: 'use_boon'; boonId: BoonId; targetId?: CharacterId }
  | { kind: 'equip'; equipmentId: EquipmentId }
  | {
      kind: 'ability_test';
      characteristic: AttackKind;
      skillId?: SkillId;
      itemId?: ItemId;
      difficulty: 4 | 5 | 6;
      describe: string;
    }
  /**
   * Attack an inanimate Thing on the grid — a scene obstacle (barrel,
   * crate, door) OR a DM-spawned emoji prop. Resolves like an ability
   * test: actor rolls their normal-attack pool, any die ≥ difficulty
   * destroys the target. Range / LoS mirror normal_attack. Counts as
   * the actor's main action for the turn.
   */
  | {
      kind: 'attack_object';
      /** Grid cell containing the obstacle or prop to target. */
      pos: Square;
      /** DC for destruction. Default 5 (normal) when omitted. */
      difficulty?: 4 | 5 | 6;
    }
  /**
   * Free an ADJACENT immobilized ally (a bound/trapped teammate). Resolves like
   * an ability test: the rescuer rolls `characteristic` (+ optional skill) vs
   * `difficulty`; any die ≥ difficulty succeeds and clears the ally's
   * `immobilized` status so they rejoin the party + combat. Counts as the
   * rescuer's main action whether or not it succeeds.
   */
  | {
      kind: 'free_ally';
      targetId: CharacterId;
      /** Pool to roll for the rescue. Defaults to 'melee' (brute strength). */
      characteristic: AttackKind;
      skillId?: SkillId;
      /** DC. Default 4 (easy) when omitted. */
      difficulty?: 4 | 5 | 6;
    }
  /**
   * Shove an ADJACENT pushable obstacle (e.g. an oil cask) one cell directly
   * AWAY from the actor into an empty floor cell. Roll-less — it always
   * succeeds when the destination is clear. Direction is fixed: the obstacle
   * moves to `pos + (pos - actorPos)`. Counts as the actor's main action.
   * Used to reposition an explosive cask next to a wall or a cluster of foes
   * before detonating it with `attack_object`.
   */
  | {
      kind: 'push_object';
      /** Grid cell of the obstacle to push. */
      pos: Square;
    }
  /**
   * Open an ADJACENT closed chest (a `chest`-flagged prop, shown in PROPS ON
   * THE GRID) to loot its single item into the actor's inventory. Roll-less —
   * it always succeeds when the actor stands within 1 cell of the chest. The
   * chest is emptied and removed from the grid. Counts as the actor's main
   * action.
   */
  | { kind: 'open_chest'; chestId: string }
  /**
   * Throw an item onto a floor cell within range, where it lands as a grid prop.
   * The thrown item must be available to the actor — EITHER carried in their
   * inventory (consumed on throw) OR lying on the ground within 1 cell of them
   * (a nearby prop, relocated to the target). Roll-less. Counts as the actor's
   * main action. A thrown wheel of Cheese (`itemId: 'cheese'`) becomes BAIT: the
   * enemy rats abandon the heroes and scramble toward the nearest wheel, and the
   * first rat to reach it eats it. Other items just rest on the grid as props.
   */
  | { kind: 'throw_item'; itemId: ItemId; pos: Square }
  | { kind: 'say'; text: string }
  /**
   * Flash a single emoji as a transient balloon over the actor's sprite.
   * Cosmetic, no game-state effect. Free action.
   */
  | { kind: 'emote'; emoji: string }
  | { kind: 'end_turn' }
  | { kind: 'skip_turn' };

export type DmAction =
  | { kind: 'narrate'; text: string }
  | { kind: 'set_scene'; sceneId: SceneId }
  | { kind: 'start_combat'; heroSide: CharacterId[]; monsterSide: CharacterId[] }
  | { kind: 'end_combat' }
  | { kind: 'request_action'; actorId: CharacterId }
  | {
      kind: 'reveal_monster';
      monsterTypeId: string;
      pos: Square;
      characterId: CharacterId;
    }
  | {
      kind: 'environmental';
      effect: 'push' | 'pull' | 'hazard';
      params: Record<string, unknown>;
    }
  /**
   * Drop an ad-hoc, narratively-imagined object on the grid (cheese, a chalk
   * mark, a thrown bone). Pure soft state: does not block movement, has no
   * stats, can be referenced + removed by id. The DM is expected to gate
   * creation behind a successful `ability_test` (dice roll required by
   * convention — the engine enforces grid validity, not story validity).
   */
  | {
      kind: 'spawn_prop';
      id: string;
      emoji: string;
      name: string;
      pos: Square;
      description?: string;
    }
  | { kind: 'remove_prop'; id: string }
  | { kind: 'offer_rest' }
  | {
      kind: 'reveal_npc';
      npcTypeId: string;
      pos: Square;
      characterId: CharacterId;
      allegiance: 'ally' | 'hostile' | 'neutral';
    }
  | {
      kind: 'npc_action';
      npcId: CharacterId;
      /** Subset of PlayerAction allowed for NPCs (engine enforces the subset).
       *  Allowed kinds: move, normal_attack, say, emote, ability_test,
       *  end_turn, skip_turn. */
      action: PlayerAction;
    }
  /**
   * The DM puppeting a monster on its OWN combat turn. The engine enforces that
   * the target is a monster, that combat is active and it is the monster's turn,
   * and the allowed-action subset (move, normal_attack, special_action,
   * ability_test, end_turn, skip_turn). The applied action event is tagged
   * `interpretedBy: 'dm'`. See Orchestrator `runDmDrivenMonsterTurn`.
   */
  | {
      kind: 'monster_action';
      monsterId: CharacterId;
      action: PlayerAction;
    }
  | { kind: 'end_adventure'; outcome: 'success' | 'failure' };

export type AnyAction =
  | { actor: 'player'; action: PlayerAction }
  | { actor: 'dm'; action: DmAction };

export type RuleViolation =
  | { reason: 'out-of-range' }
  | { reason: 'no-line-of-sight' }
  | { reason: 'invalid-target' }
  | { reason: 'not-actors-turn' }
  | {
      reason: 'unknown-id';
      what: 'item' | 'equipment' | 'boon' | 'character' | 'scene' | 'prop';
      id: string;
    }
  | { reason: 'wrong-phase' }
  | { reason: 'insufficient-movement' }
  | { reason: 'blocked-by-wall' }
  | { reason: 'no-such-effect' }
  /** This actor already used their move on this turn. */
  | { reason: 'already-moved' }
  /** This actor already used their main action (attack / special / consumable / ability_test) on this turn. */
  | { reason: 'action-already-used' }
  | { reason: 'invalid-action-shape'; details: string }
  /** attack_object cell has nothing destructible on it. */
  | { reason: 'no-such-object' }
  /** attack_object target is an attack-proof stalagmite, or push_object target is not a pushable obstacle. */
  | { reason: 'indestructible' }
  /** free_ally target is not an immobilized ally (already free, KO'd, or a foe). */
  | { reason: 'not-immobilized' }
  // Layer C — multi-target special-action dispatch
  | { reason: 'targets-required' }
  | { reason: 'target-not-adjacent'; targetId: CharacterId }
  | { reason: 'target-out-of-range'; targetId: CharacterId }
  | { reason: 'invalid-split-sum'; expected: number; actual: number }
  | { reason: 'invalid-split-shape'; details: string };
