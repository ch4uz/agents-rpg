import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asSceneId, asAdventureId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';

const grid8x8 = (): Grid =>
  new Grid(Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));

const reg = (): EffectRegistry => { const r = new EffectRegistry(); registerCoreEffects(r); return r; };

const hero = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('healing-touch'), name: 'Healing Touch', description: 'mends one wound' },
  bonusAbility:  { id: asEffectId('teamwork'),       name: 'Teamwork',      description: 'flanking bonus' },
  inventory: [], boons: [], skills: [],
});

describe('getRedactedSnapshot', () => {
  it('includes all characters for a human viewer', () => {
    const engine = new GameEngine({
      seed: 's', grid: grid8x8(), characters: [hero('h1', 0, 0), hero('h2', 1, 1)], effects: reg(),
    });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.characters.map((c) => c.id)).toEqual(expect.arrayContaining([asCharacterId('h1'), asCharacterId('h2')]));
  });

  it('captures activeActor when narrative turn is set', () => {
    const engine = new GameEngine({ seed: 's', grid: grid8x8(), characters: [hero('h1', 0, 0)], effects: reg() });
    engine.beginNarrativeTurn(asCharacterId('h1'));
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.activeActor).toBe(asCharacterId('h1'));
  });

  it('exposes pools, health, inventory, special and bonus ability names per character', () => {
    const engine = new GameEngine({ seed: 's', grid: grid8x8(), characters: [hero('h1', 0, 0)], effects: reg() });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    const h1 = snap.characters.find((c) => c.id === asCharacterId('h1'))!;
    expect(h1.pools.melee).toBe(2);
    expect(h1.health.total).toBe(3);
    expect(h1.inventory).toEqual([]);
    expect(h1.specialAction.name).toBe('Healing Touch');
    expect(h1.bonusAbility.name).toBe('Teamwork');
  });

  it('emits a SpecialTargeting descriptor matched to the bound special effect', () => {
    // One hero per archetype-special so we cover every targeting branch. The
    // descriptor must mirror resolveSpecialSubAttacks: split (melee/ranged) for
    // whirlwind/split-shot, area for flame-burst, single for everything else.
    const withSpecial = (
      id: string, effectId: string,
      pools: { melee: number; ranged: number; magic: number; armor: number },
      range: number,
    ): Character => ({
      ...hero(id, 0, 0),
      pools,
      normalAttack: { kind: 'melee', name: 'X', range, damageMod: 0 },
      specialAction: { id: asEffectId(effectId), name: effectId, description: '' },
    });
    const engine = new GameEngine({
      seed: 's', grid: grid8x8(), effects: reg(),
      characters: [
        withSpecial('warrior', 'whirlwind-attack', { melee: 2, ranged: 0, magic: 0, armor: 2 }, 1),
        withSpecial('hunter', 'split-shot', { melee: 0, ranged: 2, magic: 0, armor: 2 }, 6),
        withSpecial('warlock', 'flame-burst', { melee: 0, ranged: 0, magic: 3, armor: 1 }, 4),
        withSpecial('healer', 'healing-touch', { melee: 1, ranged: 0, magic: 1, armor: 2 }, 1),
      ],
    });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    const t = (id: string) =>
      snap.characters.find((c) => c.id === asCharacterId(id))!.specialAction.targeting;

    expect(t('warrior')).toEqual({ mode: 'split', attackKind: 'melee', pool: 2, range: 1, requiresLos: false });
    expect(t('hunter')).toEqual({ mode: 'split', attackKind: 'ranged', pool: 2, range: 6, requiresLos: true });
    expect(t('warlock')).toEqual({ mode: 'area' });
    expect(t('healer')).toEqual({ mode: 'single' });
  });

  it('viewer is echoed in the snapshot', () => {
    const engine = new GameEngine({ seed: 's', grid: grid8x8(), characters: [hero('h1', 0, 0)], effects: reg() });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.viewer).toEqual({ kind: 'human' });
  });

  it('scene is null when no adventure is loaded', () => {
    const engine = new GameEngine({ seed: 's', grid: grid8x8(), characters: [hero('h1', 0, 0)], effects: reg() });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.scene).toBeNull();
  });
});

describe('RedactedSnapshot.scene includes map data', () => {
  it('exposes obstacles, decorations, and exits from the active scene', () => {
    const adventure: Adventure = {
      id: asAdventureId('a'),
      title: 't',
      estimatedDurationMin: 1,
      scenes: [
        {
          id: asSceneId('scene-1'),
          intro: '',
          tactics: '',
          conclusion: '',
          abilityTests: [],
          transitions: [],
          monsters: [],
          map: {
            width: 3,
            height: 3,
            background: 'bg',
            walls: true,
            obstacles: [{ type: 'barrel-stack', x: 1, y: 1 }],
            decorations: [{ type: 'barrel-stack', x: 2, y: 0 }],
            exits: [{ to: 'END', at: { x: 0, y: 2 }, trigger: 'step-on' }],
            npcs: [],
          },
        },
      ],
    };
    const grid = new Grid(
      Array.from({ length: 3 }, () =>
        Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
    );
    const effects = new EffectRegistry();
    registerCoreEffects(effects);
    const engine = new GameEngine({
      seed: 's',
      grid,
      characters: [],
      effects,
      adventure,
    });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.scene?.obstacles).toEqual([{ type: 'barrel-stack', x: 1, y: 1 }]);
    expect(snap.scene?.decorations).toEqual([{ type: 'barrel-stack', x: 2, y: 0 }]);
    expect(snap.scene?.exits).toEqual([
      { to: 'END', at: { x: 0, y: 2 }, trigger: 'step-on' },
    ]);
  });

  it('exposes scene.opening when the active scene declares it, and omits it otherwise', () => {
    const sceneBase = {
      id: asSceneId('scene-1'),
      intro: 'Bbb\n\nAaa',
      tactics: '',
      conclusion: '',
      abilityTests: [],
      transitions: [],
      monsters: [],
      map: {
        width: 3, height: 3, background: 'bg', walls: true,
        obstacles: [], decorations: [], exits: [], npcs: [],
      },
    };
    const mkEngine = (adventure: Adventure): GameEngine => {
      const grid = new Grid(
        Array.from({ length: 3 }, () =>
          Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
      );
      const effects = new EffectRegistry();
      registerCoreEffects(effects);
      return new GameEngine({ seed: 's', grid, characters: [], effects, adventure });
    };

    const withOpening: Adventure = {
      id: asAdventureId('a'), title: 't', estimatedDurationMin: 1,
      scenes: [{ ...sceneBase, opening: { before: 'Bbb', after: 'Aaa' } }],
    };
    const snapWith = mkEngine(withOpening).getRedactedSnapshot({ kind: 'human' });
    expect(snapWith.scene?.opening).toEqual({ before: 'Bbb', after: 'Aaa' });

    const noOpening: Adventure = {
      id: asAdventureId('a'), title: 't', estimatedDurationMin: 1,
      scenes: [{ ...sceneBase }],
    };
    const snapWithout = mkEngine(noOpening).getRedactedSnapshot({ kind: 'human' });
    expect(snapWithout.scene?.opening).toBeUndefined();

    // A scene with a pt prose overlay rides BOTH variants in the snapshot —
    // the browser picks by UI language (the snapshot is published before the
    // hero-select gate where the language is chosen).
    const withPt: Adventure = {
      id: asAdventureId('a'), title: 't', estimatedDurationMin: 1,
      scenes: [{
        ...sceneBase,
        opening: { before: 'Bbb', after: 'Aaa' },
        i18n: { pt: { opening: { before: 'Bbb-pt', after: 'Aaa-pt' } } },
      }],
    };
    const snapPt = mkEngine(withPt).getRedactedSnapshot({ kind: 'human' });
    expect(snapPt.scene?.opening).toEqual({
      before: 'Bbb', after: 'Aaa',
      i18n: { pt: { before: 'Bbb-pt', after: 'Aaa-pt' } },
    });
  });

  it('returns defensive copies of obstacles/decorations/exits arrays', () => {
    const adventure: Adventure = {
      id: asAdventureId('a'),
      title: 't',
      estimatedDurationMin: 1,
      scenes: [
        {
          id: asSceneId('scene-1'),
          intro: '',
          tactics: '',
          conclusion: '',
          abilityTests: [],
          transitions: [],
          monsters: [],
          map: {
            width: 3,
            height: 3,
            background: 'bg',
            walls: true,
            obstacles: [{ type: 'barrel-stack', x: 1, y: 1 }],
            decorations: [{ type: 'barrel-stack', x: 2, y: 0 }],
            exits: [{ to: 'END', at: { x: 0, y: 2 }, trigger: 'step-on' }],
            npcs: [],
          },
        },
      ],
    };
    const grid = new Grid(
      Array.from({ length: 3 }, () =>
        Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
    );
    const effects = new EffectRegistry();
    registerCoreEffects(effects);
    const engine = new GameEngine({
      seed: 's',
      grid,
      characters: [],
      effects,
      adventure,
    });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });

    // Snapshot arrays must not be the engine's owned arrays.
    expect(snap.scene?.obstacles).not.toBe(adventure.scenes[0]!.map.obstacles);
    expect(snap.scene?.decorations).not.toBe(adventure.scenes[0]!.map.decorations);
    expect(snap.scene?.exits).not.toBe(adventure.scenes[0]!.map.exits);

    // Mutating the snapshot must not bleed into the engine's adventure.
    snap.scene!.obstacles.push({ type: 'evil', x: 0, y: 0 });
    expect(adventure.scenes[0]!.map.obstacles).toHaveLength(1);
  });
});
