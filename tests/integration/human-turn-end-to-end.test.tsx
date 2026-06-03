/**
 * End-to-end interactive-mode regression test.
 *
 * Drives a real Orchestrator with a real CliAdapter as the humanProvider, using
 * ScriptedLlmClient for the AI agents. The CliAdapter is wired into a real Ink
 * App rendered via ink-testing-library. Asserts that:
 *
 *   1. After AI turns complete, the Orchestrator hands control to the human
 *      and the App's InputLine becomes enabled.
 *   2. Sending keystrokes through Ink's stdin produces a `human_input` event
 *      and unblocks the orchestrator.
 *   3. The orchestrator continues to the next iteration without deadlocking.
 *
 * This is the regression test the audit-fixes pass should have included but
 * didn't — interactive mode was never end-to-end-tested.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { App } from '../../src/runtime/cli/App.js';
import { CliAdapter } from '../../src/runtime/cli/cli-adapter.js';
import { CliStore } from '../../src/runtime/cli/cli-store.js';
import { actorDisplay } from '../../src/runtime/cli/glyphs.js';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import type { Adventure, Scene } from '../../src/engine/adventure.js';
import type { Character } from '../../src/engine/character.js';

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const hero = (id: string, archetype: 'warrior' | 'hunter', x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype,
  pools: { melee: 2, ranged: 2, magic: 0, armor: 1 },
  health: { total: 3, damage: 0, status: 'normal' }, pos: { x, y },
  normalAttack: { kind: archetype === 'hunter' ? 'ranged' : 'melee', name: 'X', range: archetype === 'hunter' ? 6 : 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'X', description: '' },
  bonusAbility: { id: asEffectId('teamwork'), name: 'T', description: '' },
  inventory: [], boons: [], skills: [],
});

const stubAdventure = (): Adventure => {
  const scene: Scene = {
    id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
    map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
    monsters: [], tactics: '', abilityTests: [], transitions: [],
  };
  return {
    id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30, scenes: [scene],
  };
};

describe('human turn end-to-end via Ink + Orchestrator', () => {
  it('routes keystrokes from Ink stdin into a human_input event', async () => {
    const adventure = stubAdventure();
    const scene = adventure.scenes[0]!;
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const p1 = hero('p1_warrior', 'warrior', 0, 0);
    const human = hero('human_hunter', 'hunter', 0, 1);
    const engine = new GameEngine({
      seed: 's', grid, characters: [p1, human], effects: reg, adventure,
    });

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    // Scripts: DM does set_scene → request_action(p1); p1 says + ends turn;
    // DM react narrates → request_action(human); after human turn the DM ends adventure.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'set_scene', input: { sceneId: 's' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1_warrior' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'human_hunter' } }] } },
      // Free-text from the human now emits a literal `say` directly (no DM
      // interpretation), so no dm:interp entry is needed. The /skip path is
      // what this test still drives.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'say', input: { text: 'hello' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);

    const sharedAgentArgs = {
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => scene,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    };
    const dm = new Agent({
      ...sharedAgentArgs, role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });
    const p1Agent = new Agent({
      ...sharedAgentArgs, role: 'player', actorId: asCharacterId('p1_warrior'),
      persona: '', llm: p1Llm, tools: PLAYER_TOOLS, stepBudget: 6, tag: 'p1',
    });

    // Real CliAdapter as the humanProvider.
    const store = new CliStore();
    const displayFor = (id: 'dm' | ReturnType<typeof asCharacterId>) =>
      id === 'dm' ? actorDisplay({ id: 'dm', kind: 'dm' })
        : actorDisplay({ id: String(id), kind: 'hero', archetype: 'hunter', name: 'Bran' });
    const cli = new CliAdapter({
      store, displayFor,
      readState: () => ({ scene, grid, characters: Array.from(engine.charactersById().values()) }),
    });

    // Render the App with ink-testing-library; wire onSubmit through cli.submit.
    const { stdin, lastFrame } = render(
      <App store={store} displayFor={displayFor} onSubmit={(line: string) => cli.submit(line)} />,
    );

    const runDir = mkdtempSync(path.join(tmpdir(), 'human-e2e-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map([[asCharacterId('p1_warrior'), p1Agent]]) },
      human: { characterId: asCharacterId('human_hunter'), provider: cli },
      subscribers: [cli],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'e2e',
    });

    // Run the orchestrator concurrently. While it advances, watch for the
    // InputLine to become enabled, then send a /skip via stdin.
    const runPromise = orch.run();

    // Poll until the App shows the input prompt (i.e. it's the human's turn).
    let frames = 0;
    const maxFrames = 200; // ~200 * 5ms = 1s ceiling
    while (frames < maxFrames) {
      await flush(5);
      const f = lastFrame() ?? '';
      if (f.match(/>\s/m) && !f.match(/Waiting/)) break;
      frames += 1;
    }
    const frameAtHumanTurn = lastFrame() ?? '';
    expect(frameAtHumanTurn, 'InputLine should be enabled when human turn comes up')
      .toMatch(/>\s/m);

    // Now send /skip via stdin.
    stdin.write('/skip');
    await flush(5);
    stdin.write('\r');
    await flush(5);

    // The orchestrator should unblock and finish.
    const result = await runPromise;
    expect(result.outcome).toBe('success');
  }, 10_000);
});
