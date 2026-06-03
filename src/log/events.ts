import type { CharacterId, SceneId } from '../engine/ids.js';
import type { Square } from '../engine/primitives.js';
import type { PlayerAction, DmAction, RuleViolation } from '../engine/action.js';

export interface EventBase {
  /** Logical step counter, monotonically increasing. */
  t: number;
}

export type Event =
  | (EventBase & { type: 'scene_enter'; sceneId: SceneId })
  | (EventBase & { type: 'thought'; actorId: CharacterId | 'dm'; text: string })
  | (EventBase & { type: 'narrate'; actorId: 'dm'; text: string })
  | (EventBase & { type: 'request_action'; actorId: 'dm'; targetId: CharacterId })
  | (EventBase & { type: 'human_input'; actorId: CharacterId; text: string })
  /**
   * Out-of-character question from the human to the DM. Never consumes a turn
   * and never alters engine state — the orchestrator side-channels these
   * through the DM and emits a matching `dm_ooc_reply`. Visibility filter
   * drops the pair from other agents' history so OOC chatter doesn't leak
   * into AI party-members' decision context.
   */
  | (EventBase & { type: 'player_ooc_query'; actorId: CharacterId; text: string })
  | (EventBase & { type: 'dm_ooc_reply'; toActorId: CharacterId; text: string })
  | (EventBase & {
      type: 'action';
      actorId: CharacterId | 'dm';
      action: PlayerAction | DmAction;
      interpretedBy?: 'dm';
    })
  | (EventBase & {
      type: 'resolution';
      actorId: CharacterId | 'dm';
      public: Record<string, unknown>;
      private?: Record<string, unknown>;
    })
  | (EventBase & {
      type: 'state_change';
      changes: Array<{
        id: CharacterId;
        damage?: number;
        status?: string;
        pos?: Square;
      }>;
    })
  /**
   * A hero's bonus ability (passive) fired during action resolution — e.g. the
   * Warrior's Teamwork adding an attack die against an engaged foe, the Warlock's
   * Power Surge boosting a wounded mage, the Healer's Tangled adding an armor die
   * versus a melee attack, or the Hunter darting a square after taking a hit.
   * Purely informational: the rule effect is already baked into the surrounding
   * `resolution` / `state_change` events. The browser surfaces it as a transient
   * "{name} triggered {ability}" banner. Always public.
   */
  | (EventBase & {
      type: 'passive_triggered';
      actorId: CharacterId;
      /** Effect id (audit / de-dup). */
      abilityId: string;
      /** Display name, e.g. "Teamwork". */
      abilityName: string;
      /** Short human phrase of the effect, e.g. "+1 attack die". */
      effect: string;
    })
  | (EventBase & {
      type: 'rule_violation';
      actorId: CharacterId | 'dm';
      violation: RuleViolation;
      /**
       * The action the engine rejected, when known. Unset for shape-level
       * violations where no single action was attempted (e.g. multi-tool-call
       * responses). (audit F26)
       */
      attempted?: PlayerAction | DmAction;
    })
  | (EventBase & {
      type: 'step_budget_exhausted';
      actorId: CharacterId | 'dm';
      forced: 'end_turn';
    })
  | (EventBase & {
      type: 'combat_started';
      heroSide: CharacterId[];
      monsterSide: CharacterId[];
      /** Combined turn order. Index 0 acts first. Sorted by initiative total
       *  (d6 + dex) descending; heroes break ties before monsters; same-side
       *  ties keep declaration order. */
      order: CharacterId[];
      /** Per-character initiative results keyed by stringified CharacterId.
       *  Each entry carries d6, dex modifier, and the total used for sort. */
      rolls: {
        hero: Record<string, { d6: number; dex: number; total: number }>;
        monster: Record<string, { d6: number; dex: number; total: number }>;
      };
    })
  | (EventBase & { type: 'combat_ended' })
  | (EventBase & { type: 'rest_offered' })
  | (EventBase & {
      type: 'adventure_ended';
      outcome: 'success' | 'failure';
      /**
       * Why the run ended, when it's worth distinguishing for the closing UI.
       * `'party_wipe'` — every hero was KO'd (the defeat analog of the
       * all-monsters-ko victory); the browser shows the dedicated game-over
       * screen instead of the gentle "The Heroes Fall" ending banner. Absent
       * for ordinary endings (DM-narrated success/failure, budget-exhausted).
       */
      reason?: 'party_wipe';
    });
