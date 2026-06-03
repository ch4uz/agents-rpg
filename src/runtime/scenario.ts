import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunManifest } from '../log/manifest.js';
import { GAME_LANGUAGES, NON_EN_LANGUAGES, type GameLanguage, type Localized } from './language.js';

const AgentBlockSchema = z.object({
  characterId: z.string().optional(),
  archetype: z.string().optional(),
  /** Display name for chat/HUD (e.g. "Gareth"). Optional — defaults to the
   *  catalog's archetype name (e.g. "Warrior") when omitted. */
  name: z.string().min(1).optional(),
  /** Per-language display names keyed by LANGUAGE CODE (e.g.
   *  `{ "pt": "Heitor" }`). Applied by the orchestrator to the ENGINE
   *  character when the session language lands on that language at the
   *  hero-select gate, so the board, prompts, and narration all use it.
   *  Optional — omitted heroes keep `name` in every language; unknown codes
   *  are tolerated (content can lead the code). */
  names: z.record(z.string().min(1), z.string().min(1)).optional(),
  persona: z.string(),                 // path relative to baseDir
});

const SquareSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  adventure: z.string().min(1),
  seed: z.string().min(1),
  model: z.string().min(1),
  stepBudget: z.object({ player: z.number().int().min(1), dm: z.number().int().min(1) }),
  snapshotEveryTurns: z.number().int().min(1).default(3),
  /**
   * Default game language: shapes the LANGUAGE directive in every agent's
   * system prompt (DM narration + hero dialogue) and is recorded in the run
   * manifest. The player's pick on the browser hero-select screen overrides
   * it per session (see `hero_select_response.language`). Absent → English.
   */
  language: z.enum(GAME_LANGUAGES).default('en'),
  agents: z.object({
    p1: AgentBlockSchema.extend({ characterId: z.string(), archetype: z.string() }),
    p2: AgentBlockSchema.extend({ characterId: z.string(), archetype: z.string() }),
    /**
     * Optional 3rd AI hero. Used for a hero who joins mid-adventure (e.g. the
     * immobilized captive rescued in basement-o-rats). `characterId` MUST match
     * the scene `captives[].characterId` that materializes them. Omit for the
     * default 2-AI party.
     */
    p3: AgentBlockSchema.extend({ characterId: z.string(), archetype: z.string() }).optional(),
    dm: AgentBlockSchema,
  }),
  human: z.object({
    characterId: z.string().min(1),
    archetype: z.string().min(1),
    name: z.string().min(1).optional(),
    /** Per-language display names — see AgentBlockSchema.names. */
    names: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Persona for the human's DEFAULT hero, used ONLY when the player chooses a
     * DIFFERENT hero on the game-start screen (then this hero becomes AI-driven).
     * Present → the launcher builds an AI agent for it and offers all three
     * starting heroes as selectable. Absent → no hero-select (the player always
     * plays this hero), preserving the legacy single-fixed-hero behaviour.
     */
    persona: z.string().optional(),
  }),
  /**
   * Per-character starting grid positions for the initial scene. Keys are
   * the same characterIds used in `agents` / `human`. Adventures with
   * different map dimensions (e.g. forest-edge 10x7 vs tavern-basement
   * 11x7) need different spawns; specifying them in the scenario file is
   * the cleanest way to avoid hard-coding per-map positions in the
   * orchestrator entry-point. When omitted, bin/play.ts falls back to
   * safe top-left spawns (0,0)/(1,0)/(0,1).
   */
  spawnPositions: z.record(z.string(), SquareSchema).optional(),
});

export type ScenarioFile = z.infer<typeof ScenarioSchema>;

export interface LoadedScenario {
  id: string;
  adventurePath: string;             // resolved absolute
  seed: string;
  model: string;
  stepBudget: { player: number; dm: number };
  snapshotEveryTurns: number;
  language: GameLanguage;
  agents: {
    p1: { characterId: string; archetype: string; persona: Localized; name?: string; names?: Record<string, string> };
    p2: { characterId: string; archetype: string; persona: Localized; name?: string; names?: Record<string, string> };
    p3?: { characterId: string; archetype: string; persona: Localized; name?: string; names?: Record<string, string> };
    dm: { persona: Localized };
  };
  human: { characterId: string; archetype: string; name?: string; names?: Record<string, string>; persona?: Localized };
  spawnPositions?: Record<string, { x: number; y: number }>;
  agentRecords: RunManifest['agents'];
}

const sha256Hex = (s: string): string =>
  'sha256:' + createHash('sha256').update(s).digest('hex');

export const loadScenario = async (
  scenarioPath: string,
  baseDir: string,
): Promise<LoadedScenario> => {
  const raw = await readFile(scenarioPath, 'utf8');
  const parsed = ScenarioSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid scenario: ${parsed.error.message}`);
  const sf = parsed.data;

  /**
   * Read a persona file plus its OPTIONAL per-language siblings — the
   * `.<lang>.md` convention: `personas/gareth-warrior.md` may sit next to
   * `personas/gareth-warrior.pt.md` (one sibling per non-English language in
   * GAME_LANGUAGES). Every existing sibling loads (the session language is
   * chosen at the hero-select gate, AFTER agents are built, so prompts must
   * be able to resolve any variant at build time); no siblings keeps the
   * legacy plain-string shape. The ENGLISH file is required either way.
   */
  const readPersona = async (rel: string): Promise<Localized> => {
    const full = path.resolve(baseDir, rel);
    let en: string;
    try { en = (await readFile(full, 'utf8')).trim(); }
    catch (e) { throw new Error(`failed to read persona ${rel}: ${(e as Error).message}`); }
    const variants: Record<string, string> = {};
    for (const lang of NON_EN_LANGUAGES) {
      const siblingPath = full.replace(/\.md$/, `.${lang}.md`);
      if (siblingPath === full) continue;
      try {
        const text = (await readFile(siblingPath, 'utf8')).trim();
        if (text.length > 0) variants[lang] = text;
      } catch { /* no sibling for this language — fine */ }
    }
    return Object.keys(variants).length > 0 ? { en, ...variants } : en;
  };

  /** Canonical English text of a persona — promptHash input (stable across
   *  sessions regardless of the per-session language pick; the manifest's
   *  `language` field records which variant actually ran). */
  const enText = (p: Localized): string => (typeof p === 'string' ? p : p.en);

  const [p1Persona, p2Persona, dmPersona] = await Promise.all([
    readPersona(sf.agents.p1.persona),
    readPersona(sf.agents.p2.persona),
    readPersona(sf.agents.dm.persona),
  ]);
  const p3Persona = sf.agents.p3 ? await readPersona(sf.agents.p3.persona) : null;
  // The human's default hero only needs a persona for when the player picks a
  // DIFFERENT hero (then this one is AI-driven). Optional → null when absent.
  const humanPersona = sf.human.persona ? await readPersona(sf.human.persona) : null;

  const agentRecords: RunManifest['agents'] = [
    { role: 'dm', model: sf.model, persona: sf.agents.dm.persona, promptHash: sha256Hex(enText(dmPersona)) },
    { role: 'p1', characterId: sf.agents.p1.characterId, persona: sf.agents.p1.persona, model: sf.model, promptHash: sha256Hex(enText(p1Persona)) },
    { role: 'p2', characterId: sf.agents.p2.characterId, persona: sf.agents.p2.persona, model: sf.model, promptHash: sha256Hex(enText(p2Persona)) },
    ...(sf.agents.p3 && p3Persona !== null
      ? [{ role: 'p3' as const, characterId: sf.agents.p3.characterId, persona: sf.agents.p3.persona, model: sf.model, promptHash: sha256Hex(enText(p3Persona)) }]
      : []),
  ];

  return {
    id: sf.id,
    adventurePath: path.resolve(baseDir, sf.adventure),
    seed: sf.seed,
    model: sf.model,
    stepBudget: sf.stepBudget,
    snapshotEveryTurns: sf.snapshotEveryTurns,
    language: sf.language,
    agents: {
      p1: {
        characterId: sf.agents.p1.characterId, archetype: sf.agents.p1.archetype, persona: p1Persona,
        ...(sf.agents.p1.name !== undefined && { name: sf.agents.p1.name }),
        ...(sf.agents.p1.names !== undefined && { names: sf.agents.p1.names }),
      },
      p2: {
        characterId: sf.agents.p2.characterId, archetype: sf.agents.p2.archetype, persona: p2Persona,
        ...(sf.agents.p2.name !== undefined && { name: sf.agents.p2.name }),
        ...(sf.agents.p2.names !== undefined && { names: sf.agents.p2.names }),
      },
      ...(sf.agents.p3 && p3Persona !== null
        ? {
            p3: {
              characterId: sf.agents.p3.characterId, archetype: sf.agents.p3.archetype, persona: p3Persona,
              ...(sf.agents.p3.name !== undefined && { name: sf.agents.p3.name }),
              ...(sf.agents.p3.names !== undefined && { names: sf.agents.p3.names }),
            },
          }
        : {}),
      dm: { persona: dmPersona },
    },
    human: {
      characterId: sf.human.characterId, archetype: sf.human.archetype,
      ...(sf.human.name !== undefined && { name: sf.human.name }),
      ...(sf.human.names !== undefined && { names: sf.human.names }),
      ...(humanPersona !== null && { persona: humanPersona }),
    },
    ...(sf.spawnPositions !== undefined && { spawnPositions: sf.spawnPositions }),
    agentRecords,
  };
};
