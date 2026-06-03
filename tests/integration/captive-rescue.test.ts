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

describe("Basement O' Rats — Elara captive rescue (real content)", () => {
  it('rat-tunnel materializes Elara immobilized beyond the breach, seats the party west, and reserves her a combat slot', async () => {
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));

    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const party = [mobileHero('p1_warrior'), mobileHero('p2_warlock'), mobileHero('human_hunter')];
    const engine = new GameEngine({
      seed: 'rescue-test',
      grid: buildSceneGrid(adv.scenes[0]!),
      characters: party,
      effects: reg,
      adventure: adv,
      monsters: cats.monsters,
      npcs: cats.npcs,
      heroes: cats.heroes,
    });

    // Enter the finale scene directly.
    const r = engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('rat-tunnel') });
    expect(r.ok).toBe(true);

    // Elara is materialized as an immobilized HEALER hero at her declared cell.
    const elara = engine.charactersById().get(asCharacterId('p3_healer'));
    expect(elara).toBeDefined();
    expect(elara?.kind).toBe('hero');
    expect(elara?.archetype).toBe('healer');
    expect(elara?.name).toBe('Elara');
    expect(elara?.health.status).toBe('immobilized');
    expect(elara?.pos).toEqual({ x: 11, y: 8 });

    // The mobile party is seated at the WEST tunnel-mouth entry (x=1), NOT on
    // Elara's cell; Elara stays pinned east.
    for (const id of ['p1_warrior', 'p2_warlock', 'human_hunter']) {
      const c = engine.charactersById().get(asCharacterId(id));
      expect(c?.pos?.x).toBe(1);
    }

    // Monsters auto-revealed with deterministic ids.
    const king = engine.charactersById().get(asCharacterId('king-rat-1'));
    expect(king?.kind).toBe('monster');

    // The DM starts combat WITHOUT listing the captive — the engine reserves her
    // a turn slot anyway, so she can rejoin the moment she's freed.
    const monsterIds = Array.from(engine.charactersById().values())
      .filter((c) => c.kind === 'monster')
      .map((c) => c.id);
    const sc = engine.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('p1_warrior'), asCharacterId('p2_warlock'), asCharacterId('human_hunter')],
      monsterSide: monsterIds,
    });
    expect(sc.ok).toBe(true);
    const started = engine.flushEvents().find((ev) => ev.type === 'combat_started') as
      | { heroSide: unknown[]; order: unknown[] } | undefined;
    expect(started?.heroSide).toContain(asCharacterId('p3_healer'));
    expect(started?.order).toContain(asCharacterId('p3_healer'));
    // She is still bound at combat start (the orchestrator auto-skips her slot
    // until a teammate frees her).
    expect(engine.charactersById().get(asCharacterId('p3_healer'))?.health.status).toBe('immobilized');
  });

  it('the push-and-detonate puzzle opens the real rat-tunnel breach: shove the cask flush to the wall, detonate, and the king-rat arena connects', async () => {
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    // The detonator needs a big pool so the smash lands deterministically.
    const detonator: Character = { ...mobileHero('p2_warlock'), pools: { melee: 10, ranged: 0, magic: 0, armor: 2 } };
    const party = [mobileHero('p1_warrior'), detonator, mobileHero('human_hunter')];
    const engine = new GameEngine({
      seed: 'puzzle-test',
      grid: buildSceneGrid(adv.scenes[0]!),
      characters: party,
      effects: reg,
      adventure: adv,
      monsters: cats.monsters,
      npcs: cats.npcs,
      heroes: cats.heroes,
    });
    expect(engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('rat-tunnel') }).ok).toBe(true);

    // At the start the breach cells are solid attack-proof stalagmite wall,
    // and attacking one is rejected — the cask is the only way through.
    for (const c of [{ x: 6, y: 6 }, { x: 6, y: 7 }]) {
      expect(engine.grid.cellAt(c).kind).toBe('wall');
    }
    engine.beginNarrativeTurn(asCharacterId('p1_warrior'));
    engine.charactersById().get(asCharacterId('p1_warrior'))!.pos = { x: 3, y: 7 };
    expect(engine.applyAction(asCharacterId('p1_warrior'), { kind: 'attack_object', pos: { x: 6, y: 7 }, difficulty: 4 }).ok).toBe(false);

    // Pusher (west of the cask) shoves it (4,7) → (5,7), flush against the wall.
    const push = engine.applyAction(asCharacterId('p1_warrior'), { kind: 'push_object', pos: { x: 4, y: 7 } });
    expect(push.ok).toBe(true);
    expect(engine.grid.cellAt({ x: 5, y: 7 }).kind).toBe('wall'); // cask relocated here

    // Detonator (beside the gap) smashes the cask; the blast shatters the two
    // stalagmites in range and blows the breach — the rock at (6,8) is untouched.
    engine.charactersById().get(asCharacterId('p2_warlock'))!.pos = { x: 5, y: 6 };
    engine.beginNarrativeTurn(asCharacterId('p2_warlock'));
    const boom = engine.applyAction(asCharacterId('p2_warlock'), { kind: 'attack_object', pos: { x: 5, y: 7 } });
    expect(boom.ok).toBe(true);

    // The breach is open: both cells are floor, the rest of the wall still stands,
    // and the king-rat arena is now in line of sight from the western corridor
    // (it was blocked before).
    for (const c of [{ x: 6, y: 6 }, { x: 6, y: 7 }]) {
      expect(engine.grid.cellAt(c).kind).toBe('floor');
    }
    for (const c of [{ x: 6, y: 3 }, { x: 6, y: 4 }, { x: 6, y: 5 }]) {
      expect(engine.grid.cellAt(c).kind).toBe('wall'); // partial breach — north spires survive
    }
    expect(engine.grid.lineOfSight({ x: 3, y: 7 }, { x: 9, y: 7 }).blocked).toBe(false);
  });
});

describe('setNameOverrides — Portuguese hero names (pt sessions)', () => {
  it('renames existing heroes immediately and future captives at materialization', async () => {
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const party = [mobileHero('p1_warrior'), mobileHero('p2_warlock'), mobileHero('human_hunter')];
    party[0]!.name = 'Gareth'; party[1]!.name = 'Kael'; party[2]!.name = 'Bran';
    const engine = new GameEngine({
      seed: 'names-test', grid: buildSceneGrid(adv.scenes[0]!), characters: party,
      effects: reg, adventure: adv, monsters: cats.monsters, npcs: cats.npcs, heroes: cats.heroes,
    });

    // Applied at the language gate — BEFORE the captive's scene is entered.
    engine.setNameOverrides({
      p1_warrior: 'Heitor', p2_warlock: 'Caio', human_hunter: 'Breno', p3_healer: 'Iara',
    });

    // Existing heroes rename in place…
    expect(engine.charactersById().get(asCharacterId('p1_warrior'))?.name).toBe('Heitor');
    expect(engine.charactersById().get(asCharacterId('p2_warlock'))?.name).toBe('Caio');
    expect(engine.charactersById().get(asCharacterId('human_hunter'))?.name).toBe('Breno');

    // …and the captive, materialized LATER by set_scene, gets her pt name too.
    const r = engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('rat-tunnel') });
    expect(r.ok).toBe(true);
    const elara = engine.charactersById().get(asCharacterId('p3_healer'));
    expect(elara?.name).toBe('Iara');
    expect(elara?.health.status).toBe('immobilized');

    // The snapshot — what the browser and the LLM state blocks read — carries them.
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    const names = new Set(snap.characters.map((c) => c.name));
    expect(names.has('Heitor')).toBe(true);
    expect(names.has('Iara')).toBe(true);
    expect(names.has('Gareth')).toBe(false);
    expect(names.has('Elara')).toBe(false);
  });

  it('ids absent from the override map keep their names; empty names are ignored', async () => {
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const party = [mobileHero('p1_warrior'), mobileHero('p2_warlock'), mobileHero('human_hunter')];
    party[0]!.name = 'Gareth';
    const engine = new GameEngine({
      seed: 'names-test-2', grid: buildSceneGrid(adv.scenes[0]!), characters: party,
      effects: reg, adventure: adv, monsters: cats.monsters, npcs: cats.npcs, heroes: cats.heroes,
    });
    engine.setNameOverrides({ p1_warrior: '   ', p2_warlock: 'Caio' });
    expect(engine.charactersById().get(asCharacterId('p1_warrior'))?.name).toBe('Gareth'); // blank ignored
    expect(engine.charactersById().get(asCharacterId('p2_warlock'))?.name).toBe('Caio');
    expect(engine.charactersById().get(asCharacterId('human_hunter'))?.name).toBe('human_hunter'); // untouched
  });
});
