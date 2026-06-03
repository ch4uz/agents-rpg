import { Dice } from './dice.js';
import { type Grid, blocksMovement, isDestructibleObstacleCell } from './grid.js';
import { buildSceneGrid } from './scene-grid.js';
import type { Character } from './character.js';
import type { CharacterId, ItemId, BoonId, EquipmentId, SceneId } from './ids.js';
import { asCharacterId, asEffectId, asItemId } from './ids.js';
import type { PlayerAction, DmAction, RuleViolation } from './action.js';
import type { EffectRegistry, EffectContext, EffectChange } from './effects.js';
import type { ItemEntry, BoonEntry, MonsterEntry, NpcEntry, HeroEntry } from './catalogs.js';
import type { Adventure, Scene } from './adventure.js';
import type { Square } from './primitives.js';
import type { RedactedSnapshot, RedactedCharacter, EmojiProp, SpecialTargeting } from './snapshot.js';
import type { Viewer } from '../runtime/visibility/types.js';
import { TurnTracker } from './turn-tracker.js';
import type { Event } from '../log/events.js';
import type { Result } from './primitives.js';
import { ok, err, chebyshevDistance } from './primitives.js';
import { resolveAttack, resolveAbilityTest as resolveAbilityTestInternal } from './resolution.js';
import type { ProvidedAttackRolls, ProvidedAbilityRoll } from './resolution.js';
import type { AttackKind } from './character.js';
import { isEngaged } from './engaged.js';
import { applyDamage, healDamage } from './character.js';

const NPC_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'move', 'normal_attack', 'say', 'emote', 'ability_test', 'end_turn', 'skip_turn',
]);

/** PlayerAction kinds the DM may drive on a monster it puppets in combat
 *  (`monster_action`). Monsters fight rather than talk — no say/emote; they may
 *  use their special. The engine still validates range/LoS/budget per action. */
const MONSTER_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'move', 'normal_attack', 'special_action', 'ability_test', 'end_turn', 'skip_turn',
]);

/** Max Chebyshev distance a hero can throw an item (see `throw_item`). */
const ITEM_THROW_RANGE = 4;

/**
 * Archetypes whose normal attack loses 1 die when the target is ADJACENT
 * (Chebyshev distance 1). The Hunter (ranged) and Healer (magic) are built to
 * strike from a distance — a foe in their face fouls the shot — so a melee-range
 * target drops their attack pool by one. The Warrior (a melee fighter) and the
 * Warlock are intentionally exempt. The penalty is folded into `extraAttackDice`
 * so it applies identically in the pool preview (browser physics-dice count) and
 * the seeded resolution, and is floored at 0 attacker dice by `Math.max(0, …)`.
 */
const ADJACENT_ATTACK_PENALTY_ARCHETYPES: ReadonlySet<string> = new Set(['hunter', 'healer']);

/**
 * Emoji + bait-nature for a thrown item, keyed by item id. Some thrown items
 * are BAIT — greedy/hungry foes break off the heroes to scramble for them (a
 * wheel of cheese lures rats; a shiny coin lures loot-hungry goblins). Other
 * items just rest on the grid as inert props. Unknown items fall back to a
 * generic satchel glyph.
 */
const THROWN_ITEM_VISUAL: Record<string, { emoji: string; bait?: boolean }> = {
  cheese:       { emoji: '🧀', bait: true },
  'shiny-coin': { emoji: '🪙', bait: true },
  potion:       { emoji: '🧪' },
  bomb:         { emoji: '💣' },
  rope:         { emoji: '🪢' },
  food:         { emoji: '🍖' },
  gold:         { emoji: '🪙' },
  herbs:        { emoji: '🌿' },
};

export interface GameEngineConfig {
  seed: string;
  grid: Grid;
  characters: Character[];
  effects: EffectRegistry;
  items?: Map<string, ItemEntry>;
  boons?: Map<string, BoonEntry>;
  /**
   * Optional adventure for engine-owned scene transitions (set_scene auto-reveals
   * the scene's declared monsters when both `adventure` and `monsters` are set).
   * When omitted, set_scene is a no-op beyond emitting `scene_enter`.
   */
  adventure?: Adventure;
  /**
   * Optional monster catalog used by set_scene auto-reveal and reveal_monster.
   * Keys are monster type ids (e.g. "giant-rat"). Required when the engine is
   * expected to materialize monsters from the adventure or via reveal_monster.
   */
  monsters?: Map<string, MonsterEntry>;
  /** Optional NPC catalog. Required when scene declares npcs[] or when DM
   *  calls reveal_npc / npc_action. */
  npcs?: Map<string, NpcEntry>;
  /** Optional hero catalog. Required when a scene declares `captives[]` —
   *  set_scene materializes each captive as an immobilized hero from this
   *  catalog (keyed by archetype id, e.g. "healer"). */
  heroes?: Map<string, HeroEntry>;
}

export interface ActionOk {
  turnEnded: boolean;
}

/**
 * One opposed sub-roll of a multi-target special action, as reported by
 * `previewSpecialAttacks`. The orchestrator outsources each to the browser's
 * 3D dice (one `roll_request` per entry) exactly as it does a normal attack,
 * then feeds the settled faces back via `providedSpecialRolls`.
 */
export interface SubAttackSpec {
  targetId: CharacterId;
  attackerPoolSize: number;
  defenderArmorPoolSize: number;
  attackKind: AttackKind;
}

/** Internal: a resolved special-action sub-attack — target + the exact dice
 *  pool the attacker rolls against it. Shared by the preview and the handler so
 *  pool sizes can never drift between "what we ask the browser to roll" and
 *  "what the engine resolves". */
interface ResolvedSubAttack {
  target: Character;
  attackerPool: number;
  attackKind: AttackKind;
  specialEffectId?: string;
}

/**
 * Live, mutable state for one scene obstacle, keyed by its CURRENT cell. Seeded
 * from `scene.map.obstacles[]` on every scene entry and the single source of
 * truth for the obstacle list (snapshot + `activeSceneObstacles`) and for
 * `attack_object` / `push_object` resolution — so a `push_object` that
 * relocates a cask, or a smash that destroys one, stays consistent everywhere.
 * Obstacles on test grids built without an adventure have no entry, and the
 * relevant handlers fall back to legacy behaviour (one-hit destroy, not
 * attack-proof, not pushable).
 */
interface LiveObstacle {
  type: string;
  durability: { max: number; remaining: number };
  explosive?: { damage: number; radius: number };
  cover?: boolean;
  pushable?: boolean;
  /** type === 'stalagmite': attack-proof, and only an explosion blast clears it. */
  isStalagmite: boolean;
}

export class GameEngine {
  readonly dice: Dice;
  /**
   * Active scene's grid. Mutable because `set_scene` rebuilds it from the
   * incoming scene's obstacles when the party transitions between scenes
   * with different layouts (e.g. forest-edge 10x7 → whispering-path 12x8).
   */
  grid: Grid;
  readonly effects: EffectRegistry;
  readonly turn: TurnTracker;

  private characters: Map<CharacterId, Character>;
  private pendingEvents: Event[] = [];
  private nextT = 1;
  private items: Map<string, ItemEntry>;
  private boons: Map<string, BoonEntry>;
  private adventure: Adventure | undefined;
  private monsterCatalog: Map<string, MonsterEntry>;
  private npcCatalog: Map<string, NpcEntry>;
  private heroCatalog: Map<string, HeroEntry>;
  /** Ad-hoc DM-spawned grid objects (see `EmojiProp`). Public state. Also holds
   *  scene-materialized chests (`chest`-flagged) and hero-thrown cheese bait
   *  (`bait`-flagged). */
  private props: Map<string, EmojiProp> = new Map();
  /** Monotonic counter for generating unique thrown-cheese prop ids
   *  (`cheese-1`, `cheese-2`, …). Deterministic, so replay stays stable. */
  private baitSeq = 0;
  /**
   * Cells that began the scene as obstacles but have since been destroyed by
   * `attack_object`. Tracked so snapshot reconnects can reflect the mutated
   * scene (the scene JSON still lists the obstacle; the engine subtracts).
   */
  private destroyedObstacles: Square[] = [];
  /**
   * Live scene obstacles keyed by CURRENT `${x},${y}` cell. Seeded from the
   * active scene's `obstacles[]` on every scene entry (durability default 1,
   * explosive/cover/pushable copied, `isStalagmite` from the type). The single
   * source of truth for the obstacle list AND for `attack_object` /
   * `push_object` resolution: a smash decrements durability and deletes the
   * entry at 0; a push re-keys it to the destination cell. Cells absent from
   * the map (e.g. test grids built without an adventure) fall back to legacy
   * behaviour (one-hit destroy, not attack-proof, not pushable).
   */
  private liveObstacles: Map<string, LiveObstacle> = new Map();
  /**
   * Scene ids the engine has already entered via `set_scene`. Used to make
   * set_scene idempotent: re-entering the same scene is a no-op (no duplicate
   * `scene_enter` event, no second pass at auto-revealing monsters that already
   * exist). The orchestrator auto-enters scene[0] at startup so the DM's first
   * turn sees `MONSTERS PRESENT` already populated.
   */
  private enteredScenes: Set<SceneId> = new Set();
  /**
   * The scene the party is currently in. Updated on every successful
   * `set_scene` (including the orchestrator's auto-entry of scene[0] at
   * startup). `getRedactedSnapshot` reads this to expose the active scene's
   * grid + obstacles + decorations to subscribers. Undefined only before
   * the very first set_scene runs.
   */
  private currentSceneId: SceneId | undefined;

  constructor(cfg: GameEngineConfig) {
    this.dice = new Dice(cfg.seed);
    this.grid = cfg.grid;
    this.effects = cfg.effects;
    this.turn = new TurnTracker();
    this.characters = new Map(cfg.characters.map((c) => [c.id, c]));
    this.items = cfg.items ?? new Map();
    this.boons = cfg.boons ?? new Map();
    this.adventure = cfg.adventure;
    this.monsterCatalog = cfg.monsters ?? new Map();
    this.npcCatalog = cfg.npcs ?? new Map();
    this.heroCatalog = cfg.heroes ?? new Map();
    // Seed live obstacles for the starting scene (scenes[0]) so obstacle HP
    // works even before the orchestrator's auto set_scene. Re-seeded on entry.
    if (this.adventure?.scenes?.[0]) this.initLiveObstacles(this.adventure.scenes[0]);
  }

  /**
   * (Re)seed `liveObstacles` from a scene's obstacle list. Each obstacle cell
   * gets `durability` (default 1) remaining hits plus its explosive/cover/
   * pushable flags and `isStalagmite` (attack-proof). Called on every scene
   * entry so a fresh encounter starts with full-strength obstacles at their
   * declared cells.
   */
  private initLiveObstacles(scene: Adventure['scenes'][number]): void {
    this.liveObstacles = new Map();
    for (const o of scene.map.obstacles) {
      const max = o.durability ?? 1;
      this.liveObstacles.set(`${o.x},${o.y}`, {
        type: o.type,
        durability: { max, remaining: max },
        ...(o.explosive ? { explosive: { damage: o.explosive.damage, radius: o.explosive.radius } } : {}),
        ...(o.cover ? { cover: true } : {}),
        ...(o.pushable ? { pushable: true } : {}),
        isStalagmite: o.type === 'stalagmite',
      });
    }
  }

  /**
   * Seat the heroes onto a scene's declared `entry` cells on scene entry.
   * Deterministic: heroes are ordered by id, candidate cells are the entry list
   * followed by a north-west column-major floor scan, and each hero takes the
   * next floor cell not already occupied by a monster/NPC or an earlier hero.
   * This keeps a carved cave's party at its tunnel mouth (the correct side of a
   * breach wall) instead of wherever they stood in the previous scene. Only
   * positions are touched — HP/status are untouched. Replay-safe: `set_scene`
   * is never re-run during replay, so this never perturbs a replayed run.
   */
  private seatHeroesAtEntry(entry: ReadonlyArray<{ x: number; y: number }>): void {
    // Immobilized heroes (bound captives) are NOT re-seated — they stay pinned
    // at their declared cell. Mobile heroes are seated, sorted by id.
    const heroes = Array.from(this.characters.values())
      .filter((c) => c.kind === 'hero' && c.health.status !== 'immobilized')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (heroes.length === 0) return;
    const occupied = new Set<string>();
    for (const c of this.characters.values()) {
      // Non-hero combatants AND pinned (immobilized) heroes hold their cells so
      // a mobile hero isn't seated on top of them.
      if ((c.kind !== 'hero' || c.health.status === 'immobilized') && c.pos) {
        occupied.add(`${c.pos.x},${c.pos.y}`);
      }
    }
    const candidates: { x: number; y: number }[] = [...entry];
    for (let x = 0; x < this.grid.width; x++) {
      for (let y = 0; y < this.grid.height; y++) candidates.push({ x, y });
    }
    let ci = 0;
    for (const hero of heroes) {
      while (ci < candidates.length) {
        const s = candidates[ci++]!;
        if (!this.grid.inBounds(s)) continue;
        if (this.grid.cellAt(s).kind !== 'floor') continue;
        const k = `${s.x},${s.y}`;
        if (occupied.has(k)) continue;
        hero.pos = { x: s.x, y: s.y };
        occupied.add(k);
        break;
      }
    }
  }

  /** Snapshot of the current characters keyed by id. */
  charactersById(): ReadonlyMap<CharacterId, Character> {
    return this.characters;
  }

  /**
   * Display-name overrides keyed by characterId — set ONCE by the orchestrator
   * when a Portuguese session's language pick lands (the hero-select gate,
   * before any turn), so the heroes carry their Portuguese names ("Heitor")
   * everywhere a name renders: snapshots, LLM state blocks, event-driven UI.
   * Renames the characters that already exist AND applies to characters
   * materialized later (the bound captive a scene spawns on entry). Pure
   * display state: ids, rules, and replay are untouched (replay re-applies
   * recorded actions, which reference ids, never names).
   */
  private nameOverrides: Map<CharacterId, string> | null = null;

  setNameOverrides(overrides: Record<string, string>): void {
    this.nameOverrides = new Map(
      Object.entries(overrides)
        .filter(([, name]) => name.trim().length > 0)
        .map(([id, name]) => [asCharacterId(id), name]),
    );
    for (const [id, name] of this.nameOverrides) {
      const c = this.characters.get(id);
      if (c) c.name = name;
    }
  }

  /** Read-only view of DM-spawned ad-hoc emoji props. */
  propsList(): ReadonlyArray<EmojiProp> {
    return Array.from(this.props.values());
  }

  /**
   * Floor cells currently holding a cheese-bait prop. The orchestrator passes
   * these to the monster AI, which paths to the nearest one instead of
   * attacking heroes while any bait is on the board.
   */
  activeBaitCells(): Square[] {
    return Array.from(this.props.values())
      .filter((p) => p.bait)
      .map((p) => ({ ...p.pos }));
  }

  /**
   * The active scene's monster-focus directive, if any (see
   * `SceneMonsterFocusSchema`). The orchestrator reads this each monster turn,
   * gates it on `turn.roundNumber >= fromRound`, and — when in effect — passes
   * the target id to the deterministic planner so the pack fixates on one
   * character (e.g. the bound captive) from the scripted round on. Null when the
   * current scene declares none, or no adventure is wired in.
   */
  activeMonsterFocus(): { characterId: CharacterId; fromRound: number } | null {
    const scene = this.adventure?.scenes.find((s) => s.id === this.currentSceneId);
    if (!scene?.monsterFocus) return null;
    return {
      characterId: asCharacterId(scene.monsterFocus.characterId),
      fromRound: scene.monsterFocus.fromRound,
    };
  }

  /**
   * The Scene spec the party is currently in (follows `currentSceneId`, set by
   * every successful `set_scene`). Undefined before the first scene entry or
   * without an adventure wired in. Lets the launcher keep agent prompts
   * pointed at the LIVE scene across transitions instead of the boot scene.
   */
  activeScene(): Scene | undefined {
    return this.adventure?.scenes.find((s) => s.id === this.currentSceneId);
  }

  /**
   * The active scene's still-standing obstacles at their CURRENT cells (a push
   * relocates them; a smash/blast removes them), enriched with live durability
   * (max + remaining hits) and the `attackProof` (stalagmite) / `pushable`
   * flags. Read straight from `liveObstacles` — the single source of truth.
   * Surfaced to the player prompt so AI heroes know what's breakable, what's
   * an attack-proof wall, and what they can shove.
   */
  activeSceneObstacles(): { type: string; x: number; y: number; durability?: number; remaining?: number; explosive?: boolean; cover?: boolean; attackProof?: boolean; pushable?: boolean }[] {
    return Array.from(this.liveObstacles.entries()).map(([key, o]) => {
      const [x, y] = key.split(',').map(Number) as [number, number];
      return {
        type: o.type, x, y,
        ...(o.durability.max > 1 ? { durability: o.durability.max, remaining: o.durability.remaining } : {}),
        ...(o.explosive ? { explosive: true } : {}),
        ...(o.cover ? { cover: true } : {}),
        ...(o.isStalagmite ? { attackProof: true } : {}),
        ...(o.pushable ? { pushable: true } : {}),
      };
    });
  }

  /** Drain queued events. Caller is expected to write them to the log. */
  flushEvents(): Event[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  beginNarrativeTurn(actorId: CharacterId): void {
    this.turn.setNarrativeActor(actorId);
  }

  applyAction(
    actorId: CharacterId,
    action: PlayerAction,
    opts?: {
      interpretedBy?: 'dm';
      providedAttackRoll?: ProvidedAttackRolls;
      providedAbilityRoll?: ProvidedAbilityRoll;
      /** One pre-rolled opposed roll per sub-attack of a multi-target special
       *  action (whirlwind / split-shot / flame-burst / pack-attack), in the
       *  same order `previewSpecialAttacks` enumerated them. A missing or
       *  ill-fitting entry falls back to the seeded dice for that sub-attack. */
      providedSpecialRolls?: ReadonlyArray<ProvidedAttackRolls | undefined>;
    },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.activeActorId !== actorId) {
      return err({ reason: 'not-actors-turn' });
    }
    if (!this.characters.has(actorId)) {
      return err({ reason: 'unknown-id', what: 'character', id: String(actorId) });
    }

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};

    switch (action.kind) {
      case 'say':
        this.emit({ type: 'action', actorId, action, ...interp } as unknown as Omit<Event, 't'>);
        return ok({ turnEnded: false });
      case 'emote': {
        if (typeof action.emoji !== 'string' || action.emoji.length === 0) {
          return err({ reason: 'invalid-action-shape', details: 'emote requires non-empty emoji' });
        }
        this.emit({ type: 'action', actorId, action, ...interp } as unknown as Omit<Event, 't'>);
        return ok({ turnEnded: false });
      }
      case 'end_turn':
      case 'skip_turn':
        this.emit({ type: 'action', actorId, action, ...interp } as unknown as Omit<Event, 't'>);
        return ok({ turnEnded: true });
      case 'move':
        return this.handleMove(actorId, action.path, opts);
      case 'normal_attack':
        return this.handleNormalAttack(actorId, action.targetId, {
          ...(opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {}),
          ...(opts?.providedAttackRoll ? { providedRoll: opts.providedAttackRoll } : {}),
        });
      case 'use_item':
        return this.handleUseItem(actorId, action.itemId, action.targetId, opts);
      case 'special_action':
        return this.handleSpecialAction(actorId, action, {
          ...(opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {}),
          ...(opts?.providedSpecialRolls ? { providedSpecialRolls: opts.providedSpecialRolls } : {}),
        });
      case 'use_boon':
        return this.handleUseBoon(actorId, action.boonId, action.targetId, opts);
      case 'equip':
        return this.handleEquip(actorId, action.equipmentId, opts);
      case 'ability_test':
        return this.handleAbilityTest(actorId, action, {
          ...(opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {}),
          ...(opts?.providedAbilityRoll ? { providedRoll: opts.providedAbilityRoll } : {}),
        });
      case 'attack_object':
        return this.handleAttackObject(actorId, action, {
          ...(opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {}),
          ...(opts?.providedAbilityRoll ? { providedRoll: opts.providedAbilityRoll } : {}),
        });
      case 'free_ally':
        return this.handleFreeAlly(actorId, action, {
          ...(opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {}),
          ...(opts?.providedAbilityRoll ? { providedRoll: opts.providedAbilityRoll } : {}),
        });
      case 'push_object':
        return this.handlePushObject(actorId, action, interp);
      case 'open_chest':
        return this.handleOpenChest(actorId, action, interp);
      case 'throw_item':
        return this.handleThrowItem(actorId, action, interp);
      default: {
        void (action satisfies never);
        return err({ reason: 'invalid-action-shape', details: 'unknown kind' });
      }
    }
  }

  applyDmAction(action: DmAction): Result<ActionOk, RuleViolation> {
    switch (action.kind) {
      case 'narrate':
        this.emit({ type: 'narrate', actorId: 'dm', text: action.text } as unknown as Event);
        return ok({ turnEnded: false });

      case 'set_scene': {
        // Idempotent re-entry of the SAME current scene (e.g. the DM
        // re-calls set_scene on its first turn for the scene the orchestrator
        // already auto-entered): no-op. Re-entering a DIFFERENT previously
        // visited scene (a back-step to an earlier scene) still needs the grid
        // swap + currentSceneId update, just without re-emitting scene_enter or
        // re-revealing monsters (already alive or already KO'd).
        if (this.enteredScenes.has(action.sceneId)) {
          if (this.currentSceneId === action.sceneId) {
            return ok({ turnEnded: false });
          }
          const scene = this.adventure?.scenes.find((s) => s.id === action.sceneId);
          if (scene) {
            this.grid = buildSceneGrid(scene);
            this.destroyedObstacles = [];
            this.initLiveObstacles(scene);
          }
          this.currentSceneId = action.sceneId;
          this.emit({ type: 'scene_enter', sceneId: action.sceneId } as unknown as Event);
          return ok({ turnEnded: false });
        }
        // Without an adventure wired in, set_scene is informational only —
        // the orchestrator (or test harness) is responsible for monsters.
        if (!this.adventure) {
          this.enteredScenes.add(action.sceneId);
          this.currentSceneId = action.sceneId;
          this.emit({ type: 'scene_enter', sceneId: action.sceneId } as unknown as Event);
          return ok({ turnEnded: false });
        }
        const scene = this.adventure.scenes.find((s) => s.id === action.sceneId);
        if (!scene) {
          return err({ reason: 'unknown-id', what: 'scene', id: String(action.sceneId) });
        }
        // Are we TRANSITIONING from a previously-entered scene (vs the first
        // scene entry of the run)? Only a transition should clear the prior
        // scene's monsters below — on the first entry, any monsters present were
        // seeded by the engine constructor (tests / bespoke setups) and must be
        // preserved. Captured before `enteredScenes.add` mutates the set.
        const leavingPriorScene = this.enteredScenes.size > 0;
        this.enteredScenes.add(action.sceneId);
        this.currentSceneId = action.sceneId;
        // Swap the grid to the new scene's layout — different scenes can
        // declare different dimensions and obstacle layouts (e.g. forest-edge
        // 10x7 → whispering-path 12x8). Without this, movement and LoS keep
        // validating against the previous scene's grid. The initial entry
        // (scene[0]) rebuilds to the same shape the orchestrator already
        // constructed, which is a harmless no-op.
        this.grid = buildSceneGrid(scene);
        // Forget any obstacles destroyed in the previous scene — those cells
        // belong to a different layout and should not leak across transitions.
        this.destroyedObstacles = [];
        this.initLiveObstacles(scene);
        // Drop the previous scene's monsters and scene-NPCs before revealing
        // this scene's. Two reasons: (1) their deterministic `{type}-N` ids
        // (counters reset per scene) would otherwise COLLIDE with the new
        // scene's auto-reveal — e.g. the basement's giant-rat-1 vs the
        // rat-tunnel's giant-rat-1 — aborting the whole transition (and with it
        // the entry re-seating below, stranding heroes on the previous scene's
        // coordinates, which can be rock in a carved cave). (2) Dead bodies from
        // the prior encounter should not follow the party into the next room.
        // Heroes persist across scenes; only non-hero combatants are cleared.
        if (leavingPriorScene) {
          for (const [cid, c] of this.characters) {
            if (c.kind !== 'hero') this.characters.delete(cid);
          }
        }
        this.emit({ type: 'scene_enter', sceneId: action.sceneId } as unknown as Event);
        // Auto-reveal scene-declared monsters with deterministic ids of the
        // form `{type}-1`, `{type}-2`, ... per type (counters reset per scene).
        const counters: Record<string, number> = {};
        for (const m of scene.monsters) {
          counters[m.type] = (counters[m.type] ?? 0) + 1;
          const id = asCharacterId(`${m.type}-${counters[m.type]}`);
          if (this.characters.has(id)) {
            return err({
              reason: 'invalid-action-shape',
              details: `auto-reveal id collision: ${id}`,
            });
          }
          const monsterRes = this.materializeMonster(m.type, id, m.startPos);
          if (!monsterRes.ok) return monsterRes;
          this.characters.set(id, monsterRes.value);
          this.emit({
            type: 'action',
            actorId: 'dm',
            action: {
              kind: 'reveal_monster',
              monsterTypeId: m.type,
              characterId: id,
              pos: m.startPos,
            },
          } as unknown as Event);
        }
        // Auto-reveal scene-declared NPCs. Same id pattern as monsters: {type}-1, ...
        const npcCounters: Record<string, number> = {};
        for (const n of scene.map.npcs ?? []) {
          npcCounters[n.type] = (npcCounters[n.type] ?? 0) + 1;
          const id = asCharacterId(`${n.type}-${npcCounters[n.type]}`);
          if (this.characters.has(id)) {
            return err({ reason: 'invalid-action-shape', details: `auto-reveal id collision: ${id}` });
          }
          const npcRes = this.materializeNpc(n.type, id, n.startPos);
          if (!npcRes.ok) return npcRes;
          this.characters.set(id, npcRes.value);
          this.emit({
            type: 'action',
            actorId: 'dm',
            action: {
              kind: 'reveal_npc',
              npcTypeId: n.type,
              characterId: id,
              pos: n.startPos,
              allegiance: n.allegiance,
            },
          } as unknown as Event);
        }
        // Materialize scene-declared CAPTIVES — heroes who begin this scene
        // immobilized (rescue objectives). Done BEFORE entry-seating so the
        // captive's cell counts as occupied and a mobile hero isn't seated onto
        // it. The captive's id must match the agent that controls them once
        // freed (e.g. scenario agents.p3.characterId). Idempotent across the
        // first-entry path only (this whole branch runs once per scene).
        for (const cap of scene.map.captives ?? []) {
          const id = asCharacterId(cap.characterId);
          if (this.characters.has(id)) {
            return err({ reason: 'invalid-action-shape', details: `captive id collision: ${cap.characterId}` });
          }
          // A name override (pt session) beats the scene-declared name — the
          // captive materializes mid-run, after the language pick.
          const capName = this.nameOverrides?.get(id) ?? cap.name;
          const capRes = this.materializeCaptiveHero(cap.archetype, id, capName, cap.startPos);
          if (!capRes.ok) return capRes;
          this.characters.set(id, capRes.value);
        }
        // Materialize scene-declared CHESTS as non-blocking emoji props carrying
        // their loot. A hero adjacent to one can `open_chest` to take the item.
        // Emit a spawn_prop action so a connected browser renders the chest
        // sprite (reconnects pick it up from the snapshot's props list).
        for (const chest of scene.map.chests ?? []) {
          if (this.props.has(chest.id)) {
            return err({ reason: 'invalid-action-shape', details: `chest id collision: ${chest.id}` });
          }
          const emoji = chest.emoji ?? '📦';
          const name = chest.name ?? 'Chest';
          const description = chest.description
            ?? 'a closed chest — stand adjacent and open_chest to loot it';
          this.props.set(chest.id, {
            id: chest.id, emoji, name, pos: { ...chest.pos },
            chest: { contents: asItemId(chest.contents) }, spriteId: 'chest', description,
          });
          this.emit({
            type: 'action', actorId: 'dm',
            // `spriteId` rides along so a live browser renders the chest sprite
            // (the store reads it on the spawn_prop path); reconnects pick it up
            // from the serialized snapshot props below.
            action: { kind: 'spawn_prop', id: chest.id, emoji, name, pos: { ...chest.pos }, description, spriteId: 'chest' },
          } as unknown as Event);
        }
        // Seat the party at the scene's declared entry (if any) so a carved
        // cave drops them at its tunnel mouth rather than leaving them wherever
        // the previous scene ended. Done AFTER monster/NPC/captive reveal so
        // entry-cell collisions are detected against their placed positions.
        if (scene.map.entry && scene.map.entry.length > 0) {
          this.seatHeroesAtEntry(scene.map.entry);
        }
        return ok({ turnEnded: false });
      }

      case 'start_combat': {
        // Auto-include any on-board IMMOBILIZED hero the DM omitted from
        // heroSide. A bound captive can't be expected to be listed by the DM
        // (it may be behind a wall, out of the DM's framing) — but it must hold
        // a turn slot so that, once freed mid-combat, its turns become live
        // without re-rolling initiative. Surgical: only immobilized heroes are
        // appended, so a fully-specified heroSide (every test) is unchanged.
        const listed = new Set(action.heroSide.map(String));
        const captiveIds = Array.from(this.characters.values())
          .filter((c) => c.kind === 'hero' && c.health.status === 'immobilized' && !listed.has(String(c.id)))
          .map((c) => c.id);
        const heroSide = [...action.heroSide, ...captiveIds];
        const dexFor = (id: CharacterId): number => this.characters.get(id)?.dex ?? 0;
        const r = this.turn.startCombat(
          this.dice,
          heroSide,
          action.monsterSide,
          dexFor,
        );
        this.emit({
          type: 'combat_started',
          heroSide,
          monsterSide: action.monsterSide,
          order: r.order,
          rolls: r.rolls,
        } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'end_combat':
        if (this.turn.phase !== 'combat') {
          return err({ reason: 'wrong-phase' });
        }
        this.turn.endCombat();
        this.emit({ type: 'combat_ended' } as unknown as Event);
        return ok({ turnEnded: false });

      case 'request_action':
        if (!this.characters.has(action.actorId)) {
          return err({
            reason: 'unknown-id',
            what: 'character',
            id: String(action.actorId),
          });
        }
        this.turn.setNarrativeActor(action.actorId);
        this.emit({
          type: 'request_action',
          actorId: 'dm',
          targetId: action.actorId,
        } as unknown as Event);
        return ok({ turnEnded: false });

      case 'reveal_monster': {
        if (this.characters.has(action.characterId)) {
          return err({
            reason: 'invalid-action-shape',
            details: `id already in use: ${String(action.characterId)}`,
          });
        }
        const monsterRes = this.materializeMonster(
          action.monsterTypeId,
          action.characterId,
          action.pos,
        );
        if (!monsterRes.ok) return monsterRes;
        this.characters.set(action.characterId, monsterRes.value);
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'environmental':
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });

      case 'spawn_prop': {
        // Engine enforces grid validity only — story validity (was the dice
        // roll passed? does it make sense?) is the DM's responsibility, gated
        // by the prompt and the player's `ability_test` outcome.
        if (action.id.length === 0) {
          return err({ reason: 'invalid-action-shape', details: 'prop id is empty' });
        }
        if (action.emoji.length === 0) {
          return err({ reason: 'invalid-action-shape', details: 'emoji is empty' });
        }
        if (this.props.has(action.id)) {
          return err({ reason: 'invalid-action-shape', details: `prop id already in use: ${action.id}` });
        }
        if (!this.grid.inBounds(action.pos)) {
          return err({ reason: 'invalid-action-shape', details: 'prop pos out of bounds' });
        }
        if (blocksMovement(this.grid.cellAt(action.pos))) {
          return err({ reason: 'blocked-by-wall' });
        }
        const prop: EmojiProp = {
          id: action.id,
          emoji: action.emoji,
          name: action.name,
          pos: action.pos,
          ...(action.description !== undefined && { description: action.description }),
        };
        this.props.set(action.id, prop);
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'remove_prop': {
        if (!this.props.has(action.id)) {
          return err({ reason: 'unknown-id', what: 'prop', id: action.id });
        }
        this.props.delete(action.id);
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'offer_rest':
        this.emit({ type: 'rest_offered' } as unknown as Event);
        return ok({ turnEnded: false });

      case 'end_adventure':
        this.emit({ type: 'adventure_ended', outcome: action.outcome } as unknown as Event);
        return ok({ turnEnded: false });

      case 'npc_action': {
        const target = this.characters.get(action.npcId);
        if (!target || target.kind !== 'npc') {
          return err({ reason: 'invalid-target' });
        }
        if (!NPC_ALLOWED_ACTIONS.has(action.action.kind)) {
          return err({
            reason: 'invalid-action-shape',
            details: `npc_action: action.kind=${action.action.kind} is not allowed for NPCs`,
          });
        }
        // Outside combat the DM owns NPCs unconditionally — temporarily install
        // the NPC as the narrative actor so applyAction's `not-actors-turn` guard
        // does not reject. Restore the previous narrative actor afterward (even if
        // applyAction throws).
        const inCombat = this.turn.phase === 'combat';
        let savedNarrative: CharacterId | null = null;
        if (!inCombat) {
          savedNarrative = this.turn.activeActorId;
          this.turn.setNarrativeActor(action.npcId);
        }
        try {
          return this.applyAction(action.npcId, action.action, { interpretedBy: 'dm' });
        } finally {
          if (!inCombat) {
            this.turn.setNarrativeActor(savedNarrative);
          }
        }
      }

      case 'monster_action': {
        // The DM puppeting a monster on its OWN combat turn. Unlike npc_action,
        // no narrative-actor swap is needed: in combat the monster is already
        // the active actor, so applyAction's `not-actors-turn` guard passes.
        const target = this.characters.get(action.monsterId);
        if (!target || target.kind !== 'monster') {
          return err({ reason: 'invalid-target' });
        }
        if (this.turn.phase !== 'combat') {
          return err({ reason: 'wrong-phase' });
        }
        if (this.turn.activeActorId !== action.monsterId) {
          return err({ reason: 'not-actors-turn' });
        }
        if (!MONSTER_ALLOWED_ACTIONS.has(action.action.kind)) {
          return err({
            reason: 'invalid-action-shape',
            details: `monster_action: action.kind=${action.action.kind} is not allowed for monsters`,
          });
        }
        return this.applyAction(action.monsterId, action.action, { interpretedBy: 'dm' });
      }

      case 'reveal_npc': {
        if (this.characters.has(action.characterId)) {
          return err({
            reason: 'invalid-action-shape',
            details: `reveal_npc id collision: ${action.characterId}`,
          });
        }
        const r = this.materializeNpc(action.npcTypeId, action.characterId, action.pos);
        if (!r.ok) return r;
        this.characters.set(action.characterId, r.value);
        this.emit({
          type: 'action',
          actorId: 'dm',
          action: {
            kind: 'reveal_npc',
            npcTypeId: action.npcTypeId,
            characterId: action.characterId,
            pos: action.pos,
            allegiance: action.allegiance,
          },
        } as unknown as Event);
        return ok({ turnEnded: false });
      }

      default: {
        void (action satisfies never);
        return err({ reason: 'invalid-action-shape', details: 'unknown dm action kind' });
      }
    }
  }

  private handleMove(
    actorId: CharacterId,
    path: { x: number; y: number }[],
    opts?: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasMoved()) return err({ reason: 'already-moved' });
    // A malformed action (e.g. a DM-puppeted monster move whose nested `action`
    // omitted `path`, which the `monster_action`/`npc_action` tool schema does
    // NOT constrain) must surface as a RuleViolation, never an uncaught throw —
    // the engine validates every action and can't be crashed by a bad LLM call.
    if (!Array.isArray(path) || path.length < 2) {
      return err({ reason: 'invalid-action-shape', details: 'path must be an array of at least 2 squares' });
    }

    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });

    const start = path[0]!;
    if (start.x !== actor.pos.x || start.y !== actor.pos.y) {
      return err({
        reason: 'invalid-action-shape',
        details: 'path[0] must equal current position',
      });
    }

    // Build set of positions occupied by any LIVE character — allies AND
    // enemies. A hero can neither pass through nor end on a living teammate or
    // foe. KO'd characters are corpses; they're excluded here, so a hero may
    // still walk through (and onto) a fallen body.
    const blockedPositions = new Set<string>();
    for (const c of this.characters.values()) {
      if (c.id !== actorId && c.pos && c.health.status !== 'KO') {
        blockedPositions.add(`${c.pos.x},${c.pos.y}`);
      }
    }

    // Validate every step.
    let movementUsed = 0;
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1]!;
      const cur = path[i]!;
      if (!this.grid.isAdjacent(prev, cur)) {
        return err({
          reason: 'invalid-action-shape',
          details: `path step ${i} not adjacent`,
        });
      }
      const cell = this.grid.cellAt(cur);
      if (blocksMovement(cell)) return err({ reason: 'blocked-by-wall' });
      const k = `${cur.x},${cur.y}`;
      // A living character blocks every cell of the path — transit or end.
      if (blockedPositions.has(k)) return err({ reason: 'invalid-target' });
      movementUsed += cell.kind === 'obstacle' ? 2 : 1;
    }

    const budget = 4; // TODO: per-character override (e.g. Rogue's Nimble = 5)
    if (movementUsed > budget) return err({ reason: 'insufficient-movement' });

    const finalPos = path[path.length - 1]!;
    this.characters.set(actorId, { ...actor, pos: finalPos });

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'move', path },
      ...interp,
    } as unknown as Event);
    this.emit({
      type: 'state_change',
      changes: [{ id: actorId, pos: finalPos }],
    } as unknown as Event);

    // A monster that ENDS its move on a cheese-bait cell eats it: the lure is
    // consumed (prop removed) so it stops drawing the pack. The `remove_prop`
    // action keeps browser subscribers' prop layer in sync.
    if (actor.kind === 'monster') {
      for (const p of this.props.values()) {
        if (p.bait && p.pos.x === finalPos.x && p.pos.y === finalPos.y) {
          this.props.delete(p.id);
          this.emit({
            type: 'action', actorId,
            action: { kind: 'remove_prop', id: p.id },
            ...interp,
          } as unknown as Event);
          break;
        }
      }
    }

    this.turn.markMoved();
    return ok({ turnEnded: false });
  }

  /**
   * Validate a normal attack and compute the dice-pool sizes WITHOUT rolling.
   * Returns the same rule violations `handleNormalAttack` would, otherwise
   * the effective `attackerPoolSize` and `defenderArmorPoolSize` after all
   * engagement bonuses and cover modifiers. Used by the orchestrator when a
   * `RollProvider` (browser physics) needs to know how many dice to throw
   * before the engine resolves.
   *
   * Pure: no state mutation, no event emission, no dice consumption.
   */
  previewNormalAttackPools(
    actorId: CharacterId,
    targetId: CharacterId,
  ): Result<{ attackerPoolSize: number; defenderArmorPoolSize: number }, RuleViolation> {
    const ctx = this.computeNormalAttackContext(actorId, targetId);
    if (!ctx.ok) return ctx;
    const { attackerPool, defenderArmor, extraAttackDice, extraArmor } = ctx.value;
    return ok({
      attackerPoolSize: Math.max(0, attackerPool + extraAttackDice),
      defenderArmorPoolSize: Math.max(0, defenderArmor + extraArmor),
    });
  }

  /**
   * Shared validation + pool computation for normal attacks. `handleNormalAttack`
   * runs this then rolls; `previewNormalAttackPools` runs only this so the
   * orchestrator can ask a RollProvider for face values before the engine
   * commits.
   */
  private computeNormalAttackContext(
    actorId: CharacterId,
    targetId: CharacterId,
  ): Result<{
    actor: Character;
    target: Character;
    attackKind: AttackKind;
    attackerPool: number;
    defenderArmor: number;
    extraAttackDice: number;
    extraArmor: number;
    /** The attacker's bonus passive, set only when it actually added dice. */
    attackerPassive?: { id: string; name: string; effect: string };
    /** The defender's bonus passive, set only when it actually added armor. */
    defenderPassive?: { id: string; name: string; effect: string };
  }, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    const target = this.characters.get(targetId);
    if (!target) return err({ reason: 'unknown-id', what: 'character', id: String(targetId) });
    if (target.health.status === 'KO') return err({ reason: 'invalid-target' });
    if (!actor.pos || !target.pos) return err({ reason: 'invalid-target' });

    const attackKind = actor.normalAttack.kind;
    const range = actor.normalAttack.range;
    const distance = chebyshevDistance(actor.pos, target.pos);
    if (distance > range) return err({ reason: 'out-of-range' });

    let extraArmor = 0;
    if (attackKind !== 'melee') {
      const sight = this.grid.lineOfSight(actor.pos, target.pos);
      if (sight.blocked) return err({ reason: 'no-line-of-sight' });
      if (sight.cover) extraArmor += 1;
    }

    const pool = actor.pools[attackKind];

    // Compute teamwork / power-surge-style bonus dice from the ATTACKER's bonus
    // passive. The passive consumes `targetEngaged` (≥ 2 non-KO'd attacker-team
    // members adjacent to the target) and `attackKind` (for magic-only passives
    // like Power Surge). `attackerPassive` is set only when the passive actually
    // added dice, so the resolution path can surface a "{name} triggered" banner.
    const engaged = isEngaged(target, this.characters.values(), actor.kind);
    let extraAttackDice = 0;
    let attackerPassive: { id: string; name: string; effect: string } | undefined;
    if (this.effects.has(actor.bonusAbility.id)) {
      const bonusResult = this.effects.get(actor.bonusAbility.id).apply({
        actor, target, params: { targetEngaged: engaged, attackKind },
      });
      let added = 0;
      for (const change of bonusResult.changes) {
        if (change.kind === 'attack-mod') added += change.extraDice;
      }
      extraAttackDice += added;
      if (added > 0) {
        attackerPassive = {
          id: String(actor.bonusAbility.id),
          name: actor.bonusAbility.name,
          effect: `+${added} attack ${added === 1 ? 'die' : 'dice'}`,
        };
      }
    }

    // Compute the DEFENDER's bonus passive armor dice (e.g. Healer's Tangled:
    // +1 armor die when defending a melee attack). Evaluated with the incoming
    // `attackKind`; `defenderPassive` is set only when armor was actually added.
    let defenderPassive: { id: string; name: string; effect: string } | undefined;
    if (this.effects.has(target.bonusAbility.id)) {
      const defResult = this.effects.get(target.bonusAbility.id).apply({
        actor: target, target: actor, params: { defendingAttackKind: attackKind },
      });
      let addedArmor = 0;
      for (const change of defResult.changes) {
        if (change.kind === 'armor-mod') addedArmor += change.extraDice;
      }
      extraArmor += addedArmor;
      if (addedArmor > 0) {
        defenderPassive = {
          id: String(target.bonusAbility.id),
          name: target.bonusAbility.name,
          effect: `+${addedArmor} armor ${addedArmor === 1 ? 'die' : 'dice'}`,
        };
      }
    }

    // Hunter/Healer are skirmishers: a foe in melee range (adjacent) fouls their
    // ranged/magic attack, costing 1 die. Distance 1 == adjacent (distance 0 is
    // self / impossible for two distinct characters). Folded into extraAttackDice
    // so preview and resolution stay in lock-step; floored at 0 downstream.
    if (distance === 1 && actor.archetype && ADJACENT_ATTACK_PENALTY_ARCHETYPES.has(actor.archetype)) {
      extraAttackDice -= 1;
    }

    return ok({
      actor, target, attackKind,
      attackerPool: pool, defenderArmor: target.pools.armor,
      extraAttackDice, extraArmor,
      ...(attackerPassive && { attackerPassive }),
      ...(defenderPassive && { defenderPassive }),
    });
  }

  private handleNormalAttack(
    actorId: CharacterId,
    targetId: CharacterId,
    opts?: { interpretedBy?: 'dm'; providedRoll?: ProvidedAttackRolls },
  ): Result<ActionOk, RuleViolation> {
    const ctxResult = this.computeNormalAttackContext(actorId, targetId);
    if (!ctxResult.ok) return ctxResult;
    const { actor, target, attackKind, attackerPool: pool, defenderArmor, extraAttackDice, extraArmor, attackerPassive, defenderPassive } = ctxResult.value;

    const result = resolveAttack(this.dice, {
      attackerPool: pool,
      defenderArmor,
      attackKind,
      modifiers: {
        extraAttackDice,
        extraArmorDice: extraArmor,
        damageMod: actor.normalAttack.damageMod,
      },
    }, opts?.providedRoll);

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'normal_attack', targetId },
      ...interp,
    } as unknown as Event);
    // Surface the dice-boosting passives (attacker's Teamwork/Power Surge, the
    // defender's Tangled) the moment the roll is committed — the rule effect is
    // already baked into the pools above; this is purely the UI banner signal,
    // so it only fires for HEROES (the dice math stays kind-agnostic).
    if (attackerPassive && actor.kind === 'hero') this.emitPassiveTriggered(actorId, attackerPassive);
    if (defenderPassive && target.kind === 'hero') this.emitPassiveTriggered(target.id, defenderPassive);
    this.emit({
      type: 'resolution',
      actorId,
      public: {
        hit: result.hit,
        damage: result.damage,
        attackerTop: result.attackerTop,
        defenderTop: result.defenderTop,
        // Anchor the browser's HIT/MISS flash on the target token, not the
        // attacker — without this the browser falls back to actorId and the
        // flash appears next to the attacker instead of the enemy.
        targetId,
        attackKind,
        // When the faces came from the browser's 3D physics (physics-as-truth
        // mode), echo the request id so the client can skip re-rolling the
        // dice it already animated and just play the verdict + downstream
        // effects. Absent for engine-rolled (seeded) attacks.
        ...(opts?.providedRoll?.requestId ? { rollRequestId: opts.providedRoll.requestId } : {}),
      },
      private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
    } as unknown as Event);

    if (result.hit && result.damage > 0) {
      const damaged = applyDamage(target, result.damage);
      this.characters.set(target.id, damaged);
      this.emit({
        type: 'state_change',
        changes: [
          { id: target.id, damage: damaged.health.damage, status: damaged.health.status },
        ],
      } as unknown as Event);
      // Hunter passive: a hero that was just damaged (and survived) may dart one
      // square away from its attacker. (actor.pos is non-null — validated above.)
      if (actor.pos) this.maybeReactiveStep(target.id, actor.pos);
    }

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /** Emit a `passive_triggered` banner event for a hero's bonus ability. */
  private emitPassiveTriggered(
    actorId: CharacterId,
    passive: { id: string; name: string; effect: string },
  ): void {
    this.emit({
      type: 'passive_triggered',
      actorId,
      abilityId: passive.id,
      abilityName: passive.name,
      effect: passive.effect,
    } as unknown as Event);
  }

  /**
   * Hunter bonus ability — "When you're damaged by an attack, you can
   * immediately move 1 square." After a hero whose bonus passive yields a
   * `move-bonus` survives a hit, dart one square AWAY from the attacker. The
   * step is deterministic and only ever taken when it strictly increases the
   * distance from the attacker (so it can never blunder the hero into reach):
   * among the free, passable, unoccupied 8-neighbours, pick the one farthest
   * from `attackerPos`, tie-broken by (y, x). No candidate that improves the
   * distance → no move (just the banner). Emits a `passive_triggered` banner +
   * a `state_change` for the new position; does NOT consume the hero's own
   * movement (it's off-turn) and is replay-safe (a pure consequence of the
   * recorded attack + board state).
   */
  private maybeReactiveStep(victimId: CharacterId, attackerPos: Square): void {
    const victim = this.characters.get(victimId);
    if (!victim || victim.kind !== 'hero' || !victim.pos) return;
    if (victim.health.status === 'KO' || victim.health.status === 'immobilized') return;
    if (!this.effects.has(victim.bonusAbility.id)) return;
    const res = this.effects.get(victim.bonusAbility.id).apply({ actor: victim });
    if (!res.changes.some((c) => c.kind === 'move-bonus' && c.squares > 0)) return;

    const from = victim.pos;
    const occupied = new Set<string>();
    for (const c of this.characters.values()) {
      if (c.id !== victimId && c.pos && c.health.status !== 'KO') {
        occupied.add(`${c.pos.x},${c.pos.y}`);
      }
    }
    const curDist = chebyshevDistance(from, attackerPos);
    let best: Square | null = null;
    let bestDist = curDist;
    // 8-neighbours, scanned in (y, x) order so ties resolve deterministically.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cand: Square = { x: from.x + dx, y: from.y + dy };
        if (!this.grid.inBounds(cand)) continue;
        if (blocksMovement(this.grid.cellAt(cand))) continue;
        if (occupied.has(`${cand.x},${cand.y}`)) continue;
        const d = chebyshevDistance(cand, attackerPos);
        if (d > bestDist) { bestDist = d; best = cand; }
      }
    }
    if (!best) return;

    this.characters.set(victimId, { ...victim, pos: best });
    this.emitPassiveTriggered(victimId, {
      id: String(victim.bonusAbility.id),
      name: victim.bonusAbility.name,
      effect: 'darts 1 square',
    });
    this.emit({
      type: 'state_change',
      changes: [{ id: victimId, pos: best }],
    } as unknown as Event);
  }

  /**
   * Shared validation + pool computation for `free_ally`, without rolling — so
   * the orchestrator can outsource the dice to a RollProvider (browser physics)
   * exactly as it does for `ability_test`. Returns the same rule_violations
   * `handleFreeAlly` would, so a failed preview means the action would fail.
   */
  previewFreeAlly(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'free_ally' }>,
  ): Result<{ poolSize: number; difficulty: 4 | 5 | 6 }, RuleViolation> {
    const v = this.validateFreeAlly(actorId, action);
    if (!v.ok) return v;
    const { actor } = v.value;
    const pool = actor.pools[action.characteristic];
    const hasSkill = !!action.skillId && actor.skills.includes(action.skillId);
    return ok({ poolSize: 1 + pool + (hasSkill ? 1 : 0), difficulty: (action.difficulty ?? 4) as 4 | 5 | 6 });
  }

  /** Common gate for free_ally: actor must not have acted; target must be an
   *  ADJACENT immobilized hero (not self, not KO'd, not a foe). */
  private validateFreeAlly(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'free_ally' }>,
  ): Result<{ actor: Character; target: Character }, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    const target = this.characters.get(action.targetId);
    if (!target) return err({ reason: 'unknown-id', what: 'character', id: String(action.targetId) });
    if (target.id === actor.id) return err({ reason: 'invalid-target' });
    if (target.kind !== 'hero' || target.health.status !== 'immobilized') {
      return err({ reason: 'not-immobilized' });
    }
    if (!actor.pos || !target.pos) return err({ reason: 'invalid-target' });
    if (chebyshevDistance(actor.pos, target.pos) !== 1) return err({ reason: 'out-of-range' });
    return ok({ actor, target });
  }

  /**
   * Resolve `free_ally`: the rescuer rolls `characteristic` (+ optional skill)
   * vs `difficulty` (default 4) — ability-test semantics, binary success. On
   * success the target's `immobilized` status clears to `normal`, so it rejoins
   * the party and (if a combat turn slot was reserved at start_combat) its turns
   * become live. Always counts as the rescuer's main action, pass or fail.
   */
  private handleFreeAlly(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'free_ally' }>,
    opts?: { interpretedBy?: 'dm'; providedRoll?: ProvidedAbilityRoll },
  ): Result<ActionOk, RuleViolation> {
    const v = this.validateFreeAlly(actorId, action);
    if (!v.ok) return v;
    const { actor, target } = v.value;
    const difficulty = (action.difficulty ?? 4) as 4 | 5 | 6;
    const pool = actor.pools[action.characteristic];
    const hasSkill = !!action.skillId && actor.skills.includes(action.skillId);

    const result = resolveAbilityTestInternal(this.dice, {
      characteristicPool: pool,
      hasSkill,
      hasItem: false,
      difficulty,
    }, opts?.providedRoll);

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: {
        success: result.success,
        top: result.top,
        difficulty,
        // Carry the freed teammate's id + a `freed` flag so the UI can play a
        // "broke free" beat and refresh the chains overlay on success.
        targetId: target.id,
        freed: result.success,
        ...(opts?.providedRoll?.requestId ? { rollRequestId: opts.providedRoll.requestId } : {}),
      },
      private: { roll: result.roll },
    } as unknown as Event);

    if (result.success) {
      const freed: Character = { ...target, health: { ...target.health, status: 'normal' } };
      this.characters.set(target.id, freed);
      this.emit({
        type: 'state_change',
        changes: [{ id: target.id, damage: freed.health.damage, status: 'normal' }],
      } as unknown as Event);
    }

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  private handleUseItem(
    actorId: CharacterId,
    itemId: ItemId,
    targetId: CharacterId | undefined,
    opts?: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const stack = actor.inventory.find((s) => s.itemId === itemId);
    if (!stack || stack.count <= 0) {
      return err({ reason: 'unknown-id', what: 'item', id: String(itemId) });
    }
    const def = this.items.get(itemId);
    if (!def) return err({ reason: 'unknown-id', what: 'item', id: String(itemId) });

    if (def.category !== 'consumable') {
      return err({
        reason: 'invalid-action-shape',
        details: 'utility items are not used as actions',
      });
    }
    // Utility items don't cost the action, so the consumable check goes first.
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });

    const effect = this.effects.get(def.consumableEffect!);
    const target = targetId ? this.characters.get(targetId) ?? actor : actor;
    const result = effect.apply({ actor, target });

    // Emit the action event first, so log order is action → state_change.
    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'use_item', itemId, ...(targetId && { targetId }) },
      ...interp,
    } as unknown as Event);

    const currentActor = this.applyEffectChanges(actorId, result.changes);

    // Decrement stack.
    const newInventory =
      stack.count > 1
        ? currentActor.inventory.map((s) =>
            s.itemId === itemId ? { ...s, count: s.count - 1 } : s,
          )
        : currentActor.inventory.filter((s) => s.itemId !== itemId);
    this.characters.set(actorId, { ...currentActor, inventory: newInventory });

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Apply EffectChange entries to engine state and emit state_change.
   * Returns the (possibly updated) actor for callers that need a fresh handle.
   */
  private applyEffectChanges(
    actorId: CharacterId,
    changes: ReadonlyArray<EffectChange>,
  ): Character {
    let currentActor = this.characters.get(actorId)!;
    for (const change of changes) {
      if (change.kind === 'heal') {
        const c = this.characters.get(change.characterId as CharacterId);
        if (c) {
          const healed = healDamage(c, change.amount);
          this.characters.set(c.id, healed);
          if (c.id === actorId) currentActor = healed;
          this.emit({
            type: 'state_change',
            changes: [{ id: c.id, damage: healed.health.damage, status: healed.health.status }],
          } as unknown as Event);
        }
      } else if (change.kind === 'damage') {
        const c = this.characters.get(change.characterId as CharacterId);
        if (c) {
          const damaged = applyDamage(c, change.amount);
          this.characters.set(c.id, damaged);
          if (c.id === actorId) currentActor = damaged;
          this.emit({
            type: 'state_change',
            changes: [{ id: c.id, damage: damaged.health.damage, status: damaged.health.status }],
          } as unknown as Event);
        }
      }
      // attack-mod / free-attack / move-bonus / noop: handled by other paths.
    }
    return currentActor;
  }

  /**
   * Pool size + difficulty for an ability test, without rolling. The
   * orchestrator runs this to ask a RollProvider for the browser's physics
   * faces before the engine commits — mirrors `previewNormalAttackPools`.
   */
  previewAbilityTest(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'ability_test' }>,
  ): Result<{ poolSize: number; difficulty: 4 | 5 | 6 }, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    const pool = actor.pools[action.characteristic];
    const hasSkill = !!action.skillId && actor.skills.includes(action.skillId);
    const hasItem = !!action.itemId && actor.inventory.some((s) => s.itemId === action.itemId);
    return ok({ poolSize: 1 + pool + (hasSkill ? 1 : 0) + (hasItem ? 1 : 0), difficulty: action.difficulty });
  }

  private handleAbilityTest(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'ability_test' }>,
    opts?: { interpretedBy?: 'dm'; providedRoll?: ProvidedAbilityRoll },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    const pool = actor.pools[action.characteristic];
    const hasSkill = !!action.skillId && actor.skills.includes(action.skillId);
    const hasItem = !!action.itemId && actor.inventory.some((s) => s.itemId === action.itemId);

    const result = resolveAbilityTestInternal(this.dice, {
      characteristicPool: pool,
      hasSkill,
      hasItem,
      difficulty: action.difficulty,
    }, opts?.providedRoll);

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: {
        success: result.success,
        top: result.top,
        difficulty: action.difficulty,
        ...(opts?.providedRoll?.requestId ? { rollRequestId: opts.providedRoll.requestId } : {}),
      },
      private: { roll: result.roll },
    } as unknown as Event);

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Resolve `attack_object`: actor swings their normal-attack pool at an
   * obstacle cell or an emoji prop. Any die ≥ difficulty destroys it. The
   * engine mutates the grid (wall→floor) for obstacles, or removes the prop
   * from the props map. Always counts as the actor's main action — pass or
   * fail. Range mirrors normal_attack; ranged attacks require LoS.
   */
  /**
   * Validate an `attack_object` and report its pool size + difficulty without
   * rolling, so the orchestrator can outsource the dice to a RollProvider
   * (browser physics). Returns the same rule_violations `handleAttackObject`
   * would, so a failed preview means the action would fail anyway.
   */
  previewAttackObject(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'attack_object' }>,
  ): Result<{ poolSize: number; difficulty: 3 | 4 | 5 | 6 }, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });
    if (!this.grid.inBounds(action.pos)) return err({ reason: 'invalid-action-shape', details: 'pos out of bounds' });
    const cell = this.grid.cellAt(action.pos);
    const isObstacleCell = isDestructibleObstacleCell(cell);
    const propOnCell = Array.from(this.props.values()).some(
      (p) => p.pos.x === action.pos.x && p.pos.y === action.pos.y,
    );
    if (!isObstacleCell && !propOnCell) return err({ reason: 'no-such-object' });
    // Attack-proof stalagmites can't be smashed by attacks/spells — only an
    // explosion blast clears them (see handleAttackObject's blast path).
    if (isObstacleCell && this.liveObstacles.get(`${action.pos.x},${action.pos.y}`)?.isStalagmite) {
      return err({ reason: 'indestructible' });
    }
    const attackKind = actor.normalAttack.kind;
    if (chebyshevDistance(actor.pos, action.pos) > actor.normalAttack.range) return err({ reason: 'out-of-range' });
    if (attackKind !== 'melee' && this.grid.lineOfSight(actor.pos, action.pos).blocked) {
      return err({ reason: 'no-line-of-sight' });
    }
    // Default object DC is 3 (easy) — smashing props/obstacles should be
    // reliably doable, so the DM only needs to bump it for genuinely tough
    // targets. The DM may still override with 4 | 5 | 6.
    return ok({ poolSize: 1 + actor.pools[attackKind], difficulty: (action.difficulty ?? 3) as 3 | 4 | 5 | 6 });
  }

  private handleAttackObject(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'attack_object' }>,
    opts?: { interpretedBy?: 'dm'; providedRoll?: ProvidedAbilityRoll },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });
    if (!this.grid.inBounds(action.pos)) return err({ reason: 'invalid-action-shape', details: 'pos out of bounds' });

    // Identify the target. Obstacle takes precedence over prop when both
    // sit on the same cell (you can't reach the cheese through the barrel).
    const cell = this.grid.cellAt(action.pos);
    const isObstacleCell = isDestructibleObstacleCell(cell);
    const propOnCell = Array.from(this.props.values()).find(
      (p) => p.pos.x === action.pos.x && p.pos.y === action.pos.y,
    );
    if (!isObstacleCell && !propOnCell) return err({ reason: 'no-such-object' });
    // Attack-proof stalagmites can't be smashed by attacks/spells — only an
    // explosion blast clears them (handled in the blast path below). Reject
    // before rolling so no turn/dice are spent and the preview agrees.
    if (isObstacleCell && this.liveObstacles.get(`${action.pos.x},${action.pos.y}`)?.isStalagmite) {
      return err({ reason: 'indestructible' });
    }

    const attackKind = actor.normalAttack.kind;
    const range = actor.normalAttack.range;
    const distance = chebyshevDistance(actor.pos, action.pos);
    if (distance > range) return err({ reason: 'out-of-range' });
    if (attackKind !== 'melee') {
      const sight = this.grid.lineOfSight(actor.pos, action.pos);
      if (sight.blocked) return err({ reason: 'no-line-of-sight' });
    }

    // Must match previewAttackObject's default (3) so the browser's physics
    // verdict (top >= DC shown in the HUD) agrees with the engine resolution.
    const difficulty = action.difficulty ?? 3;
    const pool = actor.pools[attackKind];
    // Use ability-test semantics — destruction is binary, not graduated.
    const result = resolveAbilityTestInternal(this.dice, {
      characteristicPool: pool,
      hasSkill: false,
      hasItem: false,
      difficulty,
    }, opts?.providedRoll);

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);

    const targetKind = isObstacleCell ? 'obstacle' : 'prop';
    const targetRef = propOnCell?.id;

    // Obstacle durability: a successful hit drains one pip; the cell only breaks
    // when its remaining hits reach 0. Cells with no tracked durability (legacy
    // / test grids) keep the one-hit-destroys behaviour.
    const cellKey = `${action.pos.x},${action.pos.y}`;
    let obstacleBroke = false;
    let damage: { remaining: number; max: number } | null = null;
    if (result.success && isObstacleCell) {
      const ob = this.liveObstacles.get(cellKey);
      if (ob) {
        ob.durability.remaining = Math.max(0, ob.durability.remaining - 1);
        damage = { remaining: ob.durability.remaining, max: ob.durability.max };
        obstacleBroke = ob.durability.remaining === 0;
      } else {
        obstacleBroke = true;
      }
    }

    // Explosive obstacle: only the BREAKING hit bursts. It catches every
    // creature (friend or foe, including the smasher) within Chebyshev `radius`;
    // KO'd bodies are skipped. Computed before the resolution emit so the event
    // is self-describing — the HP changes are applied after the cell is cleared.
    let blast: { pos: Square; damage: number; radius: number; victimIds: CharacterId[]; demolished: Square[] } | null = null;
    if (obstacleBroke) {
      const ex = this.liveObstacles.get(cellKey)?.explosive;
      if (ex) {
        const victims = [...this.characters.values()].filter(
          (c) =>
            c.pos &&
            c.health.status !== 'KO' &&
            chebyshevDistance(c.pos, action.pos) <= ex.radius,
        );
        // An explosion is the ONE thing that breaks attack-proof stalagmites:
        // every stalagmite cell within the blast radius is demolished, opening
        // a breach. (Plain `wall` barrels in radius are NOT demolished.)
        const demolished: Square[] = [];
        for (const [k, o] of this.liveObstacles) {
          if (!o.isStalagmite) continue;
          const [sx, sy] = k.split(',').map(Number) as [number, number];
          if (chebyshevDistance({ x: sx, y: sy }, action.pos) <= ex.radius) {
            demolished.push({ x: sx, y: sy });
          }
        }
        blast = {
          pos: { ...action.pos },
          damage: ex.damage,
          // The affected AREA (Chebyshev radius) so the browser can render an
          // explosion over every inflicted cell, not just the ones that had a
          // creature standing on them.
          radius: ex.radius,
          victimIds: victims.map((v) => v.id),
          demolished,
        };
      }
    }

    this.emit({
      type: 'resolution',
      actorId,
      public: {
        success: result.success,
        top: result.top,
        difficulty,
        attackKind,
        targetKind,
        pos: { ...action.pos },
        ...(targetRef !== undefined && { targetRef }),
        ...(result.success && targetRef !== undefined && { propRemoved: targetRef }),
        ...(obstacleBroke && { obstacleDestroyed: { ...action.pos } }),
        ...(blast && { blast }),
        // A non-fatal hit reports the new durability so the UI drains a pip
        // without removing the obstacle.
        ...(damage && !obstacleBroke && { obstacleDamaged: { pos: { ...action.pos }, ...damage } }),
        ...(opts?.providedRoll?.requestId ? { rollRequestId: opts.providedRoll.requestId } : {}),
      },
      private: { roll: result.roll },
    } as unknown as Event);

    if (result.success) {
      if (isObstacleCell && obstacleBroke) {
        this.grid.clearCell(action.pos);
        this.destroyedObstacles.push({ ...action.pos });
        this.liveObstacles.delete(cellKey);
        if (blast) {
          // Demolish every attack-proof stalagmite caught in the blast — the
          // only way these walls fall. Clear them before applying creature
          // damage so the event/state stays self-describing.
          for (const d of blast.demolished) {
            this.grid.clearCell(d);
            this.destroyedObstacles.push({ ...d });
            this.liveObstacles.delete(`${d.x},${d.y}`);
          }
          const changes: {
            id: CharacterId;
            damage: number;
            status: 'normal' | 'prone' | 'KO' | 'immobilized';
          }[] = [];
          for (const id of blast.victimIds) {
            const victim = this.characters.get(id);
            if (!victim) continue;
            const damaged = applyDamage(victim, blast.damage);
            this.characters.set(id, damaged);
            changes.push({ id, damage: damaged.health.damage, status: damaged.health.status });
          }
          if (changes.length > 0) {
            this.emit({ type: 'state_change', changes } as unknown as Event);
          }
        }
      }
      if (propOnCell) {
        this.props.delete(propOnCell.id);
      }
    }

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Resolve `push_object`: shove an adjacent `pushable` obstacle (e.g. an oil
   * cask) one cell directly away from the actor into an empty floor cell. The
   * direction is fixed — `dest = pos + (pos - actorPos)` — so the actor must be
   * orthogonally OR diagonally adjacent to the obstacle and the cell beyond it
   * must be open floor. Roll-less (it always works when the path is clear), but
   * costs the actor's main action. Relocates the grid cell AND the obstacle's
   * live state (durability / explosive / pushable) to the destination, keeping
   * the snapshot + future smashes consistent. Replay-safe: the emitted `action`
   * event is re-applied verbatim by the replay harness (no dice).
   */
  private handlePushObject(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'push_object' }>,
    interp: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });
    if (!this.grid.inBounds(action.pos)) {
      return err({ reason: 'invalid-action-shape', details: 'pos out of bounds' });
    }
    const cell = this.grid.cellAt(action.pos);
    const isObstacleCell = isDestructibleObstacleCell(cell);
    if (!isObstacleCell) return err({ reason: 'no-such-object' });
    const key = `${action.pos.x},${action.pos.y}`;
    const ob = this.liveObstacles.get(key);
    if (!ob?.pushable) return err({ reason: 'indestructible' });
    if (chebyshevDistance(actor.pos, action.pos) !== 1) return err({ reason: 'out-of-range' });

    // Direction = away from the actor; destination one cell beyond the obstacle.
    const dir = { x: action.pos.x - actor.pos.x, y: action.pos.y - actor.pos.y };
    const dest: Square = { x: action.pos.x + dir.x, y: action.pos.y + dir.y };
    if (!this.grid.inBounds(dest)) return err({ reason: 'blocked-by-wall' });
    if (this.grid.cellAt(dest).kind !== 'floor') return err({ reason: 'blocked-by-wall' });
    // A living creature on the destination blocks the shove.
    for (const c of this.characters.values()) {
      if (c.pos && c.health.status !== 'KO' && c.pos.x === dest.x && c.pos.y === dest.y) {
        return err({ reason: 'invalid-target' });
      }
    }

    // Relocate the grid cell (preserving wall vs obstacle kind) and the live state.
    this.grid.setCell(dest, { kind: cell.kind });
    this.grid.clearCell(action.pos);
    this.liveObstacles.delete(key);
    this.liveObstacles.set(`${dest.x},${dest.y}`, ob);

    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: {
        objectPushed: { from: { ...action.pos }, to: { ...dest }, type: ob.type },
      },
      private: {},
    } as unknown as Event);

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Resolve `open_chest`: a hero ADJACENT (Chebyshev ≤ 1) to a closed chest
   * prop loots its single item into their inventory and the chest is removed
   * from the grid. Roll-less — it always succeeds in range. Counts as the
   * actor's main action. Emits the `open_chest` action, a `remove_prop` action
   * (so the browser drops the chest sprite), and a `chest_opened` resolution
   * recording the granted item. The inventory mutation is engine truth — the
   * opener sees the looted item in their next state block.
   */
  private handleOpenChest(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'open_chest' }>,
    interp: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });
    const chestProp = this.props.get(action.chestId);
    if (!chestProp || !chestProp.chest) {
      return err({ reason: 'unknown-id', what: 'prop', id: action.chestId });
    }
    if (chebyshevDistance(actor.pos, chestProp.pos) > 1) {
      return err({ reason: 'out-of-range' });
    }

    const itemId = chestProp.chest.contents;
    const existing = actor.inventory.find((s) => s.itemId === itemId);
    const newInventory = existing
      ? actor.inventory.map((s) => (s.itemId === itemId ? { ...s, count: s.count + 1 } : s))
      : [...actor.inventory, { itemId, count: 1 }];
    this.characters.set(actorId, { ...actor, inventory: newInventory });
    this.props.delete(action.chestId);

    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    // Mirror the looted chest's disappearance to browser subscribers, which
    // reconcile props from spawn_prop / remove_prop action events.
    this.emit({
      type: 'action', actorId,
      action: { kind: 'remove_prop', id: action.chestId },
      ...interp,
    } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: { chestOpened: action.chestId, granted: String(itemId) },
      private: {},
    } as unknown as Event);

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Resolve `throw_item`: lob an item onto an empty floor cell within
   * `ITEM_THROW_RANGE`, where it lands as a grid prop. Roll-less — it always
   * lands when the target cell is valid; counts as the actor's main action.
   *
   * The thrown item must be available to the actor:
   *   (a) IN INVENTORY — carried by the actor; one is consumed on throw and a
   *       fresh prop spawned at the target (emoji from `THROWN_ITEM_VISUAL`); or
   *   (b) CLOSE BY — a non-chest prop whose id matches `itemId` lying within 1
   *       cell of the actor; it is relocated to the target (its `bait` flag,
   *       e.g. on a ground cheese, is preserved).
   *
   * A thrown wheel of Cheese is BAIT: it draws the monster AI (see
   * `monster-ai.ts`) and is eaten by the first monster to land on it (see
   * `handleMove`). Emits the `throw_item` action plus spawn/remove `*_prop`
   * actions so browser subscribers keep their prop layer in sync.
   */
  private handleThrowItem(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'throw_item' }>,
    interp: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });

    // Target-cell validity (shared by both sources).
    if (!this.grid.inBounds(action.pos)) {
      return err({ reason: 'invalid-action-shape', details: 'throw target out of bounds' });
    }
    if (chebyshevDistance(actor.pos, action.pos) > ITEM_THROW_RANGE) {
      return err({ reason: 'out-of-range' });
    }
    // Must land on open floor — not a wall / obstacle / rock cell.
    if (blocksMovement(this.grid.cellAt(action.pos))) {
      return err({ reason: 'blocked-by-wall' });
    }
    // Can't land an item on top of a living creature.
    for (const c of this.characters.values()) {
      if (c.pos && c.health.status !== 'KO' && c.pos.x === action.pos.x && c.pos.y === action.pos.y) {
        return err({ reason: 'invalid-target' });
      }
    }

    const invStack = actor.inventory.find((s) => s.itemId === action.itemId);

    // (b) CLOSE-BY source: a non-chest prop whose id matches the requested item
    // and that lies within 1 cell of the thrower. Relocate it to the target.
    if (!invStack || invStack.count <= 0) {
      const groundProp = this.props.get(String(action.itemId));
      if (
        groundProp &&
        !groundProp.chest &&
        chebyshevDistance(actor.pos, groundProp.pos) <= 1
      ) {
        this.props.set(groundProp.id, { ...groundProp, pos: { ...action.pos } });
        this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
        // Relocate on subscribers: drop then re-add at the new cell (same id).
        this.emit({ type: 'action', actorId, action: { kind: 'remove_prop', id: groundProp.id }, ...interp } as unknown as Event);
        this.emit({
          type: 'action', actorId,
          action: {
            kind: 'spawn_prop', id: groundProp.id, emoji: groundProp.emoji,
            name: groundProp.name, pos: { ...action.pos },
            ...(groundProp.description !== undefined && { description: groundProp.description }),
          },
          ...interp,
        } as unknown as Event);
        this.turn.markActed();
        return ok({ turnEnded: false });
      }
      // Neither carried nor lying close by.
      return err({ reason: 'unknown-id', what: 'item', id: String(action.itemId) });
    }

    // (a) INVENTORY source: consume one and spawn a fresh prop at the target.
    const visual = THROWN_ITEM_VISUAL[String(action.itemId)] ?? { emoji: '🎒' };
    const name = this.items.get(String(action.itemId))?.name ?? String(action.itemId);

    // Unique, collision-free prop id (deterministic counter).
    this.baitSeq += 1;
    let id = `${String(action.itemId)}-${this.baitSeq}`;
    while (this.props.has(id)) {
      this.baitSeq += 1;
      id = `${String(action.itemId)}-${this.baitSeq}`;
    }

    const newInventory = invStack.count > 1
      ? actor.inventory.map((s) => (s.itemId === action.itemId ? { ...s, count: s.count - 1 } : s))
      : actor.inventory.filter((s) => s.itemId !== action.itemId);
    this.characters.set(actorId, { ...actor, inventory: newInventory });

    const description = visual.bait
      ? 'cheese bait — rats abandon the heroes and scramble for it'
      : `a thrown ${name.toLowerCase()}`;
    this.props.set(id, {
      id, emoji: visual.emoji, name, pos: { ...action.pos },
      ...(visual.bait ? { bait: true } : {}),
      description,
    });

    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    // Browser subscribers add the item to the board via the spawn_prop path.
    this.emit({
      type: 'action', actorId,
      action: { kind: 'spawn_prop', id, emoji: visual.emoji, name, pos: { ...action.pos }, description },
      ...interp,
    } as unknown as Event);

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Two-phase preview for `special_action`: validate exactly like
   * `handleSpecialAction` and report each opposed sub-roll's pool sizes WITHOUT
   * rolling, so the orchestrator can outsource the dice to a RollProvider
   * (browser physics) — one `roll_request` per sub-attack. Returns
   * `subAttacks: []` for the single-effect path (e.g. healing-touch), which has
   * no opposed dice; the orchestrator then resolves it straight through the
   * seeded engine. A failed validation returns the same rule_violation the
   * handler would, so a bad preview means the action would fail anyway.
   */
  previewSpecialAttacks(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
  ): Result<{ subAttacks: SubAttackSpec[] }, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId);
    if (!actor) return err({ reason: 'unknown-id', what: 'character', id: String(actorId) });
    const resolved = this.resolveSpecialSubAttacks(actor, action);
    if (resolved === null) return ok({ subAttacks: [] }); // single-effect: no opposed dice
    if (!resolved.ok) return resolved;
    return ok({
      subAttacks: resolved.value.map((s) => ({
        targetId: s.target.id,
        attackerPoolSize: s.attackerPool,
        defenderArmorPoolSize: s.target.pools.armor,
        attackKind: s.attackKind,
      })),
    });
  }

  private handleSpecialAction(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
    opts?: { interpretedBy?: 'dm'; providedSpecialRolls?: ReadonlyArray<ProvidedAttackRolls | undefined> },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
    const actor = this.characters.get(actorId)!;
    const resolved = this.resolveSpecialSubAttacks(actor, action);
    // null → not a multi-target attack effect; keep Layer A's single-effect path.
    if (resolved === null) return this.dispatchSingleEffect(actorId, action, opts);
    return this.runSubAttacks(actor, action, resolved, opts);
  }

  /**
   * Map a special action to its opposed sub-attacks (target + exact dice pool),
   * running the same validation the legacy dispatchers did. Returns `null` for
   * the single-effect path (no opposed dice). Shared by `previewSpecialAttacks`
   * and `handleSpecialAction` so pool sizes can never drift between the
   * roll_request and the resolution.
   */
  /**
   * Targeting descriptor for `c`'s special action, surfaced in the redacted
   * snapshot so the human UI can gather targets without re-deriving the rules.
   * MUST stay in lockstep with `resolveSpecialSubAttacks` below — same effect
   * ids, same pools/ranges — so the targets the browser offers are exactly the
   * ones the engine will accept.
   */
  private specialTargeting(c: Character): SpecialTargeting {
    switch (c.specialAction.id) {
      case asEffectId('whirlwind-attack'):
        return { mode: 'split', attackKind: 'melee', pool: c.pools.melee, range: 1, requiresLos: false };
      case asEffectId('split-shot'):
        return { mode: 'split', attackKind: 'ranged', pool: c.pools.ranged, range: c.normalAttack.range, requiresLos: true };
      case asEffectId('flame-burst'):
        return { mode: 'area' };
      default:
        return { mode: 'single' };
    }
  }

  private resolveSpecialSubAttacks(
    actor: Character,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
  ): Result<ResolvedSubAttack[], RuleViolation> | null {
    switch (actor.specialAction.id) {
      case asEffectId('whirlwind-attack'):
        return this.resolveSplitTargets(actor, action, 'melee', 1);
      case asEffectId('split-shot'):
        return this.resolveSplitTargets(actor, action, 'ranged', actor.normalAttack.range);
      case asEffectId('flame-burst'):
        return this.collectFlameBurstTargets(actor);
      case asEffectId('pack-attack'):
        return this.resolvePackAttackTargets(actor, action);
      default:
        return null;
    }
  }

  /**
   * Shared resolution path for every multi-target special attack: emit the
   * single `action` event, then one opposed roll per sub-attack — using the
   * provided physics faces when they fit (`providedSpecialRolls[i]`), else the
   * seeded dice — applying damage and echoing the sub-roll's `rollRequestId` so
   * the browser de-dups its own 2D dice (matchQueueItems skips on rollRequestId).
   */
  private runSubAttacks(
    actor: Character,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
    subs: Result<ResolvedSubAttack[], RuleViolation>,
    opts?: { interpretedBy?: 'dm'; providedSpecialRolls?: ReadonlyArray<ProvidedAttackRolls | undefined> },
  ): Result<ActionOk, RuleViolation> {
    if (!subs.ok) return subs;

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({ type: 'action', actorId: actor.id, action, ...interp } as unknown as Event);

    subs.value.forEach((sub, i) => {
      const armorDice = sub.target.pools.armor;
      const candidate = opts?.providedSpecialRolls?.[i];
      // Use the physics faces only if they fit the pools we asked the browser
      // to roll; a short/missing reply falls back to the seeded dice for this
      // one sub-attack (the others may still be physics-driven).
      const provided =
        candidate
        && candidate.attackRoll.length === sub.attackerPool
        && candidate.armorRoll.length === armorDice
          ? candidate
          : undefined;
      const result = resolveAttack(this.dice, {
        attackerPool: sub.attackerPool,
        defenderArmor: armorDice,
        attackKind: sub.attackKind,
        modifiers: { extraAttackDice: 0, extraArmorDice: 0, damageMod: 0 },
      }, provided);
      this.emit({
        type: 'resolution',
        actorId: actor.id,
        public: {
          hit: result.hit,
          damage: result.damage,
          attackerTop: result.attackerTop,
          defenderTop: result.defenderTop,
          targetId: sub.target.id,
          attackKind: sub.attackKind,
          ...(sub.specialEffectId ? { specialEffectId: sub.specialEffectId } : {}),
          ...(provided?.requestId ? { rollRequestId: provided.requestId } : {}),
        },
        private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
      } as unknown as Event);
      if (result.hit && result.damage > 0) {
        const damaged = applyDamage(sub.target, result.damage);
        this.characters.set(sub.target.id, damaged);
        this.emit({
          type: 'state_change',
          changes: [{ id: sub.target.id, damage: damaged.health.damage, status: damaged.health.status }],
        } as unknown as Event);
        // Hunter passive also reacts to special-attack damage (e.g. a hunter
        // caught in a Flame Burst darts clear of the caster).
        if (actor.pos) this.maybeReactiveStep(sub.target.id, actor.pos);
      }
    });

    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  /**
   * Whirlwind / split-shot target resolution. Validates targets + the diceSplit
   * and returns one sub-attack per target with its split as the dice pool.
   *
   * `kind` selects the actor pool ('melee' for whirlwind, 'ranged' for split-shot).
   * `range` is the maximum distance to a valid target (1 for melee whirlwind;
   * actor.normalAttack.range for split-shot).
   */
  private resolveSplitTargets(
    actor: Character,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
    kind: 'melee' | 'ranged',
    range: number,
  ): Result<ResolvedSubAttack[], RuleViolation> {
    const targetIds = action.targetIds ?? [];
    if (targetIds.length === 0) return err({ reason: 'targets-required' });

    const split = (action.params?.['diceSplit'] ?? {}) as Record<string, number>;
    // Shape: every targetId has an entry, no extras.
    const splitKeys = Object.keys(split);
    if (splitKeys.length !== targetIds.length || !targetIds.every((id) => Object.prototype.hasOwnProperty.call(split, String(id)))) {
      return err({ reason: 'invalid-split-shape', details: 'diceSplit keys must match targetIds exactly' });
    }
    // Each value is a positive integer.
    for (const v of Object.values(split)) {
      if (!Number.isInteger(v) || v < 1) {
        return err({ reason: 'invalid-split-shape', details: 'each diceSplit value must be a positive integer' });
      }
    }
    // Sum equals actor pool.
    const expected = actor.pools[kind];
    const actual = Object.values(split).reduce((s, n) => s + n, 0);
    if (actual !== expected) {
      return err({ reason: 'invalid-split-sum', expected, actual });
    }

    // Resolve targets and check adjacency / range.
    const subs: ResolvedSubAttack[] = [];
    for (const id of targetIds) {
      const t = this.characters.get(id);
      if (!t) return err({ reason: 'unknown-id', what: 'character', id: String(id) });
      if (t.id === actor.id) return err({ reason: 'invalid-target' });
      if (t.health.status === 'KO') return err({ reason: 'invalid-target' });
      if (!actor.pos || !t.pos) return err({ reason: 'invalid-target' });
      const dist = chebyshevDistance(actor.pos, t.pos);
      if (kind === 'melee' && dist !== range) {
        return err({ reason: 'target-not-adjacent', targetId: id });
      }
      if (kind === 'ranged') {
        if (dist > range) {
          return err({ reason: 'target-out-of-range', targetId: id });
        }
        const sight = this.grid.lineOfSight(actor.pos, t.pos);
        if (sight.blocked) return err({ reason: 'no-line-of-sight' });
      }
      subs.push({ target: t, attackerPool: split[String(t.id)] ?? 0, attackKind: kind });
    }
    return ok(subs);
  }

  /** Flame-burst targets: every adjacent (Chebyshev 1) living non-self, 1 magic die each. */
  private collectFlameBurstTargets(actor: Character): Result<ResolvedSubAttack[], RuleViolation> {
    if (!actor.pos) return err({ reason: 'invalid-target' });
    const subs: ResolvedSubAttack[] = [];
    for (const c of this.characters.values()) {
      if (c.id === actor.id) continue;
      if (c.health.status === 'KO') continue;
      if (!c.pos) continue;
      if (chebyshevDistance(actor.pos, c.pos) === 1) {
        subs.push({ target: c, attackerPool: 1, attackKind: 'magic', specialEffectId: 'flame-burst' });
      }
    }
    return ok(subs);
  }

  /** Pack-attack: single adjacent target, melee pool +1 die when it's already engaged. */
  private resolvePackAttackTargets(
    actor: Character,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
  ): Result<ResolvedSubAttack[], RuleViolation> {
    const targetIds = action.targetIds ?? [];
    if (targetIds.length === 0) return err({ reason: 'targets-required' });
    const targetId = targetIds[0]!;
    const target = this.characters.get(targetId);
    if (!target) return err({ reason: 'unknown-id', what: 'character', id: String(targetId) });
    if (target.health.status === 'KO') return err({ reason: 'invalid-target' });
    if (!actor.pos || !target.pos) return err({ reason: 'invalid-target' });
    if (chebyshevDistance(actor.pos, target.pos) !== 1) {
      return err({ reason: 'target-not-adjacent', targetId });
    }
    const engaged = isEngaged(target, this.characters.values(), actor.kind);
    // Fold the engagement bonus into the pool so the rolled die count matches
    // what the preview reports to the browser.
    return ok([{ target, attackerPool: actor.pools.melee + (engaged ? 1 : 0), attackKind: 'melee' }]);
  }

  /** Single-target effect path: keeps Layer A's healing-touch behavior intact. */
  private dispatchSingleEffect(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
    opts?: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const effect = this.effects.get(actor.specialAction.id);
    const target =
      action.targetIds && action.targetIds[0]
        ? this.characters.get(action.targetIds[0])
        : undefined;
    const ctx: EffectContext = {
      actor,
      ...(target !== undefined && { target }),
      ...(action.params !== undefined && { params: action.params }),
    };
    const result = effect.apply(ctx);

    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
    if (result.narration) {
      this.emit({
        type: 'resolution',
        actorId,
        public: { narration: result.narration, changes: result.changes },
      } as unknown as Event);
    }
    this.applyEffectChanges(actorId, result.changes);
    this.turn.markActed();
    return ok({ turnEnded: false });
  }

  private handleUseBoon(
    actorId: CharacterId,
    boonId: BoonId,
    targetId: CharacterId | undefined,
    opts?: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    if (!actor.boons.includes(boonId)) {
      return err({ reason: 'unknown-id', what: 'boon', id: String(boonId) });
    }
    const def = this.boons.get(boonId);
    if (!def) return err({ reason: 'unknown-id', what: 'boon', id: String(boonId) });

    const effect = this.effects.get(def.effectId);
    const target = targetId ? this.characters.get(targetId) ?? actor : actor;
    const result = effect.apply({ actor, target });

    // Emit action first so log order is action → state_change.
    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'use_boon', boonId, ...(targetId && { targetId }) },
      ...interp,
    } as unknown as Event);

    // Apply changes (emits state_change events).
    this.applyEffectChanges(actorId, result.changes);

    // Remove the boon from inventory.
    const fresh = this.characters.get(actorId)!;
    const newBoons = fresh.boons.filter((b) => b !== boonId);
    this.characters.set(actorId, { ...fresh, boons: newBoons });

    return ok({ turnEnded: false });
  }

  private handleEquip(
    actorId: CharacterId,
    equipmentId: EquipmentId,
    opts?: { interpretedBy?: 'dm' },
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.phase === 'combat') return err({ reason: 'wrong-phase' });
    const actor = this.characters.get(actorId)!;
    this.characters.set(actorId, { ...actor, equipped: equipmentId });
    const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'equip', equipmentId },
      ...interp,
    } as unknown as Event);
    return ok({ turnEnded: false });
  }

  /**
   * Build a `Character` for a monster from the registered catalog. Returns
   * `unknown-id` when the type isn't in the catalog. Pure construction — does
   * NOT add to the engine's character map.
   */
  private materializeMonster(
    typeId: string,
    id: CharacterId,
    pos: Square,
  ): Result<Character, RuleViolation> {
    const def = this.monsterCatalog.get(typeId);
    if (!def) {
      return err({ reason: 'unknown-id', what: 'character', id: typeId });
    }
    const monster: Character = {
      id,
      name: def.name,
      kind: 'monster',
      sprite: def.sprite,
      pools: def.pools,
      dex: def.dex ?? 0,
      health: { total: def.healthTotal, damage: 0, status: 'normal' },
      pos,
      normalAttack: def.normalAttack,
      specialAction: {
        id: asEffectId(def.specialAction.effectId),
        name: def.specialAction.name,
        description: def.specialAction.description,
      },
      bonusAbility: {
        id: asEffectId(def.bonusAbility.effectId),
        name: def.bonusAbility.name,
        description: def.bonusAbility.description,
      },
      inventory: [],
      boons: [],
      skills: [],
    };
    return ok(monster);
  }

  /**
   * Build a `Character` for an NPC from the registered catalog. Returns
   * `unknown-id` when the type isn't in the catalog. Pure construction — does
   * NOT add to the engine's character map.
   */
  private materializeNpc(
    typeId: string,
    id: CharacterId,
    pos: Square,
  ): Result<Character, RuleViolation> {
    const def = this.npcCatalog.get(typeId);
    if (!def) return err({ reason: 'unknown-id', what: 'character', id: typeId });
    const npc: Character = {
      id, name: def.name, kind: 'npc', sprite: def.sprite,
      pools: def.pools, dex: def.dex ?? 0,
      health: { total: def.healthTotal, damage: 0, status: 'normal' },
      pos, normalAttack: def.normalAttack,
      specialAction: { id: asEffectId(def.specialAction.effectId), name: def.specialAction.name, description: def.specialAction.description },
      bonusAbility:  { id: asEffectId(def.bonusAbility.effectId),  name: def.bonusAbility.name,  description: def.bonusAbility.description  },
      inventory: [], boons: [], skills: [],
    };
    return ok(npc);
  }

  /**
   * Build a `Character` for a scene-declared CAPTIVE — a hero who begins the
   * scene immobilized (a rescue objective). Stats come from the hero catalog
   * (keyed by archetype id), the display name + id + position from the scene
   * declaration. Health starts at `immobilized`. Pure construction — does NOT
   * add to the engine's character map.
   */
  private materializeCaptiveHero(
    archetype: string,
    id: CharacterId,
    name: string,
    pos: Square,
  ): Result<Character, RuleViolation> {
    const def = this.heroCatalog.get(archetype === 'warlock' ? 'warlock-fire' : archetype);
    if (!def) return err({ reason: 'unknown-id', what: 'character', id: archetype });
    const hero: Character = {
      id, name, kind: 'hero', archetype: def.archetype, sprite: def.sprite,
      pools: { ...def.pools }, dex: def.dex ?? 0,
      health: { total: def.healthTotal, damage: 0, status: 'immobilized' },
      pos, normalAttack: def.normalAttack,
      specialAction: { id: asEffectId(def.specialAction.effectId), name: def.specialAction.name, description: def.specialAction.description },
      bonusAbility:  { id: asEffectId(def.bonusAbility.effectId),  name: def.bonusAbility.name,  description: def.bonusAbility.description  },
      inventory: def.defaultInventory.map((s) => ({ itemId: s.itemId as Character['inventory'][number]['itemId'], count: s.count })),
      boons: [], skills: def.defaultSkills as Character['skills'],
    };
    return ok(hero);
  }

  /**
   * Produces a viewer-filtered snapshot for browser reconnect.
   *
   * Engine-side snapshot does NOT filter by visibility — the orchestrator's
   * visibility filter operates on event streams and on monster reveal state
   * (which the orchestrator tracks, not the engine). When the orchestrator
   * wraps this method to send a snapshot envelope, it filters out unrevealed
   * monsters before serializing.
   */
  getRedactedSnapshot(viewer: Viewer): RedactedSnapshot {
    const characters: RedactedCharacter[] = [];
    for (const c of this.characters.values()) {
      characters.push({
        id: c.id,
        name: c.name,
        kind: c.kind,
        ...(c.archetype !== undefined && { archetype: c.archetype }),
        ...(c.sprite !== undefined && { sprite: c.sprite }),
        pos: c.pos,
        health: { ...c.health },
        pools: { ...c.pools },
        ...(c.dex !== undefined && { dex: c.dex }),
        ...(c.equipped !== undefined && { equipped: c.equipped }),
        inventory: c.inventory.map((s) => ({ itemId: s.itemId, count: s.count })),
        boons: [...c.boons],
        normalAttack: { kind: c.normalAttack.kind, range: c.normalAttack.range },
        specialAction: {
          name: c.specialAction.name,
          description: c.specialAction.description,
          targeting: this.specialTargeting(c),
        },
        bonusAbility:  { name: c.bonusAbility.name,  description: c.bonusAbility.description  },
      });
    }

    // Scene info — only available when an adventure is loaded. Use the active
    // scene tracked via `currentSceneId` (set by every `set_scene`); fall back
    // to scene[0] for tests that wire an adventure but never trigger a
    // transition explicitly.
    const sceneSpec = this.adventure?.scenes?.find((s) => s.id === this.currentSceneId)
      ?? this.adventure?.scenes?.[0];
    const scene = sceneSpec
      ? {
          id: sceneSpec.id,
          assetId: sceneSpec.map.background,
          gridW: this.grid.width,
          gridH: this.grid.height,
          // Current-position obstacle list from the single source of truth
          // (`liveObstacles`): a push relocates an entry, a smash/blast removes
          // it. Carries durability + the attackProof (stalagmite) / pushable flags.
          obstacles:   this.activeSceneObstacles(),
          decorations: sceneSpec.map.decorations.map((o) => ({ ...o })),
          exits:       sceneSpec.map.exits.map((e) => ({ to: e.to, at: { ...e.at }, trigger: e.trigger })),
          walls:       sceneSpec.map.walls,
          wallCells:   (sceneSpec.map.wallCells ?? []).map((p) => ({ ...p })),
          destroyedObstacles: this.destroyedObstacles.map((p) => ({ ...p })),
          ...(sceneSpec.opening
            ? { opening: {
                before: sceneSpec.opening.before,
                after: sceneSpec.opening.after,
                ...(sceneSpec.opening.cast
                  ? { cast: sceneSpec.opening.cast.map((c) => ({
                      name: c.name,
                      ...(c.names !== undefined ? { names: { ...c.names } } : {}),
                      ...(c.portrait !== undefined ? { portrait: c.portrait } : {}),
                    })) }
                  : {}),
                // Translated splash text variants (every language the scene
                // declares) ride along so the browser can pick by its UI
                // language — the snapshot precedes the hero-select gate where
                // the game language is chosen.
                ...((): { i18n?: Record<string, { before: string; after: string }> } => {
                  const variants = Object.entries(sceneSpec.i18n ?? {})
                    .filter(([, v]) => v?.opening)
                    .map(([lang, v]) => [lang, { ...v!.opening! }] as const);
                  return variants.length > 0 ? { i18n: Object.fromEntries(variants) } : {};
                })(),
              } }
            : {}),
        }
      : null;

    return {
      viewer,
      scene,
      characters,
      props: Array.from(this.props.values()).map((p) => ({
        id: p.id,
        emoji: p.emoji,
        name: p.name,
        pos: { ...p.pos },
        ...(p.description !== undefined && { description: p.description }),
        ...(p.bait ? { bait: true } : {}),
        ...(p.chest ? { chest: { contents: p.chest.contents } } : {}),
        ...(p.spriteId !== undefined && { spriteId: p.spriteId }),
      })),
      activeActor: this.turn.activeActorId ?? null,
      recentChat: [],
    };
  }

  /**
   * Emit a non-engine event (thought, step_budget_exhausted, human_input) through
   * the engine's `t` counter so log ordering stays consistent. Used by the runtime
   * orchestrator and agents; callers must build a well-formed Event minus the `t`.
   */
  emitRuntime(ev: Omit<Event, 't'>): void {
    this.emit(ev);
  }

  private emit(ev: Omit<Event, 't'>): void {
    this.pendingEvents.push({ ...ev, t: this.nextT++ } as Event);
  }
}
