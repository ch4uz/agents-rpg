import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asSceneId, asAdventureId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { MonsterEntry } from '../../src/engine/catalogs.js';
import type { Event } from '../../src/log/events.js';

const hero = (id: string, x: number, y: number): Character => ({
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
});

const giantRat: MonsterEntry = {
  id: 'giant-rat',
  name: 'Giant Rat',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
  healthTotal: 1,
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { effectId: 'pack-attack', name: 'Pack', description: '' },
  bonusAbility: { effectId: 'coward', name: 'Coward', description: '' },
  sprite: 'giant-rat',
};

/** Build an engine whose only scene has one obstacle at (4,4) — explosive or
 *  not, with the given durability — plus a rat adjacent to it at (5,4) and a
 *  rat far away at (6,6). Heroes keep their constructor positions (no `entry`). */
const makeEngine = (
  heroes: Character[],
  obstacle: { type: string; x: number; y: number; durability?: number; explosive?: { damage: number; radius: number } },
): GameEngine => {
  const grid = new Grid(
    Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  const monsters = new Map<string, MonsterEntry>([['giant-rat', giantRat]]);
  const adventure: Adventure = {
    id: asAdventureId('boom'),
    title: 'Boom',
    estimatedDurationMin: 5,
    scenes: [
      {
        id: asSceneId('boom-room'),
        intro: '',
        conclusion: '',
        map: {
          width: 8, height: 8, background: 'stub', walls: true, npcs: [],
          obstacles: [obstacle],
          decorations: [],
          exits: [],
        },
        monsters: [
          { type: 'giant-rat', startPos: { x: 5, y: 4 } },
          { type: 'giant-rat', startPos: { x: 6, y: 6 } },
        ],
        tactics: '',
        abilityTests: [],
        transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
      },
    ],
  };
  return new GameEngine({ seed: 'boom', grid, characters: heroes, effects: reg, adventure, monsters });
};

const enterAndSmash = (
  e: GameEngine,
  smasherId: string,
  roll: readonly number[] = [6],
): Event[] => {
  e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('boom-room') });
  e.flushEvents();
  e.beginNarrativeTurn(asCharacterId(smasherId));
  const r = e.applyAction(
    asCharacterId(smasherId),
    { kind: 'attack_object', pos: { x: 4, y: 4 } },
    { providedAbilityRoll: { roll } },
  );
  expect(r.ok).toBe(true);
  return e.flushEvents();
};

const hpDamage = (e: GameEngine, id: string): number =>
  e.charactersById().get(asCharacterId(id))!.health.damage;
const status = (e: GameEngine, id: string): string =>
  e.charactersById().get(asCharacterId(id))!.health.status;
const resolution = (events: Event[]): { public: Record<string, unknown> } =>
  events.find((ev) => ev.type === 'resolution') as unknown as { public: Record<string, unknown> };

describe('explosive obstacle (oil cask)', () => {
  it('blasts every creature within radius when destroyed — foes AND the smasher', () => {
    // h1 smashes from (3,4): distance 1 to the cask at (4,4) → catches its own blast.
    const e = makeEngine([hero('h1', 3, 4), hero('h2', 1, 1)], {
      type: 'oil-cask', x: 4, y: 4, durability: 1, explosive: { damage: 1, radius: 1 },
    });
    const events = enterAndSmash(e, 'h1');

    const res = resolution(events);
    expect(res.public.obstacleDestroyed).toEqual({ x: 4, y: 4 });
    const blast = res.public.blast as { pos: { x: number; y: number }; damage: number; radius: number; victimIds: string[] };
    expect(blast.pos).toEqual({ x: 4, y: 4 });
    expect(blast.damage).toBe(1);
    expect(blast.radius).toBe(1);
    // The adjacent rat (5,4) and the adjacent smasher h1 (3,4) are caught.
    expect(blast.victimIds).toEqual(expect.arrayContaining(['giant-rat-1', 'h1']));
    // The distant rat (6,6) and distant hero h2 (1,1) are NOT.
    expect(blast.victimIds).not.toContain('giant-rat-2');
    expect(blast.victimIds).not.toContain('h2');

    // Mechanical truth: adjacent creatures took 1 damage; the 1-HP rat is KO'd.
    expect(hpDamage(e, 'giant-rat-1')).toBe(1);
    expect(status(e, 'giant-rat-1')).toBe('KO');
    expect(hpDamage(e, 'h1')).toBe(1);
    expect(hpDamage(e, 'giant-rat-2')).toBe(0);
    expect(hpDamage(e, 'h2')).toBe(0);

    // A state_change event carries the blast HP changes.
    const sc = events.find((ev) => ev.type === 'state_change') as unknown as
      { changes: { id: string }[] } | undefined;
    expect(sc).toBeDefined();
    expect(sc!.changes.map((c) => c.id)).toEqual(expect.arrayContaining(['giant-rat-1', 'h1']));
  });

  it('does NOT blast on a non-breaking hit — a tough explosive must be fully smashed first', () => {
    const e = makeEngine([hero('h1', 3, 4)], {
      type: 'oil-cask', x: 4, y: 4, durability: 2, explosive: { damage: 1, radius: 1 },
    });
    const events = enterAndSmash(e, 'h1'); // first hit: durability 2 → 1, no break

    const res = resolution(events);
    expect(res.public.obstacleDestroyed).toBeUndefined();
    expect(res.public.obstacleDamaged).toBeDefined();
    expect(res.public.blast).toBeUndefined();
    expect(hpDamage(e, 'giant-rat-1')).toBe(0); // rat unharmed until the burst

    // Second hit breaks it and bursts.
    e.beginNarrativeTurn(asCharacterId('h1'));
    e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 4, y: 4 } },
      { providedAbilityRoll: { roll: [6] } });
    const events2 = e.flushEvents();
    expect(resolution(events2).public.blast).toBeDefined();
    expect(status(e, 'giant-rat-1')).toBe('KO');
  });

  it('a plain (non-explosive) obstacle destruction emits no blast — regression', () => {
    const e = makeEngine([hero('h1', 3, 4)], { type: 'barrel-stack', x: 4, y: 4, durability: 1 });
    const events = enterAndSmash(e, 'h1');
    const res = resolution(events);
    expect(res.public.obstacleDestroyed).toEqual({ x: 4, y: 4 });
    expect(res.public.blast).toBeUndefined();
    expect(hpDamage(e, 'giant-rat-1')).toBe(0);
  });

  it('exposes the explosive flag on the active obstacle list (so AI heroes can reason about it)', () => {
    const e = makeEngine([hero('h1', 3, 4)], {
      type: 'oil-cask', x: 4, y: 4, durability: 1, explosive: { damage: 1, radius: 1 },
    });
    e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('boom-room') });
    const cask = e.activeSceneObstacles().find((o) => o.x === 4 && o.y === 4);
    expect(cask?.explosive).toBe(true);
  });
});
