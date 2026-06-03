import { describe, it, expect } from 'vitest';
import { resolvePropPlacements } from '../../web/components/Props.js';

const SCENE = {
  obstacles: [
    { type: 'barrel-stack', x: 1, y: 1 },
    { type: 'barrel-stack', x: 3, y: 0 },
  ],
  decorations: [
    { type: 'barrel-stack', x: 4, y: 2 },
  ],
  exits: [
    { to: 'rat-tunnel', at: { x: 0, y: 6 }, trigger: 'step-on' as const },
  ],
};
const PROPS = {
  'barrel-stack': 'props/barrel-stack/south.png',
};
const EXIT_MAP: Record<string, string> = {};

describe('resolvePropPlacements', () => {
  it('emits decorations first, then obstacles (exits unmapped → skipped)', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    expect(out.map((p) => p.layer)).toEqual(['decoration', 'obstacle', 'obstacle']);
  });

  it('resolves a barrel-stack obstacle to its sprite path', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const barrel = out.find((p) => p.layer === 'obstacle' && p.x === 1 && p.y === 1);
    expect(barrel).toEqual({
      x: 1, y: 1, assetRel: 'props/barrel-stack/south.png', layer: 'obstacle',
    });
  });

  it('resolves an explosive obstacle to its own sprite, untinted (the danger cue lives in the sprite, not a runtime tint)', () => {
    const out = resolvePropPlacements(
      {
        obstacles: [
          { type: 'barrel-stack', x: 1, y: 1 },
          { type: 'oil-cask', x: 2, y: 2, explosive: true },
        ],
        decorations: [],
        exits: [],
      },
      { 'barrel-stack': 'props/barrel-stack/south.png', 'oil-cask': 'props/oil-cask/south.png' },
      EXIT_MAP,
    );
    const barrel = out.find((p) => p.x === 1 && p.y === 1)!;
    const cask = out.find((p) => p.x === 2 && p.y === 2)!;
    // The cask uses its own dedicated sprite; explosive is no longer washed red.
    expect(cask).toEqual({ x: 2, y: 2, assetRel: 'props/oil-cask/south.png', layer: 'obstacle' });
    expect(barrel).toEqual({ x: 1, y: 1, assetRel: 'props/barrel-stack/south.png', layer: 'obstacle' });
  });

  it('skips entries whose prop type is not in the manifest', () => {
    const out = resolvePropPlacements(
      { obstacles: [{ type: 'unknown-thing', x: 0, y: 0 }], decorations: [], exits: [] },
      PROPS, EXIT_MAP,
    );
    expect(out).toEqual([]);
  });

  it('skips exits whose target is not in the exit-to-prop map', () => {
    const out = resolvePropPlacements(
      { obstacles: [], decorations: [],
        exits: [{ to: 'unmapped-scene', at: { x: 0, y: 0 }, trigger: 'manual' as const }] },
      PROPS, {},
    );
    expect(out).toEqual([]);
  });

  it('order within a layer matches scene array order', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const obstacles = out.filter((p) => p.layer === 'obstacle');
    expect(obstacles[0]).toMatchObject({ x: 1, y: 1 });
    expect(obstacles[1]).toMatchObject({ x: 3, y: 0 });
  });
});

describe('resolvePropPlacements — destroyedObstacles filter', () => {
  it('skips obstacles whose cell appears in destroyedObstacles', () => {
    const out = resolvePropPlacements(
      { ...SCENE, destroyedObstacles: [{ x: 1, y: 1 }] },
      PROPS, EXIT_MAP,
    );
    const obstacleCells = out
      .filter((p) => p.layer === 'obstacle')
      .map((p) => `${p.x},${p.y}`);
    expect(obstacleCells).toEqual(['3,0']);   // (1,1) gone, (3,0) survives
  });

  it('omitted destroyedObstacles behaves identically to empty []', () => {
    const a = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const b = resolvePropPlacements({ ...SCENE, destroyedObstacles: [] }, PROPS, EXIT_MAP);
    expect(a).toEqual(b);
  });

  it('does not affect decorations or exits', () => {
    const sceneWithExit = {
      ...SCENE,
      exits: [{ to: 'rat-tunnel', at: { x: 1, y: 1 }, trigger: 'step-on' as const }],
    };
    const out = resolvePropPlacements(
      { ...sceneWithExit, destroyedObstacles: [{ x: 4, y: 2 }] },
      PROPS, EXIT_MAP,
    );
    // (4,2) is a decoration — destroyedObstacles is obstacles-only, so it stays.
    expect(out.some((p) => p.layer === 'decoration' && p.x === 4 && p.y === 2)).toBe(true);
  });
});
