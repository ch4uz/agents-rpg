import { describe, it, expect } from 'vitest';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import type { Scene } from '../../src/engine/adventure.js';

const baseScene = (overrides: Partial<Scene['map']>): Scene => ({
  id: 's', intro: '', tactics: '', conclusion: '',
  abilityTests: [], transitions: [], monsters: [],
  map: {
    width: 3, height: 3, background: 'bg',
    obstacles: [], decorations: [], exits: [], walls: true, npcs: [],
    ...overrides,
  },
});

describe('buildSceneGrid', () => {
  it('returns an all-floor grid when no obstacles', () => {
    const g = buildSceneGrid(baseScene({}));
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(g.cellAt({ x, y }).kind).toBe('floor');
      }
    }
  });

  it('marks obstacle cells as wall (full block) by default', () => {
    const g = buildSceneGrid(baseScene({
      obstacles: [
        { type: 'barrel-stack', x: 1, y: 1 },
        { type: 'barrel-stack', x: 2, y: 0 },
      ],
    }));
    expect(g.cellAt({ x: 1, y: 1 }).kind).toBe('wall');
    expect(g.cellAt({ x: 2, y: 0 }).kind).toBe('wall');
    expect(g.cellAt({ x: 0, y: 0 }).kind).toBe('floor');
  });

  it('marks a cover:true obstacle as a solid cover-wall cell (blocks movement, shots pass through)', () => {
    const g = buildSceneGrid(baseScene({
      obstacles: [
        { type: 'crate', x: 1, y: 1, cover: true },     // cover → solid, shoot-through
        { type: 'barrel-stack', x: 2, y: 0 },            // default → wall
      ],
    }));
    // Cover is a `cover-wall` cell: it BLOCKS movement (you can't walk through a
    // barrel stack) but does NOT block line of sight — a shot across it lands and
    // grants the target cover (the engine's +1 armor).
    expect(g.cellAt({ x: 1, y: 1 }).kind).toBe('cover-wall');
    expect(g.cellAt({ x: 2, y: 0 }).kind).toBe('wall');
    // LoS through the cover cell is not blocked but is flagged as cover.
    expect(g.lineOfSight({ x: 0, y: 1 }, { x: 2, y: 1 })).toEqual({ blocked: false, cover: true });
  });

  it('leaves decoration cells as floor', () => {
    const g = buildSceneGrid(baseScene({
      decorations: [{ type: 'barrel-stack', x: 1, y: 2 }],
    }));
    expect(g.cellAt({ x: 1, y: 2 }).kind).toBe('floor');
  });

  it('leaves exit cells as floor (walkable)', () => {
    const g = buildSceneGrid(baseScene({
      exits: [{ to: 'next', at: { x: 0, y: 0 }, trigger: 'step-on' }],
    }));
    expect(g.cellAt({ x: 0, y: 0 }).kind).toBe('floor');
  });

  it('grid dimensions match scene width × height', () => {
    const g = buildSceneGrid(baseScene({ width: 11, height: 7 }));
    expect(g.width).toBe(11);
    expect(g.height).toBe(7);
  });

  it('marks wallCells as indestructible rock', () => {
    const g = buildSceneGrid(baseScene({
      wallCells: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
    }));
    expect(g.cellAt({ x: 0, y: 0 }).kind).toBe('rock');
    expect(g.cellAt({ x: 2, y: 2 }).kind).toBe('rock');
    expect(g.cellAt({ x: 1, y: 1 }).kind).toBe('floor');
  });

  it('lets a destructible obstacle override rock on a shared cell', () => {
    const g = buildSceneGrid(baseScene({
      wallCells: [{ x: 1, y: 1 }],
      obstacles: [{ type: 'barrel-stack', x: 1, y: 1 }],
    }));
    // Obstacle (the destructible layer) wins, so attack_object can still smash it.
    expect(g.cellAt({ x: 1, y: 1 }).kind).toBe('wall');
  });
});
