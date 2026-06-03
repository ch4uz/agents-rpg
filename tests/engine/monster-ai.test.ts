import { describe, it, expect } from 'vitest';
import { Grid, type GridCell } from '../../src/engine/grid.js';
import { chooseMonsterActions, MONSTER_MOVE_BUDGET } from '../../src/engine/monster-ai.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { CharacterId } from '../../src/engine/ids.js';

const empty = (w: number, h: number): GridCell[][] =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => ({ kind: 'floor' as const })));

const hero = (id: string, x: number, y: number, hpDamage = 0, total = 3): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total, damage: hpDamage, status: hpDamage >= total ? 'KO' : 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

const meleeRat = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  health: { total: 1, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

const rangedMonster = (id: string, x: number, y: number, range = 4): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster',
  pools: { melee: 0, ranged: 2, magic: 0, armor: 1 },
  health: { total: 2, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'ranged', name: 'Bow', range, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

const mapBy = (...cs: Character[]) => new Map<CharacterId, Character>(cs.map((c) => [c.id, c]));

describe('chooseMonsterActions', () => {
  it('attacks an adjacent enemy with normal_attack (no move)', () => {
    const grid = new Grid(empty(8, 8));
    const m  = meleeRat('m1', 5, 5);
    const h1 = hero('p1', 5, 6);  // chebyshev 1 → in melee range
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });

  it('breaks an equal-distance in-range tie by lowest HP', () => {
    const grid = new Grid(empty(8, 8));
    const m       = meleeRat('m1', 4, 4);
    const healthy = hero('p1', 4, 5, 0);  // adjacent (chebyshev 1), full HP (3/3)
    const wounded = hero('p2', 5, 5, 2);  // adjacent diagonally (chebyshev 1), 1/3 HP
    const actions = chooseMonsterActions(m, mapBy(m, healthy, wounded), grid);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p2' }]);
  });

  it('attacks the NEAREST in-range enemy even when a farther one is more wounded', () => {
    // Ranged monster (range 4) can hit both, but distance is the primary key:
    // the closer healthy hero is bitten before the distant dying one.
    const grid = new Grid(empty(10, 1));
    const m       = rangedMonster('m1', 0, 0, 4);
    const wounded = hero('p1', 4, 0, 2);  // chebyshev 4, 1/3 HP
    const nearer  = hero('p2', 2, 0, 0);  // chebyshev 2, full HP
    const actions = chooseMonsterActions(m, mapBy(m, wounded, nearer), grid);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p2' }]);
  });

  it('moves to the NEAREST reachable enemy even when a farther one is more wounded', () => {
    // Neither enemy is in melee range now. The nearer (healthy) hero needs one
    // step; the farther (wounded) hero needs three. Nearest reachable wins.
    const grid = new Grid(empty(10, 1));
    const m       = meleeRat('m1', 0, 0);
    const wounded = hero('p1', 4, 0, 2);  // reach attack range in ~3 steps
    const nearer  = hero('p2', 2, 0, 0);  // reach attack range in ~1 step
    const actions = chooseMonsterActions(m, mapBy(m, wounded, nearer), grid);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p2' });
  });

  it('moves to close distance and attacks when an enemy is within reach + range', () => {
    const grid = new Grid(empty(8, 8));
    const m  = meleeRat('m1', 0, 0);
    const h1 = hero('p1', 3, 0);  // chebyshev 3 → out of melee range, but reachable in 3 steps
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid);
    expect(actions).toHaveLength(2);
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    expect(move.kind).toBe('move');
    expect(move.path[0]).toEqual({ x: 0, y: 0 });
    const last = move.path[move.path.length - 1]!;
    // After moving, the monster must be at melee range (chebyshev 1) of p1.
    expect(Math.max(Math.abs(last.x - 3), Math.abs(last.y - 0))).toBe(1);
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p1' });
  });

  it('moves toward the closest enemy when attack is impossible this turn', () => {
    // Distance > MONSTER_MOVE_BUDGET (4) means even with movement we can't
    // reach attack range — close as much as possible, end_turn.
    const grid = new Grid(empty(12, 12));
    const m  = meleeRat('m1', 0, 0);
    const h1 = hero('p1', 11, 11);
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid);
    expect(actions).toHaveLength(2);
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    expect(move.kind).toBe('move');
    // Monster moved closer (started at chebyshev 11; should be ≤ 11 - 1 = 10 or less).
    const last = move.path[move.path.length - 1]!;
    const newDist = Math.max(Math.abs(last.x - 11), Math.abs(last.y - 11));
    expect(newDist).toBeLessThan(11);
    expect(actions[1]).toEqual({ kind: 'end_turn' });
  });

  it('end_turn when there are no live enemies', () => {
    const grid = new Grid(empty(5, 5));
    const m = meleeRat('m1', 2, 2);
    expect(chooseMonsterActions(m, mapBy(m), grid)).toEqual([{ kind: 'end_turn' }]);
  });

  it('ignores KO\'d enemies for both target selection and attack range', () => {
    // Adjacent enemy is KO'd; another live enemy is just out of melee range.
    // Should move toward the live one (KO'd is skipped, not attacked).
    const grid = new Grid(empty(8, 8));
    const m       = meleeRat('m1', 4, 4);
    const downed  = hero('p1', 4, 5, 3);  // KO'd, adjacent
    const live    = hero('p2', 6, 4, 0);  // chebyshev 2, alive
    const actions = chooseMonsterActions(m, mapBy(m, downed, live), grid);
    // Step 2 should fire: move so that p2 is at chebyshev 1, then attack p2.
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p2' });
  });

  it('routes around walls when computing the move path', () => {
    // Build a grid with a wall column at x=3 except a single gap at y=2.
    // Monster at (1,3) wants to reach hero at (5,3) — only path goes via (3,2).
    const cells = empty(7, 5);
    for (let y = 0; y < 5; y++) cells[y]![3] = { kind: 'wall' };
    cells[2]![3] = { kind: 'floor' };
    const grid = new Grid(cells);
    const m  = meleeRat('m1', 1, 3);
    const h1 = hero('p1', 5, 3);
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid);
    // Movement budget 4 isn't enough to thread the gap (1,3)→(2,2)→(3,2)→(4,2)
    // → (5,3) is 4 steps. So the AI should produce a 2-action plan:
    //   move via the gap, then normal_attack.
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p1' });
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    // The path must include the only passable column-3 cell.
    expect(move.path.some((s) => s.x === 3 && s.y === 2)).toBe(true);
  });

  it('treats other monsters as blocking allies (cannot pass through or end on)', () => {
    const grid = new Grid(empty(6, 6));
    const m1 = meleeRat('m1', 0, 0);
    const m2 = meleeRat('m2', 1, 0);  // ally on the direct route — impassable
    const h  = hero('p1', 3, 0);
    const actions = chooseMonsterActions(m1, mapBy(m1, m2, h), grid);
    // m1 must detour AROUND m2: e.g. (0,0)→(1,1)→(2,0). The path may neither
    // cross nor end on (1,0); on this open grid a diagonal detour still reaches
    // melee range of p1.
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    expect(move.kind).toBe('move');
    expect(move.path.some((s) => s.x === 1 && s.y === 0)).toBe(false); // never crosses m2
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p1' });
  });

  it('respects the configured movement budget', () => {
    const grid = new Grid(empty(20, 1));
    const m  = meleeRat('m1', 0, 0);
    const h1 = hero('p1', 19, 0);
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET);
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    expect(move.kind).toBe('move');
    // path length = budget + 1 (start + N steps).
    expect(move.path.length).toBeLessThanOrEqual(MONSTER_MOVE_BUDGET + 1);
    expect(actions[1]).toEqual({ kind: 'end_turn' });
  });

  it('a ranged monster attacks at distance without moving when LoS is clear', () => {
    const grid = new Grid(empty(8, 8));
    const m  = rangedMonster('m1', 0, 0, 4);
    const h1 = hero('p1', 4, 0);  // chebyshev 4 — at max range
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });
});

describe('chooseMonsterActions — cheese bait', () => {
  const lastCell = (actions: ReturnType<typeof chooseMonsterActions>) => {
    const move = actions[0] as Extract<typeof actions[number], { kind: 'move' }>;
    expect(move.kind).toBe('move');
    return move.path[move.path.length - 1]!;
  };
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  it('abandons an ADJACENT hero to scramble for the cheese', () => {
    const grid = new Grid(empty(10, 3));
    const m  = meleeRat('m1', 2, 1);
    const h1 = hero('p1', 3, 1);   // adjacent — would normally be bitten
    const bait = { x: 6, y: 1 };
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, [bait]);
    // It moves toward the cheese rather than attacking the hero.
    const last = lastCell(actions);
    expect(cheb(last, bait)).toBeLessThan(cheb({ x: 2, y: 1 }, bait));
    expect(actions[actions.length - 1]).toEqual({ kind: 'end_turn' });
    expect(actions.some((a) => a.kind === 'normal_attack')).toBe(false);
  });

  it('steps onto the cheese cell when it is reachable this turn', () => {
    const grid = new Grid(empty(10, 3));
    const m  = meleeRat('m1', 2, 1);
    const h1 = hero('p1', 9, 1);   // far away
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, [{ x: 5, y: 1 }]);
    expect(lastCell(actions)).toEqual({ x: 5, y: 1 });
  });

  it('heads for the NEAREST of several baits', () => {
    const grid = new Grid(empty(12, 3));
    const m  = meleeRat('m1', 5, 1);
    const h1 = hero('p1', 0, 2);
    // (2,1) is dist 3; (9,1) is dist 4 → the rat goes for (2,1).
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, [{ x: 2, y: 1 }, { x: 9, y: 1 }]);
    expect(lastCell(actions)).toEqual({ x: 2, y: 1 });
  });

  it('falls back to attacking the hero when the cheese is unreachable (no progress)', () => {
    // 1-row corridor: the only step toward the bait is blocked by the hero, so
    // the rat cannot make progress — it bites the adjacent hero instead.
    const grid = new Grid(empty(8, 1));
    const m  = meleeRat('m1', 1, 0);
    const h1 = hero('p1', 2, 0);   // adjacent, and squarely between rat and bait
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, [{ x: 6, y: 0 }]);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });

  it('with no bait, behaves exactly as before (attacks the adjacent hero)', () => {
    const grid = new Grid(empty(8, 8));
    const m  = meleeRat('m1', 5, 5);
    const h1 = hero('p1', 5, 6);
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, []);
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });
});

describe('chooseMonsterActions — focus target', () => {
  // An immobilized captive (status 'immobilized', not 'KO') is a valid focus
  // target — the monsters can still bite the bound prey.
  const bound = (id: string, x: number, y: number): Character => ({
    ...hero(id, x, y),
    health: { total: 3, damage: 0, status: 'immobilized' },
  });

  it('bites the focus target even when another enemy is nearer / more wounded', () => {
    const grid = new Grid(empty(8, 8));
    const m       = meleeRat('m1', 4, 4);
    const focus   = hero('p1', 4, 5, 0);  // adjacent, full HP — the focus
    const wounded = hero('p2', 5, 5, 2);  // adjacent, 1/3 HP — normally preferred
    // Without focus the rat would bite p2 (equal distance, lower HP).
    expect(chooseMonsterActions(m, mapBy(m, focus, wounded), grid))
      .toEqual([{ kind: 'normal_attack', targetId: 'p2' }]);
    // With focus on p1 it ignores the juicier p2 and bites p1.
    expect(chooseMonsterActions(m, mapBy(m, focus, wounded), grid, MONSTER_MOVE_BUDGET, [], asCharacterId('p1')))
      .toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });

  it('ignores an adjacent hero to MOVE toward the (farther) focus target', () => {
    const grid = new Grid(empty(8, 3));
    const m     = meleeRat('m1', 0, 1);
    const near  = hero('p2', 0, 2, 0);   // adjacent — would normally be bitten
    const focus = hero('p1', 4, 1, 0);   // far; reachable in 3 steps
    const actions = chooseMonsterActions(m, mapBy(m, near, focus), grid, MONSTER_MOVE_BUDGET, [], asCharacterId('p1'));
    expect(actions).toHaveLength(2);
    expect(actions[0]!.kind).toBe('move');
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p1' });
  });

  it('can target an IMMOBILIZED captive (the bound prey is a valid focus)', () => {
    const grid = new Grid(empty(8, 8));
    const m     = meleeRat('m1', 4, 4);
    const elara = bound('p3_healer', 4, 5);   // adjacent, bound
    const free  = hero('p2', 3, 4, 0);       // adjacent, mobile
    const actions = chooseMonsterActions(m, mapBy(m, elara, free), grid, MONSTER_MOVE_BUDGET, [], asCharacterId('p3_healer'));
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p3_healer' }]);
  });

  it('falls back to normal targeting when the focus target is KO\'d', () => {
    const grid = new Grid(empty(8, 8));
    const m      = meleeRat('m1', 4, 4);
    const downed = hero('p1', 4, 5, 3);  // KO'd — invalid focus
    const live   = hero('p2', 6, 4, 0);  // chebyshev 2, alive
    const actions = chooseMonsterActions(m, mapBy(m, downed, live), grid, MONSTER_MOVE_BUDGET, [], asCharacterId('p1'));
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({ kind: 'normal_attack', targetId: 'p2' });
  });

  it('falls back to normal targeting when the focus id is not on the board', () => {
    const grid = new Grid(empty(8, 8));
    const m  = meleeRat('m1', 5, 5);
    const h1 = hero('p1', 5, 6);  // adjacent
    const actions = chooseMonsterActions(m, mapBy(m, h1), grid, MONSTER_MOVE_BUDGET, [], asCharacterId('ghost'));
    expect(actions).toEqual([{ kind: 'normal_attack', targetId: 'p1' }]);
  });

  it('cheese bait still out-prioritizes the focus (the lure pulls the pack off)', () => {
    const grid = new Grid(empty(10, 3));
    const m     = meleeRat('m1', 2, 1);
    const focus = hero('p1', 3, 1);   // adjacent focus — would be bitten
    const bait  = { x: 6, y: 1 };
    const actions = chooseMonsterActions(m, mapBy(m, focus), grid, MONSTER_MOVE_BUDGET, [bait], asCharacterId('p1'));
    // Goes for the cheese, not the focus.
    expect(actions.some((a) => a.kind === 'normal_attack')).toBe(false);
    expect(actions[0]!.kind).toBe('move');
  });
});
