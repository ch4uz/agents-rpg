import { describe, it, expect } from 'vitest';
import { loadAdventure } from '../../src/engine/adventure.js';

describe('Scene.map.npcs', () => {
  it('parses an adventure with a scene-declared NPC', async () => {
    const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
    const scene = adv.scenes[0]!;
    expect(scene.map.npcs).toEqual([
      { type: 'mira', startPos: { x: 1, y: 2 }, allegiance: 'neutral' },
    ]);
  });

  it('defaults map.npcs to [] when omitted', async () => {
    const adv = await loadAdventure('adventures/basement-o-rats.json');
    for (const s of adv.scenes) {
      expect(Array.isArray(s.map.npcs)).toBe(true);
    }
  });
});
