import { describe, it, expect } from 'vitest';
import { GameEngine, type GameEngineConfig } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asSceneId } from '../../src/engine/ids.js';
import { applyDamage, healDamage, type Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { HeroEntry } from '../../src/engine/catalogs.js';

const floorGrid = (w = 8, h = 8): Grid =>
  new Grid(Array.from({ length: h }, () => Array.from({ length: w }, () => ({ kind: 'floor' as const }))));

const mkEngine = (chars: Character[], extra: Partial<GameEngineConfig> = {}): GameEngine => {
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({ seed: 'test', grid: floorGrid(), characters: chars, effects: reg, ...extra });
};

const hero = (id: string, x: number, y: number, over: Partial<Character> = {}): Character => ({
  id: asCharacterId(id),
  name: id,
  kind: 'hero',
  archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'WW', description: '' },
  bonusAbility: { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [],
  boons: [],
  skills: [],
  ...over,
});

const monster = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id),
  name: id,
  kind: 'monster',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 1 },
  health: { total: 2, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('noop'), name: '-', description: '' },
  bonusAbility: { id: asEffectId('noop'), name: '-', description: '' },
  inventory: [],
  boons: [],
  skills: [],
});

const immobile = (id: string, x: number, y: number): Character =>
  hero(id, x, y, { kind: 'hero', archetype: 'healer', health: { total: 3, damage: 0, status: 'immobilized' } });

describe('free_ally', () => {
  it('frees an adjacent immobilized ally on a successful roll', () => {
    const e = mkEngine([hero('rescuer', 0, 0), immobile('elara', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('rescuer'));
    const r = e.applyAction(
      asCharacterId('rescuer'),
      { kind: 'free_ally', targetId: asCharacterId('elara'), characteristic: 'melee' },
      { providedAbilityRoll: { roll: [6, 6, 6], requestId: 'rq1' } },
    );
    expect(r.ok).toBe(true);
    expect(e.charactersById().get(asCharacterId('elara'))?.health.status).toBe('normal');
    const events = e.flushEvents();
    const res = events.find((ev) => ev.type === 'resolution') as { public: Record<string, unknown> } | undefined;
    expect(res?.public.freed).toBe(true);
    expect(res?.public.targetId).toBe(asCharacterId('elara'));
    expect(res?.public.rollRequestId).toBe('rq1');
    // A state_change announces the status flip so subscribers refresh.
    expect(events.some((ev) => ev.type === 'state_change')).toBe(true);
  });

  it('a failed roll consumes the action but leaves the ally bound', () => {
    const e = mkEngine([hero('rescuer', 0, 0), immobile('elara', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('rescuer'));
    const r = e.applyAction(
      asCharacterId('rescuer'),
      { kind: 'free_ally', targetId: asCharacterId('elara'), characteristic: 'melee', difficulty: 4 },
      { providedAbilityRoll: { roll: [1, 2, 3] } },
    );
    expect(r.ok).toBe(true);
    expect(e.charactersById().get(asCharacterId('elara'))?.health.status).toBe('immobilized');
    // Main action used — a second attack this turn is rejected.
    const again = e.applyAction(asCharacterId('rescuer'), { kind: 'normal_attack', targetId: asCharacterId('elara') });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('action-already-used');
  });

  it('rejects a non-immobilized target with not-immobilized', () => {
    const e = mkEngine([hero('rescuer', 0, 0), hero('h2', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('rescuer'));
    const r = e.applyAction(asCharacterId('rescuer'), { kind: 'free_ally', targetId: asCharacterId('h2'), characteristic: 'melee' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('not-immobilized');
  });

  it('rejects a non-adjacent immobilized ally with out-of-range', () => {
    const e = mkEngine([hero('rescuer', 0, 0), immobile('elara', 3, 0)]);
    e.beginNarrativeTurn(asCharacterId('rescuer'));
    const r = e.applyAction(asCharacterId('rescuer'), { kind: 'free_ally', targetId: asCharacterId('elara'), characteristic: 'melee' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('previewFreeAlly reports pool (1 + characteristic) and default DC 4', () => {
    const e = mkEngine([hero('rescuer', 0, 0), immobile('elara', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('rescuer'));
    const p = e.previewFreeAlly(asCharacterId('rescuer'), { kind: 'free_ally', targetId: asCharacterId('elara'), characteristic: 'melee' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ poolSize: 3, difficulty: 4 });
  });
});

describe('immobilized status', () => {
  it('a bound hero can be hurt but stays immobilized until lethal damage KOs them', () => {
    const bound = immobile('elara', 0, 0);
    const hurt = applyDamage(bound, 1);
    expect(hurt.health.status).toBe('immobilized');
    expect(hurt.health.damage).toBe(1);
    const dead = applyDamage(bound, 3);
    expect(dead.health.status).toBe('KO');
  });

  it('healDamage does not silently un-bind a bound hero', () => {
    const bound = { ...immobile('elara', 0, 0), health: { total: 3, damage: 1, status: 'immobilized' as const } };
    expect(healDamage(bound, 1).health.status).toBe('immobilized');
  });
});

describe('start_combat reserves a slot for a bound captive', () => {
  it('auto-includes an on-board immobilized hero the DM omitted from heroSide', () => {
    const e = mkEngine([hero('h1', 0, 0), immobile('elara', 5, 5), monster('rat', 6, 6)]);
    const r = e.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('h1')],
      monsterSide: [asCharacterId('rat')],
    });
    expect(r.ok).toBe(true);
    const started = e.flushEvents().find((ev) => ev.type === 'combat_started') as
      | { heroSide: unknown[]; order: unknown[] } | undefined;
    expect(started?.heroSide).toContain(asCharacterId('elara'));
    expect(started?.order).toContain(asCharacterId('elara'));
  });
});

// Minimal adventure + hero catalog for the captive-materialization path.
const healerEntry: HeroEntry = {
  id: 'healer',
  name: 'Healer',
  archetype: 'healer',
  pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
  dex: 1,
  healthTotal: 3,
  normalAttack: { kind: 'magic', name: 'Searing Light', range: 4, damageMod: 0 },
  specialAction: { effectId: 'healing-touch', name: 'Healing Touch', description: '' },
  bonusAbility: { effectId: 'potion-brewer', name: 'Potion Brewer', description: '' },
  defaultInventory: [],
  defaultSkills: ['knowledge'],
  sprite: 'healer',
};

const captiveAdventure: Adventure = {
  id: 'cap',
  title: 'Captive test',
  estimatedDurationMin: 1,
  scenes: [
    {
      id: 'cave',
      intro: '',
      map: {
        width: 6, height: 3, background: 'b',
        obstacles: [], decorations: [], exits: [], walls: false,
        npcs: [],
        entry: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
        captives: [{ archetype: 'healer', characterId: 'p3_healer', name: 'Elara', startPos: { x: 4, y: 1 } }],
      },
      monsters: [],
      tactics: '',
      abilityTests: [],
      conclusion: '',
      transitions: [],
    },
  ],
};

describe('set_scene materializes scene-declared captives', () => {
  it('places the captive as an immobilized hero and does not re-seat them at entry', () => {
    const scene = captiveAdventure.scenes[0]!;
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const e = new GameEngine({
      seed: 'test',
      grid: buildSceneGrid(scene),
      characters: [hero('h1', 5, 2)], // a mobile hero, to be re-seated at entry
      effects: reg,
      adventure: captiveAdventure,
      heroes: new Map([['healer', healerEntry]]),
    });
    const r = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId(scene.id) });
    expect(r.ok).toBe(true);
    const elara = e.charactersById().get(asCharacterId('p3_healer'));
    expect(elara).toBeDefined();
    expect(elara?.kind).toBe('hero');
    expect(elara?.health.status).toBe('immobilized');
    expect(elara?.pos).toEqual({ x: 4, y: 1 });
    // The mobile hero is re-seated at an entry cell; the captive is NOT moved.
    const h1 = e.charactersById().get(asCharacterId('h1'));
    expect([`0,1`, `1,1`]).toContain(`${h1?.pos?.x},${h1?.pos?.y}`);
  });
});
