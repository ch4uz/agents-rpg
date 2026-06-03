import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const SquareSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });

const PropPlacementSchema = z.object({
  type: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  /**
   * Hits an `attack_object` must land to destroy this obstacle. Omitted → 1
   * (a single success smashes it, the v1 barrel behaviour). Stalagmites use 2
   * so the UI shows a two-pip durability bar that drains a pip per hit.
   * Ignored for decorations (they're never attacked).
   */
  durability: z.number().int().min(1).optional(),
  /**
   * COVER vs BARRIER. Both kinds are SOLID — neither can be walked through (a
   * barrel stack stops you either way). The flag controls LINE OF SIGHT only.
   * When `true`, this obstacle is *cover*: it blocks movement, but a ranged/magic
   * shot fired THROUGH it still lands, granting the target +1 armor die (the
   * engine's cover bonus) instead of being blocked. Omitted/false (the default)
   * makes it a full BARRIER that blocks movement AND sight — the barrel-barricade
   * lane-splitter and the rat-tunnel breach wall (no shooting through). Either
   * kind is smashable via `attack_object`; the difference is purely whether a
   * shot can pass through it (cover) or not (barrier). Maps to a `wall` grid cell
   * when false, a `cover-wall` grid cell when true.
   */
  cover: z.boolean().optional(),
  /**
   * When present, DESTROYING this obstacle with `attack_object` makes it BURST:
   * every creature (hero, monster, NPC — friend or foe, including the smasher
   * if in range) within Chebyshev `radius` of the cell takes `damage`. Lets the
   * party set up a coordinated detonation — herd enemies next to it, then pop it
   * (a melee smasher catches its own blast; a ranged hero can detonate safely).
   * Fires only on the breaking hit, so a tough explosive (durability > 1) must
   * be fully smashed first. Does not chain to adjacent obstacles. Ignored for
   * decorations (they're never attacked).
   */
  explosive: z
    .object({
      damage: z.number().int().min(1).default(1),
      radius: z.number().int().min(1).default(1),
    })
    .optional(),
  /**
   * When `true`, a hero standing ADJACENT to this obstacle may `push_object` it
   * one cell directly away into an empty floor cell (roll-less, costs the main
   * action). Lets the party reposition an explosive cask — e.g. shove it flush
   * against an attack-proof stalagmite wall, then detonate it to blow a breach.
   * Omitted/false → the obstacle is fixed. Ignored for decorations.
   */
  pushable: z.boolean().optional(),
});

const SceneExitSchema = z.object({
  to: z.string().min(1),
  at: SquareSchema,
  trigger: z.enum(['manual', 'step-on']).default('manual'),
});

const SceneNpcSchema = z.object({
  type: z.string().min(1),
  startPos: SquareSchema,
  allegiance: z.enum(['ally', 'hostile', 'neutral']).default('neutral'),
});

/**
 * A HERO who starts this scene immobilized (bound / trapped) — a rescue
 * objective. On fresh entry the engine materializes them from the hero catalog
 * at `startPos` with `status: 'immobilized'`, so they are on the board and can
 * be targeted/hurt by foes but cannot move or take a turn until a teammate
 * reaches them and succeeds at `free_ally`. `characterId` MUST match the player
 * agent bound to control them once freed (e.g. scenario `agents.p3.characterId`).
 */
const SceneCaptiveSchema = z.object({
  archetype: z.enum(['warrior', 'hunter', 'healer', 'warlock', 'rogue', 'knight', 'brute']),
  /** Stable id; must equal the controlling agent's characterId. */
  characterId: z.string().min(1),
  /** Display name shown in chat / HUD. */
  name: z.string().min(1),
  startPos: SquareSchema,
});

/**
 * A closed CHEST a hero can `open_chest` (when adjacent) to loot. On fresh
 * scene entry the engine materializes it as a non-blocking emoji prop at `pos`
 * carrying `contents` (an itemId, e.g. "cheese"); opening grants the item and
 * removes the prop. `emoji` / `name` / `description` are optional cosmetic
 * overrides (defaults: 📦 / "Chest" / a helpful open-me hint).
 */
const SceneChestSchema = z.object({
  id: z.string().min(1),
  pos: SquareSchema,
  /** itemId granted to the hero who opens the chest (must exist in the item catalog). */
  contents: z.string().min(1),
  emoji: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

const SceneMapSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  background: z.string().min(1),
  obstacles: z.array(PropPlacementSchema),
  decorations: z.array(PropPlacementSchema).default([]),
  exits: z.array(SceneExitSchema),
  /** Draw a wang-tile wall ring at the perimeter. Default true. Ignored when
   *  `wallCells` is present — an explicit terrain mask carves the cave instead. */
  walls: z.boolean().default(true),
  /**
   * Explicit impassable rock cells. When present, they carve an organic cave
   * shape: the engine marks each as a `rock` grid cell (blocks movement + LoS,
   * indestructible — unlike `obstacles`, `attack_object` cannot smash rock),
   * and the renderer draws the cave outline with the tileset's wall tiles via a
   * marching-squares pass instead of the rectangular `walls` ring. Cells not
   * listed stay walkable floor. Omit for open / ring-walled scenes.
   */
  wallCells: z.array(SquareSchema).optional(),
  /**
   * Where the heroes land when they ENTER this scene. On a fresh `set_scene`
   * into this scene the engine seats the (sorted-by-id) heroes onto these cells
   * — so a carved cave can drop the party at its tunnel mouth instead of
   * leaving them wherever they stood in the previous scene (which could be rock
   * or, worse, the far side of a barrier). Cells must be floor and clear of
   * monster startPos. Omit to keep the legacy behaviour (heroes carry their
   * previous-scene coordinates). Fewer cells than heroes → the overflow falls
   * back to the first open floor cells scanned from the north-west.
   */
  entry: z.array(SquareSchema).optional(),
  npcs: z.array(SceneNpcSchema).default([]),
  /** Heroes who begin this scene immobilized (rescue objectives). See
   *  SceneCaptiveSchema. Optional (like `entry`/`wallCells`) so existing scene
   *  literals need no change; the engine reads `captives ?? []`. */
  captives: z.array(SceneCaptiveSchema).optional(),
  /** Closed chests a hero can `open_chest` to loot. Optional; the engine reads
   *  `chests ?? []`. See SceneChestSchema. */
  chests: z.array(SceneChestSchema).optional(),
});

const SceneMonsterSchema = z.object({
  type: z.string().min(1),
  startPos: SquareSchema,
});

const AbilityTestSchema = z.object({
  skill: z.string().min(1),
  difficulty: z.union([z.literal(4), z.literal(5), z.literal(6)]),
  describe: z.string().min(1),
});

const SceneTransitionSchema = z.object({
  to: z.string().min(1),
  trigger: z.enum(['all-monsters-ko', 'manual', 'on-exit']),
});

/**
 * Optional directive that makes this scene's monsters FIXATE on a single
 * character from a given combat round onward, overriding the deterministic
 * planner's default "nearest reachable enemy" doctrine. Used to script dramatic
 * pressure — e.g. the rat-tunnel pack ganging up on the bound captive Elara
 * from round 2 so the party must race to breach the wall and free her.
 *
 * The engine surfaces it via `GameEngine.activeMonsterFocus`; the orchestrator
 * passes the target to `chooseMonsterActions` only once
 * `turn.roundNumber >= fromRound`. The planner fixates only while the target is
 * a valid live enemy (on-board, not KO'd) and otherwise falls back to normal
 * targeting; a hero-thrown cheese bait still out-prioritizes the focus (the
 * lure can pull the pack off the target). Replay-safe: the focus only shapes
 * which actions the planner emits, and those actions are what replay consumes.
 */
const SceneMonsterFocusSchema = z.object({
  /** Character the monsters single out (e.g. a captive's characterId). */
  characterId: z.string().min(1),
  /** First 1-based combat round the focus takes effect (default 1 = at once). */
  fromRound: z.number().int().min(1).default(1),
});

/**
 * Optional two-part "cinematic opening" for a scene. When present, the browser
 * shows `before` as a full-screen splash BEFORE the board is revealed; the
 * player dismisses it ("Begin"), and the orchestrator then emits `after` as a
 * narration beat that reveals the board and lands in the narrator window. The
 * LLM DM is told NOT to narrate the intro for such a scene (the UI owns it).
 * Headless / CLI runs have no splash — there the DM reads `intro` as usual, so
 * a scene with `opening` should keep `intro` populated (typically the two
 * halves joined) for that path.
 */
const SceneOpeningSchema = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
  /**
   * Named characters the splash should highlight in `before`: each name is
   * rendered bold wherever it appears, and (if `portrait` is set) gets an inline
   * avatar at its first mention. `portrait` is an assets-relative sprite path,
   * e.g. "heroes/hunter/south.png". Used for the "You are <avatar> Bran" framing
   * and to flag teammates/NPCs the player should care about. Optional.
   */
  cast: z.array(z.object({
    name: z.string().min(1),
    /** Per-language display names, keyed by language code (e.g.
     *  `{ "pt": "Heitor" }`). A translated opening text names the cast with
     *  THESE, so the splash's bold+avatar highlighting must match them when
     *  the UI language is that language. Optional — names shared across
     *  languages (Maeve) omit it. Unknown language keys are tolerated. */
    names: z.record(z.string().min(1), z.string().min(1)).optional(),
    portrait: z.string().min(1).optional(),
  })).optional(),
});

/**
 * Per-language overlay for a scene's PLAYER-FACING prose. The base fields
 * (`intro`, `conclusion`, `opening`) stay the canonical English; a scene may
 * carry translated variants under `i18n.<languageCode>` and consumers pick at
 * render/emit time via the selectors below ({@link sceneIntro},
 * {@link sceneConclusion}, {@link sceneOpeningText}) — never by loading a
 * different adventure file, because the game language is chosen per SESSION
 * on the hero-select screen, after the adventure is already loaded. Every
 * field is optional and falls back to English. `tactics` and ability-test
 * prompts are deliberately NOT translatable — they are LLM input only.
 */
const SceneI18nProseSchema = z.object({
  intro: z.string().min(1).optional(),
  conclusion: z.string().min(1).optional(),
  opening: z.object({
    before: z.string().min(1),
    after: z.string().min(1),
  }).optional(),
});

export type SceneI18nProse = z.infer<typeof SceneI18nProseSchema>;

const SceneSchema = z.object({
  id: z.string().min(1),
  intro: z.string(),
  opening: SceneOpeningSchema.optional(),
  /** Translated prose variants, keyed by LANGUAGE CODE (e.g. "pt"). Unknown
   *  codes are tolerated — content can ship a language ahead of the code
   *  supporting it. See SceneI18nProseSchema. */
  i18n: z.record(z.string().min(1), SceneI18nProseSchema).optional(),
  map: SceneMapSchema,
  monsters: z.array(SceneMonsterSchema),
  /** Optional scripted monster focus (see SceneMonsterFocusSchema). Absent →
   *  the deterministic planner uses its default nearest-reachable doctrine. */
  monsterFocus: SceneMonsterFocusSchema.optional(),
  tactics: z.string(),
  abilityTests: z.array(AbilityTestSchema),
  conclusion: z.string(),
  transitions: z.array(SceneTransitionSchema),
});

const AdventureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  estimatedDurationMin: z.number().int().min(1),
  scenes: z.array(SceneSchema).min(1),
});

export type Adventure = z.infer<typeof AdventureSchema>;
export type Scene = z.infer<typeof SceneSchema>;

/**
 * A language code a scene may carry prose overlays for ('en' = the base
 * fields). Plain string — the engine is language-agnostic; the runtime's
 * `GameLanguage` union (src/runtime/language.ts) governs which codes a
 * session can actually pick.
 */
export type SceneProseLanguage = string;

/** Scene intro in the requested language, falling back to English. */
export const sceneIntro = (scene: Scene, language: SceneProseLanguage): string =>
  (language !== 'en' ? scene.i18n?.[language]?.intro : undefined) ?? scene.intro;

/** Scene conclusion in the requested language, falling back to English. */
export const sceneConclusion = (scene: Scene, language: SceneProseLanguage): string =>
  (language !== 'en' ? scene.i18n?.[language]?.conclusion : undefined) ?? scene.conclusion;

/**
 * The two-part opening text in the requested language, or undefined when the
 * scene has no authored opening at all. A translated variant overrides the
 * TEXT only — `cast` always comes from the English opening (per-language cast
 * names live on the cast entries' `names` records, so the splash's
 * bold-and-avatar highlighting can match the translated text).
 */
export const sceneOpeningText = (
  scene: Scene,
  language: SceneProseLanguage,
): { before: string; after: string } | undefined => {
  if (!scene.opening) return undefined;
  const variant = language !== 'en' ? scene.i18n?.[language]?.opening : undefined;
  return variant ?? { before: scene.opening.before, after: scene.opening.after };
};

export const loadAdventure = async (filePath: string): Promise<Adventure> => {
  const raw = await readFile(filePath, 'utf8');
  const adv = AdventureSchema.parse(JSON.parse(raw));

  // Cross-ref: every transition must point at an existing scene id (or 'END').
  const sceneIds = new Set(adv.scenes.map((s) => s.id));
  for (const scene of adv.scenes) {
    for (const t of scene.transitions) {
      if (t.to !== 'END' && !sceneIds.has(t.to)) {
        throw new Error(
          `Scene "${scene.id}" has transition to non-existent scene "${t.to}"`,
        );
      }
    }
  }

  return adv;
};
