import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asSceneId, asCharacterId } from '../../src/engine/ids.js';
import path from 'node:path';

describe('set_scene auto-reveals NPCs', () => {
  it('materializes scene-declared NPCs as kind=npc characters', async () => {
    const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
    const cats = await loadCatalogs(path.resolve('data'));
    // Inject a synthetic mira NPC catalog entry so materialize succeeds.
    cats.npcs.set('mira', {
      id: 'mira', name: 'Mira',
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      dex: 1, healthTotal: 2,
      normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
      specialAction: { effectId: 'noop', name: '', description: '' },
      bonusAbility:  { effectId: 'noop', name: '', description: '' },
      sprite: 'mira',
    });
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const engine = new GameEngine({
      seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
      characters: [],
      effects: reg, items: cats.items, boons: cats.boons,
      adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
    });
    engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('s') });
    const c = engine.charactersById().get(asCharacterId('mira-1'));
    expect(c).toBeDefined();
    expect(c?.kind).toBe('npc');
    expect(c?.pos).toEqual({ x: 1, y: 2 });
  });
});
