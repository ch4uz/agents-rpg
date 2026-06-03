import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asSceneId, asCharacterId } from '../../src/engine/ids.js';
import path from 'node:path';

const setup = async () => {
  const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
  const cats = await loadCatalogs(path.resolve('data'));
  cats.npcs.set('mira', {
    id: 'mira', name: 'Mira',
    pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
    dex: 1, healthTotal: 2,
    normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
    specialAction: { effectId: 'noop', name: '', description: '' },
    bonusAbility:  { effectId: 'noop', name: '', description: '' },
    sprite: 'mira',
  });
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const engine = new GameEngine({
    seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
    characters: [],
    effects: reg, items: cats.items, boons: cats.boons,
    adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
  });
  engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('s') });
  return { engine, miraId: asCharacterId('mira-1') };
};

describe('npc_action', () => {
  it('applies say on behalf of the NPC outside combat', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'say', text: 'I am lost!' },
    });
    expect(r.ok).toBe(true);
  });

  it('applies move on behalf of the NPC outside combat', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'move', path: [{ x: 1, y: 2 }, { x: 2, y: 2 }] },
    });
    expect(r.ok).toBe(true);
    expect(engine.charactersById().get(miraId)?.pos).toEqual({ x: 2, y: 2 });
  });

  it('rejects npc_action when npcId is not an NPC', async () => {
    const { engine } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: asCharacterId('does-not-exist'),
      action: { kind: 'say', text: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects npc_action with a disallowed action kind', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'use_item', itemId: 'potion' as never },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });
});
