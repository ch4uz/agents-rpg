import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdventure } from '../../src/engine/adventure.js';

const writeAdventure = (json: unknown): { path: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'adventure-schema-'));
  const path = join(root, 'adv.json');
  writeFileSync(path, JSON.stringify(json));
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const baseScene = {
  id: 'scene-1', intro: 'i', tactics: 't', conclusion: 'c',
  abilityTests: [], transitions: [], monsters: [],
};

describe('SceneMapSchema (extended)', () => {
  it('parses obstacles with type, x, y', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: {
          width: 5, height: 5, background: 'bg',
          obstacles: [{ type: 'barrel-stack', x: 1, y: 2 }],
          exits: [],
        },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.obstacles).toEqual([{ type: 'barrel-stack', x: 1, y: 2 }]);
    } finally { cleanup(); }
  });

  it('defaults decorations to [] when omitted', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.decorations).toEqual([]);
    } finally { cleanup(); }
  });

  it('parses decorations with type, x, y', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: {
          width: 5, height: 5, background: 'bg',
          obstacles: [],
          decorations: [{ type: 'barrel-stack', x: 4, y: 2 }],
          exits: [],
        },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.decorations).toEqual([{ type: 'barrel-stack', x: 4, y: 2 }]);
    } finally { cleanup(); }
  });

  it('parses exits with at and trigger', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [
        { ...baseScene,
          map: {
            width: 5, height: 5, background: 'bg', obstacles: [],
            exits: [{ to: 'scene-2', at: { x: 0, y: 4 }, trigger: 'step-on' }],
          },
        },
        { ...baseScene, id: 'scene-2',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
        },
      ],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.exits[0]).toEqual({
        to: 'scene-2', at: { x: 0, y: 4 }, trigger: 'step-on',
      });
    } finally { cleanup(); }
  });

  it('defaults exit trigger to "manual" when omitted (back-compat)', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [
        { ...baseScene,
          map: {
            width: 5, height: 5, background: 'bg', obstacles: [],
            exits: [{ to: 'scene-2', at: { x: 0, y: 4 } }],
          },
        },
        { ...baseScene, id: 'scene-2',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
        },
      ],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.exits[0]!.trigger).toBe('manual');
    } finally { cleanup(); }
  });
});
