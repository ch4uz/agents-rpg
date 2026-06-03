/**
 * Regression test: the orchestrator must auto-enter the starting scene before
 * the DM's first turn so the scene's declared monsters materialize, even when
 * the DM never calls set_scene for the current scene.
 *
 * Previously the DM had to call set_scene(scene[0].id) itself. With real
 * Sonnet that often happened — but not always — so enemies sometimes failed
 * to appear at game start. The fix moves the initial entry into the
 * Orchestrator and makes set_scene idempotent so existing scripts that DO
 * call set_scene(scene[0]) still work.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Character } from '../../src/engine/character.js';
import type { MonsterEntry } from '../../src/engine/catalogs.js';

const hero = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'hunter',
  pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
  health: { total: 3, damage: 0, status: 'normal' }, pos: { x, y },
  normalAttack: { kind: 'ranged', name: 'Quick Shot', range: 6, damageMod: 0 },
  specialAction: { id: asEffectId('split-shot'), name: 'Split Shot', description: '' },
  bonusAbility: { id: asEffectId('keen-eye'), name: 'Keen Eye', description: '' },
  inventory: [], boons: [], skills: [],
});

const buildAdventure = (): Adventure => ({
  id: asAdventureId('a'),
  title: 'A',
  estimatedDurationMin: 5,
  scenes: [{
    id: asSceneId('s'),
    intro: 'go.', conclusion: 'done.',
    map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
    monsters: [
      { type: 'giant-rat', startPos: { x: 4, y: 0 } },
      { type: 'giant-rat', startPos: { x: 5, y: 0 } },
    ],
    tactics: '', abilityTests: [], transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
  }],
});

const monsterCatalog: Map<string, MonsterEntry> = new Map([
  ['giant-rat', {
    id: 'giant-rat', name: 'Giant Rat',
    pools: { melee: 1, ranged: 0, magic: 0, armor: 0 }, dex: 0, healthTotal: 1,
    normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
    specialAction: { effectId: 'pack-attack', name: 'Pack Attack', description: '' },
    bonusAbility: { effectId: 'skitter', name: 'Skitter', description: '' },
    sprite: 'giant-rat',
  }],
]);

describe('Orchestrator auto-enters the starting scene before the DM acts', () => {
  it('materializes scene[0].monsters even when the scripted DM never calls set_scene', async () => {
    const adventure = buildAdventure();
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const p1 = hero('p1_warrior', 0, 0);
    const engine = new GameEngine({
      seed: 's', grid, characters: [p1], effects: reg, adventure, monsters: monsterCatalog,
    });

    // Before run() — no monsters yet, only heroes.
    expect(Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster')).toHaveLength(0);

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    // DM script: skip set_scene entirely. Go straight to end_adventure so the
    // run terminates quickly. If the orchestrator did NOT auto-enter scene[0],
    // monsters would never materialize.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const sharedAgentArgs = {
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
    };
    const dm = new Agent({
      ...sharedAgentArgs, role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });

    const runDir = mkdtempSync(path.join(tmpdir(), 'auto-enter-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map() },
      human: null,
      subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'auto-enter',
    });

    const result = await orch.run();
    expect(result.outcome).toBe('success');

    // After run() — both scene-declared rats must be present, with the
    // engine-assigned deterministic ids.
    const ids = Array.from(engine.charactersById().keys()).map(String);
    expect(ids).toContain('giant-rat-1');
    expect(ids).toContain('giant-rat-2');
  });

  it('stays correct when the scripted DM also calls set_scene for the starting scene', async () => {
    // This guards the idempotency contract: existing test fixtures script
    // the DM to call set_scene(scene[0]) — those must continue to succeed.
    const adventure = buildAdventure();
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const p1 = hero('p1_warrior', 0, 0);
    const engine = new GameEngine({
      seed: 's', grid, characters: [p1], effects: reg, adventure, monsters: monsterCatalog,
    });

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'set_scene', input: { sceneId: 's' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const sharedAgentArgs = {
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
    };
    const dm = new Agent({
      ...sharedAgentArgs, role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });

    const runDir = mkdtempSync(path.join(tmpdir(), 'idempotent-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map() },
      human: null,
      subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'idempotent',
    });

    const result = await orch.run();
    expect(result.outcome).toBe('success');

    // No duplicate materialization — exactly the scene's two declared rats.
    const monsters = Array.from(engine.charactersById().values())
      .filter((c) => c.kind === 'monster');
    expect(monsters).toHaveLength(2);
  });
});
