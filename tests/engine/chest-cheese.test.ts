import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid, type GridCell } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import {
  asCharacterId, asEffectId, asItemId, asSceneId, asAdventureId,
} from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { ItemStack } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Event } from '../../src/log/events.js';

// --- helpers ---------------------------------------------------------------

const grid = (w: number, h: number, walls: { x: number; y: number }[] = []): Grid => {
  const cells: GridCell[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => ({ kind: 'floor' as const })));
  for (const wcell of walls) cells[wcell.y]![wcell.x] = { kind: 'wall' };
  return new Grid(cells);
};

const reg = (): EffectRegistry => {
  const r = new EffectRegistry();
  registerCoreEffects(r);
  return r;
};

const hero = (id: string, x: number, y: number, inventory: ItemStack[] = []): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory, boons: [], skills: [],
});

const rat = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  health: { total: 1, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('coward'),      name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

const cheese = (count = 1): ItemStack => ({ itemId: asItemId('cheese'), count });

const plainEngine = (chars: Character[], g: Grid = grid(10, 10)): GameEngine =>
  new GameEngine({ seed: 't', grid: g, characters: chars, effects: reg() });

interface ActionEv { type: string; action?: { kind?: string; id?: string } }
interface ResolutionEv { type: string; public?: Record<string, unknown> }
const actionKinds = (events: Event[]): string[] =>
  (events as unknown as ActionEv[]).filter((e) => e.type === 'action').map((e) => e.action?.kind ?? '');
const resolutionPublic = (events: Event[]): Record<string, unknown> | undefined =>
  (events as unknown as ResolutionEv[]).find((e) => e.type === 'resolution')?.public;

// An adventure whose single scene declares a chest containing cheese.
const chestAdventure = (chestPos: { x: number; y: number }): Adventure => ({
  id: asAdventureId('chest-adv'), title: 'Chest', estimatedDurationMin: 5,
  scenes: [{
    id: asSceneId('vault'), intro: '', conclusion: '', tactics: '', abilityTests: [],
    map: {
      width: 10, height: 10, background: 'cave', obstacles: [], decorations: [],
      exits: [], walls: false, npcs: [],
      chests: [{ id: 'supply-chest', pos: chestPos, contents: 'cheese' }],
    },
    monsters: [],
    transitions: [{ to: 'END', trigger: 'all-monsters-ko' }],
  }],
});

// --- open_chest ------------------------------------------------------------

describe('open_chest', () => {
  const setup = (heroPos: { x: number; y: number }) => {
    const h = hero('p1', heroPos.x, heroPos.y);
    const e = new GameEngine({
      seed: 't', grid: grid(10, 10), characters: [h], effects: reg(),
      adventure: chestAdventure({ x: 3, y: 3 }),
    });
    expect(e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('vault') }).ok).toBe(true);
    e.flushEvents();
    e.beginNarrativeTurn(asCharacterId('p1'));
    return e;
  };

  it('set_scene materializes the chest as a prop carrying its contents + emits spawn_prop', () => {
    const e = new GameEngine({
      seed: 't', grid: grid(10, 10), characters: [hero('p1', 0, 0)], effects: reg(),
      adventure: chestAdventure({ x: 3, y: 3 }),
    });
    const r = e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('vault') });
    expect(r.ok).toBe(true);
    const chestProp = e.propsList().find((p) => p.id === 'supply-chest');
    expect(chestProp).toBeDefined();
    expect(chestProp!.chest).toEqual({ contents: asItemId('cheese') });
    expect(chestProp!.pos).toEqual({ x: 3, y: 3 });
    // It carries the manifest sprite key so the browser renders the chest sprite.
    expect(chestProp!.spriteId).toBe('chest');
    // A spawn_prop action was emitted so a live browser renders the chest.
    expect(actionKinds(e.flushEvents())).toContain('spawn_prop');
    // The chest is serialized into the snapshot (chest contents + sprite key) for
    // reconnect rendering.
    const snapProp = e.getRedactedSnapshot({ kind: 'human' }).props.find((p) => p.id === 'supply-chest');
    expect(snapProp?.chest).toEqual({ contents: asItemId('cheese') });
    expect(snapProp?.spriteId).toBe('chest');
  });

  it('an adjacent hero loots the cheese, removes the chest, and spends the action', () => {
    const e = setup({ x: 3, y: 2 }); // adjacent to chest at (3,3)
    const r = e.applyAction(asCharacterId('p1'), { kind: 'open_chest', chestId: 'supply-chest' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.turnEnded).toBe(false);
    // Cheese is now in the hero's inventory.
    const inv = e.charactersById().get(asCharacterId('p1'))!.inventory;
    expect(inv).toEqual([{ itemId: asItemId('cheese'), count: 1 }]);
    // The chest prop is gone, and a remove_prop + chest_opened resolution fired.
    expect(e.propsList().some((p) => p.id === 'supply-chest')).toBe(false);
    const evs = e.flushEvents();
    expect(actionKinds(evs)).toEqual(expect.arrayContaining(['open_chest', 'remove_prop']));
    expect(resolutionPublic(evs)).toMatchObject({ chestOpened: 'supply-chest', granted: 'cheese' });
    // The main action was consumed.
    expect(e.turn.hasActed()).toBe(true);
  });

  it('rejects opening a chest more than 1 cell away', () => {
    const e = setup({ x: 0, y: 0 }); // far from chest at (3,3)
    const r = e.applyAction(asCharacterId('p1'), { kind: 'open_chest', chestId: 'supply-chest' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('rejects an unknown chest id', () => {
    const e = setup({ x: 3, y: 2 });
    const r = e.applyAction(asCharacterId('p1'), { kind: 'open_chest', chestId: 'no-such-chest' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ reason: 'unknown-id', what: 'prop' });
  });

  it('rejects opening after the main action is already used', () => {
    const e = setup({ x: 3, y: 2 });
    expect(e.applyAction(asCharacterId('p1'), { kind: 'open_chest', chestId: 'supply-chest' }).ok).toBe(true);
    // A second main action this turn must be rejected.
    const r = e.applyAction(asCharacterId('p1'), { kind: 'open_chest', chestId: 'supply-chest' });
    expect(r.ok).toBe(false);
  });
});

// --- throw_item: inventory source ------------------------------------------

describe('throw_item (from inventory)', () => {
  const setup = (inv: ItemStack[] = [cheese()]) => {
    const e = plainEngine([hero('p1', 1, 1, inv)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    return e;
  };

  it('drops a cheese bait prop on the target, consuming one from inventory', () => {
    const e = setup([cheese(2)]);
    const r = e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 3, y: 3 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.turnEnded).toBe(false);
    // Inventory decremented 2 → 1.
    expect(e.charactersById().get(asCharacterId('p1'))!.inventory).toEqual([{ itemId: asItemId('cheese'), count: 1 }]);
    // A bait prop now sits on (3,3).
    const baitProp = e.propsList().find((p) => p.bait);
    expect(baitProp).toBeDefined();
    expect(baitProp!.pos).toEqual({ x: 3, y: 3 });
    expect(baitProp!.emoji).toBe('🧀');
    // activeBaitCells exposes it to the monster AI.
    expect(e.activeBaitCells()).toEqual([{ x: 3, y: 3 }]);
    // throw_item + spawn_prop emitted; main action consumed.
    expect(actionKinds(e.flushEvents())).toEqual(expect.arrayContaining(['throw_item', 'spawn_prop']));
    expect(e.turn.hasActed()).toBe(true);
  });

  it('removes the stack entirely when the last cheese is thrown', () => {
    const e = setup([cheese(1)]);
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 2, y: 2 } }).ok).toBe(true);
    expect(e.charactersById().get(asCharacterId('p1'))!.inventory).toEqual([]);
  });

  it('a thrown non-cheese item lands as an INERT prop (not bait)', () => {
    const e = setup([{ itemId: asItemId('potion'), count: 1 }]);
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('potion'), pos: { x: 2, y: 2 } }).ok).toBe(true);
    const prop = e.propsList().find((p) => p.pos.x === 2 && p.pos.y === 2);
    expect(prop).toBeDefined();
    expect(prop!.bait).toBeUndefined();
    expect(e.activeBaitCells()).toEqual([]);
  });

  it('rejects throwing an item the hero does not have (and is not near)', () => {
    const e = setup([]); // empty inventory
    const r = e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 2, y: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ reason: 'unknown-id', what: 'item' });
  });

  it('rejects a target beyond throw range (4)', () => {
    const e = setup();
    const r = e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 9, y: 9 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('rejects a non-floor target cell', () => {
    const e = plainEngine([hero('p1', 1, 1, [cheese()])], grid(10, 10, [{ x: 2, y: 2 }]));
    e.beginNarrativeTurn(asCharacterId('p1'));
    const r = e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 2, y: 2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('blocked-by-wall');
  });

  it('rejects a cell occupied by a living creature', () => {
    const e = plainEngine([hero('p1', 1, 1, [cheese()]), rat('r1', 3, 3)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    const r = e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 3, y: 3 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });
});

// --- throw_item: close-by ground source ------------------------------------

describe('throw_item (a prop lying close by)', () => {
  it('relocates an adjacent ground prop instead of requiring it in inventory', () => {
    // p1 throws cheese to (2,1), creating a bait prop. p2 (no cheese carried)
    // stands adjacent to that prop and re-throws it to (5,1).
    const e = plainEngine([hero('p1', 1, 1, [cheese()]), hero('p2', 3, 1)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 2, y: 1 } }).ok).toBe(true);
    const baitId = e.propsList().find((p) => p.bait)!.id; // "cheese-1"
    e.flushEvents();

    e.beginNarrativeTurn(asCharacterId('p2')); // p2 is at (3,1), adjacent to (2,1)
    const r = e.applyAction(asCharacterId('p2'), { kind: 'throw_item', itemId: asItemId(baitId), pos: { x: 5, y: 1 } });
    expect(r.ok).toBe(true);
    const moved = e.propsList().find((p) => p.id === baitId)!;
    expect(moved.pos).toEqual({ x: 5, y: 1 });
    expect(moved.bait).toBe(true); // bait nature preserved through the re-throw
    expect(e.charactersById().get(asCharacterId('p2'))!.inventory).toEqual([]); // nothing consumed
  });

  it('rejects re-throwing a ground prop that is not within 1 cell', () => {
    const e = plainEngine([hero('p1', 1, 1, [cheese()]), hero('p2', 8, 8)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 2, y: 1 } }).ok).toBe(true);
    const baitId = e.propsList().find((p) => p.bait)!.id;
    e.beginNarrativeTurn(asCharacterId('p2')); // far from the prop
    const r = e.applyAction(asCharacterId('p2'), { kind: 'throw_item', itemId: asItemId(baitId), pos: { x: 8, y: 7 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ reason: 'unknown-id', what: 'item' });
  });
});

// --- bait consumption on monster arrival -----------------------------------

describe('bait is eaten when a monster lands on it', () => {
  it('a monster ending its move on the cheese cell removes the bait (and emits remove_prop)', () => {
    const e = plainEngine([hero('p1', 1, 1, [cheese()]), rat('r1', 5, 7)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 5, y: 5 } }).ok).toBe(true);
    expect(e.activeBaitCells()).toEqual([{ x: 5, y: 5 }]);
    e.flushEvents();

    // The rat walks onto the cheese cell.
    e.beginNarrativeTurn(asCharacterId('r1'));
    const r = e.applyAction(asCharacterId('r1'), { kind: 'move', path: [{ x: 5, y: 7 }, { x: 5, y: 6 }, { x: 5, y: 5 }] });
    expect(r.ok).toBe(true);
    // The cheese is consumed.
    expect(e.activeBaitCells()).toEqual([]);
    expect(e.propsList().some((p) => p.bait)).toBe(false);
    expect(actionKinds(e.flushEvents())).toContain('remove_prop');
  });

  it('a HERO walking over the cheese does NOT eat it', () => {
    const e = plainEngine([hero('p1', 1, 1, [cheese()]), hero('p2', 5, 7)]);
    e.beginNarrativeTurn(asCharacterId('p1'));
    expect(e.applyAction(asCharacterId('p1'), { kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 5, y: 5 } }).ok).toBe(true);

    e.beginNarrativeTurn(asCharacterId('p2'));
    expect(e.applyAction(asCharacterId('p2'), { kind: 'move', path: [{ x: 5, y: 7 }, { x: 5, y: 6 }, { x: 5, y: 5 }] }).ok).toBe(true);
    // Still there — only monsters eat the bait.
    expect(e.activeBaitCells()).toEqual([{ x: 5, y: 5 }]);
  });
});
