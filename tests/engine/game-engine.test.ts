import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid, type GridCell } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asBoonId } from '../../src/engine/ids.js';
import type { BoonEntry } from '../../src/engine/catalogs.js';
import { Dice } from '../../src/engine/dice.js';
import type { Character } from '../../src/engine/character.js';
import type { PlayerAction } from '../../src/engine/action.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import type { Adventure as AdventureType, Scene as SceneType } from '../../src/engine/adventure.js';

const makeEngine = (chars: Character[]): GameEngine => {
  const grid = new Grid(
    Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    ),
  );
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({
    seed: 'test',
    grid,
    characters: chars,
    effects: reg,
  });
};

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

describe('GameEngine skeleton', () => {
  it('say action emits action event and returns ok', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const result = e.applyAction(asCharacterId('h1'), { kind: 'say', text: 'hello world' });
    expect(result.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action')).toBeDefined();
  });

  it('emote action emits action event, does not end turn or consume slot', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const result = e.applyAction(asCharacterId('h1'), { kind: 'emote', emoji: '🙀' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.turnEnded).toBe(false);
    const events = e.flushEvents();
    const emoteEvent = events.find(
      (ev) =>
        ev.type === 'action' &&
        (ev as { action?: { kind?: string } }).action?.kind === 'emote',
    );
    expect(emoteEvent).toBeDefined();
    // Main action slot still available — a follow-up normal_attack must not
    // fail with action-already-used.
    const next = e.applyAction(asCharacterId('h1'), { kind: 'end_turn' });
    expect(next.ok).toBe(true);
  });

  it('emote rejects empty emoji as invalid-action-shape', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'emote', emoji: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  it('end_turn returns ok and signals turn end', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'end_turn' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.turnEnded).toBe(true);
  });

  it('skip_turn ends turn (human-only signal)', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'skip_turn' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.turnEnded).toBe(true);
  });

  it('rejects action when actor is not the active actor', () => {
    const e = makeEngine([hero('h1', 0, 0), hero('h2', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h2'), { kind: 'say', text: 'butting in' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('not-actors-turn');
  });
});

describe('GameEngine.move', () => {
  it('valid move updates character position and emits state_change', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(true);
    const c = e.charactersById().get(asCharacterId('h1'));
    expect(c?.pos).toEqual({ x: 2, y: 0 });
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'state_change')).toBeDefined();
  });

  it('rejects move exceeding 4 squares', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 4, y: 0 },
        { x: 5, y: 0 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('insufficient-movement');
  });

  it('rejects move ending on enemy', () => {
    const enemy: Character = { ...hero('m1', 2, 0), kind: 'monster' };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects discontinuous path (non-adjacent steps)', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 4, y: 4 }],
    });
    expect(r.ok).toBe(false);
  });

  it('allows walking through and onto a KO\'d enemy corpse', () => {
    const koEnemy: Character = {
      ...hero('m1', 2, 0),
      kind: 'monster',
      health: { total: 1, damage: 1, status: 'KO' },
    };
    const e = makeEngine([hero('h1', 0, 0), koEnemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    // End ON the corpse cell — should succeed (corpse doesn't block).
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(true);
  });

  it('allows walking through a KO\'d ally corpse on an intermediate step', () => {
    const koAlly = { ...hero('h2', 1, 0),
      health: { total: 1, damage: 1, status: 'KO' as const } };
    const e = makeEngine([hero('h1', 0, 0), koAlly]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    // Pass through the corpse and end past it.
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects walking THROUGH a live ally on an intermediate step', () => {
    // A living teammate blocks the path — a hero cannot pass through it.
    const e = makeEngine([hero('h1', 0, 0), hero('h2', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects move ending on a live ally', () => {
    const e = makeEngine([hero('h1', 0, 0), hero('h2', 2, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });
});

describe('GameEngine.normal_attack', () => {
  it('rejects attack on out-of-range target (melee, non-adjacent)', () => {
    const enemy: Character = { ...hero('m1', 5, 5), kind: 'monster' };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack',
      targetId: asCharacterId('m1'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('rejects attack on unknown target', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack',
      targetId: asCharacterId('ghost'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unknown-id');
  });

  it('valid melee attack emits action + resolution events', () => {
    const enemy: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
      health: { total: 1, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack',
      targetId: asCharacterId('m1'),
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action')).toBeDefined();
    const resolution = events.find((ev) => ev.type === 'resolution');
    expect(resolution).toBeDefined();
    // attackKind is emitted so the browser projectile layer can pick a sprite
    // without re-deriving it from the actor's normalAttack.
    expect((resolution as { public: { attackKind?: string } }).public.attackKind)
      .toBe('melee');
  });

  it('attack against KO target rejected as invalid-target', () => {
    const dead: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      health: { total: 1, damage: 1, status: 'KO' },
    };
    const e = makeEngine([hero('h1', 0, 0), dead]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack',
      targetId: asCharacterId('m1'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  /**
   * Friendly fire is allowed at the engine level. The DM may NARRATIVELY
   * choose to dissuade or moralize, but the engine must not invent a
   * friendly-fire rule that doesn't exist in the spec — players have agency,
   * the DM doesn't get to lawyer-ban actions during interp.
   */
  it('friendly fire is engine-allowed: ally hero is a valid normal_attack target', () => {
    const ally: Character = {
      ...hero('h2', 1, 0),
      // Same kind ('hero') as h1 → friendly fire scenario.
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      health: { total: 3, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), ally]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack',
      targetId: asCharacterId('h2'),
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action')).toBeDefined();
    expect(events.find((ev) => ev.type === 'resolution')).toBeDefined();
  });
});

import { asItemId } from '../../src/engine/ids.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE_USE_ITEM = dirname(fileURLToPath(import.meta.url));
const REPO_USE_ITEM = join(HERE_USE_ITEM, '..', '..');
const catalogs_for_use_item = await loadCatalogs(join(REPO_USE_ITEM, 'data'));

const makeEngineWithItems = (chars: Character[]): GameEngine => {
  const grid = new Grid(
    Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    ),
  );
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({
    seed: 'test',
    grid,
    characters: chars,
    effects: reg,
    items: catalogs_for_use_item.items,
  });
};

describe('GameEngine.use_boon', () => {
  it('use_boon dispatches the boon effect via registry', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    // Register a fixture-only boon that heals 1 to the actor.
    reg.register('fixture-boon-heal', {
      kind: 'boon',
      apply: ({ actor }) => ({
        changes: [{ kind: 'heal', characterId: actor.id, amount: 1 }],
        narration: `${actor.name} invokes a healing boon.`,
      }),
    });

    const grid = new Grid(
      Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
    );

    const hero: Character = {
      id: asCharacterId('h'),
      name: 'Hero',
      kind: 'hero',
      archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 2, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility: { id: asEffectId('teamwork'), name: '', description: '' },
      inventory: [],
      boons: [asBoonId('fixture-heal-boon')],
      skills: [],
    };

    const boonsMap = new Map<string, BoonEntry>([
      ['fixture-heal-boon', { id: 'fixture-heal-boon', name: 'Test Boon', description: '', effectId: 'fixture-boon-heal', icon: 'b' }],
    ]);

    const engine = new GameEngine({ seed: 's', grid, characters: [hero], effects: reg, boons: boonsMap });
    engine.beginNarrativeTurn(asCharacterId('h'));

    const result = engine.applyAction(asCharacterId('h'), {
      kind: 'use_boon',
      boonId: asBoonId('fixture-heal-boon'),
    });
    expect(result.ok).toBe(true);

    const heroAfter = engine.charactersById().get(asCharacterId('h'))!;
    expect(heroAfter.health.damage).toBe(1); // healed 1
    expect(heroAfter.boons).toEqual([]); // boon removed from inventory
  });
});

describe('GameEngine.use_item', () => {
  it('use potion heals target to full', () => {
    const wounded: Character = {
      ...hero('h1', 0, 0),
      inventory: [{ itemId: asItemId('potion'), count: 1 }],
      health: { total: 3, damage: 2, status: 'normal' },
    };
    const e = makeEngineWithItems([wounded]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'use_item',
      itemId: asItemId('potion'),
      targetId: asCharacterId('h1'),
    });
    expect(r.ok).toBe(true);
    const c = e.charactersById().get(asCharacterId('h1'));
    expect(c?.health.damage).toBe(0);
    expect(c?.inventory.find((s) => s.itemId === 'potion')).toBeUndefined();
  });

  it('rejects use_item when actor does not have the item', () => {
    const noItems: Character = { ...hero('h1', 0, 0), inventory: [] };
    const e = makeEngineWithItems([noItems]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'use_item',
      itemId: asItemId('potion'),
      targetId: asCharacterId('h1'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unknown-id');
  });
});

describe('GameEngine.special_action', () => {
  it('special_action heals when the registered effect emits a heal change', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );

    const healer: Character = {
      id: asCharacterId('h-healer'),
      name: 'Healer',
      kind: 'hero',
      archetype: 'healer',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 1, y: 1 },
      normalAttack: { kind: 'magic', name: 'Searing Light', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('healing-touch'), name: 'Healing Touch', description: '' },
      bonusAbility: { id: asEffectId('potion-brewer'), name: 'Potion Brewer', description: '' },
      inventory: [],
      boons: [],
      skills: [],
    };
    const ally: Character = {
      ...healer,
      id: asCharacterId('h-ally'),
      name: 'Hunter',
      archetype: 'hunter',
      pos: { x: 1, y: 2 },
      health: { total: 3, damage: 2, status: 'normal' },
      specialAction: { id: asEffectId('split-shot'), name: '', description: '' },
      bonusAbility: { id: asEffectId('evasive-maneuver'), name: '', description: '' },
    };

    const engine = new GameEngine({ seed: 's', grid, characters: [healer, ally], effects: reg });
    engine.beginNarrativeTurn(asCharacterId('h-healer'));

    const result = engine.applyAction(asCharacterId('h-healer'), {
      kind: 'special_action',
      targetIds: [asCharacterId('h-ally')],
    });
    expect(result.ok).toBe(true);

    const events = engine.flushEvents();
    const stateChange = events.find((e) => e.type === 'state_change');
    expect(stateChange).toBeDefined();

    // Ally went from 2 damage to 1 damage.
    const allyAfter = engine.charactersById().get(asCharacterId('h-ally'))!;
    expect(allyAfter.health.damage).toBe(1);
  });
});

import { asEquipmentId } from '../../src/engine/ids.js';

describe('GameEngine.ability_test', () => {
  it('emits action + resolution events', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'ability_test',
      characteristic: 'melee',
      difficulty: 4,
      describe: 'I shove the door open',
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action')).toBeDefined();
    expect(events.find((ev) => ev.type === 'resolution')).toBeDefined();
  });
});

describe('GameEngine.equip', () => {
  it('rejects equip during combat phase', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    // Force combat phase via the public turn API.
    e.turn.startCombat(new Dice('x'), [asCharacterId('h1')], []);
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'equip',
      equipmentId: asEquipmentId('raiders-battleaxe'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('wrong-phase');
  });
});

describe('GameEngine.applyDmAction', () => {
  it('narrate emits action event', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'narrate', text: 'You enter a damp cellar.' });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'narrate')).toBeDefined();
  });

  it('start_combat rolls initiative and transitions phase', () => {
    const enemy: Character = { ...hero('m1', 5, 5), kind: 'monster' };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    const r = e.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('h1')],
      monsterSide: [asCharacterId('m1')],
    });
    expect(r.ok).toBe(true);
    expect(e.turn.phase).toBe('combat');
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'combat_started')).toBeDefined();
  });

  it('end_combat returns to narrative', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('h1')],
      monsterSide: [],
    });
    e.flushEvents();
    const r = e.applyDmAction({ kind: 'end_combat' });
    expect(r.ok).toBe(true);
    expect(e.turn.phase).toBe('narrative');
  });

  it('request_action sets the narrative active actor', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'request_action', actorId: asCharacterId('h1') });
    expect(r.ok).toBe(true);
    expect(e.turn.activeActorId).toBe('h1');
  });
});

describe('GameEngine.applyDmAction monster_action (DM puppets monsters)', () => {
  const monster = (id: string, x: number, y: number): Character =>
    ({ ...hero(id, x, y), kind: 'monster' });

  /** Start combat, then spin the combat cursor until `id` is the active actor. */
  const advanceTo = (e: GameEngine, id: string): void => {
    let guard = 0;
    while (e.turn.activeActorId !== asCharacterId(id) && guard < 16) {
      e.turn.advance(() => true);
      guard += 1;
    }
    expect(e.turn.activeActorId).toBe(id);
  };

  it('accepts a monster_action on the active monster and tags it interpretedBy:dm', () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [asCharacterId('m1')] });
    e.flushEvents();
    advanceTo(e, 'm1');

    const r = e.applyDmAction({ kind: 'monster_action', monsterId: asCharacterId('m1'), action: { kind: 'normal_attack', targetId: asCharacterId('h1') } });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    const act = events.find((ev) => ev.type === 'action' && (ev as { actorId: string }).actorId === 'm1') as unknown as { interpretedBy?: string };
    expect(act?.interpretedBy).toBe('dm');
    expect(events.find((ev) => ev.type === 'resolution')).toBeDefined();
  });

  it('rejects monster_action targeting a non-monster (invalid-target)', () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [asCharacterId('m1')] });
    e.flushEvents();
    const r = e.applyDmAction({ kind: 'monster_action', monsterId: asCharacterId('h1'), action: { kind: 'end_turn' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects monster_action outside combat (wrong-phase)', () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    const r = e.applyDmAction({ kind: 'monster_action', monsterId: asCharacterId('m1'), action: { kind: 'end_turn' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('wrong-phase');
  });

  it("rejects monster_action when it is not that monster's turn (not-actors-turn)", () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [asCharacterId('m1')] });
    e.flushEvents();
    advanceTo(e, 'h1'); // hero is up, not the monster
    const r = e.applyDmAction({ kind: 'monster_action', monsterId: asCharacterId('m1'), action: { kind: 'end_turn' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('not-actors-turn');
  });

  it('rejects a disallowed inner action (say) for a monster (invalid-action-shape)', () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [asCharacterId('m1')] });
    e.flushEvents();
    advanceTo(e, 'm1');
    const r = e.applyDmAction({ kind: 'monster_action', monsterId: asCharacterId('m1'), action: { kind: 'say', text: 'squeak' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  // Regression: the monster_action / npc_action tool schemas leave the nested
  // `action` object unconstrained, so the DM can emit a `move` with no `path`.
  // This used to reach handleMove's `path.length` and crash the whole session
  // with an uncaught TypeError (run 2026-05-31T16-18-06, giant-rat-3's turn).
  // It must now be a recoverable RuleViolation instead.
  it('rejects a monster move with a missing path as invalid-action-shape (no throw)', () => {
    const e = makeEngine([hero('h1', 0, 0), monster('m1', 1, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [asCharacterId('m1')] });
    e.flushEvents();
    advanceTo(e, 'm1');
    const r = e.applyDmAction({
      kind: 'monster_action',
      monsterId: asCharacterId('m1'),
      // path deliberately omitted — mirrors a malformed DM tool call
      action: { kind: 'move' } as unknown as PlayerAction,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });
});

describe('end_combat phase gate', () => {
  it('returns wrong-phase rule violation when not in combat', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'end_combat' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('wrong-phase');
  });

  it('emits exactly one combat_ended when end_combat is called twice in a row', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [] });
    e.flushEvents();
    const r1 = e.applyDmAction({ kind: 'end_combat' });
    expect(r1.ok).toBe(true);
    const r2 = e.applyDmAction({ kind: 'end_combat' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('wrong-phase');
    const events = e.flushEvents();
    expect(events.filter((ev) => ev.type === 'combat_ended').length).toBe(1);
  });
});

import { asSceneId, asAdventureId } from '../../src/engine/ids.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { MonsterEntry } from '../../src/engine/catalogs.js';

const makeEngineWithCatalog = (): GameEngine => {
  const grid = new Grid(
    Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    ),
  );
  const reg = new EffectRegistry();
  registerCoreEffects(reg);

  const giantRat: MonsterEntry = {
    id: 'giant-rat',
    name: 'Giant Rat',
    pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 1,
    normalAttack: { kind: 'melee', name: 'Horrid Bite', range: 1, damageMod: 0 },
    specialAction: { effectId: 'pack-attack', name: 'Pack Attack', description: '' },
    bonusAbility: { effectId: 'coward', name: 'Coward', description: '' },
    sprite: 'giant-rat',
  };
  const monsters = new Map<string, MonsterEntry>([['giant-rat', giantRat]]);

  const adventure: Adventure = {
    id: asAdventureId('stub-adventure'),
    title: 'Stub',
    estimatedDurationMin: 5,
    scenes: [
      {
        id: asSceneId('stub-cell-b'),
        intro: '',
        conclusion: '',
        map: { width: 8, height: 8, background: 'stub-cell-b', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [
          { type: 'giant-rat', startPos: { x: 5, y: 2 } },
          { type: 'giant-rat', startPos: { x: 6, y: 2 } },
          { type: 'giant-rat', startPos: { x: 5, y: 5 } },
        ],
        tactics: '',
        abilityTests: [],
        transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
      },
    ],
  };

  return new GameEngine({
    seed: 'reveal-test',
    grid,
    characters: [hero('h1', 0, 0)],
    effects: reg,
    adventure,
    monsters,
  });
};

describe('set_scene auto-reveals declared monsters', () => {
  it('adds monsters with deterministic IDs to engine.characters when set_scene is called', () => {
    const e = makeEngineWithCatalog();
    const r = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    const ids = Array.from(e.charactersById().keys());
    expect(ids).toContain(asCharacterId('giant-rat-1'));
    expect(ids).toContain(asCharacterId('giant-rat-2'));
    expect(ids).toContain(asCharacterId('giant-rat-3'));

    // Each materialized monster sits at the scene's declared startPos.
    expect(e.charactersById().get(asCharacterId('giant-rat-1'))?.pos).toEqual({ x: 5, y: 2 });
    expect(e.charactersById().get(asCharacterId('giant-rat-2'))?.pos).toEqual({ x: 6, y: 2 });
    expect(e.charactersById().get(asCharacterId('giant-rat-3'))?.pos).toEqual({ x: 5, y: 5 });

    // scene_enter is emitted plus a reveal_monster action per scene-declared monster.
    expect(events.filter((ev) => ev.type === 'scene_enter').length).toBe(1);
    const reveals = events.filter((ev) => ev.type === 'action'
      && (ev as unknown as { action: { kind: string } }).action.kind === 'reveal_monster');
    expect(reveals.length).toBe(3);
  });

  it('returns unknown-id when set_scene targets a scene not in the adventure', () => {
    const e = makeEngineWithCatalog();
    const r = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('does-not-exist') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('unknown-id');
      if (r.error.reason === 'unknown-id') expect(r.error.what).toBe('scene');
    }
  });

  it('is idempotent — a second set_scene for the same scene is a no-op', () => {
    const e = makeEngineWithCatalog();
    const r1 = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    expect(r1.ok).toBe(true);
    const firstEvents = e.flushEvents();
    expect(firstEvents.filter((ev) => ev.type === 'scene_enter').length).toBe(1);
    const firstMonsterCount = Array.from(e.charactersById().values())
      .filter((c) => c.kind === 'monster').length;
    expect(firstMonsterCount).toBe(3);

    // Re-enter the same scene — must succeed silently, no duplicate events,
    // and the monster roster stays exactly as it was (no collision error).
    const r2 = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    expect(r2.ok).toBe(true);
    const secondEvents = e.flushEvents();
    expect(secondEvents.length).toBe(0);
    const secondMonsterCount = Array.from(e.charactersById().values())
      .filter((c) => c.kind === 'monster').length;
    expect(secondMonsterCount).toBe(3);
  });
});

describe('activeMonsterFocus', () => {
  const makeFocusEngine = (): GameEngine => {
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const adventure: Adventure = {
      id: asAdventureId('focus-adv'), title: 'Focus', estimatedDurationMin: 5,
      scenes: [
        {
          id: asSceneId('focused'), intro: '', conclusion: '', tactics: '', abilityTests: [],
          map: { width: 6, height: 6, background: 'b', obstacles: [], decorations: [], exits: [], walls: false, npcs: [] },
          monsters: [],
          monsterFocus: { characterId: 'victim', fromRound: 2 },
          transitions: [{ to: 'plain', trigger: 'manual' }],
        },
        {
          id: asSceneId('plain'), intro: '', conclusion: '', tactics: '', abilityTests: [],
          map: { width: 6, height: 6, background: 'b', obstacles: [], decorations: [], exits: [], walls: false, npcs: [] },
          monsters: [],
          transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
        },
      ],
    };
    return new GameEngine({ seed: 'focus', grid, characters: [hero('h1', 0, 0)], effects: reg, adventure });
  };

  it('returns null before any scene is entered', () => {
    expect(makeFocusEngine().activeMonsterFocus()).toBeNull();
  });

  it('returns the active scene\'s focus directive once entered', () => {
    const e = makeFocusEngine();
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('focused') }).ok).toBe(true);
    expect(e.activeMonsterFocus()).toEqual({ characterId: 'victim', fromRound: 2 });
  });

  it('returns null on a scene that declares no focus (and after leaving a focused one)', () => {
    const e = makeFocusEngine();
    e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('focused') });
    e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('plain') });
    expect(e.activeMonsterFocus()).toBeNull();
  });
});

describe('set_scene seats heroes at the declared entry cells', () => {
  const ratEntry: MonsterEntry = {
    id: 'giant-rat', name: 'Giant Rat', pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 1, normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
    specialAction: { effectId: 'pack-attack', name: 'Pack', description: '' },
    bonusAbility: { effectId: 'coward', name: 'Coward', description: '' }, sprite: 'giant-rat',
  };

  const makeEngineEntry = (
    heroes: Character[],
    entry: { x: number; y: number }[] | undefined,
    sceneMonsters: { type: string; startPos: { x: number; y: number } }[] = [],
  ): GameEngine => {
    const grid = new Grid(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const adventure: Adventure = {
      id: asAdventureId('seat-adv'), title: 'Seat', estimatedDurationMin: 5,
      scenes: [{
        id: asSceneId('cave'), intro: '', conclusion: '', tactics: '', abilityTests: [],
        map: {
          width: 8, height: 8, background: 'cave', obstacles: [], decorations: [],
          exits: [], walls: false, npcs: [], ...(entry ? { entry } : {}),
        },
        monsters: sceneMonsters,
        transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
      }],
    };
    return new GameEngine({
      seed: 'seat', grid, characters: heroes, effects: reg, adventure,
      monsters: new Map([['giant-rat', ratEntry]]),
    });
  };

  it('moves heroes (sorted by id) onto the declared entry cells on fresh entry', () => {
    // Heroes start far from the entry and OUT of id order.
    const e = makeEngineEntry(
      [hero('p2', 7, 7), hero('p1', 6, 6)],
      [{ x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 }],
    );
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('cave') }).ok).toBe(true);
    // Sorted by id: p1 → entry[0], p2 → entry[1].
    expect(e.charactersById().get(asCharacterId('p1'))?.pos).toEqual({ x: 1, y: 4 });
    expect(e.charactersById().get(asCharacterId('p2'))?.pos).toEqual({ x: 1, y: 5 });
  });

  it('skips an entry cell occupied by a revealed monster and seats the hero on the next candidate', () => {
    // entry[0] = (5,2) collides with the auto-revealed giant-rat-1 startPos.
    const e = makeEngineEntry(
      [hero('p1', 0, 0)],
      [{ x: 5, y: 2 }, { x: 1, y: 5 }],
      [{ type: 'giant-rat', startPos: { x: 5, y: 2 } }],
    );
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('cave') }).ok).toBe(true);
    // The hero can't take (5,2) (rat there) → falls through to entry[1] = (1,5).
    expect(e.charactersById().get(asCharacterId('p1'))?.pos).toEqual({ x: 1, y: 5 });
  });

  it('leaves hero positions untouched when the scene declares no entry (legacy behaviour)', () => {
    const e = makeEngineEntry([hero('p1', 3, 3)], undefined);
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('cave') }).ok).toBe(true);
    expect(e.charactersById().get(asCharacterId('p1'))?.pos).toEqual({ x: 3, y: 3 });
  });
});

describe('set_scene drops the previous scene monsters before revealing the next', () => {
  const ratEntry: MonsterEntry = {
    id: 'giant-rat', name: 'Giant Rat', pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 1, normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
    specialAction: { effectId: 'pack-attack', name: 'Pack', description: '' },
    bonusAbility: { effectId: 'coward', name: 'Coward', description: '' }, sprite: 'giant-rat',
  };
  const kingEntry: MonsterEntry = {
    id: 'king-rat', name: 'King Rat', pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 3, normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
    specialAction: { effectId: 'pack-attack', name: 'Pack', description: '' },
    bonusAbility: { effectId: 'coward', name: 'Coward', description: '' }, sprite: 'king-rat',
  };
  const make2Scene = (heroes: Character[]): GameEngine => {
    const grid = new Grid(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const adventure: Adventure = {
      id: asAdventureId('two-scene'), title: 'Two', estimatedDurationMin: 5,
      scenes: [
        {
          id: asSceneId('a'), intro: '', conclusion: '', tactics: '', abilityTests: [],
          map: { width: 8, height: 8, background: 'a', obstacles: [], decorations: [], exits: [], walls: false, npcs: [] },
          monsters: [
            { type: 'giant-rat', startPos: { x: 5, y: 2 } },
            { type: 'giant-rat', startPos: { x: 6, y: 2 } },
          ],
          transitions: [{ to: 'b', trigger: 'all-monsters-ko' }],
        },
        {
          id: asSceneId('b'), intro: '', conclusion: '', tactics: '', abilityTests: [],
          map: {
            width: 8, height: 8, background: 'b', obstacles: [], decorations: [], exits: [],
            walls: false, npcs: [], entry: [{ x: 1, y: 4 }, { x: 1, y: 5 }, { x: 1, y: 6 }],
          },
          // Same `giant-rat` type → would reuse ids giant-rat-1.. that collide
          // with scene A's, plus a boss new to this scene.
          monsters: [
            { type: 'king-rat', startPos: { x: 7, y: 7 } },
            { type: 'giant-rat', startPos: { x: 6, y: 6 } },
          ],
          transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
        },
      ],
    };
    return new GameEngine({
      seed: 'two', grid, characters: heroes, effects: reg, adventure,
      monsters: new Map([['giant-rat', ratEntry], ['king-rat', kingEntry]]),
    });
  };

  it('clears scene-A monsters so scene-B reveal does not collide, and re-seats heroes at scene-B entry', () => {
    const e = make2Scene([hero('p1', 3, 3)]);
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('a') }).ok).toBe(true);
    e.flushEvents();
    // Scene A revealed giant-rat-1 + giant-rat-2.
    const aMonsters = Array.from(e.charactersById().values())
      .filter((c) => c.kind === 'monster').map((c) => String(c.id)).sort();
    expect(aMonsters).toEqual(['giant-rat-1', 'giant-rat-2']);

    // Transition to B. Before the fix this returned ok:false (giant-rat-1
    // id collision), which also skipped the entry re-seating.
    const r = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('b') });
    expect(r.ok).toBe(true);

    // Scene A's monsters are gone; only scene B's are present (no leftovers).
    const bMonsters = Array.from(e.charactersById().values())
      .filter((c) => c.kind === 'monster').map((c) => String(c.id)).sort();
    expect(bMonsters).toEqual(['giant-rat-1', 'king-rat-1']);

    // The hero was re-seated at scene B's entry (not stranded on its scene-A pos).
    expect(e.charactersById().get(asCharacterId('p1'))?.pos).toEqual({ x: 1, y: 4 });
  });
});

describe('reveal_monster id uniqueness', () => {
  it('rejects a reveal that collides with an existing character id', () => {
    const e = makeEngineWithCatalog();
    const r0 = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    expect(r0.ok).toBe(true);
    e.flushEvents();

    const r = e.applyDmAction({
      kind: 'reveal_monster',
      monsterTypeId: 'giant-rat',
      characterId: asCharacterId('giant-rat-1'),
      pos: { x: 0, y: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  it('reveal_monster materializes a fresh monster from the catalog and emits the action event', () => {
    const e = makeEngineWithCatalog();
    const r = e.applyDmAction({
      kind: 'reveal_monster',
      monsterTypeId: 'giant-rat',
      characterId: asCharacterId('giant-rat-99'),
      pos: { x: 7, y: 7 },
    });
    expect(r.ok).toBe(true);
    const newby = e.charactersById().get(asCharacterId('giant-rat-99'));
    expect(newby).toBeDefined();
    expect(newby?.kind).toBe('monster');
    expect(newby?.pos).toEqual({ x: 7, y: 7 });
    const events = e.flushEvents();
    const reveal = events.find((ev) => ev.type === 'action'
      && (ev as unknown as { action: { kind: string } }).action.kind === 'reveal_monster');
    expect(reveal).toBeDefined();
  });

  it('reveal_monster returns unknown-id when type is not in the catalog', () => {
    const e = makeEngineWithCatalog();
    const r = e.applyDmAction({
      kind: 'reveal_monster',
      monsterTypeId: 'no-such-type',
      characterId: asCharacterId('mystery-1'),
      pos: { x: 0, y: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unknown-id');
  });
});

/**
 * HeroKids per-turn action economy: at most 1 move and 1 main action per turn.
 * Main action ∈ {normal_attack, special_action, ability_test, consumable use_item}.
 * say / use_boon / equip / utility use_item / end_turn / skip_turn are free.
 */
describe('per-turn action economy: 1 move + 1 main action', () => {
  it('move + normal_attack in the same turn is allowed', () => {
    const enemy: Character = {
      ...hero('m1', 2, 0),
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 1, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const m = e.applyAction(asCharacterId('h1'), {
      kind: 'move',
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    });
    expect(m.ok).toBe(true);
    const a = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(a.ok).toBe(true);
  });

  it('rejects a second move with already-moved', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const m1 = e.applyAction(asCharacterId('h1'), {
      kind: 'move', path: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    });
    expect(m1.ok).toBe(true);
    const m2 = e.applyAction(asCharacterId('h1'), {
      kind: 'move', path: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(m2.ok).toBe(false);
    if (!m2.ok) expect(m2.error.reason).toBe('already-moved');
  });

  it('rejects a second normal_attack with action-already-used', () => {
    const enemy: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 9, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const a1 = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(a1.ok).toBe(true);
    const a2 = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(a2.ok).toBe(false);
    if (!a2.ok) expect(a2.error.reason).toBe('action-already-used');
  });

  it('normal_attack and special_action are mutually exclusive (both share the action slot)', () => {
    const enemy: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 9, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const a1 = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(a1.ok).toBe(true);
    const sa = e.applyAction(asCharacterId('h1'), {
      kind: 'special_action', targetIds: [asCharacterId('m1')],
    });
    expect(sa.ok).toBe(false);
    if (!sa.ok) expect(sa.error.reason).toBe('action-already-used');
  });

  it('say does not consume the action slot', () => {
    const enemy: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 1, damage: 0, status: 'normal' },
    };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const said = e.applyAction(asCharacterId('h1'), { kind: 'say', text: 'En garde!' });
    expect(said.ok).toBe(true);
    const a = e.applyAction(asCharacterId('h1'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(a.ok).toBe(true);
  });

  it('flags reset between narrative-actor turns', () => {
    const e = makeEngine([hero('h1', 0, 0), hero('h2', 5, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const m1 = e.applyAction(asCharacterId('h1'), {
      kind: 'move', path: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    });
    expect(m1.ok).toBe(true);

    e.beginNarrativeTurn(asCharacterId('h2'));
    const m2 = e.applyAction(asCharacterId('h2'), {
      kind: 'move', path: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
    });
    expect(m2.ok).toBe(true); // flags reset → h2 can move on its own turn
  });

  it('rejecting a use_item for utility category leaves the action slot intact', () => {
    // Hunter starts with rope (utility). Trying to use_item rejects with
    // invalid-action-shape and must NOT consume the main action slot, so the
    // hunter can still attack on the same turn.
    const huntr: Character = {
      ...hero('hu', 0, 0),
      archetype: 'hunter',
      normalAttack: { kind: 'ranged', name: 'bow', range: 6, damageMod: 0 },
      pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
      inventory: [{ itemId: asItemId('rope'), count: 1 }],
    };
    const enemy: Character = {
      ...hero('m1', 3, 0), kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 1, damage: 0, status: 'normal' },
    };
    const e = makeEngineWithItems([huntr, enemy]);
    e.beginNarrativeTurn(asCharacterId('hu'));
    const utility = e.applyAction(asCharacterId('hu'), {
      kind: 'use_item', itemId: asItemId('rope'),
    });
    expect(utility.ok).toBe(false);
    if (!utility.ok) expect(utility.error.reason).toBe('invalid-action-shape');
    const atk = e.applyAction(asCharacterId('hu'), {
      kind: 'normal_attack', targetId: asCharacterId('m1'),
    });
    expect(atk.ok).toBe(true); // utility-item rejection didn't burn the action
  });
});

describe('teamwork bonus passive', () => {
  it('hero gains +1 die when attacking an engaged target', () => {
    // Two heroes adjacent to one rat. Warrior attacks; teamwork should add +1
    // attack die. We pin the dice seed and assert the attack roll length.
    const engine = makeEngine([
      { ...hero('h1', 0, 0), pools: { melee: 2, ranged: 0, magic: 0, armor: 2 } },
      hero('h2', 1, 1),
      { ...hero('m1', 1, 0), kind: 'monster' as const, name: 'Rat',
        pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
        health: { total: 1, damage: 0, status: 'normal' as const } },
    ]);
    engine.beginNarrativeTurn(asCharacterId('h1'));
    const r = engine.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    // melee 2 + teamwork +1 = 3 dice
    expect(resolution.private.attackRoll.length).toBe(3);
  });

  it('hero does NOT gain +1 die when target is not engaged (lone attacker)', () => {
    const engine = makeEngine([
      hero('h1', 0, 0),
      { ...hero('m1', 1, 0), kind: 'monster' as const, name: 'Rat',
        pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
        health: { total: 1, damage: 0, status: 'normal' as const } },
    ]);
    engine.beginNarrativeTurn(asCharacterId('h1'));
    const r = engine.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(2);
  });

  it('emits a passive_triggered banner event when Teamwork fires', () => {
    const engine = makeEngine([
      { ...hero('h1', 0, 0), pools: { melee: 2, ranged: 0, magic: 0, armor: 2 } },
      hero('h2', 1, 1),
      { ...hero('m1', 1, 0), kind: 'monster' as const, name: 'Rat',
        pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
        health: { total: 1, damage: 0, status: 'normal' as const } },
    ]);
    engine.beginNarrativeTurn(asCharacterId('h1'));
    engine.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    const events = engine.flushEvents();
    const banner = events.find((e) => e.type === 'passive_triggered') as unknown as
      { actorId: string; abilityName: string; effect: string } | undefined;
    expect(banner).toBeDefined();
    expect(banner!.actorId).toBe('h1');
    expect(banner!.abilityName).toBe('TW');
    expect(banner!.effect).toBe('+1 attack die');
  });
});

describe('power-surge bonus passive (Warlock)', () => {
  // Warlock at (0,0), target rat at (3,0) — magic range 4, distance 3 (NOT
  // adjacent, so the warlock has no adjacency penalty), clear LoS on open floor.
  const warlock = (id: string, x: number, y: number, damage: number): Character => ({
    ...hero(id, x, y),
    archetype: 'warlock',
    pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
    health: { total: 2, damage, status: 'normal' },
    normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
    bonusAbility: { id: asEffectId('power-surge'), name: 'Power Surge', description: '' },
  });
  const rat = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y), kind: 'monster', name: 'Rat',
    pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
    health: { total: 2, damage: 0, status: 'normal' },
  });

  it('wounded warlock gains +1 magic die and emits a banner', () => {
    const engine = makeEngine([warlock('w1', 0, 0, 1), rat('m1', 3, 0)]);
    engine.beginNarrativeTurn(asCharacterId('w1'));
    engine.applyAction(asCharacterId('w1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(3); // magic 2 + power-surge 1
    const banner = events.find((e) => e.type === 'passive_triggered') as unknown as { abilityName: string } | undefined;
    expect(banner?.abilityName).toBe('Power Surge');
  });

  it('full-health warlock gets no bonus and no banner', () => {
    const engine = makeEngine([warlock('w1', 0, 0, 0), rat('m1', 3, 0)]);
    engine.beginNarrativeTurn(asCharacterId('w1'));
    engine.applyAction(asCharacterId('w1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(2);
    expect(events.find((e) => e.type === 'passive_triggered')).toBeUndefined();
  });
});

describe('tangled bonus passive (Healer defending melee)', () => {
  const healer = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y),
    archetype: 'healer',
    pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
    health: { total: 2, damage: 0, status: 'normal' },
    normalAttack: { kind: 'magic', name: 'Light', range: 4, damageMod: 0 },
    bonusAbility: { id: asEffectId('tangled'), name: 'Tangled', description: '' },
  });
  const meleeRat = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y), kind: 'monster', name: 'Rat',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 0 },
    health: { total: 2, damage: 0, status: 'normal' },
    normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  });
  const rangedRat = (id: string, x: number, y: number): Character => ({
    ...meleeRat(id, x, y),
    pools: { melee: 0, ranged: 2, magic: 0, armor: 0 },
    normalAttack: { kind: 'ranged', name: 'Spit', range: 6, damageMod: 0 },
  });

  it('healer gains +1 armor die vs a melee attack, with a banner on the defender', () => {
    const engine = makeEngine([healer('h1', 0, 0), meleeRat('m1', 1, 0)]);
    const pools = engine.previewNormalAttackPools(asCharacterId('m1'), asCharacterId('h1'));
    expect(pools.ok && pools.value.defenderArmorPoolSize).toBe(2); // armor 1 + tangled 1

    engine.beginNarrativeTurn(asCharacterId('m1'));
    engine.applyAction(asCharacterId('m1'), { kind: 'normal_attack', targetId: asCharacterId('h1') });
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as unknown as { private: { armorRoll: number[] } };
    expect(resolution.private.armorRoll.length).toBe(2);
    const banner = events.find((e) => e.type === 'passive_triggered') as unknown as
      { actorId: string; abilityName: string; effect: string } | undefined;
    expect(banner?.actorId).toBe('h1');
    expect(banner?.abilityName).toBe('Tangled');
    expect(banner?.effect).toBe('+1 armor die');
  });

  it('healer gets NO armor bonus vs a ranged attack', () => {
    const engine = makeEngine([healer('h1', 0, 0), rangedRat('m1', 3, 0)]);
    const pools = engine.previewNormalAttackPools(asCharacterId('m1'), asCharacterId('h1'));
    expect(pools.ok && pools.value.defenderArmorPoolSize).toBe(1); // armor 1, no tangled
    engine.beginNarrativeTurn(asCharacterId('m1'));
    engine.applyAction(asCharacterId('m1'), { kind: 'normal_attack', targetId: asCharacterId('h1') });
    const events = engine.flushEvents();
    expect(events.find((e) => e.type === 'passive_triggered')).toBeUndefined();
  });
});

describe('Hunter bonus passive — reactive step on taking damage', () => {
  // A melee rat with attack dice and the hunter at 0 armor → guaranteed HIT
  // (attackerTop ≥ 1 > defenderTop 0), so the hunter takes 1 damage, survives
  // (HP 2), and darts to the free 8-neighbour farthest from the attacker.
  const huntr = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y),
    archetype: 'hunter',
    pools: { melee: 0, ranged: 2, magic: 0, armor: 0 },
    health: { total: 2, damage: 0, status: 'normal' },
    normalAttack: { kind: 'ranged', name: 'Bow', range: 6, damageMod: 0 },
    bonusAbility: { id: asEffectId('evasive-maneuver'), name: 'Hunter', description: '' },
  });
  const meleeRat = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y), kind: 'monster', name: 'Rat',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 0 },
    health: { total: 2, damage: 0, status: 'normal' },
    normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  });

  it('darts one square away from the attacker and emits a banner', () => {
    // hunter at (4,4); attacker at (3,4) (west). Farthest reachable neighbour is
    // (5,3) — deterministic (y,x) scan picks it first among distance-2 cells.
    const engine = makeEngine([huntr('h1', 4, 4), meleeRat('m1', 3, 4)]);
    engine.beginNarrativeTurn(asCharacterId('m1'));
    engine.applyAction(asCharacterId('m1'), { kind: 'normal_attack', targetId: asCharacterId('h1') });
    const events = engine.flushEvents();
    const hunterPos = engine.charactersById().get(asCharacterId('h1'))!.pos;
    expect(hunterPos).toEqual({ x: 5, y: 3 });
    const banner = events.find((e) => e.type === 'passive_triggered') as unknown as
      { actorId: string; abilityName: string; effect: string } | undefined;
    expect(banner?.actorId).toBe('h1');
    expect(banner?.abilityName).toBe('Hunter');
    expect(banner?.effect).toBe('darts 1 square');
    // The move is published as a state_change so the browser repositions the token.
    const moved = events.filter((e) => e.type === 'state_change') as unknown as
      Array<{ changes: Array<{ id: string; pos?: { x: number; y: number } }> }>;
    expect(moved.some((e) => e.changes.some((c) => c.id === 'h1' && c.pos?.x === 5 && c.pos?.y === 3))).toBe(true);
  });

  it('does not move when boxed in (no farther free cell)', () => {
    // Hunter at corner (0,0); attacker at (1,1). Neighbours (1,0),(0,1) are
    // distance 1 (not farther than current 1); (1,1) is the attacker. No move.
    const engine = makeEngine([huntr('h1', 0, 0), meleeRat('m1', 1, 1)]);
    engine.beginNarrativeTurn(asCharacterId('m1'));
    engine.applyAction(asCharacterId('m1'), { kind: 'normal_attack', targetId: asCharacterId('h1') });
    engine.flushEvents();
    expect(engine.charactersById().get(asCharacterId('h1'))!.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('cover obstacles vs barriers — line of sight', () => {
  // Regression for the "shot voided by an obstacle in the middle" bug: a COVER
  // obstacle (walkable `obstacle` cell) on the line must NOT block the shot — it
  // grants the target +1 armor die. Only a BARRIER (`wall`) blocks LoS.
  const ranged = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y),
    archetype: 'hunter',
    normalAttack: { kind: 'ranged', name: 'bow', range: 6, damageMod: 0 },
    pools: { melee: 1, ranged: 2, magic: 0, armor: 2 },
  });
  const foe = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y),
    kind: 'monster',
    pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
    health: { total: 1, damage: 0, status: 'normal' },
  });

  const engineWith = (chars: Character[]): GameEngine => {
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })));
    cells[0]![2] = { kind: 'obstacle' };   // walkable cover at (2,0) — grants cover
    cells[2]![2] = { kind: 'wall' };       // barrier at (2,2) — blocks LoS
    cells[4]![2] = { kind: 'cover-wall' }; // SOLID cover at (2,4) — blocks move, shoot-through
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    return new GameEngine({ seed: 'test', grid: new Grid(cells), characters: chars, effects: reg });
  };

  it('a cover obstacle on the line does NOT block the shot — it adds +1 defender armor', () => {
    // Hunter (0,0) → foe (4,0). Supercover line crosses the cover cell at (2,0).
    const hu = ranged('hu', 0, 0);
    const m = foe('m1', 4, 0);
    const e = engineWith([hu, m]);
    const preview = e.previewNormalAttackPools(asCharacterId('hu'), asCharacterId('m1'));
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      // base armor 1 + 1 cover = 2.
      expect(preview.value.defenderArmorPoolSize).toBe(2);
      expect(preview.value.attackerPoolSize).toBe(2);
    }
  });

  it('a barrier (wall) on the line still blocks with no-line-of-sight', () => {
    // Hunter (0,0) → foe (4,4). Supercover diagonal crosses the wall at (2,2).
    const hu = ranged('hu', 0, 0);
    const m = foe('m1', 4, 4);
    const e = engineWith([hu, m]);
    const preview = e.previewNormalAttackPools(asCharacterId('hu'), asCharacterId('m1'));
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.reason).toBe('no-line-of-sight');
  });

  it('a hero can move onto a walkable obstacle cell at +1 movement cost', () => {
    const hu = ranged('hu', 1, 0); // adjacent to the walkable cover cell at (2,0)
    const e = engineWith([hu]);
    e.beginNarrativeTurn(asCharacterId('hu'));
    const r = e.applyAction(asCharacterId('hu'), { kind: 'move', path: [{ x: 1, y: 0 }, { x: 2, y: 0 }] });
    expect(r.ok).toBe(true); // not blocked-by-wall
  });

  it('a hero CANNOT move onto a solid cover-wall (the walk-through-barrel bug)', () => {
    // Regression: a `cover:true` barrel is now a `cover-wall` — solid. Moving
    // onto (2,4) must be rejected as blocked-by-wall, not silently allowed.
    const hu = ranged('hu', 2, 3); // adjacent to the cover-wall at (2,4)
    const e = engineWith([hu]);
    e.beginNarrativeTurn(asCharacterId('hu'));
    const r = e.applyAction(asCharacterId('hu'), { kind: 'move', path: [{ x: 2, y: 3 }, { x: 2, y: 4 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('blocked-by-wall');
  });

  it('a shot across a solid cover-wall still lands and grants the target +1 armor', () => {
    // Hunter (0,4) → foe (4,4). Supercover line crosses the cover-wall at (2,4):
    // it blocks movement but NOT sight, so the shot lands with the cover bonus.
    const hu = ranged('hu', 0, 4);
    const m = foe('m1', 4, 4);
    const e = engineWith([hu, m]);
    const preview = e.previewNormalAttackPools(asCharacterId('hu'), asCharacterId('m1'));
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.defenderArmorPoolSize).toBe(2); // base 1 + 1 cover
      expect(preview.value.attackerPoolSize).toBe(2);
    }
  });
});

describe('adjacent-attack penalty — Hunter & Healer lose 1 die in melee range', () => {
  // Hunter (ranged) and Healer (magic) are skirmishers: a foe adjacent
  // (Chebyshev distance 1) fouls their attack, costing 1 die. Warrior (melee)
  // and Warlock (magic) are exempt. Verified through previewNormalAttackPools,
  // which shares computeNormalAttackContext with handleNormalAttack — so the
  // physics-dice count and the seeded resolution see the same reduced pool.
  const archetypeHero = (
    id: string, x: number, y: number,
    over: Partial<Character>,
  ): Character => ({ ...hero(id, x, y), ...over });

  const ranged = (id: string, x: number, y: number, pool = 2): Character =>
    archetypeHero(id, x, y, {
      archetype: 'hunter',
      pools: { melee: 0, ranged: pool, magic: 0, armor: 2 },
      normalAttack: { kind: 'ranged', name: 'bow', range: 6, damageMod: 0 },
      bonusAbility: { id: asEffectId('evasive-maneuver'), name: 'EM', description: '' },
    });
  const caster = (id: string, x: number, y: number, archetype: 'healer' | 'warlock'): Character =>
    archetypeHero(id, x, y, {
      archetype,
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      normalAttack: { kind: 'magic', name: 'bolt', range: 4, damageMod: 0 },
      bonusAbility: { id: asEffectId(archetype === 'healer' ? 'potion-brewer' : 'power-surge'), name: 'B', description: '' },
    });
  const foe = (id: string, x: number, y: number): Character =>
    archetypeHero(id, x, y, {
      kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 1, damage: 0, status: 'normal' },
    });

  const poolFor = (chars: Character[], attacker: string, target: string): number => {
    const e = makeEngine(chars);
    const preview = e.previewNormalAttackPools(asCharacterId(attacker), asCharacterId(target));
    expect(preview.ok).toBe(true);
    return preview.ok ? preview.value.attackerPoolSize : -1;
  };

  it('Hunter loses 1 die when the target is adjacent', () => {
    // Foe at (1,0) is adjacent to the hunter at (0,0): pool 2 → 1.
    expect(poolFor([ranged('hu', 0, 0), foe('m1', 1, 0)], 'hu', 'm1')).toBe(1);
  });

  it('Hunter keeps the full pool when the target is NOT adjacent', () => {
    // Foe at (2,0) is two cells away: no penalty, full pool 2.
    expect(poolFor([ranged('hu', 0, 0), foe('m1', 2, 0)], 'hu', 'm1')).toBe(2);
  });

  it('Healer loses 1 die when the target is adjacent', () => {
    expect(poolFor([caster('he', 0, 0, 'healer'), foe('m1', 1, 1)], 'he', 'm1')).toBe(1);
  });

  it('Warrior (melee) is NOT penalised at adjacency', () => {
    // Base hero() is a melee warrior with pool 2; an adjacent foe is its only
    // legal target and the pool stays 2.
    expect(poolFor([hero('w', 0, 0), foe('m1', 1, 0)], 'w', 'm1')).toBe(2);
  });

  it('Warlock (magic) is intentionally exempt — keeps full pool at adjacency', () => {
    expect(poolFor([caster('wl', 0, 0, 'warlock'), foe('m1', 1, 0)], 'wl', 'm1')).toBe(2);
  });

  it('penalty floors at 0 — a 1-die Hunter throws 0 dice in melee', () => {
    expect(poolFor([ranged('hu', 0, 0, 1), foe('m1', 1, 0)], 'hu', 'm1')).toBe(0);
  });

  it('the reduced pool also drives the resolution roll, not just the preview', () => {
    // handleNormalAttack shares computeNormalAttackContext, so an adjacent
    // hunter resolves against a 1-die attack roll (private payload length).
    const e = makeEngine([ranged('hu', 0, 0), foe('m1', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('hu'));
    const r = e.applyAction(asCharacterId('hu'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(true);
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as
      | { private?: { attackRoll?: number[] } } | undefined;
    expect(res?.private?.attackRoll).toHaveLength(1);
  });
});

describe('emoji prop spawn / remove', () => {
  it('spawn_prop adds the prop and emits an action event', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({
      kind: 'spawn_prop',
      id: 'cheese-1',
      emoji: '🧀',
      name: 'Wheel of cheese',
      pos: { x: 3, y: 4 },
      description: 'Half-nibbled.',
    });
    expect(r.ok).toBe(true);
    const props = e.propsList();
    expect(props).toHaveLength(1);
    expect(props[0]?.id).toBe('cheese-1');
    expect(props[0]?.emoji).toBe('🧀');
    expect(props[0]?.pos).toEqual({ x: 3, y: 4 });
    expect(props[0]?.description).toBe('Half-nibbled.');
    const events = e.flushEvents();
    const action = events.find((ev) => ev.type === 'action'
      && (ev as unknown as { action: { kind: string } }).action.kind === 'spawn_prop');
    expect(action).toBeDefined();
  });

  it('snapshot exposes spawned props', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({
      kind: 'spawn_prop', id: 'torch-1', emoji: '🔥', name: 'Lit torch', pos: { x: 2, y: 2 },
    });
    const snap = e.getRedactedSnapshot({ kind: 'human' });
    expect(snap.props).toHaveLength(1);
    expect(snap.props[0]?.emoji).toBe('🔥');
  });

  it('rejects spawn with duplicate id', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({
      kind: 'spawn_prop', id: 'rope-1', emoji: '🪢', name: 'Rope', pos: { x: 1, y: 1 },
    });
    const r = e.applyDmAction({
      kind: 'spawn_prop', id: 'rope-1', emoji: '🪢', name: 'Rope', pos: { x: 2, y: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  it('rejects spawn at out-of-bounds pos', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({
      kind: 'spawn_prop', id: 'far-1', emoji: '⭐', name: 'Star', pos: { x: 99, y: 99 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  it('rejects spawn with empty emoji', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({
      kind: 'spawn_prop', id: 'x-1', emoji: '', name: 'Thing', pos: { x: 1, y: 1 },
    });
    expect(r.ok).toBe(false);
  });

  it('remove_prop drops the prop and emits an action event', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({
      kind: 'spawn_prop', id: 'bone-1', emoji: '🦴', name: 'Bone', pos: { x: 1, y: 1 },
    });
    e.flushEvents();
    const r = e.applyDmAction({ kind: 'remove_prop', id: 'bone-1' });
    expect(r.ok).toBe(true);
    expect(e.propsList()).toHaveLength(0);
    const events = e.flushEvents();
    const action = events.find((ev) => ev.type === 'action'
      && (ev as unknown as { action: { kind: string } }).action.kind === 'remove_prop');
    expect(action).toBeDefined();
  });

  it('remove_prop with unknown id returns unknown-id (what="prop")', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'remove_prop', id: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.reason === 'unknown-id') {
      expect(r.error.what).toBe('prop');
    }
  });
});

describe('attack_object', () => {
  const makeAttackerEngine = (): GameEngine => {
    // 8x8 floor grid with one obstacle at (2,0) — adjacent to h1 at (1,0).
    // Hero h1 has melee 2d6, range 1.
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    );
    cells[0]![2] = { kind: 'obstacle' };
    const grid = new Grid(cells);
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    return new GameEngine({
      seed: 'attack-object-test',
      grid,
      characters: [hero('h1', 1, 0)],
      effects: reg,
    });
  };

  it('successful smash flips the obstacle cell to floor + records destroyedObstacles', () => {
    // Pick a difficulty of 4 so even a low roll succeeds with h1's 3-die pool
    // (1 base + 2 melee). Seed is deterministic.
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    // Confirm starting state
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('obstacle');
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4,
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    const res = events.find((ev) => ev.type === 'resolution') as unknown as {
      public: { success: boolean; obstacleDestroyed?: { x: number; y: number } };
    };
    expect(res).toBeDefined();
    if (res.public.success) {
      expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('floor');
      expect(res.public.obstacleDestroyed).toEqual({ x: 2, y: 0 });
      const snap = e.getRedactedSnapshot({ kind: 'human' });
      // No adventure wired in, so snap.scene is null — but the engine state
      // is still mutated. Test the grid directly.
      expect(snap).toBeDefined();
    }
  });

  it('miss leaves the obstacle intact', () => {
    // DC 6 against 3 dice — chance of failure is ~67% per Sonnet's RNG, but
    // we control the seed. Run once and read the resolution.
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 6,
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    const res = events.find((ev) => ev.type === 'resolution') as unknown as {
      public: { success: boolean };
    };
    // Whichever way the roll lands, the grid mutation MUST match success.
    if (!res.public.success) {
      expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('obstacle');
    } else {
      expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('floor');
    }
  });

  it('attacking a prop destroys it on success', () => {
    const e = makeAttackerEngine();
    e.applyDmAction({
      kind: 'spawn_prop', id: 'cheese-1', emoji: '🧀', name: 'Cheese', pos: { x: 0, y: 0 },
    });
    e.flushEvents();
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 0, y: 0 }, difficulty: 4,
    });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    const res = events.find((ev) => ev.type === 'resolution') as unknown as {
      public: { success: boolean; targetKind: string; propRemoved?: string };
    };
    expect(res.public.targetKind).toBe('prop');
    if (res.public.success) {
      expect(e.propsList()).toHaveLength(0);
      expect(res.public.propRemoved).toBe('cheese-1');
    } else {
      expect(e.propsList()).toHaveLength(1);
    }
  });

  it('rejects when the cell holds neither obstacle nor prop', () => {
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 5, y: 5 }, difficulty: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('no-such-object');
  });

  it('rejects when the cell is out of range', () => {
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    // h1 at (1,0), range 1; obstacle at (2,0) is in range. Try (6,6).
    // (6,6) is floor with no prop, so `no-such-object` would fire first. Spawn
    // a prop there to isolate the range check.
    e.applyDmAction({
      kind: 'spawn_prop', id: 'far', emoji: '⭐', name: 'star', pos: { x: 6, y: 6 },
    });
    e.flushEvents();
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 6, y: 6 }, difficulty: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('counts as the actor main action (action-already-used on second call)', () => {
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4,
    });
    // Second call same turn — main action already spent.
    const r2 = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('action-already-used');
  });

  it('rejects when pos is out of bounds', () => {
    const e = makeAttackerEngine();
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 99, y: 99 }, difficulty: 4,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });

  it('cannot smash indestructible cave rock (no-such-object)', () => {
    // Same 8×8 grid as makeAttackerEngine but the cell at (2,0) is ROCK, not
    // an obstacle. Rock is cave terrain — attack_object must refuse it.
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    );
    cells[0]![2] = { kind: 'rock' };
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const e = new GameEngine({ seed: 'rock-test', grid: new Grid(cells), characters: [hero('h1', 1, 0)], effects: reg });
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('no-such-object');
    // The rock cell is untouched.
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('rock');
  });
});

describe('attack_object durability (multi-hit obstacles)', () => {
  const makeDurabilityEngine = (): GameEngine => {
    // 8×8 grid with one obstacle cell at (2,0); the adventure declares it a
    // durability-2 barrel-stack (a smashable multi-hit obstacle — NOT a
    // stalagmite, which is attack-proof), so the constructor seeds 2 hits.
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    );
    cells[0]![2] = { kind: 'wall' };
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const adventure = {
      id: 'a', title: 'A', estimatedDurationMin: 1,
      scenes: [{
        id: 's', intro: '',
        map: { width: 8, height: 8, background: 'b', obstacles: [{ type: 'barrel-stack', x: 2, y: 0, durability: 2 }], decorations: [], exits: [], walls: false, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], conclusion: '', transitions: [],
      }],
    } as unknown as Adventure;
    // A large melee pool makes the difficulty-4 smash land deterministically
    // under the fixed seed (so the test exercises the success path, not luck).
    const h: Character = { ...hero('h1', 1, 0), pools: { melee: 10, ranged: 0, magic: 0, armor: 2 } };
    return new GameEngine({ seed: 'barrel-durability', grid: new Grid(cells), characters: [h], effects: reg, adventure });
  };

  it('takes two successful hits to break; the first only drains a durability pip', () => {
    const e = makeDurabilityEngine();

    // First hit: lands, but the spire survives with one pip left.
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r1 = e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(r1.ok).toBe(true);
    const res1 = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as {
      public: { success: boolean; obstacleDamaged?: { pos: { x: number; y: number }; remaining: number; max: number }; obstacleDestroyed?: unknown };
    };
    expect(res1.public.success).toBe(true);
    expect(res1.public.obstacleDamaged).toEqual({ pos: { x: 2, y: 0 }, remaining: 1, max: 2 });
    expect(res1.public.obstacleDestroyed).toBeUndefined();
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('wall'); // still standing

    // The snapshot exposes the drained durability so the UI can paint one pip.
    const ob = e.getRedactedSnapshot({ kind: 'human' }).scene!.obstacles.find((o) => o.x === 2 && o.y === 0)!;
    expect(ob.durability).toBe(2);
    expect(ob.remaining).toBe(1);

    // Second hit (a new turn) shatters it into a breach.
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r2 = e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(r2.ok).toBe(true);
    const res2 = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as {
      public: { success: boolean; obstacleDestroyed?: { x: number; y: number } };
    };
    expect(res2.public.success).toBe(true);
    expect(res2.public.obstacleDestroyed).toEqual({ x: 2, y: 0 });
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('floor'); // breached
  });
});

describe('check rolls: previews + provided physics faces (ability_test / attack_object)', () => {
  it('previewAbilityTest reports pool size (1 + characteristic) and difficulty', () => {
    const e = makeEngine([hero('h1', 0, 0)]); // melee 2
    e.beginNarrativeTurn(asCharacterId('h1'));
    const p = e.previewAbilityTest(asCharacterId('h1'), { kind: 'ability_test', characteristic: 'melee', difficulty: 4, describe: 'climb' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ poolSize: 3, difficulty: 4 });
  });

  it('ability_test resolves against provided faces (top die vs difficulty), not the seed', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'),
      { kind: 'ability_test', characteristic: 'melee', difficulty: 4, describe: 'climb' },
      { providedAbilityRoll: { roll: [6, 1, 1] } });
    expect(r.ok).toBe(true);
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as { public: { success: boolean }; private: { roll: number[] } };
    expect(res.private.roll).toEqual([6, 1, 1]); // used verbatim
    expect(res.public.success).toBe(true);       // top 6 >= 4
  });

  it('ability_test with low provided faces fails the check', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'),
      { kind: 'ability_test', characteristic: 'melee', difficulty: 5, describe: 'climb' },
      { providedAbilityRoll: { roll: [2, 3, 1] } });
    expect(r.ok).toBe(true);
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as { public: { success: boolean } };
    expect(res.public.success).toBe(false); // top 3 < 5
  });

  it('previewAttackObject validates + reports pool/difficulty; attack_object honors provided faces', () => {
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    );
    cells[0]![2] = { kind: 'wall' };
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const e = new GameEngine({ seed: 'check', grid: new Grid(cells), characters: [hero('h1', 1, 0)], effects: reg });
    e.beginNarrativeTurn(asCharacterId('h1'));
    const p = e.previewAttackObject(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ poolSize: 3, difficulty: 4 }); // 1 + melee 2

    const r = e.applyAction(asCharacterId('h1'),
      { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 },
      { providedAbilityRoll: { roll: [6, 1, 1] } });
    expect(r.ok).toBe(true);
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('floor'); // top 6 >= 4 → smashed
  });

  it('echoes rollRequestId on the check resolution when provided faces carry one', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    e.applyAction(asCharacterId('h1'),
      { kind: 'ability_test', characteristic: 'melee', difficulty: 4, describe: 'climb' },
      { providedAbilityRoll: { roll: [6, 1, 1], requestId: 'roll-xyz-7' } });
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as { public: { rollRequestId?: string } };
    expect(res.public.rollRequestId).toBe('roll-xyz-7');
  });

  it('omits rollRequestId on the check resolution for the seeded path (no requestId)', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    e.applyAction(asCharacterId('h1'),
      { kind: 'ability_test', characteristic: 'melee', difficulty: 4, describe: 'climb' });
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as { public: Record<string, unknown> };
    expect('rollRequestId' in res.public).toBe(false);
  });
});

describe('GameEngine.move with rock terrain', () => {
  const makeRockGrid = (): Grid => {
    const cells: GridCell[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    );
    cells[0]![2] = { kind: 'rock' };
    return new Grid(cells);
  };

  it('rejects a move stepping onto a rock cell (blocked-by-wall)', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const e = new GameEngine({ seed: 's', grid: makeRockGrid(), characters: [hero('h1', 0, 0)], effects: reg });
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move', path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('blocked-by-wall');
  });

  it('lets a hero standing on rock still move off it (start cell is not re-validated)', () => {
    // Carryover edge case: a hero seated on a rock cell can still walk to floor.
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const e = new GameEngine({ seed: 's', grid: makeRockGrid(), characters: [hero('h1', 2, 0)], effects: reg });
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'move', path: [{ x: 2, y: 0 }, { x: 2, y: 1 }],
    });
    expect(r.ok).toBe(true);
  });
});

// Build a 10×10 engine from an obstacle list (grid + liveObstacles kept in sync
// via buildSceneGrid + the constructor's scene[0] seeding).
const makeSceneEngine = (
  obstacles: Array<Record<string, unknown>>,
  chars: Character[],
  seed = 'scene-test',
): GameEngine => {
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  const scene = {
    id: 's', intro: '',
    map: { width: 10, height: 10, background: 'b', obstacles, decorations: [], exits: [], walls: false },
    monsters: [], tactics: '', abilityTests: [], conclusion: '', transitions: [],
  } as unknown as SceneType;
  const adventure = { id: 'a', title: 'A', estimatedDurationMin: 1, scenes: [scene] } as unknown as AdventureType;
  return new GameEngine({ seed, grid: buildSceneGrid(scene), characters: [...chars], effects: reg, adventure });
};

const bruiser = (id: string, x: number, y: number): Character => ({
  ...hero(id, x, y), pools: { melee: 10, ranged: 0, magic: 0, armor: 2 },
});

describe('attack-proof stalagmites', () => {
  it('attack_object on a stalagmite is rejected as indestructible — no roll, no turn spent', () => {
    const e = makeSceneEngine([{ type: 'stalagmite', x: 2, y: 0 }], [bruiser('h1', 1, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const preview = e.previewAttackObject(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.reason).toBe('indestructible');
    const r = e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('indestructible');
    // The spire still stands and the turn was NOT consumed (the hero can still act).
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('wall');
    const move = e.applyAction(asCharacterId('h1'), { kind: 'move', path: [{ x: 1, y: 0 }, { x: 1, y: 1 }] });
    expect(move.ok).toBe(true);
  });
});

describe('explosion demolishes stalagmites', () => {
  it("a cask blast clears stalagmites in range (but not far ones, and not plain walls), and still damages creatures", () => {
    const e = makeSceneEngine(
      [
        { type: 'oil-cask', x: 2, y: 0, explosive: { damage: 1, radius: 1 } },
        { type: 'stalagmite', x: 3, y: 0 }, // adjacent to the cask → demolished
        { type: 'stalagmite', x: 5, y: 5 }, // far → survives
        { type: 'barrel-stack', x: 2, y: 1 }, // in radius but NOT a stalagmite → survives
      ],
      [bruiser('h1', 1, 0)],
      'demolish-seed',
    );
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 2, y: 0 }, difficulty: 4 });
    expect(r.ok).toBe(true);
    const evs = e.flushEvents();
    const res = evs.find((ev) => ev.type === 'resolution') as unknown as {
      public: { obstacleDestroyed?: { x: number; y: number }; blast?: { demolished: { x: number; y: number }[]; victimIds: string[] } };
    };
    expect(res.public.obstacleDestroyed).toEqual({ x: 2, y: 0 });
    expect(res.public.blast?.demolished).toEqual([{ x: 3, y: 0 }]);
    // Grid: cask + adjacent stalagmite cleared; far stalagmite + plain barrel stand.
    expect(e.grid.cellAt({ x: 2, y: 0 }).kind).toBe('floor');
    expect(e.grid.cellAt({ x: 3, y: 0 }).kind).toBe('floor');
    expect(e.grid.cellAt({ x: 5, y: 5 }).kind).toBe('wall');
    expect(e.grid.cellAt({ x: 2, y: 1 }).kind).toBe('wall');
    // The blast still damaged the (adjacent) smasher.
    const h1 = e.charactersById().get(asCharacterId('h1'))!;
    expect(h1.health.damage).toBe(1);
    // The far stalagmite remains attack-proof afterward.
    const reject = e.applyAction(asCharacterId('h1'), { kind: 'attack_object', pos: { x: 5, y: 5 }, difficulty: 4 });
    expect(reject.ok).toBe(false);
  });
});

describe('push_object', () => {
  const pushable = (x: number, y: number) =>
    ({ type: 'oil-cask', x, y, pushable: true, explosive: { damage: 1, radius: 1 } });

  it('shoves an adjacent pushable cask one cell directly away into empty floor', () => {
    const e = makeSceneEngine([pushable(4, 5)], [hero('h1', 3, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
    expect(r.ok).toBe(true);
    // The cask moved (4,5) → (5,5).
    expect(e.grid.cellAt({ x: 4, y: 5 }).kind).toBe('floor');
    expect(e.grid.cellAt({ x: 5, y: 5 }).kind).toBe('wall');
    // The objectPushed resolution describes the move.
    const res = e.flushEvents().find((ev) => ev.type === 'resolution') as unknown as {
      public: { objectPushed?: { from: { x: number; y: number }; to: { x: number; y: number }; type: string } };
    };
    expect(res.public.objectPushed).toEqual({ from: { x: 4, y: 5 }, to: { x: 5, y: 5 }, type: 'oil-cask' });
    // The snapshot shows the cask at its new cell, still pushable + explosive.
    const ob = e.getRedactedSnapshot({ kind: 'human' }).scene!.obstacles.find((o) => o.type === 'oil-cask')!;
    expect(ob).toMatchObject({ x: 5, y: 5, pushable: true, explosive: true });
    // It cost the main action: a second action this turn is rejected.
    const again = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 5, y: 5 } });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('action-already-used');
  });

  it('is deterministic (roll-less): two engines produce the identical move', () => {
    const run = () => {
      const e = makeSceneEngine([pushable(4, 5)], [hero('h1', 3, 5)]);
      e.beginNarrativeTurn(asCharacterId('h1'));
      e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
      return e.grid.cellAt({ x: 5, y: 5 }).kind;
    };
    expect(run()).toBe('wall');
    expect(run()).toBe(run());
  });

  it('rejects pushing a non-pushable obstacle (indestructible)', () => {
    const e = makeSceneEngine([{ type: 'stalagmite', x: 4, y: 5 }], [hero('h1', 3, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('indestructible');
  });

  it('rejects pushing when not adjacent (out-of-range)', () => {
    const e = makeSceneEngine([pushable(4, 5)], [hero('h1', 1, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('rejects pushing into a non-floor destination (blocked-by-wall)', () => {
    // Pusher west of the cask, but a stalagmite sits in the destination cell.
    const e = makeSceneEngine([pushable(4, 5), { type: 'stalagmite', x: 5, y: 5 }], [hero('h1', 3, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('blocked-by-wall');
  });

  it('rejects pushing into a cell occupied by a living creature (invalid-target)', () => {
    const e = makeSceneEngine([pushable(4, 5)], [hero('h1', 3, 5), hero('h2', 5, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 4, y: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects pushing a cell with no obstacle (no-such-object)', () => {
    const e = makeSceneEngine([pushable(4, 5)], [hero('h1', 3, 5)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'push_object', pos: { x: 7, y: 7 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('no-such-object');
  });
});
