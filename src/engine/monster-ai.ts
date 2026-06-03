import type { Character } from './character.js';
import type { CharacterId } from './ids.js';
import type { PlayerAction } from './action.js';
import type { Grid, MoveContext } from './grid.js';
import type { Square } from './primitives.js';
import { chebyshevDistance } from './primitives.js';

/**
 * Engine-level movement budget per turn. Mirrors the constant in
 * `GameEngine.handleMove` so the AI never proposes a path the engine would
 * reject as `insufficient-movement`.
 */
export const MONSTER_MOVE_BUDGET = 4;

/**
 * Pure deterministic "dumb AI" monster turn planner.
 *
 * Doctrine: a monster simply goes for the NEAREST reachable enemy and bites it,
 * using lowest remaining HP as the tie-break (then character id ascending for
 * replay-stability). No flanking, no kiting, no self-preservation.
 *
 * Strategy (in order):
 *   1. If at least one non-KO enemy is in attack range from the monster's
 *      current cell, attack the nearest such enemy (smallest chebyshev
 *      distance), breaking ties by lowest remaining HP, then id.
 *   2. Else, find the enemy reachable in the FEWEST move steps (nearest
 *      reachable) and move there + attack. Equally-near targets are broken by
 *      lowest remaining HP, then id.
 *   3. Else, step toward the closest enemy as far as movement allows.
 *   4. Else end_turn.
 *
 * The returned actions are submitted to the engine in order; the orchestrator
 * stops at the first action whose result is `turnEnded: true`.
 *
 * This is a deterministic helper only — no LLM call, no randomness. It exists
 * so monster turns aren't dead air during combat. A future Layer can replace
 * this with an LLM-driven controller without changing the orchestrator
 * contract (still returns `PlayerAction[]`).
 *
 * BAIT override: when `baitCells` is non-empty (a hero has thrown cheese onto
 * the grid), the monster ABANDONS the heroes and scrambles for the nearest
 * cheese — but only if it can make progress toward one this turn. An
 * unreachable lure does not freeze it; it then fights normally. The engine
 * consumes the cheese when a monster lands on its cell (see `handleMove`).
 *
 * FOCUS override: when `focusTargetId` names a character that is itself a valid
 * live enemy (different kind, on-board, not KO'd), the monster FIXATES on it —
 * the other enemies are ignored for steps 1–3, so the pack single-out one
 * target (e.g. the bound captive Elara from round 2 onward; the orchestrator
 * decides WHEN by gating on `turn.roundNumber`). If the named target is KO'd /
 * off-board / absent the monster falls back to normal nearest-reachable
 * targeting. Cheese bait still takes priority over the focus, so a thrown lure
 * can pull the fixated pack off its target.
 */
export const chooseMonsterActions = (
  monster: Character,
  characters: ReadonlyMap<CharacterId, Character>,
  grid: Grid,
  movementBudget: number = MONSTER_MOVE_BUDGET,
  baitCells: ReadonlyArray<Square> = [],
  focusTargetId?: CharacterId,
): PlayerAction[] => {
  if (!monster.pos) return [{ kind: 'end_turn' }];

  // Cheese on the ground out-prioritizes the heroes: head for the nearest wheel
  // if a step toward it is possible. Falls through to normal targeting when the
  // bait is unreachable (no progress), so an unreachable lure doesn't freeze
  // the monster.
  if (baitCells.length > 0) {
    const here = monster.pos;
    const nearestBait = baitCells.reduce((best, b) =>
      chebyshevDistance(here, b) < chebyshevDistance(here, best) ? b : best,
    );
    const baitPlan = planStepToward(monster, characters, grid, movementBudget, nearestBait);
    if (baitPlan) return baitPlan;
    // else: cannot approach the cheese this turn — fight normally.
  }

  // Live enemies (different kind, has a position, not KO'd) — only these are
  // valid attack targets per `GameEngine.handleNormalAttack`. An immobilized
  // captive (status 'immobilized', not 'KO') is a valid target, so a focused
  // pack can still bite the bound prey.
  const allLiveEnemies = Array.from(characters.values())
    .filter((c) =>
      c.id !== monster.id &&
      c.kind !== monster.kind &&
      c.health.status !== 'KO' &&
      c.pos != null,
    )
    .sort(byMostWoundedThenId);
  if (allLiveEnemies.length === 0) return [{ kind: 'end_turn' }];

  // FOCUS override: fixate on the named target when it is itself a valid live
  // enemy. Restricting the candidate set to that one character makes every
  // targeting step below single it out; if it isn't a live enemy (KO'd / gone)
  // we leave the full set in place and target normally.
  let liveEnemies = allLiveEnemies;
  if (focusTargetId != null) {
    const focus = allLiveEnemies.find((e) => e.id === focusTargetId);
    if (focus) liveEnemies = [focus];
  }

  const range = monster.normalAttack.range;
  const attackKind = monster.normalAttack.kind;
  const here = monster.pos;

  // Step 1: attack from the current cell. Among every enemy already in range,
  // bite the NEAREST one (smallest chebyshev distance), breaking ties by lowest
  // remaining HP, then id — "the nearest reachable target with the lowest HP".
  const inRangeNow = liveEnemies.filter((e) =>
    canAttackFrom(here, e.pos!, attackKind, range, grid),
  );
  if (inRangeNow.length > 0) {
    const target = inRangeNow.reduce((best, e) =>
      byNearestThenWounded(e, best, here) < 0 ? e : best,
    );
    return [{ kind: 'normal_attack', targetId: target.id }];
  }

  // Build the engine-equivalent passability context. Match `handleMove`
  // exactly: any live character — a different-kind enemy OR a same-kind ally
  // (another monster) — blocks every cell, transit or end. No passing through.
  const ctx = buildMoveContext(monster, characters);
  const reachable = grid.reachable(monster.pos, movementBudget, ctx);

  // Step 2: move-then-attack. For every enemy, find the shortest reachable cell
  // from which the monster could land an attack, then pick the target requiring
  // the FEWEST move steps — the nearest reachable enemy. Because `liveEnemies`
  // is pre-sorted lowest-HP-first, scanning in that order and only replacing on
  // a strictly shorter path makes "lowest HP" the tie-break between targets that
  // are equally near (a healthy adjacent enemy still beats a dying one across
  // the map, since nearness is the primary key).
  let plan: { dest: Square; targetId: CharacterId; pathLen: number } | null = null;
  for (const target of liveEnemies) {
    let best: { dest: Square; pathLen: number } | null = null;
    for (const cellKey of reachable) {
      const dest = parseCellKey(cellKey);
      if (!canAttackFrom(dest, target.pos!, attackKind, range, grid)) continue;
      const path = grid.shortestPath(monster.pos, dest, movementBudget, ctx);
      if (!path || path.length < 2) continue;
      if (!best || path.length < best.pathLen) best = { dest, pathLen: path.length };
    }
    if (best && (!plan || best.pathLen < plan.pathLen)) {
      plan = { dest: best.dest, targetId: target.id, pathLen: best.pathLen };
    }
  }
  if (plan) {
    const path = grid.shortestPath(monster.pos, plan.dest, movementBudget, ctx)!;
    return [{ kind: 'move', path }, { kind: 'normal_attack', targetId: plan.targetId }];
  }

  // Step 3: close distance toward the nearest enemy, no attack possible
  // this turn. Pick the reachable cell minimising chebyshev distance to the
  // closest enemy (target chosen first, then the destination optimised for
  // that target).
  const nearestEnemy = liveEnemies.reduce<{ enemy: Character; dist: number } | null>(
    (best, e) => {
      const d = chebyshevDistance(here, e.pos!);
      return !best || d < best.dist ? { enemy: e, dist: d } : best;
    },
    null,
  );
  if (nearestEnemy) {
    let bestStep: { dest: Square; dist: number; pathLen: number } | null = null;
    for (const cellKey of reachable) {
      const dest = parseCellKey(cellKey);
      const d = chebyshevDistance(dest, nearestEnemy.enemy.pos!);
      if (d >= nearestEnemy.dist) continue;  // no progress
      const path = grid.shortestPath(monster.pos, dest, movementBudget, ctx);
      if (!path || path.length < 2) continue;
      if (!bestStep ||
          d < bestStep.dist ||
          (d === bestStep.dist && path.length < bestStep.pathLen)) {
        bestStep = { dest, dist: d, pathLen: path.length };
      }
    }
    if (bestStep) {
      const path = grid.shortestPath(monster.pos, bestStep.dest, movementBudget, ctx)!;
      return [{ kind: 'move', path }, { kind: 'end_turn' }];
    }
  }

  return [{ kind: 'end_turn' }];
};

/**
 * Plan a [move, end_turn] toward `target` (e.g. a cheese-bait cell): pick the
 * reachable cell that minimises Chebyshev distance to the target and makes
 * STRICT progress (closer than the monster currently is), ties broken by the
 * shorter path. If the target cell itself is reachable it wins (distance 0) —
 * the monster steps onto it and the engine eats the cheese. Returns null when
 * no progress is possible (target unreachable / fully blocked), so the caller
 * can fall back to normal targeting. Mirrors the passability rules in
 * `chooseMonsterActions` step 3.
 */
const planStepToward = (
  monster: Character,
  characters: ReadonlyMap<CharacterId, Character>,
  grid: Grid,
  movementBudget: number,
  target: Square,
): PlayerAction[] | null => {
  const here = monster.pos!;
  const curDist = chebyshevDistance(here, target);
  if (curDist === 0) return [{ kind: 'end_turn' }]; // already on it (defensive)

  const ctx = buildMoveContext(monster, characters);
  const reachable = grid.reachable(here, movementBudget, ctx);
  let best: { dest: Square; dist: number; pathLen: number } | null = null;
  for (const cellKey of reachable) {
    const dest = parseCellKey(cellKey);
    const d = chebyshevDistance(dest, target);
    if (d >= curDist) continue; // require progress
    const path = grid.shortestPath(here, dest, movementBudget, ctx);
    if (!path || path.length < 2) continue;
    if (!best || d < best.dist || (d === best.dist && path.length < best.pathLen)) {
      best = { dest, dist: d, pathLen: path.length };
    }
  }
  if (best) {
    const path = grid.shortestPath(here, best.dest, movementBudget, ctx)!;
    return [{ kind: 'move', path }, { kind: 'end_turn' }];
  }
  return null;
};

const byMostWoundedThenId = (a: Character, b: Character): number => {
  const aRem = a.health.total - a.health.damage;
  const bRem = b.health.total - b.health.damage;
  if (aRem !== bRem) return aRem - bRem;
  return String(a.id).localeCompare(String(b.id));
};

/**
 * Order two candidate targets by "nearest, then most-wounded" relative to
 * `from`: smaller chebyshev distance wins; ties broken by lowest remaining HP,
 * then character id ascending. Returns <0 if `a` should be preferred over `b`.
 */
const byNearestThenWounded = (a: Character, b: Character, from: Square): number => {
  const da = chebyshevDistance(from, a.pos!);
  const db = chebyshevDistance(from, b.pos!);
  if (da !== db) return da - db;
  return byMostWoundedThenId(a, b);
};

const canAttackFrom = (
  from: Square, to: Square, kind: 'melee' | 'ranged' | 'magic',
  range: number, grid: Grid,
): boolean => {
  const d = chebyshevDistance(from, to);
  if (d === 0 || d > range) return false;
  if (kind === 'melee') return true;
  // Ranged / magic: engine requires line of sight (cover allowed).
  return !grid.lineOfSight(from, to).blocked;
};

const buildMoveContext = (
  monster: Character,
  characters: ReadonlyMap<CharacterId, Character>,
): MoveContext => {
  const enemyPositions = new Set<string>();
  const allyPositions = new Set<string>();
  for (const c of characters.values()) {
    if (c.id === monster.id || !c.pos) continue;
    // Corpses don't block — KO'd characters are walkthrough so a monster
    // (or hero) can step over a fallen rat instead of routing around it.
    if (c.health.status === 'KO') continue;
    const k = `${c.pos.x},${c.pos.y}`;
    if (c.kind === monster.kind) allyPositions.add(k);
    else enemyPositions.add(k);
  }
  return { enemyPositions, allyPositions };
};

const parseCellKey = (k: string): Square => {
  const [x, y] = k.split(',').map(Number);
  return { x: x!, y: y! };
};
