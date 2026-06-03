import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asSceneId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const mobileHero = (id: string): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'WW', description: '' },
  bonusAbility: { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [], boons: [], skills: [],
});

const loadGoblinWarren = async () => {
  const cats = await loadCatalogs(path.join(REPO, 'data'));
  const adv = await loadAdventure(path.join(REPO, 'adventures', 'goblin-warren.json'));
  return { cats, adv };
};

describe('The Goblin Warren — adventure + catalog content', () => {
  it('new catalog entries: goblin + goblin-warboss monsters and the shiny-coin throwable lure', async () => {
    const { cats } = await loadGoblinWarren();

    const goblin = cats.monsters.get('goblin');
    expect(goblin?.healthTotal).toBe(1);
    expect(goblin?.normalAttack.kind).toBe('melee');
    // Reuses the engine's registered pack/coward effects so the deterministic
    // monster AI behaves exactly like the rats.
    expect(goblin?.specialAction.effectId).toBe('pack-attack');
    expect(goblin?.bonusAbility.effectId).toBe('coward');

    const boss = cats.monsters.get('goblin-warboss');
    expect(boss?.healthTotal).toBe(3);
    expect(boss?.pools.melee).toBe(2);
    expect(boss?.specialAction.effectId).toBe('pack-attack');

    const coin = cats.items.get('shiny-coin');
    expect(coin?.category).toBe('throwable');
  });

  it('chains mine-entrance → goblin-warren → END; the approach scene fights goblins among explosive powder kegs', async () => {
    const { adv } = await loadGoblinWarren();
    expect(adv.scenes.map((s) => s.id)).toEqual(['mine-entrance', 'goblin-warren']);

    const s1 = adv.scenes[0]!;
    expect(s1.transitions).toEqual([{ to: 'goblin-warren', trigger: 'all-monsters-ko' }]);
    expect(s1.monsters.every((m) => m.type === 'goblin')).toBe(true);
    expect(s1.monsters).toHaveLength(4);
    // The set-piece: skull-marked black-powder kegs (explosive oil-casks).
    const kegs = s1.map.obstacles.filter((o) => o.type === 'oil-cask' && o.explosive);
    expect(kegs.length).toBeGreaterThanOrEqual(3);

    const s2 = adv.scenes[1]!;
    expect(s2.transitions).toEqual([{ to: 'END', trigger: 'all-monsters-ko' }]);
    expect(s2.monsters.some((m) => m.type === 'goblin-warboss')).toBe(true);
  });

  it('goblin-warren materializes Fern (immobilized healer) beyond the breach, seats the party west, holds the loot-chest + boss', async () => {
    const { cats, adv } = await loadGoblinWarren();
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const party = [mobileHero('p1_warrior'), mobileHero('p2_warlock'), mobileHero('human_hunter')];
    const engine = new GameEngine({
      seed: 'warren-test',
      grid: buildSceneGrid(adv.scenes[0]!),
      characters: party,
      effects: reg,
      adventure: adv,
      monsters: cats.monsters,
      npcs: cats.npcs,
      heroes: cats.heroes,
    });

    expect(engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('goblin-warren') }).ok).toBe(true);

    // Fern is the rescue objective: a HEALER hero, immobilized at her stake.
    const fern = engine.charactersById().get(asCharacterId('p3_healer'));
    expect(fern?.kind).toBe('hero');
    expect(fern?.archetype).toBe('healer');
    expect(fern?.name).toBe('Fern');
    expect(fern?.health.status).toBe('immobilized');
    expect(fern?.pos).toEqual({ x: 11, y: 8 });

    // Mobile party seated at the WEST shaft mouth (x=1), not on Fern's cell.
    for (const id of ['p1_warrior', 'p2_warlock', 'human_hunter']) {
      expect(engine.charactersById().get(asCharacterId(id))?.pos?.x).toBe(1);
    }

    // The Warboss is auto-revealed east.
    expect(engine.charactersById().get(asCharacterId('goblin-warboss-1'))?.kind).toBe('monster');

    // The loot-chest is on the board carrying the shiny coin.
    const chest = engine.propsList().find((p) => p.id === 'loot-chest');
    expect(chest?.chest?.contents).toBe('shiny-coin');
  });

  it('the reskinned push-and-detonate breach still works: shove the powder keg flush, detonate, open the warren', async () => {
    const { cats, adv } = await loadGoblinWarren();
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const detonator: Character = { ...mobileHero('p2_warlock'), pools: { melee: 10, ranged: 0, magic: 0, armor: 2 } };
    const party = [mobileHero('p1_warrior'), detonator, mobileHero('human_hunter')];
    const engine = new GameEngine({
      seed: 'warren-puzzle',
      grid: buildSceneGrid(adv.scenes[0]!),
      characters: party,
      effects: reg,
      adventure: adv,
      monsters: cats.monsters,
      npcs: cats.npcs,
      heroes: cats.heroes,
    });
    expect(engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('goblin-warren') }).ok).toBe(true);

    // The cave-in (stalagmite) wall at x=6 is attack-proof — smashing it fails.
    for (const c of [{ x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 }]) {
      expect(engine.grid.cellAt(c).kind).toBe('wall');
    }
    engine.beginNarrativeTurn(asCharacterId('p1_warrior'));
    engine.charactersById().get(asCharacterId('p1_warrior'))!.pos = { x: 3, y: 5 };
    expect(engine.applyAction(asCharacterId('p1_warrior'), { kind: 'attack_object', pos: { x: 6, y: 5 }, difficulty: 4 }).ok).toBe(false);

    // Shove the keg (4,5) → (5,5), flush against the rubble.
    expect(engine.applyAction(asCharacterId('p1_warrior'), { kind: 'push_object', pos: { x: 4, y: 5 } }).ok).toBe(true);
    expect(engine.grid.cellAt({ x: 5, y: 5 }).kind).toBe('wall');

    // Detonate from beside the gap; the blast opens the three-tile breach.
    engine.charactersById().get(asCharacterId('p2_warlock'))!.pos = { x: 5, y: 4 };
    engine.beginNarrativeTurn(asCharacterId('p2_warlock'));
    expect(engine.applyAction(asCharacterId('p2_warlock'), { kind: 'attack_object', pos: { x: 5, y: 5 } }).ok).toBe(true);

    for (const c of [{ x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 }]) {
      expect(engine.grid.cellAt(c).kind).toBe('floor');
    }
    expect(engine.grid.lineOfSight({ x: 3, y: 5 }, { x: 9, y: 5 }).blocked).toBe(false);
  });
});
