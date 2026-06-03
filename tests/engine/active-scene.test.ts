import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asSceneId } from '../../src/engine/ids.js';
import path from 'node:path';

describe('GameEngine.activeScene()', () => {
  const build = async () => {
    const adv = await loadAdventure('adventures/basement-o-rats.json');
    const cats = await loadCatalogs(path.resolve('data'));
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const engine = new GameEngine({
      seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
      characters: [],
      effects: reg, items: cats.items, boons: cats.boons,
      adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
    });
    return { engine, adv };
  };

  it('is undefined before the first set_scene', async () => {
    const { engine } = await build();
    expect(engine.activeScene()).toBeUndefined();
  });

  it('tracks the live scene across set_scene transitions', async () => {
    const { engine } = await build();
    engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('tavern-basement') });
    expect(engine.activeScene()?.id).toBe('tavern-basement');
    // The start scene has an opening (splash); the finale does not — the
    // launcher's getActiveScene wiring keys intro suppression off this.
    expect(engine.activeScene()?.opening).toBeDefined();

    engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('rat-tunnel') });
    expect(engine.activeScene()?.id).toBe('rat-tunnel');
    expect(engine.activeScene()?.opening).toBeUndefined();
  });
});
