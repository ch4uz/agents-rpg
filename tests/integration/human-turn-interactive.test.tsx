import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/runtime/cli/App.js';
import { CliAdapter } from '../../src/runtime/cli/cli-adapter.js';
import { CliStore } from '../../src/runtime/cli/cli-store.js';
import { actorDisplay } from '../../src/runtime/cli/glyphs.js';
import { Grid } from '../../src/engine/grid.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asSceneId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { Scene } from '../../src/engine/adventure.js';

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const stubScene: Scene = {
  id: asSceneId('s'),
  intro: 'go.', conclusion: 'done.',
  map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
  monsters: [], tactics: '', abilityTests: [], transitions: [],
};

const hero = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'hunter',
  pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
  health: { total: 3, damage: 0, status: 'normal' }, pos: { x, y },
  normalAttack: { kind: 'ranged', name: 'Quick Shot', range: 6, damageMod: 0 },
  specialAction: { id: asEffectId('split-shot'), name: 'Split Shot', description: '' },
  bonusAbility: { id: asEffectId('keen-eye'), name: 'Keen Eye', description: '' },
  inventory: [], boons: [], skills: [],
});

const buildEnv = () => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const human = hero('human_hunter', 0, 1);
  const engine = new GameEngine({
    seed: 's', grid, characters: [human], effects: reg,
  });
  const store = new CliStore();
  const cli = new CliAdapter({
    store,
    displayFor: (id) => id === 'dm' ? actorDisplay({ id: 'dm', kind: 'dm' })
      : actorDisplay({ id: String(id), kind: 'hero', archetype: 'hunter', name: 'Bran' }),
    readState: () => ({ scene: stubScene, grid, characters: [human] }),
  });
  return { engine, store, cli, humanId: asCharacterId('human_hunter') };
};

describe('human turn — interactive mode end-to-end', () => {
  it('App unlocks input when CliAdapter.requestInput is called', async () => {
    const { store, cli } = buildEnv();
    cli.onStart();
    expect(store.getSnapshot().inputUnlocked).toBe(false);

    // Simulate orchestrator: turn started, then requestInput.
    cli.onTurnStarted(asCharacterId('human_hunter'));
    expect(store.getSnapshot().inputUnlocked).toBe(false);

    const inputPromise = cli.requestInput();
    expect(store.getSnapshot().inputUnlocked).toBe(true);

    // Resolve via submit
    cli.submit('hello');
    const result = await inputPromise;
    expect(result.kind).toBe('free_text');
    if (result.kind === 'free_text') expect(result.text).toBe('hello');

    // After delivery, input is locked again.
    expect(store.getSnapshot().inputUnlocked).toBe(false);
  });

  it('App.InputLine becomes enabled and accepts keystrokes when human turn comes up', async () => {
    const { store, cli } = buildEnv();
    cli.onStart();

    let submitted: string | null = null;
    const { stdin, lastFrame } = render(
      <App store={store} displayFor={(id) => id === 'dm'
        ? actorDisplay({ id: 'dm', kind: 'dm' })
        : actorDisplay({ id: String(id), kind: 'hero', archetype: 'hunter', name: 'Bran' })}
        onSubmit={(line) => { submitted = line; cli.submit(line); }} />,
    );

    // Initially locked
    await flush();
    expect(lastFrame() ?? '').toMatch(/Waiting/);

    // Simulate orchestrator: turn started, requestInput.
    cli.onTurnStarted(asCharacterId('human_hunter'));
    const inputPromise = cli.requestInput();
    await flush();

    // Now the InputLine should be visible (no longer "Waiting").
    const frameAfter = lastFrame() ?? '';
    expect(frameAfter).not.toMatch(/Waiting/);
    expect(frameAfter).toMatch(/>\s/m);

    // Type "hi" + Enter; the orchestrator-side promise should resolve.
    stdin.write('hi');
    await flush();
    stdin.write('\r');
    await flush();

    expect(submitted).toBe('hi');
    const result = await inputPromise;
    expect(result.kind).toBe('free_text');
    if (result.kind === 'free_text') expect(result.text).toBe('hi');
  });

  it('InputLine remains enabled across multiple consecutive turns (no stuck-disabled state)', async () => {
    const { store, cli } = buildEnv();
    cli.onStart();

    const { lastFrame } = render(
      <App store={store} displayFor={(id) => id === 'dm'
        ? actorDisplay({ id: 'dm', kind: 'dm' })
        : actorDisplay({ id: String(id), kind: 'hero', archetype: 'hunter', name: 'Bran' })}
        onSubmit={() => undefined} />,
    );
    await flush();

    // Turn 1
    cli.onTurnStarted(asCharacterId('human_hunter'));
    const p1 = cli.requestInput();
    await flush();
    expect(lastFrame() ?? '').toMatch(/>\s/m);
    cli.submit('/skip');
    await p1;
    cli.onTurnEnded(asCharacterId('human_hunter'));
    await flush();
    expect(lastFrame() ?? '').toMatch(/Waiting/);

    // Turn 2 — should re-unlock
    cli.onTurnStarted(asCharacterId('human_hunter'));
    const p2 = cli.requestInput();
    await flush();
    expect(lastFrame() ?? '').toMatch(/>\s/m);
    cli.submit('/skip');
    await p2;
  });
});
