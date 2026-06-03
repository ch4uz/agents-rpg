#!/usr/bin/env node
import path from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { render } from 'ink';
import React from 'react';
import { fileURLToPath } from 'node:url';
import openBrowser from 'open';

import { loadScenario, type LoadedScenario } from '../src/runtime/scenario.js';
import { NON_EN_LANGUAGES, type Localized } from '../src/runtime/language.js';
import { loadCatalogs, type Catalogs } from '../src/engine/load.js';
import { loadAdventure, type Adventure } from '../src/engine/adventure.js';
import { buildSceneGrid } from '../src/engine/scene-grid.js';
import { GameEngine } from '../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../src/engine/ids.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { Agent } from '../src/runtime/agent.js';
import { PromptBuilder } from '../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../src/runtime/prompt/tools.js';
import { AnthropicLlmClient } from '../src/runtime/llm/anthropic.js';
import { GeminiLlmClient } from '../src/runtime/llm/gemini.js';
import { CliStore } from '../src/runtime/cli/cli-store.js';
import { CliAdapter } from '../src/runtime/cli/cli-adapter.js';
import { actorDisplay } from '../src/runtime/cli/glyphs.js';
import { ScriptHumanProvider } from '../src/runtime/cli/script-reader.js';
import { App } from '../src/runtime/cli/App.js';
import { WsAdapter } from '../src/runtime/ws/adapter.js';
import { bootWsServer, type BootedServer } from '../src/runtime/ws/server.js';
import { SessionRegistry } from '../src/runtime/ws/session-registry.js';
import { persistSurvey, createGcsUploader } from '../src/runtime/survey-store.js';
import { archiveRunArtifacts } from '../src/runtime/run-archive.js';
import { encodeServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { WebSocket } from 'ws';
import type { Character } from '../src/engine/character.js';
import type { HeroChoice, SurveySubmission, SurveyPersistResult } from '../src/runtime/ws/protocol.js';
import type { HumanInputProvider } from '../src/runtime/orchestrator.js';
import type { Subscriber } from '../src/runtime/subscriber.js';
import type { LlmClient } from '../src/runtime/llm/llm-client.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** GCS bucket receiving the run's research artifacts: submitted playtest
 *  surveys (one object per submit, `surveys/<runId>/<stamp>.json`) and the
 *  end-of-run event-log archive (`runs/<runId>/events.jsonl` +
 *  `manifest.json`, uploaded when the session settles). Defaults to the
 *  project's bucket; set GCS_BUCKET to override, or to '' / 'none' to disable
 *  uploads (artifacts then land only in runs/ — ephemeral on Render!). Auth
 *  is ADC, the same chain the Vertex AI path uses (`gcloud auth
 *  application-default login` locally; the service-account JSON on Render,
 *  which needs `roles/storage.objectCreator` on the bucket). A failed upload
 *  never breaks the run — it degrades to the local write + a console line. */
const GCS_BUCKET =
  process.env['GCS_BUCKET'] ?? 'agents-rpg-surveys-high-torch-494308-r0';
const gcsUploader = GCS_BUCKET && GCS_BUCKET !== 'none'
  ? createGcsUploader(GCS_BUCKET)
  : undefined;

/** Cap on CONCURRENT game sessions. Each session runs its own DM + hero LLM
 *  agents plus an engine/orchestrator, so unbounded parallel games can
 *  overwhelm the host's CPU (and multiply token spend N-fold). Beyond the
 *  cap, a new tab waits in a FIFO line — the browser banner shows
 *  "you are #N in line" — and is admitted as running sessions end (or are
 *  reaped after the disconnect grace). Override with MAX_SESSIONS
 *  (`<= 0` = unlimited). */
const MAX_SESSIONS = process.env['MAX_SESSIONS'] !== undefined
  ? Number(process.env['MAX_SESSIONS'])
  : 3;

/** Newest mtime (ms) of any source file under `dirs`, recursively. Used to
 *  detect whether the built web bundle is older than its inputs. Skips
 *  `node_modules`, build output, and caches so we only consider hand-edited
 *  source. A missing directory contributes nothing (0). */
const newestMtimeMs = (dirs: string[]): number => {
  const SKIP = new Set(['node_modules', 'dist', '.cache', '.git']);
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;  // unreadable / missing dir — contributes nothing
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const m = statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  for (const d of dirs) walk(d);
  return newest;
};

interface Args {
  mode: 'cli' | 'browser';
  scenario: string;
  humanScript: string | null;
  /** Scene id to start the run from (`--start-scene <id>`). null → first scene. */
  startScene: string | null;
}

const parseArgs = (argv: string[]): Args => {
  const args = argv.slice(2);
  const isCli = args.includes('--cli');
  const isBrowser = args.includes('--browser');
  const mode: 'cli' | 'browser' = isCli ? 'cli' : isBrowser ? 'browser' : 'browser';
  // No positional scenario → default to the flagship adventure.
  const scenario = args.find((a) => !a.startsWith('--') && a.endsWith('.json'))
    ?? 'scenarios/basement-o-rats.json';
  const flagIdx = args.indexOf('--human-script');
  const humanScript = flagIdx !== -1 ? args[flagIdx + 1] ?? null : null;
  const startSceneIdx = args.indexOf('--start-scene');
  const startScene = startSceneIdx !== -1 ? args[startSceneIdx + 1] ?? null : null;
  return { mode, scenario, humanScript, startScene };
};

const heroFromCatalog = (
  cats: Catalogs,
  id: string,
  archetype: string,
  pos: { x: number; y: number },
  displayName?: string,
): Character => {
  const hero = cats.heroes.get(archetype === 'warlock' ? 'warlock-fire' : archetype);
  if (!hero) throw new Error(`unknown archetype: ${archetype}`);
  return {
    id: asCharacterId(id), name: displayName ?? hero.name, kind: 'hero', archetype: hero.archetype,
    sprite: hero.sprite,
    pools: hero.pools,
    dex: hero.dex ?? 0,
    health: { total: hero.healthTotal, damage: 0, status: 'normal' },
    pos, normalAttack: hero.normalAttack,
    specialAction: { id: asEffectId(hero.specialAction.effectId), name: hero.specialAction.name, description: hero.specialAction.description },
    bonusAbility:  { id: asEffectId(hero.bonusAbility.effectId),  name: hero.bonusAbility.name,  description: hero.bonusAbility.description },
    inventory: [...hero.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
    boons: [], skills: hero.defaultSkills as Character['skills'],
  };
};

/** Resolve the hero catalog id for an archetype (the only quirk is warlock,
 *  whose single catalog entry is "warlock-fire"). Mirrors `heroFromCatalog`. */
const catalogIdFor = (archetype: string): string =>
  archetype === 'warlock' ? 'warlock-fire' : archetype;

/** Build the game-start "Choose your hero" card data for one starting hero from
 *  its built Character (identity + live stats) plus the catalog entry (flavor
 *  blurb). The portrait path follows the engine's `heroes/<archetype>/south.png`
 *  convention used everywhere else in the UI. */
const heroChoiceFor = (cats: Catalogs, c: Character, names?: Record<string, string>): HeroChoice => {
  const archetype = c.archetype ?? 'hero';
  const entry = cats.heroes.get(catalogIdFor(archetype));
  const blurb = entry?.blurb
    ?? `A ${archetype} — ${c.normalAttack.name} (${c.normalAttack.kind}, range ${c.normalAttack.range}).`;
  return {
    characterId: c.id,
    name: c.name,
    ...(names && Object.keys(names).length > 0 ? { names } : {}),
    archetype,
    spritePath: `heroes/${archetype}/south.png`,
    blurb,
    health: c.health.total,
    pools: { melee: c.pools.melee, ranged: c.pools.ranged, magic: c.pools.magic, armor: c.pools.armor },
    dex: c.dex ?? 0,
    normalAttack: { name: c.normalAttack.name, kind: c.normalAttack.kind, range: c.normalAttack.range },
    specialAction: { name: c.specialAction.name, description: c.specialAction.description },
    bonusAbility: { name: c.bonusAbility.name, description: c.bonusAbility.description },
  };
};

/** Per-start-scene hero seat columns, used when a scene's open floor doesn't
 *  match the generic layouts below. These match each scene's declared `map.entry`
 *  cells so the transient constructor seating equals the engine's on-entry reseat
 *  (no visible jump). tavern-basement seats at the north-west ladder; rat-tunnel
 *  is a carved cave whose only floor on the west is the tunnel mouth (y=4-6). */
const SCENE_SEATS: Record<string, [Vec2, Vec2, Vec2]> = {
  'tavern-basement': [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 }],
  'rat-tunnel':      [{ x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 }],
  // goblin-warren adventure (mirrors the tavern-basement / rat-tunnel pair):
  // the mine gallery seats at its north-west mouth; the warren is a carved cave
  // whose only west-side floor is the shaft mouth (y=4-6).
  'mine-entrance':   [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 }],
  'goblin-warren':   [{ x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 }],
};

interface Vec2 { x: number; y: number }

/** Resolve hero spawn positions: scenario override → per-scene seats → legacy basement
 *  layout → safe top-left fallback. `startScene` is the scene the run actually opens on
 *  (scenes[0] unless --start-scene overrode it), so the choice reflects the map heroes are
 *  seated onto rather than always scene[0]. */
const resolveSpawns = (
  scenario: LoadedScenario,
  startScene: Adventure['scenes'][number],
): Record<string, { x: number; y: number }> => {
  const seats: [Vec2, Vec2, Vec2] =
    SCENE_SEATS[startScene.id] ??
    (startScene.map.width > 10
      ? [{ x: 10, y: 2 }, { x: 10, y: 3 }, { x: 10, y: 4 }]
      : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
  return scenario.spawnPositions ?? {
    [scenario.agents.p1.characterId]: seats[0],
    [scenario.agents.p2.characterId]: seats[1],
    [scenario.human.characterId]:     seats[2],
  };
};

interface SessionHandle {
  /** Identifier persisted across reconnects for the same browser tab. */
  sid: string;
  /** Cancel the run and return once the orchestrator has unwound. */
  abort: () => Promise<void>;
  /** Re-attach a fresh WS to the existing adapter (same-sid reconnect). */
  reattach?: (ws: WebSocket) => void;
}

interface SessionDeps {
  scenario: LoadedScenario;
  catalogs: Catalogs;
  adventure: Adventure;
  /** Lazily build (and memoize) the LLM client. Called per session rather than
   *  at boot so a provider-credential error can't stop the web/WS server from
   *  coming up (and so failing the deploy health check) — see main(). */
  getLlm: () => Promise<LlmClient>;
  humanScript: string | null;
  /** Scene id to open the run on; null → adventure.scenes[0]. From `--start-scene`. */
  startSceneId: string | null;
}

/**
 * Construct the LLM client for a scenario's model. `gemini-*` (or
 * `models/gemini-*`) → Google Gen AI SDK; anything else → Anthropic. No
 * scenario-schema change needed: just set `"model"` and supply the matching
 * credentials. Both SDKs are imported lazily so a run only needs the package +
 * key for the provider it actually uses.
 *
 * Gemini has TWO backends behind the same SDK + GeminiLlmClient:
 *   • Gemini Developer API (default): API key, AI Studio billing.
 *   • Vertex AI: set GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT
 *     (+ optional GOOGLE_CLOUD_LOCATION, default 'global'). Auth is ADC
 *     (`gcloud auth application-default login`) and usage bills the GCP project
 *     directly — the path that draws down Cloud credits. Only the SDK init
 *     differs; GeminiLlmClient is identical for both.
 *
 * Throws a clear error when the matching credentials are absent. Callers invoke
 * it lazily (per session), so that error never blocks server boot / health.
 */
const buildLlm = async (model: string): Promise<LlmClient> => {
  if (/^(models\/)?gemini[-.]/i.test(model)) {
    const { GoogleGenAI } = await import('@google/genai');
    const useVertex = process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true'
      || process.env['GEMINI_VERTEX'] === '1';
    const buildOpts = () => {
      if (useVertex) {
        const project = process.env['GOOGLE_CLOUD_PROJECT'];
        if (!project) throw new Error('GOOGLE_CLOUD_PROJECT env var required for Vertex AI mode (GOOGLE_GENAI_USE_VERTEXAI=true).');
        const location = process.env['GOOGLE_CLOUD_LOCATION'] ?? 'global';
        console.log(`[play] Gemini via Vertex AI (project=${project}, location=${location})`);
        return { vertexai: true as const, project, location };
      }
      const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
      if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) env var required for Gemini Developer API runs. For Vertex AI, set GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT.');
      return { apiKey };
    };
    const ai = new GoogleGenAI(buildOpts());
    return new GeminiLlmClient({
      // The abort signal rides inside params.config.abortSignal (set by the
      // client), so a human interjection cancels the in-flight request.
      generate: async (params) => ai.models.generateContent(params as never) as never,
      // Streaming transport: turn calls apply tool calls + surface thinking
      // LIVE while the model generates (see LlmClient.completeStream).
      generateStream: async (params) => ai.models.generateContentStream(params as never) as never,
    });
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var required for live runs.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const sdk = new Anthropic({ apiKey });
  return new AnthropicLlmClient({
    // Forward the per-call options (notably the AbortSignal) so a human
    // interjection can cancel the in-flight request rather than waiting it out.
    create: async (args, options) => sdk.messages.create(args as never, options) as never,
    // Streaming transport (raw SSE events) — same live-apply behaviour.
    stream: async (args, options) =>
      sdk.messages.create({ ...(args as never as object), stream: true } as never, options) as never,
  });
};

/**
 * Spin up one playthrough: fresh engine, fresh agents, fresh orchestrator.
 * `mountSubscriber` returns the Subscriber + HumanInputProvider pair plus a
 * cleanup hook — the CLI path mounts Ink, the WS path attaches an adapter.
 */
const createSession = async (
  sid: string,
  deps: SessionDeps,
  mountSubscriber: (
    engine: GameEngine,
    scene0: Adventure['scenes'][number],
    grid: ReturnType<typeof buildSceneGrid>,
  ) => Promise<{
    subscriber: Subscriber;
    humanProvider: HumanInputProvider;
    /**
     * Optional dice roll provider. The WS mount returns its WsAdapter (which
     * also implements RollProvider) so the orchestrator can outsource
     * normal-attack rolls to the browser's 3D physics. The CLI mount omits
     * this; the orchestrator falls back to the engine's seeded `Dice`.
     */
    rollProvider?: import('../src/runtime/roll-provider.js').RollProvider;
    /**
     * Optional initiative-reveal gate. The WS mount returns its WsAdapter
     * (which also implements RevealProvider) so the orchestrator blocks the
     * first combat turn until the browser acks the on-screen Order of Battle
     * reveal. The CLI mount omits this; the orchestrator falls back to the
     * fixed `initiativeRevealDelayMs` sleep.
     */
    revealProvider?: import('../src/runtime/reveal-provider.js').RevealProvider;
    /**
     * Optional beat-pacing gate. The WS mount returns its WsAdapter (which
     * also implements BeatGate) so the orchestrator holds each turn until the
     * browser has drained the previous turn's narration / hero-speech beats.
     * The CLI mount omits this; turns run back-to-back as before.
     */
    beatGate?: import('../src/runtime/beat-gate.js').BeatGate;
    /**
     * Optional opening-splash gate. The WS mount returns its WsAdapter (which
     * also implements OpeningProvider) so the orchestrator holds the DM's first
     * turn until the browser acks the title splash. The CLI mount omits it; the
     * DM reads the intro itself.
     */
    openingProvider?: import('../src/runtime/opening-provider.js').OpeningProvider;
    /**
     * Optional hero-selection gate. The WS mount returns its WsAdapter (which
     * also implements HeroSelectProvider) so the orchestrator can let the
     * player choose which starting hero they control before the game begins.
     * The CLI mount omits it; the scenario's default human hero stands.
     */
    heroSelectProvider?: import('../src/runtime/hero-select-provider.js').HeroSelectProvider;
    /**
     * Optional survey-sink registration. The WS mount returns a function that
     * registers the persistence handler on its WsAdapter; createSession calls
     * it once the run identity (runId / runDir) exists, wiring submitted
     * playtest surveys to the run dir + the GCS bucket. The CLI mount omits
     * it (no browser, no survey modal).
     */
    surveySink?: (handler: (survey: SurveySubmission) => Promise<SurveyPersistResult>) => void;
    onAttach?: (ws: WebSocket) => void;
    cleanup: () => Promise<void>;
  }>,
): Promise<SessionHandle & { runPromise: Promise<void> }> => {
  const { scenario, catalogs: cats, adventure, humanScript, startSceneId } = deps;
  // Resolve the (memoized) LLM client now that a session is actually starting.
  // Throws here — not at server boot — if the provider's credentials are
  // missing, so the web/WS server stays up and the deploy health check passes.
  const llm = await deps.getLlm();

  // Live runs use a FRESH random seed every launch so the dice — initiative
  // above all — vary between sessions. Seeded determinism is no longer a
  // guarantee: replay reconstructs a session from the recorded event log
  // (logged dice faces), not by re-rolling from the seed, so a per-run random
  // seed costs us nothing reproducibility-wise. The scenario's static `seed`
  // is kept only as a human-readable label/prefix. Set PLAY_SEED to pin a
  // seed for debugging/repro.
  const runSeed = process.env.PLAY_SEED ?? `${scenario.seed}-${randomUUID()}`;
  console.log(`[play] dice seed: ${runSeed}`);

  const reg = new EffectRegistry(); registerCoreEffects(reg);

  // The scene the run opens on. `--start-scene <id>` jumps straight to a later
  // encounter; with no flag (or an unknown id, already rejected in main) we
  // open on the adventure's first scene.
  const startScene =
    (startSceneId ? adventure.scenes.find((s) => s.id === startSceneId) : undefined) ??
    adventure.scenes[0]!;

  const spawns = resolveSpawns(scenario, startScene);
  const spawnFor = (id: string): { x: number; y: number } => {
    const p = spawns[id];
    if (!p) throw new Error(`scenario.spawnPositions missing entry for ${id}`);
    return p;
  };
  const p1    = heroFromCatalog(cats, scenario.agents.p1.characterId, scenario.agents.p1.archetype, spawnFor(scenario.agents.p1.characterId), scenario.agents.p1.name);
  const p2    = heroFromCatalog(cats, scenario.agents.p2.characterId, scenario.agents.p2.archetype, spawnFor(scenario.agents.p2.characterId), scenario.agents.p2.name);
  const human = heroFromCatalog(cats, scenario.human.characterId,    scenario.human.archetype,    spawnFor(scenario.human.characterId),    scenario.human.name);

  // The board the engine seats heroes onto + the scene the views render first.
  // Named `scene0` for the downstream wiring (getActiveScene / CLI readState /
  // mountSubscriber) even when --start-scene opened on a later encounter.
  const scene0 = startScene;
  const grid = buildSceneGrid(scene0);

  const engine = new GameEngine({
    seed: runSeed, grid,
    characters: [p1, p2, human],
    effects: reg, items: cats.items, boons: cats.boons,
    // `heroes` lets set_scene materialize scene-declared captives (immobilized
    // heroes like Elara) from the catalog when the party enters their scene.
    adventure, monsters: cats.monsters, npcs: cats.npcs, heroes: cats.heroes,
  });

  const builder = new PromptBuilder({
    snapshotEveryTurns: scenario.snapshotEveryTurns,
    // Scenario default; the player's pick on the hero-select screen overrides
    // it via onLanguageSelected below — before the first LLM call.
    language: scenario.language,
  });

  // Intentionally NOT tagging which party-mate is the human player: the AI
  // agents see all three as in-fiction characters, not "two AIs and a human".
  // A scenario p3 (e.g. the captive healer Elara) is a teammate too — listed
  // so the party knows she exists and is worth rescuing, even though she only
  // materializes (immobilized) when the scene that holds her is entered.
  const p3cfg = scenario.agents.p3;
  // Localized display names: language code → characterId → name (from the
  // scenario `names` records). Applied to the ENGINE characters by the
  // orchestrator once the session language lands at the hero-select gate —
  // so the board, prompts, and narration all carry them. Languages with no
  // declared names simply have no entry and never rename.
  const heroNames: Record<string, Record<string, string>> = {
    [scenario.agents.p1.characterId]: scenario.agents.p1.names ?? {},
    [scenario.agents.p2.characterId]: scenario.agents.p2.names ?? {},
    ...(p3cfg ? { [p3cfg.characterId]: p3cfg.names ?? {} } : {}),
    [scenario.human.characterId]: scenario.human.names ?? {},
  };
  const namesForLanguage = (lang: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries(heroNames).flatMap(([cid, names]) =>
        names[lang] ? [[cid, names[lang]!] as const] : []),
    );
  const nameOverrides: Record<string, Record<string, string>> = Object.fromEntries(
    NON_EN_LANGUAGES
      .map((lang) => [lang, namesForLanguage(lang)] as const)
      .filter(([, m]) => Object.keys(m).length > 0),
  );
  // The roster block embeds hero names, so each localized language needs its
  // own variant — built statically here (all name sets are scenario config)
  // and resolved by the PromptBuilder per session language.
  const partyLines = (nameOf: (id: string, fallback: string) => string): string => [
    ...[p1, p2, human].map((c) => `  - id=${c.id} name="${nameOf(String(c.id), c.name)}" archetype=${c.archetype ?? 'hero'}`),
    ...(p3cfg
      ? [`  - id=${p3cfg.characterId} name="${nameOf(p3cfg.characterId, p3cfg.name ?? p3cfg.archetype)}" archetype=${p3cfg.archetype} (a separated teammate — captured; you may find and free her along the way)`]
      : []),
  ].join('\n');
  const partyDescriptionEn = partyLines((_id, fallback) => fallback);
  const partyDescription: Localized = Object.keys(nameOverrides).length > 0
    ? {
        en: partyDescriptionEn,
        ...Object.fromEntries(Object.entries(nameOverrides).map(([lang, m]) =>
          [lang, partyLines((id, fallback) => m[id] ?? fallback)])),
      }
    : partyDescriptionEn;

  // Mount the subscriber (Ink CLI or WS browser adapter) BEFORE building the
  // agents so the DM can learn whether a browser is attached. A WS mount
  // returns an `openingProvider` (its WsAdapter) — its presence means the
  // browser renders scene openings (splash + opening.after narration), so the
  // DM should stay quiet about the intro (`uiShowsIntro`). Keyed off the
  // opening gate, NOT `rollProvider` — PHYSICS_DICE=0 drops the latter while
  // the splash still shows. The CLI mount returns none → the DM reads the
  // intro as before. mountSubscriber needs only engine/scene/grid, all built
  // above, so this reorder is side-effect-safe.
  const mounted = await mountSubscriber(engine, scene0, grid);
  const uiShowsIntro = !!mounted.openingProvider;

  const sharedAgentArgs = {
    llm, promptBuilder: builder, model: scenario.model, maxTokens: 4096,
    engine, adventure, partyDescription,
    // LIVE scene, not the boot scene: after a set_scene transition the agents'
    // prompts must carry the new scene's intro/map/conclusion — and the DM's
    // intro suppression (uiShowsIntro) must key off the CURRENT scene's
    // `opening`, so it only applies where the splash actually showed one.
    getActiveScene: () => engine.activeScene() ?? scene0,
    getCharacters: () => Array.from(engine.charactersById().values()),
    getMonstersInScene: () => Array.from(engine.charactersById().values())
      .filter((c) => c.kind === 'monster' && c.health.status !== 'KO'),
  };

  const dmAgent = new Agent({
    ...sharedAgentArgs,
    role: 'dm', actorId: 'dm', persona: scenario.agents.dm.persona,
    tools: DM_TOOLS, stepBudget: scenario.stepBudget.dm, tag: 'dm',
    ...(uiShowsIntro ? { uiShowsIntro: true } : {}),
  });
  const p1Agent = new Agent({
    ...sharedAgentArgs,
    role: 'player', actorId: asCharacterId(scenario.agents.p1.characterId),
    persona: scenario.agents.p1.persona,
    tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'p1',
  });
  const p2Agent = new Agent({
    ...sharedAgentArgs,
    role: 'player', actorId: asCharacterId(scenario.agents.p2.characterId),
    persona: scenario.agents.p2.persona,
    tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'p2',
  });
  // Optional 3rd AI hero (the rescued captive). Built up-front so her ReACT
  // agent is ready the moment she's freed; she takes no turns while immobilized
  // (the orchestrator auto-skips her reserved combat slot until then).
  const p3Agent = p3cfg
    ? new Agent({
        ...sharedAgentArgs,
        role: 'player', actorId: asCharacterId(p3cfg.characterId),
        persona: p3cfg.persona,
        tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'p3',
      })
    : null;

  // AI agent for the human's DEFAULT hero. Used ONLY when the player chooses a
  // DIFFERENT hero on the game-start screen (then this hero is AI-driven). Built
  // only when the scenario provides a persona for it; absent → no hero-select,
  // and the player always plays this hero (legacy behaviour).
  const humanAgent = scenario.human.persona
    ? new Agent({
        ...sharedAgentArgs,
        role: 'player', actorId: asCharacterId(scenario.human.characterId),
        persona: scenario.human.persona,
        tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'human',
      })
    : null;

  // The three starting party heroes offered on the "Choose your hero" screen.
  // Only when ALL THREE can be AI-driven (the human's default hero has a
  // persona/agent) AND the run isn't script-automated do we offer a choice —
  // otherwise the gate is a no-op and the scenario default stands.
  const heroChoices: HeroChoice[] =
    humanAgent && !humanScript
      ? [p1, p2, human].map((c) => heroChoiceFor(cats, c, heroNames[String(c.id)]))
      : [];

  const humanProvider: HumanInputProvider = humanScript
    ? await ScriptHumanProvider.fromFile(path.resolve(REPO, humanScript), { onExhausted: 'skip' })
    : mounted.humanProvider;

  // A short random suffix guards against two parallel sessions that start within
  // the same millisecond colliding on one run directory (the ISO timestamp alone
  // is only ms-resolution).
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario.id}-${randomUUID().slice(0, 8)}`;
  const runDir = path.resolve(REPO, 'runs', runId);

  // Wire submitted playtest surveys to persistence now that the run identity
  // exists: always written to <runDir>/survey.json, and uploaded to the GCS
  // bucket unless disabled (see GCS_BUCKET above).
  mounted.surveySink?.((survey) => persistSurvey(survey, {
    runDir, runId, sid,
    ...(gcsUploader ? { uploader: gcsUploader } : {}),
    log: (m) => console.error(`[session ${sid}] ${m}`),
  }));

  const ac = new AbortController();

  const orch = new Orchestrator({
    engine, adventure,
    agents: {
      dm: dmAgent,
      players: new Map([
        [asCharacterId(scenario.agents.p1.characterId), p1Agent],
        [asCharacterId(scenario.agents.p2.characterId), p2Agent],
        // The human's default hero gets an AI agent too (used only if the player
        // picks someone else). Harmless when they DO play it — the human-turn
        // dispatch short-circuits before this agent is ever consulted.
        ...(humanAgent ? [[asCharacterId(scenario.human.characterId), humanAgent] as const] : []),
        ...(p3Agent && p3cfg ? [[asCharacterId(p3cfg.characterId), p3Agent] as const] : []),
      ]),
    },
    human: { characterId: asCharacterId(scenario.human.characterId), provider: humanProvider },
    subscribers: [mounted.subscriber],
    stepBudget: scenario.stepBudget,
    runDir, seed: runSeed, runId,
    startSceneId: scene0.id,
    agentRecords: scenario.agentRecords,
    monsterActionDelayMs: 250,
    monsterTurnDelayMs:   500,
    // Stagger between two CHAINED hero actions from one LLM reply (and between
    // the DM-interpreted actions of a human free-text turn) so a chained
    // say + move + attack reads as distinct moments instead of one burst.
    // A chained say/emote additionally awaits the beat gate first.
    playerActionDelayMs:  750,
    // Rats are "dumb AI", not agents: the deterministic planner in
    // monster-ai.ts drives every monster turn (go for the nearest reachable
    // enemy, lowest-HP tie-break). No LLM puppets the monsters.
    monsterControl: 'deterministic',
    // A message the human sends to the party lets the other AI heroes react
    // (banter / emoji) off-turn. Live play only — the test suite stays off.
    partyReactions: true,
    initiativeRevealDelayMs: 4500,
    postResolutionDelayMs: 1000,
    // Latency instrumentation: stamp events.jsonl lines with wall-clock ms
    // (post-hoc turn-pacing analysis) and log every LLM call live so a slow
    // run shows WHERE the time goes — role, round-trip seconds, tokens, and
    // the cache hit share of the input.
    stampWallClock: true,
    onLlmCall: ({ role, usage, durationMs }) => {
      const secs = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : '?s';
      const totalIn = usage.inputTokens + usage.cacheReadTokens;
      const cachePct = totalIn > 0 ? Math.round((usage.cacheReadTokens / totalIn) * 100) : 0;
      console.error(`[session ${sid}] [llm] ${role} ${secs} in=${totalIn} (cache ${cachePct}%) out=${usage.outputTokens}`);
    },
    abortSignal: ac.signal,
    ...(mounted.rollProvider ? { rollProvider: mounted.rollProvider } : {}),
    ...(mounted.revealProvider ? { revealProvider: mounted.revealProvider } : {}),
    ...(mounted.beatGate ? { beatGate: mounted.beatGate } : {}),
    ...(mounted.openingProvider ? { openingProvider: mounted.openingProvider } : {}),
    ...(mounted.heroSelectProvider && heroChoices.length > 0
      ? { heroSelectProvider: mounted.heroSelectProvider, heroChoices }
      : {}),
    // Game language: scenario default, overridden by the player's pick on the
    // hero-select screen. The hook reroutes every agent's system prompt (the
    // LANGUAGE directive) through the shared PromptBuilder — the gate fires
    // before the first LLM call, so prompt caching is unaffected.
    language: scenario.language,
    onLanguageSelected: (lang) => {
      builder.setLanguage(lang);
      console.error(`[session ${sid}] game language → ${lang}`);
    },
    // Localized hero names (scenario `names` records, keyed by language) —
    // applied to the engine by the orchestrator once the session language
    // lands on one that has an entry.
    ...(Object.keys(nameOverrides).length > 0 ? { nameOverrides } : {}),
  });

  // End-of-run archive: ship events.jsonl + manifest.json to the GCS bucket
  // (runs/<runId>/…) so the research record outlives Render's ephemeral disk.
  // Best-effort on EVERY settle path (win / wipe / abort / crash) — a failed
  // upload only logs; it can never break session teardown. Skipped entirely
  // when the game never started (the session was reaped/aborted while parked
  // at the hero-select / opening gate — ghost tabs, queue-pressure reaps):
  // those runs hold only setup events, not a research record worth keeping.
  const archiveRun = async (): Promise<void> => {
    if (!gcsUploader) return;
    if (!orch.gameStarted) {
      console.error(`[session ${sid}] archive skipped — game never started (no hero selected)`);
      return;
    }
    const res = await archiveRunArtifacts({
      runDir, runId, uploader: gcsUploader,
      log: (m) => console.error(`[session ${sid}] ${m}`),
    });
    if (res.uploaded.length > 0) {
      console.error(`[session ${sid}] archived ${res.uploaded.join(' + ')} → gs://${GCS_BUCKET}/runs/${runId}/`);
    }
  };

  const runPromise = orch.run().then(
    async (result) => {
      console.error(`[session ${sid}] ended: ${result.outcome} (${result.totalEvents} events) — ${result.manifestPath}`);
      await archiveRun();
    },
    async (e) => {
      console.error(`[session ${sid}] failed:`, e);
      await archiveRun();
    },
  ).finally(() => mounted.cleanup());

  return {
    sid,
    abort: async () => {
      ac.abort();
      // adapter.abort() (if WS mode) is invoked by the session manager via
      // onAttach replacement — but for clean shutdown we still need the
      // orchestrator's run() to settle. cleanup() runs in the .finally above.
      await runPromise;
    },
    reattach: mounted.onAttach,
    runPromise,
  };
};

const main = async () => {
  const { mode, scenario: scenarioRel, humanScript, startScene } = parseArgs(process.argv);
  const scenario = await loadScenario(path.resolve(REPO, scenarioRel), REPO);

  const catalogs = await loadCatalogs(path.resolve(REPO, 'data'));
  const adventure = await loadAdventure(scenario.adventurePath);

  // Validate --start-scene up front so a typo fails fast with the valid ids,
  // rather than silently falling back to scene[0] inside the orchestrator.
  if (startScene && !adventure.scenes.some((s) => s.id === startScene)) {
    console.error(
      `unknown --start-scene "${startScene}". Valid scenes for ${adventure.id}:\n` +
        adventure.scenes.map((s) => `  - ${s.id}`).join('\n'),
    );
    process.exit(1);
  }
  if (startScene) console.log(`Starting from scene: ${startScene}`);

  // Build the LLM client LAZILY (on first session), NOT at boot. Constructing
  // it eagerly here used to throw before bootWsServer whenever the provider's
  // credentials were missing/misconfigured (the default scenario is gemini-*,
  // so an absent GEMINI_API_KEY threw) — which killed the process via
  // main().catch and FAILED Render's `/` health check, even though serving the
  // page + assets needs no LLM at all. Deferring it means the web/WS server
  // always comes up (health check green) and an LLM-config error surfaces only
  // when a game actually tries to start (logged per session; the server stays
  // alive). Memoized so the SDK + client are built at most once and shared
  // across every parallel session.
  let llmPromise: Promise<LlmClient> | null = null;
  const getLlm = (): Promise<LlmClient> => (llmPromise ??= buildLlm(scenario.model));

  const deps: SessionDeps = { scenario, catalogs, adventure, getLlm, humanScript, startSceneId: startScene };

  if (mode === 'cli') {
    // Single-shot CLI run. No lifecycle juggling — the Ink view is the only
    // surface, so reusing the session-manager would just add latency.
    const session = await createSession('cli', deps, async (engine, scene0, grid) => {
      const store = new CliStore();
      const displayFor = (id: 'dm' | ReturnType<typeof asCharacterId>) => {
        if (id === 'dm') return actorDisplay({ id: 'dm', kind: 'dm' });
        const c = engine.charactersById().get(id);
        if (!c) return actorDisplay({ id: String(id) });
        return actorDisplay({
          id: c.id, kind: c.kind,
          ...(c.archetype !== undefined && { archetype: c.archetype }),
          name: c.name,
        });
      };
      const cli = new CliAdapter({
        store, displayFor,
        readState: () => ({ scene: scene0, grid, characters: Array.from(engine.charactersById().values()) }),
      });
      const inkInstance = render(React.createElement(App, {
        store, displayFor, onSubmit: (line: string) => cli.submit(line),
      }));
      return {
        subscriber: cli,
        humanProvider: cli,
        cleanup: async () => { inkInstance.unmount(); },
      };
    });
    await session.runPromise;
    return;
  }

  // Browser mode: build web bundle if needed, boot WS server, lazy-start a
  // session per connection (keyed by the browser's `?sid=`).
  const webRoot = path.resolve(REPO, 'dist/web');
  const indexPath = path.join(webRoot, 'index.html');
  // Rebuild when the bundle is MISSING or STALE. The bundle compiles both
  // `web/` and the `src/` modules it imports (engine types, the WS protocol),
  // so a source change in EITHER tree must trigger a rebuild — otherwise the
  // server runs fresh src/ code while the browser serves a stale bundle, and
  // the two disagree on the wire (e.g. a server that sends `reveal_request`
  // to a browser that never learned to ack it → the run hangs). Previously
  // this only rebuilt when index.html was absent, which silently shipped a
  // stale bundle after every web/src edit.
  const bundleStale = (): boolean => {
    if (!existsSync(indexPath)) return true;
    const builtAt = statSync(indexPath).mtimeMs;
    return newestMtimeMs([path.resolve(REPO, 'web'), path.resolve(REPO, 'src')]) > builtAt;
  };
  if (bundleStale()) {
    console.log('Building web bundle (missing or out of date)...');
    const r = spawnSync('npm', ['run', 'build:web'], { stdio: 'inherit', cwd: REPO });
    if (r.status !== 0) {
      console.error('web build failed; cannot start browser mode');
      process.exit(r.status ?? 1);
    }
  }

  // Hosted platforms (Render etc.) inject the port to bind via $PORT. Locally
  // we keep the fixed 5175 the dev proxy and docs expect.
  const booted: BootedServer = await bootWsServer({
    webRoot,
    assetsRoot: path.resolve(REPO, 'assets'),
    port: Number(process.env['PORT']) || 5175,
  });
  console.log(`Serving on port ${booted.port}`);

  // One independent game per browser `sid`, hosted side by side. A new sid →
  // spin up a fresh run; the same sid (a WS reconnect OR a page refresh — the
  // browser keeps its sid in sessionStorage, see web/ws-client.ts) →
  // re-attach to the existing adapter. The registry also reaps a session
  // whose tab stays gone past the disconnect grace, so abandoned tabs don't leak
  // engines + agents. Override the grace with SESSION_GRACE_MS (ms; <=0 to keep
  // sessions until they end or the server stops). At most MAX_SESSIONS games
  // run concurrently — further tabs wait in a FIFO line and learn their place
  // via `queued` envelopes until a slot frees; while anyone is waiting, a
  // DISCONNECTED session is reaped on the much shorter queue-pressure grace
  // (QUEUE_GRACE_MS, default 15s) so zombie tabs can't pin the slots, and a
  // CONNECTED session whose human hasn't acted in IDLE_GRACE_MS (default
  // 2 min) is reaped too — a clicked-into-and-forgotten tab is just as
  // abandoned as a closed one. Reconnects from tabs whose session no longer
  // exists here (server restart, reap) are REFUSED (`rejected: session_gone`)
  // instead of being given a fresh game, so forgotten tabs' reconnect loops
  // can't grab the slots the moment the server comes back up.
  if (MAX_SESSIONS > 0) console.log(`Session cap: ${MAX_SESSIONS} concurrent games (MAX_SESSIONS to override)`);
  const registry = new SessionRegistry<WebSocket>({
    log: (m) => console.error(m),
    ...(process.env['SESSION_GRACE_MS'] ? { graceMs: Number(process.env['SESSION_GRACE_MS']) } : {}),
    ...(process.env['QUEUE_GRACE_MS'] ? { queueGraceMs: Number(process.env['QUEUE_GRACE_MS']) } : {}),
    ...(process.env['IDLE_GRACE_MS'] ? { idlePressureMs: Number(process.env['IDLE_GRACE_MS']) } : {}),
    maxSessions: MAX_SESSIONS,
    onQueued: (ws, standing) => {
      ws.send(encodeServerEnvelope({ kind: 'queued', ...standing }));
    },
    onRefused: (ws) => {
      ws.send(encodeServerEnvelope({ kind: 'rejected', reason: 'session_gone' }));
      ws.close();
    },
    onClose: (ws, listener) => ws.on('close', listener),
    create: async (sid, ws) => {
      // `adapter` is assigned synchronously inside createSession's mount callback
      // (mountSubscriber is awaited before createSession returns), so it's set by
      // the time we build the ManagedSession below.
      let adapter!: WsAdapter;
      // Whether the player will be offered the "Choose your hero" gate at game
      // start — the same condition createSession uses to build `heroChoices`
      // (human persona present AND not a scripted run). The adapter stamps this
      // onto every snapshot so the browser can hold the opening splash until
      // the chooser mounts, instead of flashing it in the window between the
      // first snapshot and the `hero_select_request`.
      const expectsHeroSelect = !!deps.scenario.human.persona && !deps.humanScript;
      const handle = await createSession(sid, deps, async (engine) => {
        adapter = new WsAdapter({ kind: 'human' }, booted.manifest, { expectsHeroSelect });
        adapter.attach(ws, engine.getRedactedSnapshot(adapter.viewer));
        return {
          subscriber: adapter,
          humanProvider: adapter,
          // WsAdapter implements RollProvider — the browser's 3D physics is
          // authoritative for normal-attack rolls when a tab is attached.
          // The browser answers `roll_request` with the faces its dice settle
          // on (web/main.ts handleRollRequest). Set `PHYSICS_DICE=0` to opt
          // out and fall back to the engine's seeded `Dice` everywhere.
          ...(process.env.PHYSICS_DICE === '0' ? {} : { rollProvider: adapter }),
          // The reveal gate is independent of physics dice — even with
          // PHYSICS_DICE=0 we still want the first combat turn to wait for the
          // player to dismiss the on-screen Order of Battle.
          revealProvider: adapter,
          // The beat gate holds each turn until the browser has drained the
          // previous turn's narration / hero-speech beats, so AI / monster /
          // DM turns don't race ahead of the reader (Skip button paces play).
          beatGate: adapter,
          // The opening gate holds the DM's first turn until the player
          // dismisses the title splash ("Begin"). WsAdapter implements it.
          openingProvider: adapter,
          // The hero-select gate holds the whole run at game start until the
          // player chooses which starting hero they control. WsAdapter
          // implements it. The orchestrator only wires it when heroChoices is
          // non-empty (human persona present + not script-automated).
          heroSelectProvider: adapter,
          // Submitted playtest surveys flow through the adapter to
          // persistSurvey (run dir + GCS) — createSession registers the
          // handler once the run identity exists.
          surveySink: (h) => adapter.onSurvey(h),
          onAttach: (newWs) => adapter.attach(newWs, engine.getRedactedSnapshot(adapter.viewer)),
          cleanup: async () => { adapter.abort(); },
        };
      });
      return {
        runPromise: handle.runPromise,
        reattach: handle.reattach!,
        // Unblock the adapter's pending waiters (requestInput / roll / gates)
        // first, THEN cancel the orchestrator and await its unwind.
        abort: async () => { adapter.abort(); await handle.abort(); },
        // The registry's idle-under-queue-pressure sweep reads the human's
        // last input stamp off the adapter (automatic page traffic excluded).
        lastHumanActivityMs: () => adapter.lastHumanActivityMs(),
      };
    },
  });

  booted.onConnect((ws, info) => {
    registry.handleConnection(ws, info.sid ?? `anon-${randomUUID()}`, {
      reattachOnly: info.reattachOnly,
    });
  });

  // Only auto-open a browser for a local run. In a hosted environment Render
  // sets $PORT and there's no local browser to launch (and `open` would error).
  // Set NO_OPEN=1 to suppress it locally too.
  if (!process.env['PORT'] && process.env['NO_OPEN'] !== '1') {
    await openBrowser(`http://localhost:${booted.port}`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    // Second Ctrl-C while already unwinding: stop trying to be graceful, die now.
    if (shuttingDown) process.exit(130);
    shuttingDown = true;

    // Graceful unwind awaits the orchestrator's run() settling, which can block
    // indefinitely (pending LLM call, a roll_response from a gone tab, human
    // input). Installing this handler disables Node's default SIGINT=terminate,
    // so without a hard deadline a wedged run() makes the process unkillable by
    // Ctrl-C. Force-exit after 3s regardless.
    const forceTimer = setTimeout(() => {
      console.error('graceful shutdown timed out — forcing exit (Ctrl-C again to skip the wait)');
      process.exit(130);
    }, 3000);
    forceTimer.unref();

    try {
      await registry.shutdownAll();
      await booted.shutdown();
    } catch (e) {
      console.error('shutdown error:', e);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  // Block the main task forever — sessions come and go via onConnect.
  await new Promise<void>(() => { /* never resolves */ });
};

main().catch((e) => { console.error(e); process.exit(1); });
