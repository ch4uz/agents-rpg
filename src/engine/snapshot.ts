import type { CharacterId, ItemId, BoonId, EquipmentId } from './ids.js';
import type { Viewer } from '../runtime/visibility/types.js';
import type { Square } from './primitives.js';

/**
 * How a human UI should gather targets for a character's special action.
 * Emitted by the engine (computed from the bound effect id) so the browser
 * never re-derives targeting rules from archetype strings — spec rule #2,
 * the engine owns the rules and clients render structured state.
 */
export type SpecialTargeting =
  | {
      /**
       * whirlwind-attack / split-shot: choose ≥1 targets and split `pool`
       * dice across them (each target ≥1 die; the values sum to `pool`).
       */
      mode: 'split';
      /** Which actor pool the dice come from / how the sub-attacks resolve. */
      attackKind: 'melee' | 'ranged';
      /** Dice to distribute — the actor's melee (whirlwind) or ranged
       *  (split-shot) pool. */
      pool: number;
      /** Max Chebyshev distance to a valid target. Melee whirlwind requires
       *  EXACT adjacency (engine: dist === range, range 1); ranged split-shot
       *  allows dist ≤ range. */
      range: number;
      /** Ranged specials require line of sight to each target; melee do not. */
      requiresLos: boolean;
    }
  /** flame-burst: the engine auto-targets every adjacent foe — no manual
   *  target picking, the UI just triggers it. */
  | { mode: 'area' }
  /** healing-touch / pack-attack / any single-target effect. */
  | { mode: 'single' };

export interface RedactedCharacter {
  id: CharacterId;
  name: string;
  kind: 'hero' | 'monster' | 'npc';
  archetype?: string;
  sprite?: string;
  pos: Square | null;
  health: { total: number; damage: number; status: 'normal' | 'prone' | 'KO' | 'immobilized' };
  pools: { melee: number; ranged: number; magic: number; armor: number };
  /** Dexterity modifier surfaced so the initiative panel can show the
   *  d6 + dex breakdown. Optional for backward compatibility. */
  dex?: number;
  equipped?: EquipmentId;
  inventory: { itemId: ItemId; count: number }[];
  boons: BoonId[];
  /**
   * The character's normal-attack reach + kind, surfaced so a human UI can gate
   * attack targeting to exactly what the engine accepts — within `range`
   * Chebyshev cells, plus line of sight for non-melee — instead of letting an
   * out-of-range click round-trip into a `rule_violation`. Mirrors
   * `Character.normalAttack`'s kind/range; the damage modifier stays
   * engine-private. Also governs `attack_object`, which the engine validates
   * with the same range + LoS rule.
   */
  normalAttack: { kind: 'melee' | 'ranged' | 'magic'; range: number };
  specialAction: { name: string; description: string; targeting?: SpecialTargeting };
  bonusAbility:  { name: string; description: string };
}

/**
 * Ad-hoc grid object summoned by the DM in response to creative play
 * (e.g. a wheel of cheese discovered in a barrel after a successful ability
 * test). Public to all viewers; no stats; does not block movement.
 */
export interface EmojiProp {
  id: string;
  emoji: string;
  name: string;
  pos: Square;
  description?: string;
  /**
   * A throwable lure (a thrown wheel of cheese) resting on the grid. While ANY
   * bait prop is on the board the monster AI abandons the heroes and paths to
   * the nearest bait cell; the first monster to step onto a bait cell eats it
   * (the prop is removed). Engine/AI-only — the browser renders the emoji
   * exactly like any other prop and ignores this flag.
   */
  bait?: boolean;
  /**
   * A closed container a hero can `open_chest` (when adjacent) to loot. The
   * `contents` itemId is granted to the opener and the chest prop is then
   * removed from the grid. Engine-only metadata; the browser just renders the
   * chest sprite/emoji.
   */
  chest?: { contents: ItemId };
  /**
   * Optional manifest prop key (e.g. `'chest'`). When set AND present in
   * `manifest.props`, the browser renders that pixel-art sprite for the prop
   * instead of `emoji`, sized to one cell (the emoji stays the fallback). Lets
   * an interactive prop like a chest read as a real sprite, consistent with the
   * scene's tileset props. Absent for plain emoji props (e.g. thrown cheese).
   */
  spriteId?: string;
}

export interface RedactedSnapshot {
  runId?: string;
  viewer: Viewer;
  scene: {
    id: string;
    assetId: string;
    gridW: number;
    gridH: number;
    obstacles: {
      type: string; x: number; y: number;
      /** Max `attack_object` hits to break (present only when > 1). */
      durability?: number;
      /** Remaining hits before this obstacle breaks (present only when durability > 1). */
      remaining?: number;
      /** When true, destroying this obstacle bursts and damages adjacent
       *  creatures (friend AND foe). See `map.obstacles[].explosive`. */
      explosive?: boolean;
      /** When true, this obstacle is cover (walkable, +1 move cost, does NOT
       *  block line of sight; shots through it give the target +1 armor). When
       *  absent it is a full barrier blocking movement AND sight. */
      cover?: boolean;
      /** When true, this obstacle (a stalagmite) cannot be smashed by
       *  `attack_object` — only an explosion blast clears it. Still blocks
       *  movement AND sight. The browser must not offer it as an attack target. */
      attackProof?: boolean;
      /** When true, a hero adjacent to it may `push_object` it one floor cell
       *  directly away. Used to reposition an explosive cask. */
      pushable?: boolean;
    }[];
    decorations: { type: string; x: number; y: number }[];
    exits: { to: string; at: Square; trigger: 'manual' | 'step-on' }[];
    walls: boolean;
    /**
     * Two-part cinematic opening (from `map`-sibling `scene.opening`). When
     * present the browser shows `before` as a pre-board splash; `after` is
     * emitted as a narration beat once the player dismisses it. `cast` names the
     * characters the splash should bold (+ inline-avatar at first mention).
     * Absent for scenes without an authored opening (the common case / mid-run
     * scenes).
     */
    opening?: {
      before: string;
      after: string;
      /** `names` carries per-language display names keyed by language code,
       *  so the splash's highlighting matches whichever text variant renders. */
      cast?: { name: string; names?: Record<string, string>; portrait?: string }[];
      /**
       * Translated variants of the splash text, keyed by LANGUAGE CODE (from
       * the scene's `i18n.<lang>.opening`). The BROWSER picks which variant
       * to display by its UI language — the snapshot must carry all of them
       * because it is published BEFORE the hero-select gate where the
       * language is chosen. `cast` applies to every variant. Absent when the
       * scene has no translated opening.
       */
      i18n?: Record<string, { before: string; after: string }>;
    };
    /**
     * Impassable rock cells carving the cave shape (from `map.wallCells`).
     * The renderer draws the cave outline from these via a marching-squares
     * pass over the tileset's wall tiles; the engine has already blocked them.
     * Absent / empty for open or ring-walled scenes.
     */
    wallCells?: Square[];
    /**
     * Cells that started as obstacles but have been destroyed mid-scene
     * (attack_object). Renderers should hide the obstacle sprite at any
     * matching cell. Empty when nothing's been broken.
     */
    destroyedObstacles: Square[];
  } | null;
  characters: RedactedCharacter[];
  /**
   * Ad-hoc DM-spawned objects rendered as emojis on the grid. Always public.
   * Empty when the DM has not summoned anything.
   */
  props: EmojiProp[];
  activeActor: CharacterId | 'dm' | null;
  /**
   * Populated by the orchestrator when sending a snapshot envelope.
   * Engine-side getRedactedSnapshot leaves this empty — the orchestrator
   * tracks recent events because the engine does not.
   */
  recentChat: unknown[];
  ended?: { outcome: 'success' | 'failure' | 'aborted' };
}
