import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../../src/runtime/cli/App.js';
import { CliStore } from '../../../src/runtime/cli/cli-store.js';
import { Grid } from '../../../src/engine/grid.js';
import { asCharacterId, asEffectId, asSceneId } from '../../../src/engine/ids.js';
import { actorDisplay } from '../../../src/runtime/cli/glyphs.js';
import type { Character, Archetype } from '../../../src/engine/character.js';
import type { Scene } from '../../../src/engine/adventure.js';

const stubDisplay = () => actorDisplay({ id: 'unknown' });

// Ink/chalk may wrap rendered text in ANSI color/bold escapes depending on the
// worker's detected color level (TTY / FORCE_COLOR), which varies run-to-run.
// These tests check CONTENT, not styling, so strip escapes before asserting —
// otherwise `toContain('Scene: s')` flakes when the scene name renders bold
// (`Scene: [1ms[22m`).
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const mkScene = (): Scene => ({
  id: asSceneId('s'),
  intro: '', conclusion: '',
  tactics: '',
  map: { width: 4, height: 4, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
  monsters: [], abilityTests: [], transitions: [],
});

const mkChar = (id: string, archetype: Archetype): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype,
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('App', () => {
  it('renders board, character panel, chat, and locked input by default', () => {
    const store = new CliStore();
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );
    store.setScene(mkScene(), grid);
    store.setCharacters([mkChar('p1', 'warrior')]);

    const { lastFrame } = render(<App store={store} displayFor={stubDisplay} onSubmit={() => undefined} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Scene: s');
    expect(frame).toContain('p1');
    expect(frame).toMatch(/Waiting/);
  });

  it('unlocks input when store.unlockInput(true)', () => {
    const store = new CliStore();
    const grid = new Grid(
      Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ kind: 'floor' as const }))),
    );
    store.setScene(mkScene(), grid);
    store.setCharacters([mkChar('p1', 'warrior')]);
    store.unlockInput(true);
    const { lastFrame } = render(<App store={store} displayFor={stubDisplay} onSubmit={() => undefined} />);
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/>\s/m);
  });
});
