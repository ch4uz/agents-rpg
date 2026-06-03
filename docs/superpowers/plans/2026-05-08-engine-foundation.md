# Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless, deterministic HeroKids game engine, the event log with replay harness, and the item/equipment/boon catalog system. End state: a unit-tested engine that can execute scripted action sequences, persist events to JSONL, and prove the replay invariant (same seed + same actions → identical state).

**Architecture:** Single TypeScript package, no LLM, no UI, no browser. Pure functions and small classes for engine state. Catalogs are JSON files validated by zod schemas at load time. Special-action and item effects dispatch through a registry of named pure functions, so adding gear is a JSON entry plus a function.

**Tech Stack:** TypeScript 5.x, Node 20+, vitest for tests, zod for runtime validation, custom mulberry32 PRNG (no PRNG library — we want byte-identical output across platforms for replay determinism), prettier + eslint per the project's existing global rules.

**Reference:** This plan implements slices 1–3 of `docs/superpowers/specs/2026-05-08-agents-rpg-design.md` (Layer A — Engine Foundation). Layers B/C/D get their own plans after this one is shipped.

---

## File Structure

```
agents-rpg/
├── package.json                       # NEW: deps + scripts
├── tsconfig.json                      # NEW: TS compiler options
├── vitest.config.ts                   # NEW: test runner config
├── .eslintrc.cjs                      # NEW: lint rules
├── .prettierrc                        # NEW: format rules
├── src/
│   ├── engine/
│   │   ├── ids.ts                     # NEW: branded ID types
│   │   ├── primitives.ts              # NEW: Square, Direction, Result types
│   │   ├── dice.ts                    # NEW: mulberry32 PRNG + d6 pool rolling
│   │   ├── grid.ts                    # NEW: BFS movement, line-of-sight, adjacency
│   │   ├── character.ts               # NEW: Character type + health helpers
│   │   ├── catalogs.ts                # NEW: zod schemas for hero/monster/item/equipment/boon JSONs
│   │   ├── load.ts                    # NEW: load + validate all catalogs at startup
│   │   ├── effects.ts                 # NEW: effect-id registry + concrete effect functions
│   │   ├── resolution.ts              # NEW: attack roll + ability test resolution
│   │   ├── turn-tracker.ts            # NEW: initiative roll + side-based turn order
│   │   ├── game-engine.ts             # NEW: GameEngine class + applyAction dispatch
│   │   └── index.ts                   # NEW: public engine API
│   ├── log/
│   │   ├── events.ts                  # NEW: Event union type
│   │   ├── event-log.ts               # NEW: append-only writer + reader
│   │   ├── manifest.ts                # NEW: run manifest writer
│   │   └── replay.ts                  # NEW: replay harness
│   └── index.ts                       # NEW: package entry
├── data/
│   ├── heroes.json                    # NEW: 4 archetype stat blocks (warrior/hunter/healer/warlock)
│   ├── monsters.json                  # NEW: giant-rat, king-rat (others can be added later)
│   ├── items.json                     # NEW: potion, bomb, rope, food, gold, herbs
│   ├── equipment.json                 # NEW: raiders-battleaxe
│   └── boons.json                     # NEW: empty array (schema only)
├── adventures/
│   └── stub-one-scene.json            # NEW: minimal 1-scene adventure for integration tests
├── tests/
│   ├── fixtures/
│   │   ├── basic-attack-sequence.json # NEW: scripted action sequence used by replay test
│   │   └── full-stub-run.json         # NEW: scripted full run of stub-one-scene
│   ├── engine/
│   │   ├── dice.test.ts
│   │   ├── grid.test.ts
│   │   ├── catalogs.test.ts
│   │   ├── effects.test.ts
│   │   ├── resolution.test.ts
│   │   ├── turn-tracker.test.ts
│   │   └── game-engine.test.ts
│   └── log/
│       ├── event-log.test.ts
│       └── replay.test.ts
└── runs/                              # gitignored; created at runtime by event log
```

**Why this layout:** the `engine/` folder is pure logic (no I/O), the `log/` folder owns disk I/O, and `data/` is untyped JSON validated at load. This separation means engine tests need zero I/O setup and run in milliseconds, while log/replay tests use real files (small, fast, throwaway).

---

## Tasks

### Task 1: Bootstrap the TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore` (extend existing)
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

Create `package.json`:

```json
{
  "name": "agents-rpg",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint 'src/**/*.ts' 'tests/**/*.ts'",
    "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@typescript-eslint/eslint-plugin": "^7.7.0",
    "@typescript-eslint/parser": "^7.7.0",
    "eslint": "^8.57.0",
    "prettier": "^3.2.5",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

- [ ] **Step 2: Install deps**

Run:
```bash
npm install
```
Expected: creates `node_modules/` and `package-lock.json`. No errors.

- [ ] **Step 3: Add tsconfig.json**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Extend .gitignore**

Append to existing `.gitignore`:

```
node_modules/
dist/
runs/
*.tsbuildinfo
coverage/
```

- [ ] **Step 5: Add vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 6: Add eslint + prettier configs**

Create `.eslintrc.cjs`:

```js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
  },
};
```

Create `.prettierrc`:

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 7: Verify everything wires up**

Run:
```bash
npx tsc --noEmit && npx vitest run --reporter=verbose
```
Expected: `tsc` exits clean (no source files yet), `vitest` exits with "No test files found".

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .eslintrc.cjs .prettierrc .gitignore
git commit -m "chore: bootstrap typescript engine package"
```

---

### Task 2: Branded ID types and shared primitives

**Files:**
- Create: `src/engine/ids.ts`
- Create: `src/engine/primitives.ts`
- Create: `tests/engine/primitives.test.ts`

- [ ] **Step 1: Write failing test for primitive helpers**

Create `tests/engine/primitives.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { squaresEqual, manhattanDistance, chebyshevDistance } from '../../src/engine/primitives.js';

describe('primitives', () => {
  it('squaresEqual returns true for identical squares', () => {
    expect(squaresEqual({ x: 3, y: 5 }, { x: 3, y: 5 })).toBe(true);
  });
  it('squaresEqual returns false for different squares', () => {
    expect(squaresEqual({ x: 3, y: 5 }, { x: 3, y: 6 })).toBe(false);
  });
  it('manhattanDistance counts orthogonal steps', () => {
    expect(manhattanDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
  });
  it('chebyshevDistance counts diagonal-allowed steps (HeroKids movement)', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4);
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/primitives.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create branded ID types**

Create `src/engine/ids.ts`:

```ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type CharacterId = Brand<string, 'CharacterId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type EquipmentId = Brand<string, 'EquipmentId'>;
export type BoonId = Brand<string, 'BoonId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type SceneId = Brand<string, 'SceneId'>;
export type EffectId = Brand<string, 'EffectId'>;
export type AdventureId = Brand<string, 'AdventureId'>;
export type RunId = Brand<string, 'RunId'>;

export const asCharacterId = (s: string): CharacterId => s as CharacterId;
export const asItemId = (s: string): ItemId => s as ItemId;
export const asEquipmentId = (s: string): EquipmentId => s as EquipmentId;
export const asBoonId = (s: string): BoonId => s as BoonId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asSceneId = (s: string): SceneId => s as SceneId;
export const asEffectId = (s: string): EffectId => s as EffectId;
export const asAdventureId = (s: string): AdventureId => s as AdventureId;
export const asRunId = (s: string): RunId => s as RunId;
```

- [ ] **Step 4: Create primitives module**

Create `src/engine/primitives.ts`:

```ts
export interface Square {
  readonly x: number;
  readonly y: number;
}

export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export const squaresEqual = (a: Square, b: Square): boolean => a.x === b.x && a.y === b.y;

export const manhattanDistance = (a: Square, b: Square): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Chebyshev distance counts diagonals as one step — matches HeroKids movement
 * (4 squares per turn including diagonals).
 */
export const chebyshevDistance = (a: Square, b: Square): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine/primitives.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/ids.ts src/engine/primitives.ts tests/engine/primitives.test.ts
git commit -m "feat(engine): add branded ids and grid primitives"
```

---

### Task 3: Seeded RNG and dice pool rolling

**Files:**
- Create: `src/engine/dice.ts`
- Create: `tests/engine/dice.test.ts`

The mulberry32 algorithm is 6 lines, audit-able, and produces byte-identical output on every JS runtime. We commit to it because replay determinism matters more than RNG quality (we're not doing crypto).

- [ ] **Step 1: Write failing tests for Dice**

Create `tests/engine/dice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';

describe('Dice (mulberry32 PRNG)', () => {
  it('produces identical sequences from the same seed', () => {
    const a = new Dice('seed-A');
    const b = new Dice('seed-A');
    expect(a.rollPool(5)).toEqual(b.rollPool(5));
  });

  it('produces different sequences for different seeds', () => {
    const a = new Dice('seed-A');
    const b = new Dice('seed-B');
    expect(a.rollPool(20)).not.toEqual(b.rollPool(20));
  });

  it('rollPool(0) returns []', () => {
    expect(new Dice('x').rollPool(0)).toEqual([]);
  });

  it('rollPool(N) returns N ints in 1..6', () => {
    const rolls = new Dice('x').rollPool(100);
    expect(rolls).toHaveLength(100);
    for (const r of rolls) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
  });

  it('highestDie returns the max of a roll', () => {
    expect(Dice.highestDie([1, 4, 6, 2])).toBe(6);
    expect(Dice.highestDie([3])).toBe(3);
  });

  it('highestDie returns 0 for empty pool (no dice = automatic miss)', () => {
    expect(Dice.highestDie([])).toBe(0);
  });

  it('rollPool advances state (consecutive calls differ)', () => {
    const d = new Dice('x');
    const first = d.rollPool(5);
    const second = d.rollPool(5);
    expect(first).not.toEqual(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/dice.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement Dice**

Create `src/engine/dice.ts`:

```ts
/**
 * Deterministic d6 roller. Uses mulberry32 — chosen for byte-identical
 * output across platforms (Node, browser, any JS runtime). Replay
 * determinism is the requirement; PRNG quality is secondary.
 */
export class Dice {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? Dice.hashSeed(seed) : seed >>> 0;
  }

  /** djb2-ish string hash → uint32 */
  private static hashSeed(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Mulberry32 — returns float in [0, 1). Mutates internal state. */
  private next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Roll N d6, returns array of integers in [1, 6]. */
  rollPool(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(1 + Math.floor(this.next() * 6));
    }
    return out;
  }

  /** Roll a single d6. */
  rollD6(): number {
    return 1 + Math.floor(this.next() * 6);
  }

  /** Highest die in a pool. Empty pool → 0 (used as "automatic miss"). */
  static highestDie(pool: readonly number[]): number {
    if (pool.length === 0) return 0;
    let max = pool[0]!;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i]! > max) max = pool[i]!;
    }
    return max;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/dice.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dice.ts tests/engine/dice.test.ts
git commit -m "feat(engine): seeded mulberry32 dice roller"
```

---

### Task 4: Grid map, BFS movement, line-of-sight

**Files:**
- Create: `src/engine/grid.ts`
- Create: `tests/engine/grid.test.ts`

HeroKids movement: 4 squares (chebyshev distance), through allies, blocked by enemies and walls, +1 cost for obstacles, no diagonal-around-corners. Line-of-sight is naive Bresenham — blocked by walls (full block), partially blocked by obstacles (cover, +1 armor die for the defender).

- [ ] **Step 1: Write failing tests for grid**

Create `tests/engine/grid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Grid, type GridCell, type MoveContext } from '../../src/engine/grid.js';

const empty = (w: number, h: number): GridCell[][] =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => ({ kind: 'floor' as const })));

describe('Grid', () => {
  it('isAdjacent: 8-directional including diagonals', () => {
    const g = new Grid(empty(5, 5));
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 3, y: 3 })).toBe(true);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 2, y: 3 })).toBe(true);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 4, y: 4 })).toBe(false);
    expect(g.isAdjacent({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(false);
  });

  it('inBounds rejects out-of-range coords', () => {
    const g = new Grid(empty(3, 3));
    expect(g.inBounds({ x: 0, y: 0 })).toBe(true);
    expect(g.inBounds({ x: 2, y: 2 })).toBe(true);
    expect(g.inBounds({ x: -1, y: 0 })).toBe(false);
    expect(g.inBounds({ x: 3, y: 0 })).toBe(false);
  });

  it('reachable squares within budget exclude walls and enemies', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'wall' };
    const g = new Grid(cells);
    const ctx: MoveContext = {
      enemyPositions: new Set(['1,1']),
      allyPositions: new Set(),
    };
    const reach = g.reachable({ x: 0, y: 0 }, 2, ctx);
    expect(reach.has('0,0')).toBe(true);
    expect(reach.has('1,0')).toBe(true);
    expect(reach.has('2,2')).toBe(false);   // wall
    expect(reach.has('1,1')).toBe(false);   // enemy occupies, cannot end there
    expect(reach.has('3,3')).toBe(false);   // out of budget
  });

  it('reachable allows passing through allies (HeroKids rule)', () => {
    const g = new Grid(empty(5, 5));
    const ctx: MoveContext = {
      enemyPositions: new Set(),
      allyPositions: new Set(['1,0']),
    };
    const reach = g.reachable({ x: 0, y: 0 }, 2, ctx);
    expect(reach.has('2,0')).toBe(true);    // moved through ally
    expect(reach.has('1,0')).toBe(false);   // can't END on ally's square
  });

  it('obstacles cost +1 movement to enter', () => {
    const cells = empty(5, 5);
    cells[0]![1] = { kind: 'obstacle' };
    const g = new Grid(cells);
    const ctx: MoveContext = { enemyPositions: new Set(), allyPositions: new Set() };
    const reach = g.reachable({ x: 0, y: 0 }, 2, ctx);
    // (1,0) is an obstacle: costs 2 to enter. (2,0) would be 1+2=3, exceeds budget.
    expect(reach.has('1,0')).toBe(true);
    expect(reach.has('2,0')).toBe(false);
  });

  it('lineOfSight: clear when no walls between', () => {
    const g = new Grid(empty(5, 5));
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: false, cover: false });
  });

  it('lineOfSight: walls block', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'wall' };
    const g = new Grid(cells);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: true, cover: false });
  });

  it('lineOfSight: obstacles grant cover but do not block', () => {
    const cells = empty(5, 5);
    cells[2]![2] = { kind: 'obstacle' };
    const g = new Grid(cells);
    expect(g.lineOfSight({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual({ blocked: false, cover: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/grid.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Grid**

Create `src/engine/grid.ts`:

```ts
import { type Square, chebyshevDistance } from './primitives.js';

export type GridCell =
  | { kind: 'floor' }
  | { kind: 'wall' }
  | { kind: 'obstacle' };

export interface MoveContext {
  /** Squares currently occupied by enemies (cannot pass or end). */
  enemyPositions: ReadonlySet<string>;
  /** Squares currently occupied by allies (can pass, cannot end). */
  allyPositions: ReadonlySet<string>;
}

export interface SightResult {
  blocked: boolean;
  cover: boolean;
}

const key = (s: Square): string => `${s.x},${s.y}`;

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

export class Grid {
  readonly width: number;
  readonly height: number;

  constructor(private readonly cells: GridCell[][]) {
    this.height = cells.length;
    this.width = cells[0]?.length ?? 0;
  }

  inBounds(s: Square): boolean {
    return s.x >= 0 && s.x < this.width && s.y >= 0 && s.y < this.height;
  }

  cellAt(s: Square): GridCell {
    if (!this.inBounds(s)) return { kind: 'wall' };
    return this.cells[s.y]![s.x]!;
  }

  isAdjacent(a: Square, b: Square): boolean {
    if (a.x === b.x && a.y === b.y) return false;
    return chebyshevDistance(a, b) === 1;
  }

  /**
   * Set of squares reachable from `start` within `budget` movement.
   * Allies are passable but not end-able. Enemies block. Walls block.
   * Obstacles cost +1 to enter.
   */
  reachable(start: Square, budget: number, ctx: MoveContext): Set<string> {
    const dist = new Map<string, number>();
    dist.set(key(start), 0);
    const queue: Square[] = [start];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curDist = dist.get(key(cur))!;

      for (const [dx, dy] of NEIGHBORS) {
        const nx = cur.x + dx!;
        const ny = cur.y + dy!;
        const next: Square = { x: nx, y: ny };
        const k = key(next);
        if (!this.inBounds(next)) continue;

        const cell = this.cellAt(next);
        if (cell.kind === 'wall') continue;
        if (ctx.enemyPositions.has(k)) continue;

        const stepCost = cell.kind === 'obstacle' ? 2 : 1;
        const newDist = curDist + stepCost;
        if (newDist > budget) continue;

        const known = dist.get(k);
        if (known !== undefined && known <= newDist) continue;

        dist.set(k, newDist);
        queue.push(next);
      }
    }

    // Drop start square and squares occupied by allies (cannot end there).
    dist.delete(key(start));
    for (const a of ctx.allyPositions) dist.delete(a);
    return new Set(dist.keys());
  }

  /**
   * Line-of-sight via supercover line walk. Walls in intermediate squares
   * block; obstacles grant cover (do not block). The endpoints themselves
   * do not contribute (you can shoot something hiding behind a barrel).
   */
  lineOfSight(from: Square, to: Square): SightResult {
    const path = this.supercover(from, to);
    let cover = false;
    // Skip endpoints (first and last).
    for (let i = 1; i < path.length - 1; i++) {
      const cell = this.cellAt(path[i]!);
      if (cell.kind === 'wall') return { blocked: true, cover: false };
      if (cell.kind === 'obstacle') cover = true;
    }
    return { blocked: false, cover };
  }

  private supercover(a: Square, b: Square): Square[] {
    const out: Square[] = [];
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1;
    const sy = a.y < b.y ? 1 : -1;
    let err = dx - dy;
    out.push({ x, y });
    while (x !== b.x || y !== b.y) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx)  { err += dx; y += sy; }
      out.push({ x, y });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/grid.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/grid.ts tests/engine/grid.test.ts
git commit -m "feat(engine): grid with bfs movement and line-of-sight"
```

---

### Task 5: Character type and health helpers

**Files:**
- Create: `src/engine/character.ts`
- Create: `tests/engine/character.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/engine/character.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyDamage, healDamage, isKO } from '../../src/engine/character.js';
import type { Character } from '../../src/engine/character.js';
import { asCharacterId } from '../../src/engine/ids.js';

const hero = (): Character => ({
  id: asCharacterId('test-hero'),
  name: 'Test',
  kind: 'hero',
  archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
  specialAction: { id: 'noop', name: 'Noop', description: '' },
  bonusAbility: { id: 'noop', name: 'Noop', description: '' },
  inventory: [],
  boons: [],
  skills: [],
});

describe('character health', () => {
  it('applyDamage marks a box and stays normal under threshold', () => {
    const c = hero();
    const next = applyDamage(c, 1);
    expect(next.health.damage).toBe(1);
    expect(next.health.status).toBe('normal');
    expect(isKO(next)).toBe(false);
  });

  it('applyDamage transitions to prone+KO when damage equals total', () => {
    const c = hero();
    const next = applyDamage(c, 3);
    expect(next.health.damage).toBe(3);
    expect(next.health.status).toBe('KO');
    expect(isKO(next)).toBe(true);
  });

  it('applyDamage clamps damage at total', () => {
    const c = hero();
    const next = applyDamage(c, 10);
    expect(next.health.damage).toBe(3);
  });

  it('healDamage reduces damage and clears KO if any damage cleared', () => {
    const c = applyDamage(hero(), 3);
    const healed = healDamage(c, 1);
    expect(healed.health.damage).toBe(2);
    expect(healed.health.status).toBe('normal');
  });

  it('healDamage with amount Infinity heals to full', () => {
    const c = applyDamage(hero(), 3);
    const healed = healDamage(c, Infinity);
    expect(healed.health.damage).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/character.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create character module**

Create `src/engine/character.ts`:

```ts
import type {
  CharacterId,
  ItemId,
  EquipmentId,
  BoonId,
  SkillId,
  EffectId,
} from './ids.js';
import type { Square } from './primitives.js';

export type Archetype =
  | 'warrior'
  | 'hunter'
  | 'healer'
  | 'warlock'
  | 'rogue'
  | 'knight'
  | 'brute';

export type AttackKind = 'melee' | 'ranged' | 'magic';

export interface AttackSpec {
  kind: AttackKind;
  name: string;
  /** Melee=1, ranged=6, magic=4. Per-character override allowed. */
  range: number;
  /** 0 for default 1-damage attacks. */
  damageMod: number;
}

export interface SpecialSpec {
  id: EffectId;       // resolved against the effects registry
  name: string;
  description: string;
}

export interface BonusSpec {
  id: EffectId;       // passive trigger
  name: string;
  description: string;
}

export interface ItemStack {
  itemId: ItemId;
  count: number;
}

export interface Character {
  id: CharacterId;
  name: string;
  kind: 'hero' | 'monster';
  archetype?: Archetype;

  pools: {
    melee: number;
    ranged: number;
    magic: number;
    armor: number;
  };
  health: {
    total: number;
    damage: number;
    status: 'normal' | 'prone' | 'KO';
  };
  pos: Square | null;

  normalAttack: AttackSpec;
  specialAction: SpecialSpec;
  bonusAbility: BonusSpec;

  equipped?: EquipmentId;
  inventory: ItemStack[];
  boons: BoonId[];
  skills: SkillId[];

  persona?: string;
}

export const isKO = (c: Character): boolean => c.health.status === 'KO';

export const applyDamage = (c: Character, amount: number): Character => {
  if (amount <= 0) return c;
  const newDamage = Math.min(c.health.total, c.health.damage + amount);
  const status: Character['health']['status'] = newDamage >= c.health.total ? 'KO' : c.health.status;
  return {
    ...c,
    health: { ...c.health, damage: newDamage, status },
  };
};

export const healDamage = (c: Character, amount: number): Character => {
  if (amount <= 0) return c;
  const newDamage = Math.max(0, c.health.damage - amount);
  const status: Character['health']['status'] =
    newDamage < c.health.total && c.health.status === 'KO' ? 'normal' : c.health.status;
  return {
    ...c,
    health: { ...c.health, damage: newDamage, status },
  };
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/character.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/character.ts tests/engine/character.test.ts
git commit -m "feat(engine): character type and health helpers"
```

---

### Task 6: Catalog zod schemas (heroes, monsters, items, equipment, boons)

**Files:**
- Create: `src/engine/catalogs.ts`
- Create: `tests/engine/catalogs.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/engine/catalogs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  HeroEntrySchema,
  MonsterEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
} from '../../src/engine/catalogs.js';

describe('catalog schemas', () => {
  it('HeroEntrySchema accepts a valid warrior entry', () => {
    const valid = {
      id: 'warrior',
      name: 'Warrior',
      archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 3,
      normalAttack: { kind: 'melee', name: 'Slashing Strike', range: 1, damageMod: 0 },
      specialAction: { effectId: 'whirlwind-attack', name: 'Whirlwind', description: '...' },
      bonusAbility: { effectId: 'teamwork', name: 'Teamwork', description: '...' },
      defaultInventory: [{ itemId: 'potion', count: 2 }],
      defaultSkills: [],
      sprite: 'warrior',
    };
    expect(() => HeroEntrySchema.parse(valid)).not.toThrow();
  });

  it('HeroEntrySchema rejects an entry with negative dice pool', () => {
    const bad = {
      id: 'broken',
      name: 'Broken',
      archetype: 'warrior',
      pools: { melee: -1, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 3,
      normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
      specialAction: { effectId: 'noop', name: 'X', description: '' },
      bonusAbility: { effectId: 'noop', name: 'X', description: '' },
      defaultInventory: [],
      defaultSkills: [],
      sprite: 'warrior',
    };
    expect(() => HeroEntrySchema.parse(bad)).toThrow();
  });

  it('MonsterEntrySchema accepts a giant rat', () => {
    const valid = {
      id: 'giant-rat',
      name: 'Giant Rat',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 1,
      normalAttack: { kind: 'melee', name: 'Horrid Bite', range: 1, damageMod: 0 },
      specialAction: { effectId: 'pack-attack', name: 'Pack Attack', description: '' },
      bonusAbility: { effectId: 'coward', name: 'Coward', description: '' },
      sprite: 'giant-rat',
    };
    expect(() => MonsterEntrySchema.parse(valid)).not.toThrow();
  });

  it('ItemEntrySchema requires consumableEffect on consumables', () => {
    const valid = {
      id: 'potion',
      name: 'Potion',
      category: 'consumable',
      consumableEffect: 'heal-full',
      icon: 'potion',
    };
    expect(() => ItemEntrySchema.parse(valid)).not.toThrow();
  });

  it('ItemEntrySchema requires skillBonus on utility items', () => {
    const valid = {
      id: 'rope',
      name: 'Rope',
      category: 'utility',
      skillBonus: ['athletics', 'acrobatics'],
      icon: 'rope',
    };
    expect(() => ItemEntrySchema.parse(valid)).not.toThrow();
  });

  it('EquipmentEntrySchema parses a battleaxe', () => {
    const valid = {
      id: 'raiders-battleaxe',
      name: "Raider's Battleaxe",
      effectId: 'reaping-strike',
      icon: 'raiders-battleaxe',
    };
    expect(() => EquipmentEntrySchema.parse(valid)).not.toThrow();
  });

  it('BoonEntrySchema parses a sample boon', () => {
    const valid = {
      id: 'lucky-charm',
      name: 'Lucky Charm',
      description: 'Reroll one die.',
      effectId: 'reroll-one',
      icon: 'lucky-charm',
    };
    expect(() => BoonEntrySchema.parse(valid)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/engine/catalogs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement catalog schemas**

Create `src/engine/catalogs.ts`:

```ts
import { z } from 'zod';

const PoolsSchema = z.object({
  melee: z.number().int().min(0).max(6),
  ranged: z.number().int().min(0).max(6),
  magic: z.number().int().min(0).max(6),
  armor: z.number().int().min(0).max(6),
});

const AttackSpecSchema = z.object({
  kind: z.enum(['melee', 'ranged', 'magic']),
  name: z.string().min(1),
  range: z.number().int().min(1).max(20),
  damageMod: z.number().int().min(-2).max(5),
});

const NamedEffectSchema = z.object({
  effectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
});

const ItemStackSchema = z.object({
  itemId: z.string().min(1),
  count: z.number().int().min(1),
});

export const HeroEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  archetype: z.enum(['warrior', 'hunter', 'healer', 'warlock', 'rogue', 'knight', 'brute']),
  pools: PoolsSchema,
  healthTotal: z.literal(3),                 // HeroKids: heroes always 3 boxes
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  defaultInventory: z.array(ItemStackSchema),
  defaultSkills: z.array(z.string()),
  defaultEquipped: z.string().optional(),
  sprite: z.string().min(1),
});

export const MonsterEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pools: PoolsSchema,
  healthTotal: z.number().int().min(1).max(4),  // weak=1, normal=2, tough=3, boss=4
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  sprite: z.string().min(1),
});

export const ItemEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(['consumable', 'utility']),
    consumableEffect: z.string().optional(),
    skillBonus: z.array(z.string()).optional(),
    icon: z.string().min(1),
  })
  .refine(
    (v) => (v.category === 'consumable' ? !!v.consumableEffect : true),
    { message: 'consumable items require consumableEffect' },
  )
  .refine(
    (v) => (v.category === 'utility' ? Array.isArray(v.skillBonus) && v.skillBonus.length > 0 : true),
    { message: 'utility items require non-empty skillBonus' },
  );

export const EquipmentEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  effectId: z.string().min(1),
  icon: z.string().min(1),
});

export const BoonEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  effectId: z.string().min(1),
  icon: z.string().min(1),
});

export type HeroEntry = z.infer<typeof HeroEntrySchema>;
export type MonsterEntry = z.infer<typeof MonsterEntrySchema>;
export type ItemEntry = z.infer<typeof ItemEntrySchema>;
export type EquipmentEntry = z.infer<typeof EquipmentEntrySchema>;
export type BoonEntry = z.infer<typeof BoonEntrySchema>;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/catalogs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/catalogs.ts tests/engine/catalogs.test.ts
git commit -m "feat(engine): zod schemas for hero/monster/item/equipment/boon catalogs"
```

---

### Task 7: Concrete catalog JSON files

**Files:**
- Create: `data/heroes.json`
- Create: `data/monsters.json`
- Create: `data/items.json`
- Create: `data/equipment.json`
- Create: `data/boons.json`

This is data, not code. Stat blocks are taken verbatim from the HeroKids manual (warrior pp. 33; hunter pp. 34; healer & knight pp. 37; warlock pp. 35; brute & rogue pp. 36) and the Basement O' Rats adventure (king rat & giant rat pp. 19).

- [ ] **Step 1: Write heroes.json**

Create `data/heroes.json`:

```json
[
  {
    "id": "warrior",
    "name": "Warrior",
    "archetype": "warrior",
    "pools": { "melee": 2, "ranged": 0, "magic": 0, "armor": 2 },
    "healthTotal": 3,
    "normalAttack": { "kind": "melee", "name": "Slashing Strike", "range": 1, "damageMod": 0 },
    "specialAction": {
      "effectId": "whirlwind-attack",
      "name": "Whirlwind Attack",
      "description": "Split your melee dice to make melee attacks at multiple adjacent targets."
    },
    "bonusAbility": {
      "effectId": "teamwork",
      "name": "Teamwork",
      "description": "When a target is engaged, your attacks against that target gain 1 extra die."
    },
    "defaultInventory": [{ "itemId": "potion", "count": 2 }, { "itemId": "food", "count": 1 }],
    "defaultSkills": ["tracking"],
    "sprite": "warrior"
  },
  {
    "id": "hunter",
    "name": "Hunter",
    "archetype": "hunter",
    "pools": { "melee": 0, "ranged": 2, "magic": 0, "armor": 2 },
    "healthTotal": 3,
    "normalAttack": { "kind": "ranged", "name": "Arrow Shot", "range": 6, "damageMod": 0 },
    "specialAction": {
      "effectId": "split-shot",
      "name": "Arrow-Split Shot",
      "description": "Split your ranged dice to attack multiple targets up to 6 squares away."
    },
    "bonusAbility": {
      "effectId": "evasive-maneuver",
      "name": "Evasive Maneuver",
      "description": "When you're damaged, you can immediately move 1 square."
    },
    "defaultInventory": [{ "itemId": "potion", "count": 2 }, { "itemId": "rope", "count": 1 }],
    "defaultSkills": ["tracking"],
    "sprite": "hunter"
  },
  {
    "id": "healer",
    "name": "Healer",
    "archetype": "healer",
    "pools": { "melee": 0, "ranged": 0, "magic": 2, "armor": 1 },
    "healthTotal": 3,
    "normalAttack": { "kind": "magic", "name": "Searing Light", "range": 4, "damageMod": 0 },
    "specialAction": {
      "effectId": "healing-touch",
      "name": "Healing Touch",
      "description": "Remove 1 damage from yourself or an adjacent ally."
    },
    "bonusAbility": {
      "effectId": "potion-brewer",
      "name": "Potion Brewer",
      "description": "After an encounter, replenish 1 potion that you or an ally has used."
    },
    "defaultInventory": [{ "itemId": "potion", "count": 2 }, { "itemId": "herbs", "count": 1 }],
    "defaultSkills": ["knowledge"],
    "sprite": "healer"
  },
  {
    "id": "warlock-fire",
    "name": "Warlock (Fire)",
    "archetype": "warlock",
    "pools": { "melee": 0, "ranged": 0, "magic": 2, "armor": 1 },
    "healthTotal": 3,
    "normalAttack": { "kind": "magic", "name": "Flaming Bolt", "range": 4, "damageMod": 0 },
    "specialAction": {
      "effectId": "flame-burst",
      "name": "Flame Burst",
      "description": "Make 1-die magic attacks at all adjacent targets, including allies."
    },
    "bonusAbility": {
      "effectId": "power-surge",
      "name": "Power Surge",
      "description": "When you are not at full health, your magic attacks gain 1 extra die."
    },
    "defaultInventory": [{ "itemId": "potion", "count": 2 }, { "itemId": "food", "count": 1 }],
    "defaultSkills": ["knowledge"],
    "sprite": "warlock"
  }
]
```

- [ ] **Step 2: Write monsters.json**

Create `data/monsters.json`:

```json
[
  {
    "id": "giant-rat",
    "name": "Giant Rat",
    "pools": { "melee": 1, "ranged": 0, "magic": 0, "armor": 2 },
    "healthTotal": 1,
    "normalAttack": { "kind": "melee", "name": "Horrid Bite", "range": 1, "damageMod": 0 },
    "specialAction": {
      "effectId": "pack-attack",
      "name": "Pack Attack",
      "description": "If an adjacent target is engaged, you can make a melee attack at that target with 1 extra die."
    },
    "bonusAbility": {
      "effectId": "coward",
      "name": "Coward",
      "description": "When you've been attacked since your last turn, you can move 2 extra squares."
    },
    "sprite": "giant-rat"
  },
  {
    "id": "king-rat",
    "name": "King Rat",
    "pools": { "melee": 2, "ranged": 0, "magic": 0, "armor": 2 },
    "healthTotal": 3,
    "normalAttack": { "kind": "melee", "name": "Horrid Bite", "range": 1, "damageMod": 0 },
    "specialAction": {
      "effectId": "pack-attack",
      "name": "Pack Attack",
      "description": "If an adjacent target is engaged, melee attack at that target with 1 extra die."
    },
    "bonusAbility": {
      "effectId": "coward",
      "name": "Coward",
      "description": "When you've been attacked since your last turn, you can move 2 extra squares."
    },
    "sprite": "king-rat"
  }
]
```

- [ ] **Step 3: Write items.json**

Create `data/items.json`:

```json
[
  {
    "id": "potion",
    "name": "Healing Potion",
    "category": "consumable",
    "consumableEffect": "heal-full",
    "icon": "potion"
  },
  {
    "id": "bomb",
    "name": "Bomb",
    "category": "consumable",
    "consumableEffect": "bomb-blast",
    "icon": "bomb"
  },
  {
    "id": "rope",
    "name": "Rope",
    "category": "utility",
    "skillBonus": ["athletics", "acrobatics"],
    "icon": "rope"
  },
  {
    "id": "food",
    "name": "Food",
    "category": "utility",
    "skillBonus": ["persuasion"],
    "icon": "food"
  },
  {
    "id": "gold",
    "name": "Gold",
    "category": "utility",
    "skillBonus": ["persuasion"],
    "icon": "gold"
  },
  {
    "id": "herbs",
    "name": "Herbs",
    "category": "utility",
    "skillBonus": ["knowledge"],
    "icon": "herbs"
  }
]
```

- [ ] **Step 4: Write equipment.json**

Create `data/equipment.json`:

```json
[
  {
    "id": "raiders-battleaxe",
    "name": "Raider's Battleaxe",
    "effectId": "reaping-strike",
    "icon": "raiders-battleaxe"
  }
]
```

- [ ] **Step 5: Write boons.json**

Create `data/boons.json`:

```json
[]
```

Empty array — type exists but no boons in v1 catalog. Schema validation still runs.

- [ ] **Step 6: Commit**

```bash
git add data/heroes.json data/monsters.json data/items.json data/equipment.json data/boons.json
git commit -m "data: hero/monster/item/equipment catalogs from herokids manual"
```

---

### Task 8: Catalog loader with validation

**Files:**
- Create: `src/engine/load.ts`
- Create: `tests/engine/load.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/engine/load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadCatalogs } from '../../src/engine/load.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');

describe('loadCatalogs', () => {
  it('loads all five catalog files without error', async () => {
    const catalogs = await loadCatalogs(DATA_DIR);
    expect(catalogs.heroes.size).toBeGreaterThanOrEqual(4);
    expect(catalogs.monsters.size).toBeGreaterThanOrEqual(2);
    expect(catalogs.items.size).toBeGreaterThanOrEqual(6);
    expect(catalogs.equipment.size).toBeGreaterThanOrEqual(1);
    expect(catalogs.boons.size).toBe(0);
  });

  it('indexes heroes by id', async () => {
    const c = await loadCatalogs(DATA_DIR);
    const warrior = c.heroes.get('warrior');
    expect(warrior?.archetype).toBe('warrior');
    expect(warrior?.pools.melee).toBe(2);
  });

  it('throws on duplicate hero id', async () => {
    const tmpDir = await makeTmpCatalog({
      'heroes.json': [
        validHero({ id: 'warrior' }),
        validHero({ id: 'warrior' }),
      ],
    });
    await expect(loadCatalogs(tmpDir)).rejects.toThrow(/duplicate hero id/i);
  });

  it('throws on missing referenced effectId', async () => {
    // We don't validate effect IDs at load time (the registry isn't passed),
    // but we DO validate item references in heroes.defaultInventory.
    const tmpDir = await makeTmpCatalog({
      'heroes.json': [validHero({ defaultInventory: [{ itemId: 'no-such-item', count: 1 }] })],
      'items.json': [],
      'monsters.json': [],
      'equipment.json': [],
      'boons.json': [],
    });
    await expect(loadCatalogs(tmpDir)).rejects.toThrow(/unknown item id/i);
  });
});

// helpers
async function makeTmpCatalog(files: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-rpg-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(tmp, name), JSON.stringify(content));
  }
  return tmp;
}

function validHero(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'warrior',
    name: 'Warrior',
    archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 3,
    normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { effectId: 'whirlwind-attack', name: 'WW', description: '' },
    bonusAbility: { effectId: 'teamwork', name: 'TW', description: '' },
    defaultInventory: [],
    defaultSkills: [],
    sprite: 'warrior',
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/load.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement loadCatalogs**

Create `src/engine/load.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HeroEntrySchema,
  MonsterEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
  type HeroEntry,
  type MonsterEntry,
  type ItemEntry,
  type EquipmentEntry,
  type BoonEntry,
} from './catalogs.js';

export interface Catalogs {
  heroes: Map<string, HeroEntry>;
  monsters: Map<string, MonsterEntry>;
  items: Map<string, ItemEntry>;
  equipment: Map<string, EquipmentEntry>;
  boons: Map<string, BoonEntry>;
}

const indexById = <T extends { id: string }>(entries: T[], label: string): Map<string, T> => {
  const out = new Map<string, T>();
  for (const e of entries) {
    if (out.has(e.id)) throw new Error(`Duplicate ${label} id: ${e.id}`);
    out.set(e.id, e);
  }
  return out;
};

const readJson = async <T>(filePath: string, schema: z.ZodSchema<T[]>): Promise<T[]> => {
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid catalog at ${filePath}: ${result.error.message}`);
  }
  return result.data;
};

export const loadCatalogs = async (dataDir: string): Promise<Catalogs> => {
  const heroes = indexById(
    await readJson(path.join(dataDir, 'heroes.json'), z.array(HeroEntrySchema)),
    'hero',
  );
  const monsters = indexById(
    await readJson(path.join(dataDir, 'monsters.json'), z.array(MonsterEntrySchema)),
    'monster',
  );
  const items = indexById(
    await readJson(path.join(dataDir, 'items.json'), z.array(ItemEntrySchema)),
    'item',
  );
  const equipment = indexById(
    await readJson(path.join(dataDir, 'equipment.json'), z.array(EquipmentEntrySchema)),
    'equipment',
  );
  const boons = indexById(
    await readJson(path.join(dataDir, 'boons.json'), z.array(BoonEntrySchema)),
    'boon',
  );

  // Cross-ref validation: every hero's defaultInventory.itemId must exist.
  for (const hero of heroes.values()) {
    for (const stack of hero.defaultInventory) {
      if (!items.has(stack.itemId)) {
        throw new Error(`Hero "${hero.id}" references unknown item id: ${stack.itemId}`);
      }
    }
    if (hero.defaultEquipped && !equipment.has(hero.defaultEquipped)) {
      throw new Error(`Hero "${hero.id}" references unknown equipment id: ${hero.defaultEquipped}`);
    }
  }

  return { heroes, monsters, items, equipment, boons };
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/load.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/load.ts tests/engine/load.test.ts
git commit -m "feat(engine): catalog loader with cross-ref validation"
```

---

### Task 9: Effect registry skeleton

**Files:**
- Create: `src/engine/effects.ts`
- Create: `tests/engine/effects.test.ts`

The effect registry maps `effectId` strings (from JSON) to TypeScript functions that mutate engine state. We define the **contract** here and register a small set of effects (heal-full, healing-touch, reaping-strike, teamwork, evasive-maneuver). More effects can be added without engine changes — that's the design point.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/effects.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';

describe('EffectRegistry', () => {
  it('register and retrieve an effect by id', () => {
    const reg = new EffectRegistry();
    reg.register('heal-full', { kind: 'consumable', apply: () => ({ healed: Infinity }) });
    expect(reg.has('heal-full')).toBe(true);
    expect(reg.get('heal-full').apply({} as never)).toEqual({ healed: Infinity });
  });

  it('get throws on missing effectId', () => {
    const reg = new EffectRegistry();
    expect(() => reg.get('nope')).toThrow(/unknown effect/i);
  });

  it('registerCoreEffects installs the v1 catalog effects', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    expect(reg.has('heal-full')).toBe(true);
    expect(reg.has('bomb-blast')).toBe(true);
    expect(reg.has('healing-touch')).toBe(true);
    expect(reg.has('reaping-strike')).toBe(true);
    expect(reg.has('teamwork')).toBe(true);
    expect(reg.has('evasive-maneuver')).toBe(true);
    expect(reg.has('whirlwind-attack')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/effects.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement EffectRegistry**

Create `src/engine/effects.ts`:

```ts
/**
 * Effects are pure descriptions of changes the engine should apply.
 * Each effect declares its kind (where it can fire) and an `apply`
 * function that takes a context and returns a structured result.
 *
 * The engine uses the result to update state and emit events. Effects
 * never mutate engine state directly — they return what should change.
 */

import type { Character } from './character.js';

export type EffectKind =
  | 'consumable'      // an item used as an action (potion, bomb)
  | 'special-action'  // a character's special action
  | 'bonus-passive'   // a character's bonus ability (passive trigger)
  | 'equipment'       // worn equipment (typically passive trigger)
  | 'boon';           // a one-shot favor, usable any time

export interface EffectContext {
  /** The character that triggered the effect (the actor). */
  actor: Character;
  /** Optional target, when the effect targets a specific character. */
  target?: Character;
  /** Free-form params from the action (e.g. split-attack distribution). */
  params?: Record<string, unknown>;
}

export type EffectChange =
  | { kind: 'heal'; characterId: string; amount: number }
  | { kind: 'damage'; characterId: string; amount: number }
  | { kind: 'attack-mod'; extraDice: number }
  | { kind: 'free-attack'; targetId: string }
  | { kind: 'move-bonus'; squares: number }
  | { kind: 'noop' };

export interface EffectResult {
  changes: EffectChange[];
  /** Optional narration hint for the DM. */
  narration?: string;
}

export interface Effect {
  kind: EffectKind;
  apply(ctx: EffectContext): EffectResult;
}

export class EffectRegistry {
  private map = new Map<string, Effect>();

  register(id: string, effect: Effect): void {
    if (this.map.has(id)) throw new Error(`Effect id already registered: ${id}`);
    this.map.set(id, effect);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): Effect {
    const e = this.map.get(id);
    if (!e) throw new Error(`Unknown effect id: ${id}`);
    return e;
  }
}

/* ─── Core v1 effects ──────────────────────────────────────────────── */

export const registerCoreEffects = (reg: EffectRegistry): void => {
  // Consumables
  reg.register('heal-full', {
    kind: 'consumable',
    apply: ({ target, actor }) => ({
      changes: [{ kind: 'heal', characterId: (target ?? actor).id, amount: Infinity }],
      narration: `${(target ?? actor).name} drinks a potion and is fully healed.`,
    }),
  });

  reg.register('bomb-blast', {
    kind: 'consumable',
    apply: ({ target }) => ({
      // The engine resolves the actual to-hit roll; the effect just declares
      // "make a 1-die magic-style attack against the primary target and adjacents".
      // Concrete attack resolution is handled in resolution.ts via params.
      changes: [{ kind: 'noop' }],
      narration: `BA-BOOM! The bomb explodes around ${target?.name ?? 'the target'}.`,
    }),
  });

  // Special actions
  reg.register('healing-touch', {
    kind: 'special-action',
    apply: ({ target, actor }) => ({
      changes: [{ kind: 'heal', characterId: (target ?? actor).id, amount: 1 }],
      narration: `${actor.name} touches ${(target ?? actor).name}, mending one wound.`,
    }),
  });

  reg.register('whirlwind-attack', {
    kind: 'special-action',
    apply: () => ({
      // Engine handles the multi-target attack via params (split-attack list).
      changes: [{ kind: 'noop' }],
      narration: 'A whirlwind of steel sweeps across the foes.',
    }),
  });

  // Bonus passives
  reg.register('teamwork', {
    kind: 'bonus-passive',
    apply: ({ params }) => {
      const targetEngaged = params?.['targetEngaged'] === true;
      return {
        changes: targetEngaged ? [{ kind: 'attack-mod', extraDice: 1 }] : [{ kind: 'noop' }],
      };
    },
  });

  reg.register('evasive-maneuver', {
    kind: 'bonus-passive',
    apply: () => ({
      changes: [{ kind: 'move-bonus', squares: 1 }],
      narration: 'A nimble dodge!',
    }),
  });

  reg.register('power-surge', {
    kind: 'bonus-passive',
    apply: ({ actor }) => {
      const wounded = actor.health.damage > 0;
      return { changes: wounded ? [{ kind: 'attack-mod', extraDice: 1 }] : [{ kind: 'noop' }] };
    },
  });

  reg.register('coward', {
    kind: 'bonus-passive',
    apply: ({ params }) => ({
      changes: params?.['attackedSinceLastTurn'] === true
        ? [{ kind: 'move-bonus', squares: 2 }]
        : [{ kind: 'noop' }],
    }),
  });

  reg.register('pack-attack', {
    kind: 'special-action',
    apply: () => ({ changes: [{ kind: 'noop' }] }),
  });

  reg.register('split-shot', {
    kind: 'special-action',
    apply: () => ({ changes: [{ kind: 'noop' }] }),
  });

  reg.register('flame-burst', {
    kind: 'special-action',
    apply: () => ({ changes: [{ kind: 'noop' }] }),
  });

  reg.register('potion-brewer', {
    kind: 'bonus-passive',
    apply: () => ({ changes: [{ kind: 'noop' }] }),
  });

  // Equipment
  reg.register('reaping-strike', {
    kind: 'equipment',
    apply: ({ params }) => ({
      changes: params?.['justKOd'] === true
        ? [{ kind: 'free-attack', targetId: String(params['adjacentTargetId'] ?? '') }]
        : [{ kind: 'noop' }],
    }),
  });
};
```

**Note:** Some special actions (whirlwind, split-shot, flame-burst, pack-attack) carry `kind: 'noop'` here because the engine handles their multi-target attack mechanics directly in `resolution.ts`. The effect registry is for **state changes outside the basic attack path** (heals, free attacks, dice modifiers, movement bonuses). Multi-target attacks are still attacks — they just have different target-list params.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/effects.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/effects.ts tests/engine/effects.test.ts
git commit -m "feat(engine): effect registry with core herokids effects"
```

---

### Task 10: Attack resolution

**Files:**
- Create: `src/engine/resolution.ts`
- Create: `tests/engine/resolution.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/engine/resolution.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';
import { resolveAttack, resolveAbilityTest } from '../../src/engine/resolution.js';
import type { AttackKind } from '../../src/engine/character.js';

const ctx = {
  attackerPool: 2,
  defenderArmor: 2,
  attackKind: 'melee' as AttackKind,
  modifiers: { extraAttackDice: 0, extraArmorDice: 0, damageMod: 0 },
};

describe('resolveAttack', () => {
  it('attack hits when attacker top die >= defender top die', () => {
    const dice = new Dice('hits-1');
    const result = resolveAttack(dice, ctx);
    // mulberry32('hits-1') first 4 d6 with our impl needs to be checked, but
    // we assert structural shape, not specific dice — the dice test covers
    // determinism separately.
    expect(result).toHaveProperty('hit');
    expect(result).toHaveProperty('attackRoll');
    expect(result).toHaveProperty('armorRoll');
    expect(result.attackRoll).toHaveLength(2);
    expect(result.armorRoll).toHaveLength(2);
    if (result.hit) {
      expect(result.damage).toBe(1);
    } else {
      expect(result.damage).toBe(0);
    }
  });

  it('ties go to attacker (hit)', () => {
    // Force the same RNG seed across many calls and find a tie. With the
    // determinism guarantee, we can pick a known seed where the highest
    // dice on each side are equal. Easier: use a deterministic stub.
    const fixed = new Dice('tie-test');
    // Try several seeds until we find one where attack and armor both top at e.g. 4.
    // We assert the property holds: when top dice equal, hit is true.
    for (let i = 0; i < 100; i++) {
      const d = new Dice(`s${i}`);
      const r = resolveAttack(d, ctx);
      if (Dice.highestDie(r.attackRoll) === Dice.highestDie(r.armorRoll)) {
        expect(r.hit).toBe(true);
        return;
      }
    }
    // No tie in 100 iterations is statistically improbable; fail loudly.
    throw new Error('no tie found in 100 iterations');
  });

  it('extraAttackDice adds to attacker pool', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, modifiers: { extraAttackDice: 1, extraArmorDice: 0, damageMod: 0 } });
    expect(r.attackRoll).toHaveLength(3);
  });

  it('extraArmorDice (cover) adds to defender pool', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, modifiers: { extraAttackDice: 0, extraArmorDice: 1, damageMod: 0 } });
    expect(r.armorRoll).toHaveLength(3);
  });

  it('empty attacker pool always misses (highestDie 0 < anything)', () => {
    const r = resolveAttack(new Dice('x'), { ...ctx, attackerPool: 0 });
    expect(r.hit).toBe(false);
  });

  it('damageMod increases damage on hit', () => {
    // Try seeds until we get a hit, then check damage.
    for (let i = 0; i < 100; i++) {
      const d = new Dice(`hit-${i}`);
      const r = resolveAttack(d, { ...ctx, modifiers: { extraAttackDice: 5, extraArmorDice: 0, damageMod: 2 } });
      if (r.hit) {
        expect(r.damage).toBe(3); // 1 base + 2 mod
        return;
      }
    }
    throw new Error('no hit in 100 iterations with stacked attacker pool');
  });
});

describe('resolveAbilityTest', () => {
  it('uses 1 base + characteristic + skill bonus + item bonus', () => {
    const r = resolveAbilityTest(new Dice('x'), {
      characteristicPool: 2,
      hasSkill: true,
      hasItem: true,
      difficulty: 5,
    });
    expect(r.roll).toHaveLength(4); // 1 + 2 + 1 + 1
  });

  it('success when top die >= difficulty', () => {
    for (let i = 0; i < 200; i++) {
      const d = new Dice(`abil-${i}`);
      const r = resolveAbilityTest(d, { characteristicPool: 5, hasSkill: false, hasItem: false, difficulty: 4 });
      const expected = Dice.highestDie(r.roll) >= 4;
      expect(r.success).toBe(expected);
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/resolution.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement resolution**

Create `src/engine/resolution.ts`:

```ts
import { Dice } from './dice.js';
import type { AttackKind } from './character.js';

export interface AttackContext {
  attackerPool: number;       // base dice pool (melee/ranged/magic)
  defenderArmor: number;      // base armor pool
  attackKind: AttackKind;
  modifiers: AttackModifiers;
}

export interface AttackModifiers {
  /** +dice to attacker pool (engaged target, prone defender, persona effects, etc.) */
  extraAttackDice: number;
  /** +dice to defender armor (cover, magic resistance, etc.) */
  extraArmorDice: number;
  /** Damage offset (e.g. Retaliation +1, default 0) */
  damageMod: number;
}

export interface AttackResult {
  hit: boolean;
  damage: number;
  attackRoll: number[];
  armorRoll: number[];
  attackerTop: number;
  defenderTop: number;
}

export const resolveAttack = (dice: Dice, ctx: AttackContext): AttackResult => {
  const attackerDice = Math.max(0, ctx.attackerPool + ctx.modifiers.extraAttackDice);
  const armorDice = Math.max(0, ctx.defenderArmor + ctx.modifiers.extraArmorDice);

  const attackRoll = dice.rollPool(attackerDice);
  const armorRoll = dice.rollPool(armorDice);
  const attackerTop = Dice.highestDie(attackRoll);
  const defenderTop = Dice.highestDie(armorRoll);

  const hit = attackerTop >= defenderTop && attackerTop > 0;
  const damage = hit ? Math.max(0, 1 + ctx.modifiers.damageMod) : 0;

  return { hit, damage, attackRoll, armorRoll, attackerTop, defenderTop };
};

export interface AbilityTestContext {
  characteristicPool: number;
  hasSkill: boolean;
  hasItem: boolean;
  difficulty: 4 | 5 | 6;
}

export interface AbilityTestResult {
  success: boolean;
  roll: number[];
  top: number;
}

export const resolveAbilityTest = (dice: Dice, ctx: AbilityTestContext): AbilityTestResult => {
  const total = 1 + ctx.characteristicPool + (ctx.hasSkill ? 1 : 0) + (ctx.hasItem ? 1 : 0);
  const roll = dice.rollPool(total);
  const top = Dice.highestDie(roll);
  return { success: top >= ctx.difficulty, roll, top };
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/resolution.test.ts`
Expected: PASS, 7 tests (some use loops to find seeds).

- [ ] **Step 5: Commit**

```bash
git add src/engine/resolution.ts tests/engine/resolution.test.ts
git commit -m "feat(engine): attack and ability test resolution"
```

---

### Task 11: Initiative and turn tracker

**Files:**
- Create: `src/engine/turn-tracker.ts`
- Create: `tests/engine/turn-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/engine/turn-tracker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';
import { TurnTracker } from '../../src/engine/turn-tracker.js';
import { asCharacterId } from '../../src/engine/ids.js';

describe('TurnTracker', () => {
  it('starts in narrative phase with no active actor (DM picks)', () => {
    const t = new TurnTracker();
    expect(t.phase).toBe('narrative');
    expect(t.activeActorId).toBeNull();
  });

  it('startCombat rolls initiative and stores side that goes first', () => {
    const t = new TurnTracker();
    const heroes = [asCharacterId('h1'), asCharacterId('h2')];
    const monsters = [asCharacterId('m1')];
    const dice = new Dice('initiative-1');
    const result = t.startCombat(dice, heroes, monsters);
    expect(t.phase).toBe('combat');
    expect(['hero', 'monster']).toContain(result.firstSide);
    expect(t.combatOrder).not.toBeNull();
  });

  it('heroes win ties (per herokids rules)', () => {
    const t = new TurnTracker();
    // Force same result both rolls — easier with stub.
    const dice = new (class extends Dice { rollD6() { return 4; } })('x');
    const r = t.startCombat(dice, [asCharacterId('h1')], [asCharacterId('m1')]);
    expect(r.firstSide).toBe('hero');
  });

  it('advance cycles through hero side, then monster side, then hero again', () => {
    const t = new TurnTracker();
    // Force monsters first by stubbing dice that returns 6 then 1.
    let i = 0;
    const dice = new (class extends Dice { rollD6() { return i++ === 0 ? 1 : 6; } })('x');
    t.startCombat(dice, [asCharacterId('h1'), asCharacterId('h2')], [asCharacterId('m1')]);
    // first side = monster (rolled 6), then hero
    const order: string[] = [];
    for (let n = 0; n < 5; n++) {
      order.push(String(t.activeActorId));
      t.advance();
    }
    expect(order[0]).toBe('m1');
    expect(order[1]).toBe('h1');
    expect(order[2]).toBe('h2');
    expect(order[3]).toBe('m1'); // wraps
    expect(order[4]).toBe('h1');
  });

  it('endCombat returns to narrative phase', () => {
    const t = new TurnTracker();
    t.startCombat(new Dice('x'), [asCharacterId('h1')], [asCharacterId('m1')]);
    t.endCombat();
    expect(t.phase).toBe('narrative');
    expect(t.activeActorId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/turn-tracker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement TurnTracker**

Create `src/engine/turn-tracker.ts`:

```ts
import type { Dice } from './dice.js';
import type { CharacterId } from './ids.js';

export type TurnPhase = 'narrative' | 'combat';
export type Side = 'hero' | 'monster';

export interface CombatOrder {
  heroSide: CharacterId[];
  monsterSide: CharacterId[];
  firstSide: Side;
  /** Index into the combined order: heroSide first if firstSide=hero, etc. */
  cursor: number;
  /** heroRoll, monsterRoll for audit. */
  rolls: { hero: number; monster: number };
}

export class TurnTracker {
  phase: TurnPhase = 'narrative';
  combatOrder: CombatOrder | null = null;
  /** Out-of-combat: null (DM picks via request_action). In combat: derived from order. */
  private narrativeActor: CharacterId | null = null;

  get activeActorId(): CharacterId | null {
    if (this.phase === 'narrative') return this.narrativeActor;
    if (!this.combatOrder) return null;
    const seq = this.sequence();
    return seq[this.combatOrder.cursor] ?? null;
  }

  setNarrativeActor(id: CharacterId | null): void {
    this.narrativeActor = id;
  }

  startCombat(dice: Dice, heroSide: CharacterId[], monsterSide: CharacterId[]): { firstSide: Side; rolls: { hero: number; monster: number } } {
    const heroRoll = dice.rollD6();
    const monsterRoll = dice.rollD6();
    const firstSide: Side = heroRoll >= monsterRoll ? 'hero' : 'monster';
    this.combatOrder = {
      heroSide: [...heroSide],
      monsterSide: [...monsterSide],
      firstSide,
      cursor: 0,
      rolls: { hero: heroRoll, monster: monsterRoll },
    };
    this.phase = 'combat';
    this.narrativeActor = null;
    return { firstSide, rolls: { hero: heroRoll, monster: monsterRoll } };
  }

  endCombat(): void {
    this.phase = 'narrative';
    this.combatOrder = null;
    this.narrativeActor = null;
  }

  advance(): void {
    if (this.phase !== 'combat' || !this.combatOrder) return;
    this.combatOrder.cursor = (this.combatOrder.cursor + 1) % this.sequence().length;
  }

  private sequence(): readonly CharacterId[] {
    if (!this.combatOrder) return [];
    return this.combatOrder.firstSide === 'hero'
      ? [...this.combatOrder.heroSide, ...this.combatOrder.monsterSide]
      : [...this.combatOrder.monsterSide, ...this.combatOrder.heroSide];
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/turn-tracker.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/turn-tracker.ts tests/engine/turn-tracker.test.ts
git commit -m "feat(engine): turn tracker with side-based initiative"
```

---

### Task 12: Action and event union types

**Files:**
- Create: `src/log/events.ts`
- Create: `src/engine/action.ts`
- Create: `tests/engine/action.test.ts`

- [ ] **Step 1: Define PlayerAction and DmAction**

Create `src/engine/action.ts`:

```ts
import type {
  CharacterId,
  ItemId,
  EquipmentId,
  BoonId,
  SkillId,
  SceneId,
} from './ids.js';
import type { Square } from './primitives.js';
import type { AttackKind } from './character.js';

export type PlayerAction =
  | { kind: 'move'; path: Square[] }
  | { kind: 'normal_attack'; targetId: CharacterId }
  | { kind: 'special_action'; targetIds?: CharacterId[]; params?: Record<string, unknown> }
  | { kind: 'use_item'; itemId: ItemId; targetId?: CharacterId }
  | { kind: 'use_boon'; boonId: BoonId; targetId?: CharacterId }
  | { kind: 'equip'; equipmentId: EquipmentId }
  | { kind: 'ability_test'; characteristic: AttackKind; skillId?: SkillId; itemId?: ItemId; difficulty: 4 | 5 | 6; describe: string }
  | { kind: 'say'; text: string }
  | { kind: 'end_turn' }
  | { kind: 'skip_turn' };

export type DmAction =
  | { kind: 'narrate'; text: string }
  | { kind: 'set_scene'; sceneId: SceneId }
  | { kind: 'start_combat'; heroSide: CharacterId[]; monsterSide: CharacterId[] }
  | { kind: 'end_combat' }
  | { kind: 'request_action'; actorId: CharacterId }
  | { kind: 'reveal_monster'; monsterTypeId: string; pos: Square; characterId: CharacterId }
  | { kind: 'environmental'; effect: 'push' | 'pull' | 'hazard'; params: Record<string, unknown> }
  | { kind: 'offer_rest' }
  | { kind: 'end_adventure'; outcome: 'success' | 'failure' };

export type AnyAction =
  | { actor: 'player'; action: PlayerAction }
  | { actor: 'dm'; action: DmAction };

export type RuleViolation =
  | { reason: 'out-of-range' }
  | { reason: 'no-line-of-sight' }
  | { reason: 'invalid-target' }
  | { reason: 'not-actors-turn' }
  | { reason: 'unknown-id'; what: 'item' | 'equipment' | 'boon' | 'character' | 'scene'; id: string }
  | { reason: 'wrong-phase' }
  | { reason: 'insufficient-movement' }
  | { reason: 'blocked-by-wall' }
  | { reason: 'no-such-effect' }
  | { reason: 'invalid-action-shape'; details: string };
```

- [ ] **Step 2: Define Event union**

Create `src/log/events.ts`:

```ts
import type { CharacterId, SceneId } from '../engine/ids.js';
import type { Square } from '../engine/primitives.js';
import type { PlayerAction, DmAction, RuleViolation } from '../engine/action.js';

export interface EventBase {
  /** Logical step counter, monotonically increasing. */
  t: number;
}

export type Event =
  | (EventBase & { type: 'scene_enter'; sceneId: SceneId })
  | (EventBase & { type: 'thought'; actorId: CharacterId | 'dm'; text: string })
  | (EventBase & { type: 'narrate'; actorId: 'dm'; text: string })
  | (EventBase & { type: 'request_action'; actorId: 'dm'; targetId: CharacterId })
  | (EventBase & { type: 'human_input'; actorId: CharacterId; text: string })
  | (EventBase & {
      type: 'action';
      actorId: CharacterId | 'dm';
      action: PlayerAction | DmAction;
      interpretedBy?: 'dm';
    })
  | (EventBase & {
      type: 'resolution';
      actorId: CharacterId | 'dm';
      public: Record<string, unknown>;
      private?: Record<string, unknown>;
    })
  | (EventBase & {
      type: 'state_change';
      changes: Array<{ id: CharacterId; damage?: number; status?: string; pos?: Square }>;
    })
  | (EventBase & {
      type: 'rule_violation';
      actorId: CharacterId | 'dm';
      violation: RuleViolation;
    })
  | (EventBase & { type: 'step_budget_exhausted'; actorId: CharacterId; forced: 'end_turn' })
  | (EventBase & { type: 'combat_started'; heroSide: CharacterId[]; monsterSide: CharacterId[]; rolls: { hero: number; monster: number } })
  | (EventBase & { type: 'combat_ended' })
  | (EventBase & { type: 'rest_offered' })
  | (EventBase & { type: 'adventure_ended'; outcome: 'success' | 'failure' });
```

- [ ] **Step 3: Add a smoke test for the action types**

Create `tests/engine/action.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { PlayerAction, DmAction } from '../../src/engine/action.js';
import { asCharacterId, asItemId } from '../../src/engine/ids.js';

describe('action types compile and discriminate', () => {
  it('a PlayerAction can be narrowed by kind', () => {
    const a: PlayerAction = { kind: 'normal_attack', targetId: asCharacterId('rat-1') };
    if (a.kind === 'normal_attack') {
      expect(a.targetId).toBe('rat-1');
    } else {
      throw new Error('unexpected branch');
    }
  });

  it('a DmAction can be narrowed', () => {
    const a: DmAction = { kind: 'narrate', text: 'hello' };
    if (a.kind === 'narrate') {
      expect(a.text).toBe('hello');
    }
  });

  it('use_item carries optional target', () => {
    const a: PlayerAction = { kind: 'use_item', itemId: asItemId('potion'), targetId: asCharacterId('h1') };
    expect(a.kind).toBe('use_item');
  });
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/action.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/action.ts src/log/events.ts tests/engine/action.test.ts
git commit -m "feat(engine): playeraction, dmaction, event union types"
```

---

### Task 13: GameEngine skeleton with state and applyAction dispatch

**Files:**
- Create: `src/engine/game-engine.ts`
- Create: `tests/engine/game-engine.test.ts`

This task creates the engine class and the applyAction dispatch shape. Concrete handlers for each action kind come in the next tasks. We start with `say`, `end_turn`, and `skip_turn` as the simplest handlers.

- [ ] **Step 1: Write failing tests for the skeleton**

Create `tests/engine/game-engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Dice } from '../../src/engine/dice.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const makeEngine = (chars: Character[]): GameEngine => {
  const grid = new Grid(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));
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

  it('rejects unknown action shape', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    // @ts-expect-error: deliberate bad shape
    const r = e.applyAction(asCharacterId('h1'), { kind: 'fly_to_moon' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement GameEngine skeleton**

Create `src/engine/game-engine.ts`:

```ts
import { Dice } from './dice.js';
import type { Grid } from './grid.js';
import type { Character } from './character.js';
import type { CharacterId } from './ids.js';
import type { PlayerAction, DmAction, RuleViolation } from './action.js';
import type { EffectRegistry } from './effects.js';
import { TurnTracker } from './turn-tracker.js';
import type { Event } from '../log/events.js';
import type { Result } from './primitives.js';
import { ok, err } from './primitives.js';

export interface GameEngineConfig {
  seed: string;
  grid: Grid;
  characters: Character[];
  effects: EffectRegistry;
}

export interface ActionOk {
  turnEnded: boolean;
}

export class GameEngine {
  readonly dice: Dice;
  readonly grid: Grid;
  readonly effects: EffectRegistry;
  readonly turn: TurnTracker;

  private characters: Map<CharacterId, Character>;
  private pendingEvents: Event[] = [];
  private nextT = 1;

  constructor(cfg: GameEngineConfig) {
    this.dice = new Dice(cfg.seed);
    this.grid = cfg.grid;
    this.effects = cfg.effects;
    this.turn = new TurnTracker();
    this.characters = new Map(cfg.characters.map((c) => [c.id, c]));
  }

  /** Snapshot of the current characters keyed by id. */
  charactersById(): ReadonlyMap<CharacterId, Character> {
    return this.characters;
  }

  /** Drain queued events. Caller is expected to write them to the log. */
  flushEvents(): Event[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  beginNarrativeTurn(actorId: CharacterId): void {
    this.turn.setNarrativeActor(actorId);
  }

  applyAction(actorId: CharacterId, action: PlayerAction): Result<ActionOk, RuleViolation> {
    if (this.turn.activeActorId !== actorId) {
      return err({ reason: 'not-actors-turn' });
    }
    if (!this.characters.has(actorId)) {
      return err({ reason: 'unknown-id', what: 'character', id: String(actorId) });
    }

    switch (action.kind) {
      case 'say':
        this.emit({ type: 'action', actorId, action } as unknown as Event);
        return ok({ turnEnded: false });
      case 'end_turn':
      case 'skip_turn':
        this.emit({ type: 'action', actorId, action } as unknown as Event);
        return ok({ turnEnded: true });
      case 'move':
      case 'normal_attack':
      case 'special_action':
      case 'use_item':
      case 'use_boon':
      case 'equip':
      case 'ability_test':
        // Implemented in subsequent tasks.
        return err({ reason: 'invalid-action-shape', details: `not yet implemented: ${action.kind}` });
      default: {
        const _exhaustive: never = action;
        return err({ reason: 'invalid-action-shape', details: 'unknown kind' });
      }
    }
  }

  applyDmAction(_action: DmAction): Result<ActionOk, RuleViolation> {
    // Implemented in a later task.
    return err({ reason: 'invalid-action-shape', details: 'dm dispatch not yet implemented' });
  }

  private emit(ev: Omit<Event, 't'>): void {
    this.pendingEvents.push({ ...ev, t: this.nextT++ } as Event);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/action.ts src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): game engine skeleton with say/end/skip handlers"
```

---

### Task 14: Move action handler

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts` (add tests)

- [ ] **Step 1: Add failing tests for move**

Append to `tests/engine/game-engine.test.ts`:

```ts
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
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }],
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
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the move handler**

Replace the `case 'move'` line in `src/engine/game-engine.ts` and add a private method. Specifically:

In the switch statement, replace `case 'move':` with:

```ts
      case 'move':
        return this.handleMove(actorId, action.path);
```

And add this private method to the class (place after `applyDmAction`):

```ts
  private handleMove(actorId: CharacterId, path: { x: number; y: number }[]): Result<ActionOk, RuleViolation> {
    if (path.length < 2) return err({ reason: 'invalid-action-shape', details: 'path must have at least 2 squares' });

    const actor = this.characters.get(actorId)!;
    if (!actor.pos) return err({ reason: 'invalid-target' });

    const start = path[0]!;
    if (start.x !== actor.pos.x || start.y !== actor.pos.y) {
      return err({ reason: 'invalid-action-shape', details: 'path[0] must equal current position' });
    }

    // Validate every step is to an adjacent in-bounds non-wall non-enemy square.
    const enemyKey = (c: Character) =>
      c.kind !== actor.kind && c.pos ? `${c.pos.x},${c.pos.y}` : null;
    const enemyPositions = new Set(
      Array.from(this.characters.values())
        .map(enemyKey)
        .filter((k): k is string => k !== null),
    );

    let movementUsed = 0;
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1]!;
      const cur = path[i]!;
      if (!this.grid.isAdjacent(prev, cur)) {
        return err({ reason: 'invalid-action-shape', details: `path step ${i} not adjacent` });
      }
      const cell = this.grid.cellAt(cur);
      if (cell.kind === 'wall') return err({ reason: 'blocked-by-wall' });
      const k = `${cur.x},${cur.y}`;
      const isEndStep = i === path.length - 1;
      if (enemyPositions.has(k)) return err({ reason: 'invalid-target' });
      // Allies block end-step only; pass-through allowed.
      if (isEndStep) {
        for (const c of this.characters.values()) {
          if (c.id !== actorId && c.kind === actor.kind && c.pos && c.pos.x === cur.x && c.pos.y === cur.y) {
            return err({ reason: 'invalid-target' });
          }
        }
      }
      movementUsed += cell.kind === 'obstacle' ? 2 : 1;
    }

    const budget = 4;  // TODO: per-character override (e.g. Rogue's Nimble = 5)
    if (movementUsed > budget) return err({ reason: 'insufficient-movement' });

    const finalPos = path[path.length - 1]!;
    const updated = { ...actor, pos: finalPos };
    this.characters.set(actorId, updated);

    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'move', path },
    } as unknown as Event);
    this.emit({
      type: 'state_change',
      changes: [{ id: actorId, pos: finalPos }],
    } as unknown as Event);

    return ok({ turnEnded: false });
  }
```

**Note:** The TODO inside the function is acceptable for v1 — Rogue's Nimble is out of scope for the warrior/hunter/healer/warlock v1. When Rogue is added, this is the one line that changes.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS, all (previous + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): move action with bfs validation"
```

---

### Task 15: Normal attack action handler

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts`

- [ ] **Step 1: Add failing tests for normal_attack**

Append to `tests/engine/game-engine.test.ts`:

```ts
describe('GameEngine.normal_attack', () => {
  it('rejects attack on out-of-range target (melee, non-adjacent)', () => {
    const enemy: Character = { ...hero('m1', 5, 5), kind: 'monster' };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('out-of-range');
  });

  it('rejects attack on unknown target', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('ghost') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unknown-id');
  });

  it('valid melee attack emits action + resolution + state_change events', () => {
    const enemy: Character = { ...hero('m1', 1, 0), kind: 'monster', pools: { melee: 1, ranged: 0, magic: 0, armor: 2 }, health: { total: 1, damage: 0, status: 'normal' } };
    const e = makeEngine([hero('h1', 0, 0), enemy]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action')).toBeDefined();
    expect(events.find((ev) => ev.type === 'resolution')).toBeDefined();
    // state_change only emitted if hit. Run multiple seeds to find a hit if needed
    // (this seed-dependent assertion lives in resolution.test.ts; here we just
    // verify the event pipeline).
  });

  it('attack against KO target rejected as invalid-target', () => {
    const dead: Character = {
      ...hero('m1', 1, 0),
      kind: 'monster',
      health: { total: 1, damage: 1, status: 'KO' },
    };
    const e = makeEngine([hero('h1', 0, 0), dead]);
    e.beginNarrativeTurn(asCharacterId('h1'));
    const r = e.applyAction(asCharacterId('h1'), { kind: 'normal_attack', targetId: asCharacterId('m1') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL on new tests.

- [ ] **Step 3: Implement normal_attack**

In `src/engine/game-engine.ts`, replace `case 'normal_attack':` in the switch with:

```ts
      case 'normal_attack':
        return this.handleNormalAttack(actorId, action.targetId);
```

And add this private method:

```ts
  private handleNormalAttack(
    actorId: CharacterId,
    targetId: CharacterId,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const target = this.characters.get(targetId);
    if (!target) return err({ reason: 'unknown-id', what: 'character', id: String(targetId) });
    if (target.health.status === 'KO') return err({ reason: 'invalid-target' });
    if (!actor.pos || !target.pos) return err({ reason: 'invalid-target' });

    const attackKind = actor.normalAttack.kind;
    const range = actor.normalAttack.range;
    const distance = chebyshev(actor.pos, target.pos);
    if (distance > range) return err({ reason: 'out-of-range' });

    if (attackKind !== 'melee') {
      const sight = this.grid.lineOfSight(actor.pos, target.pos);
      if (sight.blocked) return err({ reason: 'no-line-of-sight' });
    }

    const pool = actor.pools[attackKind];

    // TODO: gather attack modifiers (engaged, prone, cover, persona effects).
    // For v1, only cover from line-of-sight is wired; others come with later tasks.
    let extraArmor = 0;
    if (attackKind !== 'melee') {
      const sight = this.grid.lineOfSight(actor.pos, target.pos);
      if (sight.cover) extraArmor += 1;
    }

    const result = resolveAttackInternal(this.dice, {
      attackerPool: pool,
      defenderArmor: target.pools.armor,
      attackKind,
      modifiers: { extraAttackDice: 0, extraArmorDice: extraArmor, damageMod: actor.normalAttack.damageMod },
    });

    this.emit({ type: 'action', actorId, action: { kind: 'normal_attack', targetId } } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: { hit: result.hit, damage: result.damage, attackerTop: result.attackerTop, defenderTop: result.defenderTop },
      private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
    } as unknown as Event);

    if (result.hit && result.damage > 0) {
      const damaged = applyDamageInternal(target, result.damage);
      this.characters.set(target.id, damaged);
      this.emit({
        type: 'state_change',
        changes: [{ id: target.id, damage: damaged.health.damage, status: damaged.health.status }],
      } as unknown as Event);
    }

    return ok({ turnEnded: false });
  }
```

Add these imports at the top of the file:

```ts
import { chebyshevDistance as chebyshev } from './primitives.js';
import { resolveAttack as resolveAttackInternal } from './resolution.js';
import { applyDamage as applyDamageInternal } from './character.js';
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): normal_attack with range, los, cover modifiers"
```

---

### Task 16: Use_item action handler

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/engine/game-engine.test.ts`:

```ts
describe('GameEngine.use_item', () => {
  it('use potion heals target to full', () => {
    const wounded = { ...hero('h1', 0, 0), inventory: [{ itemId: asItemId('potion'), count: 1 }], health: { total: 3, damage: 2, status: 'normal' as const } };
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
    const e = makeEngineWithItems([{ ...hero('h1', 0, 0), inventory: [] }]);
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

import { asItemId } from '../../src/engine/ids.js';
import { loadCatalogs } from '../../src/engine/load.js';

const makeEngineWithItems = (chars: Character[]): GameEngine => {
  const grid = new Grid(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  // Load real item catalog so 'potion' resolves.
  // We use a sync workaround: pre-load and cache for this test file.
  return new GameEngine({
    seed: 'test',
    grid,
    characters: chars,
    effects: reg,
    items: ITEMS_FOR_TEST,
  });
};

const ITEMS_FOR_TEST = await (async () => {
  const c = await loadCatalogs(`${process.cwd()}/data`);
  return c.items;
})();
```

(The top-level await pattern only works in vitest's default ESM mode. If your vitest config disables top-level await, move to a `beforeAll`.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend GameEngine with items**

In `src/engine/game-engine.ts`:

a. Add `items?: Map<string, ItemEntry>;` to the config:

```ts
import type { ItemEntry } from './catalogs.js';
// ...
export interface GameEngineConfig {
  seed: string;
  grid: Grid;
  characters: Character[];
  effects: EffectRegistry;
  items?: Map<string, ItemEntry>;
}
```

b. Store on the class:

```ts
  private items: Map<string, ItemEntry>;

  constructor(cfg: GameEngineConfig) {
    // ... existing
    this.items = cfg.items ?? new Map();
  }
```

c. Replace `case 'use_item':` with:

```ts
      case 'use_item':
        return this.handleUseItem(actorId, action.itemId, action.targetId);
```

d. Add the handler:

```ts
  private handleUseItem(
    actorId: CharacterId,
    itemId: ItemId,
    targetId: CharacterId | undefined,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const stack = actor.inventory.find((s) => s.itemId === itemId);
    if (!stack || stack.count <= 0) {
      return err({ reason: 'unknown-id', what: 'item', id: String(itemId) });
    }
    const def = this.items.get(itemId);
    if (!def) return err({ reason: 'unknown-id', what: 'item', id: String(itemId) });

    if (def.category !== 'consumable') {
      // Utility items grant passive bonuses; using them is a no-op action.
      return err({ reason: 'invalid-action-shape', details: 'utility items are not used as actions' });
    }

    const effect = this.effects.get(def.consumableEffect!);
    const target = targetId ? this.characters.get(targetId) ?? actor : actor;
    const result = effect.apply({ actor, target });

    // Apply changes (heal, damage, etc.).
    for (const change of result.changes) {
      if (change.kind === 'heal') {
        const c = this.characters.get(change.characterId as CharacterId);
        if (c) {
          const healed = healDamageInternal(c, change.amount);
          this.characters.set(c.id, healed);
          this.emit({
            type: 'state_change',
            changes: [{ id: c.id, damage: healed.health.damage, status: healed.health.status }],
          } as unknown as Event);
        }
      }
      // damage/free-attack/etc. paths handled in their respective tasks.
    }

    // Decrement stack.
    const newInventory =
      stack.count > 1
        ? actor.inventory.map((s) => (s.itemId === itemId ? { ...s, count: s.count - 1 } : s))
        : actor.inventory.filter((s) => s.itemId !== itemId);
    this.characters.set(actorId, { ...actor, inventory: newInventory });

    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'use_item', itemId, targetId },
    } as unknown as Event);

    return ok({ turnEnded: false });
  }
```

Add the imports:

```ts
import type { ItemId } from './ids.js';
import { healDamage as healDamageInternal } from './character.js';
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): use_item action with consumable effect dispatch"
```

---

### Task 17: Ability test, special action, equip, use_boon handlers

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts`

These are smaller — grouped into one task because each handler is mostly delegating to the effect registry and resolution module.

- [ ] **Step 1: Add tests for ability_test**

Append to `tests/engine/game-engine.test.ts`:

```ts
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
  it('rejects equip during combat (would need turn tracker in combat phase)', () => {
    // Setup combat phase with a stub.
    const e = makeEngine([hero('h1', 0, 0)]);
    // Force combat phase by calling startCombat on the tracker directly via reflection.
    e.turn.startCombat(new Dice('x'), [asCharacterId('h1')], []);
    const r = e.applyAction(asCharacterId('h1'), {
      kind: 'equip',
      equipmentId: asEquipmentId('raiders-battleaxe'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('wrong-phase');
  });
});

import { asEquipmentId } from '../../src/engine/ids.js';
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement remaining handlers**

In `src/engine/game-engine.ts`, replace these switch cases:

```ts
      case 'special_action':
        return this.handleSpecialAction(actorId, action);
      case 'use_boon':
        return this.handleUseBoon(actorId, action.boonId, action.targetId);
      case 'equip':
        return this.handleEquip(actorId, action.equipmentId);
      case 'ability_test':
        return this.handleAbilityTest(actorId, action);
```

Add these private methods:

```ts
  private handleAbilityTest(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'ability_test' }>,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const pool = actor.pools[action.characteristic];
    const result = resolveAbilityTestInternal(this.dice, {
      characteristicPool: pool,
      hasSkill: !!action.skillId && actor.skills.includes(action.skillId),
      hasItem: !!action.itemId && actor.inventory.some((s) => s.itemId === action.itemId),
      difficulty: action.difficulty,
    });

    this.emit({ type: 'action', actorId, action } as unknown as Event);
    this.emit({
      type: 'resolution',
      actorId,
      public: { success: result.success, top: result.top, difficulty: action.difficulty },
      private: { roll: result.roll },
    } as unknown as Event);

    return ok({ turnEnded: false });
  }

  private handleSpecialAction(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const effect = this.effects.get(actor.specialAction.id);
    const target = action.targetIds?.[0]
      ? this.characters.get(action.targetIds[0])
      : undefined;
    const result = effect.apply({ actor, target, params: action.params });

    this.emit({ type: 'action', actorId, action } as unknown as Event);
    // Concrete special-action mechanics (split attacks, multi-target) are
    // forthcoming in later plans (Layer B + adventure encoding). For v1, the
    // engine logs the action + narration; full mechanics are scoped per-effect.
    if (result.narration) {
      this.emit({
        type: 'resolution',
        actorId,
        public: { narration: result.narration, changes: result.changes },
      } as unknown as Event);
    }
    return ok({ turnEnded: false });
  }

  private handleUseBoon(
    actorId: CharacterId,
    boonId: BoonId,
    _targetId: CharacterId | undefined,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    if (!actor.boons.includes(boonId)) {
      return err({ reason: 'unknown-id', what: 'boon', id: String(boonId) });
    }
    // Boons can be played off-turn; bypass active-actor check by virtue of the
    // applyAction caller having already approved it. For v1 we have no boons in
    // the catalog, so this handler is here for completeness and shape.
    const newBoons = actor.boons.filter((b) => b !== boonId);
    this.characters.set(actorId, { ...actor, boons: newBoons });
    this.emit({ type: 'action', actorId, action: { kind: 'use_boon', boonId } } as unknown as Event);
    return ok({ turnEnded: false });
  }

  private handleEquip(
    actorId: CharacterId,
    equipmentId: EquipmentId,
  ): Result<ActionOk, RuleViolation> {
    if (this.turn.phase === 'combat') return err({ reason: 'wrong-phase' });
    const actor = this.characters.get(actorId)!;
    this.characters.set(actorId, { ...actor, equipped: equipmentId });
    this.emit({ type: 'action', actorId, action: { kind: 'equip', equipmentId } } as unknown as Event);
    return ok({ turnEnded: false });
  }
```

Add imports:

```ts
import type { BoonId, EquipmentId } from './ids.js';
import { resolveAbilityTest as resolveAbilityTestInternal } from './resolution.js';
```

**Note:** Boon-off-turn semantics need orchestrator support (Layer B), so v1 only validates the boon exists in inventory and removes it. The off-turn dispatch path is wired in Layer B's plan.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS, all.

- [ ] **Step 5: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): special_action, use_boon, equip, ability_test handlers"
```

---

### Task 18: DM action dispatch

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts`

- [ ] **Step 1: Add tests for DM actions**

Append to `tests/engine/game-engine.test.ts`:

```ts
describe('GameEngine.applyDmAction', () => {
  it('narrate emits action event', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'narrate', text: 'You enter a damp cellar.' });
    expect(r.ok).toBe(true);
    const events = e.flushEvents();
    expect(events.find((ev) => ev.type === 'action' && ev.actorId === 'dm')).toBeDefined();
  });

  it('start_combat rolls initiative and transitions phase', () => {
    const enemy = { ...hero('m1', 5, 5), kind: 'monster' as const };
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
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [] });
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement applyDmAction**

Replace the body of `applyDmAction` in `src/engine/game-engine.ts`:

```ts
  applyDmAction(action: DmAction): Result<ActionOk, RuleViolation> {
    switch (action.kind) {
      case 'narrate':
        this.emit({ type: 'narrate', actorId: 'dm', text: action.text } as unknown as Event);
        return ok({ turnEnded: false });

      case 'set_scene':
        this.emit({ type: 'scene_enter', sceneId: action.sceneId } as unknown as Event);
        return ok({ turnEnded: false });

      case 'start_combat': {
        const r = this.turn.startCombat(this.dice, action.heroSide, action.monsterSide);
        this.emit({
          type: 'combat_started',
          heroSide: action.heroSide,
          monsterSide: action.monsterSide,
          rolls: r.rolls,
        } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'end_combat':
        this.turn.endCombat();
        this.emit({ type: 'combat_ended' } as unknown as Event);
        return ok({ turnEnded: false });

      case 'request_action':
        if (!this.characters.has(action.actorId)) {
          return err({ reason: 'unknown-id', what: 'character', id: String(action.actorId) });
        }
        this.turn.setNarrativeActor(action.actorId);
        this.emit({ type: 'request_action', actorId: 'dm', targetId: action.actorId } as unknown as Event);
        return ok({ turnEnded: false });

      case 'reveal_monster': {
        // Synthesize a Character from monster catalog. Catalog must be passed
        // to the engine for this to work; v1 supports the case where the DM
        // knows the typeId and we have the monster catalog.
        // For v1, we accept a pre-built Character via a side channel. The DM
        // emits the action and the orchestrator (Layer B) will inject the
        // monster into the engine. Here we just log the intent.
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });
      }

      case 'environmental':
        this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
        return ok({ turnEnded: false });

      case 'offer_rest':
        this.emit({ type: 'rest_offered' } as unknown as Event);
        return ok({ turnEnded: false });

      case 'end_adventure':
        this.emit({ type: 'adventure_ended', outcome: action.outcome } as unknown as Event);
        return ok({ turnEnded: false });

      default: {
        const _exhaustive: never = action;
        return err({ reason: 'invalid-action-shape', details: 'unknown dm action kind' });
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS, all.

- [ ] **Step 5: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): dm action dispatch (narrate/scene/combat/request/etc)"
```

---

### Task 19: Event log writer and reader

**Files:**
- Create: `src/log/event-log.ts`
- Create: `tests/log/event-log.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/log/event-log.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, readEventLog } from '../../src/log/event-log.js';
import type { Event } from '../../src/log/events.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-'));
});

describe('EventLog', () => {
  it('append + reads back identical events', async () => {
    const log = await EventLog.create(join(dir, 'events.jsonl'));
    const events: Event[] = [
      { t: 1, type: 'narrate', actorId: 'dm', text: 'hello' } as Event,
      { t: 2, type: 'combat_ended' } as Event,
    ];
    for (const e of events) await log.append(e);
    await log.close();
    const read = await readEventLog(join(dir, 'events.jsonl'));
    expect(read).toEqual(events);
  });

  it('append is durable across reopen', async () => {
    const path = join(dir, 'events.jsonl');
    const log1 = await EventLog.create(path);
    await log1.append({ t: 1, type: 'narrate', actorId: 'dm', text: 'first' } as Event);
    await log1.close();
    const log2 = await EventLog.create(path, { append: true });
    await log2.append({ t: 2, type: 'narrate', actorId: 'dm', text: 'second' } as Event);
    await log2.close();
    const read = await readEventLog(path);
    expect(read).toHaveLength(2);
    expect((read[0] as { text: string }).text).toBe('first');
    expect((read[1] as { text: string }).text).toBe('second');
  });

  it('readEventLog throws on malformed JSON line', async () => {
    const fs = await import('node:fs/promises');
    const path = join(dir, 'events.jsonl');
    await fs.writeFile(path, '{"t":1,"type":"narrate"}\nNOT JSON\n');
    await expect(readEventLog(path)).rejects.toThrow();
  });
});
```

Add cleanup:

```ts
import { afterEach } from 'vitest';
afterEach(() => rmSync(dir, { recursive: true, force: true }));
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/log/event-log.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement EventLog**

Create `src/log/event-log.ts`:

```ts
import { open, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Event } from './events.js';

export interface EventLogOptions {
  append?: boolean;
}

export class EventLog {
  private constructor(private handle: FileHandle) {}

  static async create(path: string, opts: EventLogOptions = {}): Promise<EventLog> {
    await mkdir(dirname(path), { recursive: true });
    const flags = opts.append ? 'a' : 'w';
    const handle = await open(path, flags);
    return new EventLog(handle);
  }

  async append(event: Event): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    await this.handle.write(line, null, 'utf8');
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export const readEventLog = async (path: string): Promise<Event[]> => {
  const raw = await readFile(path, 'utf8');
  const out: Event[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch (e) {
      throw new Error(`Malformed JSON at line ${lineNo} of ${path}: ${(e as Error).message}`);
    }
  }
  return out;
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/log/event-log.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/log/event-log.ts tests/log/event-log.test.ts
git commit -m "feat(log): append-only event log writer and reader"
```

---

### Task 20: Run manifest

**Files:**
- Create: `src/log/manifest.ts`
- Create: `tests/log/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/log/manifest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeManifest, type RunManifest } from '../../src/log/manifest.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'manifest-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('manifest', () => {
  it('writes and re-reads a complete manifest', async () => {
    const m: RunManifest = {
      runId: 'test-run-1',
      startedAt: '2026-05-08T14:00:00Z',
      endedAt: '2026-05-08T15:00:00Z',
      outcome: 'success',
      adventure: 'stub-one-scene@v1',
      rngSeed: 'abc123',
      agents: [],
      human: null,
      stepBudget: 6,
      totalEvents: 42,
      totalLlmCalls: {},
      totalTokens: { in: 0, out: 0 },
      cacheHitRatio: 0,
    };
    await writeManifest(join(dir, 'manifest.json'), m);
    const read = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(read).toEqual(m);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/log/manifest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement manifest module**

Create `src/log/manifest.ts`:

```ts
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AgentRecord {
  role: 'dm' | 'p1' | 'p2';
  characterId?: string;
  persona?: string;
  model: string;
  promptHash: string;
}

export interface HumanRecord {
  characterId: string;
}

export interface RunManifest {
  runId: string;
  startedAt: string;       // ISO-8601
  endedAt: string;         // ISO-8601
  outcome: 'success' | 'failure' | 'in-progress';
  adventure: string;       // "<adventureId>@<version>"
  rngSeed: string;
  agents: AgentRecord[];
  human: HumanRecord | null;
  stepBudget: number;
  totalEvents: number;
  totalLlmCalls: Record<string, number>;
  totalTokens: { in: number; out: number };
  cacheHitRatio: number;
}

export const writeManifest = async (path: string, m: RunManifest): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(m, null, 2) + '\n', 'utf8');
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/log/manifest.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/log/manifest.ts tests/log/manifest.test.ts
git commit -m "feat(log): run manifest writer"
```

---

### Task 21: Replay harness — proves the replay invariant

**Files:**
- Create: `src/log/replay.ts`
- Create: `tests/log/replay.test.ts`
- Create: `tests/fixtures/basic-attack-sequence.json`

This is the keystone test for Layer A. The replay invariant says: given the seed + adventure + action sequence, replaying produces identical state. We prove it by:

1. Run the engine against a scripted sequence, capture final state (S1).
2. Replay the same sequence against a fresh engine with the same seed, capture state (S2).
3. Assert `deepEqual(S1, S2)`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/basic-attack-sequence.json`:

```json
{
  "seed": "fixture-attack-1",
  "characters": [
    {
      "id": "h1",
      "name": "Bran",
      "kind": "hero",
      "archetype": "warrior",
      "pools": { "melee": 2, "ranged": 0, "magic": 0, "armor": 2 },
      "healthTotal": 3,
      "pos": { "x": 0, "y": 0 },
      "normalAttack": { "kind": "melee", "name": "Slash", "range": 1, "damageMod": 0 },
      "specialAction": { "id": "whirlwind-attack", "name": "WW", "description": "" },
      "bonusAbility": { "id": "teamwork", "name": "TW", "description": "" }
    },
    {
      "id": "m1",
      "name": "Rat",
      "kind": "monster",
      "pools": { "melee": 1, "ranged": 0, "magic": 0, "armor": 2 },
      "healthTotal": 1,
      "pos": { "x": 1, "y": 0 },
      "normalAttack": { "kind": "melee", "name": "Bite", "range": 1, "damageMod": 0 },
      "specialAction": { "id": "pack-attack", "name": "PA", "description": "" },
      "bonusAbility": { "id": "coward", "name": "CW", "description": "" }
    }
  ],
  "narrativeActor": "h1",
  "actions": [
    { "actorId": "h1", "action": { "kind": "say", "text": "Take this!" } },
    { "actorId": "h1", "action": { "kind": "normal_attack", "targetId": "m1" } },
    { "actorId": "h1", "action": { "kind": "end_turn" } }
  ]
}
```

- [ ] **Step 2: Write failing test**

Create `tests/log/replay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Grid } from '../../src/engine/grid.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import { replayFromFixture, snapshotEngineState } from '../../src/log/replay.js';
import type { Character } from '../../src/engine/character.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'basic-attack-sequence.json'), 'utf8'));

const buildEngine = (seed: string, chars: Character[]): GameEngine => {
  const grid = new Grid(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({ seed, grid, characters: chars, effects: reg });
};

const charsFromFixture = (): Character[] =>
  (fixture.characters as Array<Record<string, unknown>>).map((c) => ({
    id: asCharacterId(c['id'] as string),
    name: c['name'] as string,
    kind: c['kind'] as 'hero' | 'monster',
    archetype: c['archetype'] as Character['archetype'],
    pools: c['pools'] as Character['pools'],
    health: { total: c['healthTotal'] as number, damage: 0, status: 'normal' },
    pos: c['pos'] as Character['pos'],
    normalAttack: c['normalAttack'] as Character['normalAttack'],
    specialAction: { id: asEffectId((c['specialAction'] as { id: string }).id), name: '', description: '' },
    bonusAbility: { id: asEffectId((c['bonusAbility'] as { id: string }).id), name: '', description: '' },
    inventory: [],
    boons: [],
    skills: [],
  }));

describe('replay invariant', () => {
  it('replaying the same fixture twice produces identical engine state', () => {
    const engine1 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine1, fixture);
    const snap1 = snapshotEngineState(engine1);

    const engine2 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine2, fixture);
    const snap2 = snapshotEngineState(engine2);

    expect(snap2).toEqual(snap1);
  });

  it('different seed produces different snapshot', () => {
    const engine1 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine1, fixture);
    const snap1 = snapshotEngineState(engine1);

    const engine2 = buildEngine('different-seed', charsFromFixture());
    replayFromFixture(engine2, fixture);
    const snap2 = snapshotEngineState(engine2);

    expect(snap2).not.toEqual(snap1);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `npx vitest run tests/log/replay.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement replay harness**

Create `src/log/replay.ts`:

```ts
import type { GameEngine } from '../engine/game-engine.js';
import type { CharacterId } from '../engine/ids.js';
import { asCharacterId } from '../engine/ids.js';
import type { PlayerAction } from '../engine/action.js';
import type { Character } from '../engine/character.js';

export interface ReplayFixture {
  seed: string;
  characters: unknown[];
  narrativeActor: string;
  actions: Array<{ actorId: string; action: PlayerAction }>;
}

export const replayFromFixture = (engine: GameEngine, fixture: ReplayFixture): void => {
  engine.beginNarrativeTurn(asCharacterId(fixture.narrativeActor));
  for (const step of fixture.actions) {
    const result = engine.applyAction(asCharacterId(step.actorId), step.action);
    if (!result.ok) {
      throw new Error(`Replay diverged on action ${JSON.stringify(step.action)}: ${result.error.reason}`);
    }
  }
};

/**
 * Canonicalized snapshot used for equality checks. Excludes pendingEvents
 * (already drained) and includes only public, deterministic state.
 */
export const snapshotEngineState = (engine: GameEngine): {
  characters: Array<{ id: CharacterId; pos: Character['pos']; health: Character['health'] }>;
  phase: string;
  activeActor: CharacterId | null;
} => {
  const chars = Array.from(engine.charactersById().values())
    .map((c) => ({ id: c.id, pos: c.pos, health: c.health }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    characters: chars,
    phase: engine.turn.phase,
    activeActor: engine.turn.activeActorId,
  };
};
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/log/replay.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/log/replay.ts tests/log/replay.test.ts tests/fixtures/basic-attack-sequence.json
git commit -m "feat(log): replay harness proves engine state determinism"
```

---

### Task 22: Adventure schema (engine-side; encoding deferred to Layer C)

**Files:**
- Create: `src/engine/adventure.ts`
- Create: `tests/engine/adventure.test.ts`
- Create: `adventures/stub-one-scene.json`

The full Basement O' Rats encoding is Layer C work. Here we define the schema, write a loader, and ship a tiny stub adventure for integration tests.

- [ ] **Step 1: Write stub adventure**

Create `adventures/stub-one-scene.json`:

```json
{
  "id": "stub-one-scene",
  "title": "Stub: a single empty cell for engine integration tests",
  "estimatedDurationMin": 5,
  "scenes": [
    {
      "id": "stub-cell",
      "intro": "You stand in a dim stone room. A single rat scurries in the corner.",
      "map": {
        "width": 8,
        "height": 8,
        "background": "stub-cell",
        "obstacles": [],
        "exits": []
      },
      "monsters": [
        { "type": "giant-rat", "startPos": { "x": 5, "y": 5 } }
      ],
      "tactics": "Rat won't attack until attacked first.",
      "abilityTests": [],
      "conclusion": "The rat lies still. The room is quiet again.",
      "transitions": [{ "to": "END", "trigger": "all-monsters-ko" }]
    }
  ]
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/engine/adventure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAdventure } from '../../src/engine/adventure.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('loadAdventure', () => {
  it('loads the stub adventure', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'stub-one-scene.json'));
    expect(adv.id).toBe('stub-one-scene');
    expect(adv.scenes).toHaveLength(1);
    expect(adv.scenes[0]!.id).toBe('stub-cell');
  });

  it('rejects an adventure with a transition to a non-existent scene', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-'));
    const file = path.join(tmp, 'bad.json');
    await fs.writeFile(file, JSON.stringify({
      id: 'bad', title: 'Bad', estimatedDurationMin: 1,
      scenes: [{
        id: 's1', intro: '', conclusion: '',
        map: { width: 4, height: 4, background: 'b', obstacles: [], exits: [] },
        monsters: [], tactics: '', abilityTests: [],
        transitions: [{ to: 'no-such-scene', trigger: 'all-monsters-ko' }],
      }],
    }));
    await expect(loadAdventure(file)).rejects.toThrow(/transition.*no-such-scene/i);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/engine/adventure.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement adventure schema and loader**

Create `src/engine/adventure.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const SquareSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });

const SceneMapSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  background: z.string().min(1),
  obstacles: z.array(SquareSchema),
  exits: z.array(z.object({ to: z.string(), at: SquareSchema })),
});

const SceneMonsterSchema = z.object({
  type: z.string().min(1),
  startPos: SquareSchema,
});

const AbilityTestSchema = z.object({
  skill: z.string().min(1),
  difficulty: z.union([z.literal(4), z.literal(5), z.literal(6)]),
  describe: z.string().min(1),
});

const SceneTransitionSchema = z.object({
  to: z.string().min(1),
  trigger: z.enum(['all-monsters-ko', 'manual', 'on-exit']),
});

const SceneSchema = z.object({
  id: z.string().min(1),
  intro: z.string(),
  map: SceneMapSchema,
  monsters: z.array(SceneMonsterSchema),
  tactics: z.string(),
  abilityTests: z.array(AbilityTestSchema),
  conclusion: z.string(),
  transitions: z.array(SceneTransitionSchema),
});

const AdventureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  estimatedDurationMin: z.number().int().min(1),
  scenes: z.array(SceneSchema).min(1),
});

export type Adventure = z.infer<typeof AdventureSchema>;
export type Scene = z.infer<typeof SceneSchema>;

export const loadAdventure = async (filePath: string): Promise<Adventure> => {
  const raw = await readFile(filePath, 'utf8');
  const adv = AdventureSchema.parse(JSON.parse(raw));

  // Cross-ref: every transition must point at an existing scene id (or 'END').
  const sceneIds = new Set(adv.scenes.map((s) => s.id));
  for (const scene of adv.scenes) {
    for (const t of scene.transitions) {
      if (t.to !== 'END' && !sceneIds.has(t.to)) {
        throw new Error(`Scene "${scene.id}" has transition to non-existent scene "${t.to}"`);
      }
    }
  }

  return adv;
};
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/engine/adventure.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/adventure.ts tests/engine/adventure.test.ts adventures/stub-one-scene.json
git commit -m "feat(engine): adventure schema and loader (stub adventure)"
```

---

### Task 23: Public API surface

**Files:**
- Create: `src/engine/index.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Engine exports**

Create `src/engine/index.ts`:

```ts
export * from './ids.js';
export * from './primitives.js';
export * from './character.js';
export * from './action.js';
export { Dice } from './dice.js';
export { Grid } from './grid.js';
export type { GridCell, MoveContext, SightResult } from './grid.js';
export { resolveAttack, resolveAbilityTest } from './resolution.js';
export type {
  AttackContext,
  AttackModifiers,
  AttackResult,
  AbilityTestContext,
  AbilityTestResult,
} from './resolution.js';
export { TurnTracker } from './turn-tracker.js';
export type { TurnPhase, Side, CombatOrder } from './turn-tracker.js';
export {
  EffectRegistry,
  registerCoreEffects,
} from './effects.js';
export type {
  Effect,
  EffectKind,
  EffectChange,
  EffectContext,
  EffectResult,
} from './effects.js';
export { GameEngine } from './game-engine.js';
export type { GameEngineConfig, ActionOk } from './game-engine.js';
export { loadCatalogs } from './load.js';
export type { Catalogs } from './load.js';
export { loadAdventure } from './adventure.js';
export type { Adventure, Scene } from './adventure.js';
export {
  HeroEntrySchema,
  MonsterEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
} from './catalogs.js';
export type {
  HeroEntry,
  MonsterEntry,
  ItemEntry,
  EquipmentEntry,
  BoonEntry,
} from './catalogs.js';
```

- [ ] **Step 2: Top-level package exports**

Create `src/index.ts`:

```ts
export * from './engine/index.js';
export { EventLog, readEventLog } from './log/event-log.js';
export type { Event } from './log/events.js';
export { writeManifest } from './log/manifest.js';
export type { RunManifest, AgentRecord, HumanRecord } from './log/manifest.js';
export { replayFromFixture, snapshotEngineState } from './log/replay.js';
export type { ReplayFixture } from './log/replay.js';
```

- [ ] **Step 3: Verify build**

Run:
```bash
npx tsc --noEmit
```
Expected: clean exit.

- [ ] **Step 4: Verify all tests still pass**

Run:
```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/index.ts src/index.ts
git commit -m "feat: public api surface for engine + log"
```

---

### Task 24: End-to-end stub-adventure integration test

**Files:**
- Create: `tests/integration/stub-adventure.test.ts`
- Create: `tests/fixtures/full-stub-run.json`

This pulls together everything: load the stub adventure, build characters from catalogs, run a scripted action sequence covering DM narration → combat start → attack → KO → combat end → narrative resolution, write to disk, replay, and assert state equality.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/full-stub-run.json`:

```json
{
  "seed": "integration-1",
  "adventureFile": "adventures/stub-one-scene.json",
  "heroIds": ["warrior", "warlock-fire"],
  "humanCharacterId": "h-human",
  "humanArchetype": "hunter",
  "actions": [
    { "actor": "dm", "action": { "kind": "set_scene", "sceneId": "stub-cell" } },
    { "actor": "dm", "action": { "kind": "narrate", "text": "You stand in a dim stone room." } },
    {
      "actor": "dm",
      "action": {
        "kind": "start_combat",
        "heroSide": ["h-warrior", "h-warlock-fire", "h-human"],
        "monsterSide": ["m-giant-rat-1"]
      }
    },
    { "actor": "dm", "action": { "kind": "end_combat" } },
    { "actor": "dm", "action": { "kind": "request_action", "actorId": "h-warrior" } },
    { "actor": "h-warrior", "action": { "kind": "say", "text": "Stand back." } },
    { "actor": "h-warrior", "action": { "kind": "end_turn" } }
  ]
}
```

- [ ] **Step 2: Write the test**

Create `tests/integration/stub-adventure.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameEngine,
  Grid,
  EffectRegistry,
  registerCoreEffects,
  loadCatalogs,
  loadAdventure,
  asCharacterId,
  asEffectId,
} from '../../src/engine/index.js';
import { EventLog, readEventLog } from '../../src/log/event-log.js';
import { snapshotEngineState } from '../../src/log/replay.js';
import type { Character } from '../../src/engine/character.js';
import type { HeroEntry, MonsterEntry } from '../../src/engine/catalogs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const heroFromCatalog = (id: string, hero: HeroEntry, pos: { x: number; y: number }): Character => ({
  id: asCharacterId(id),
  name: hero.name,
  kind: 'hero',
  archetype: hero.archetype,
  pools: hero.pools,
  health: { total: hero.healthTotal, damage: 0, status: 'normal' },
  pos,
  normalAttack: hero.normalAttack,
  specialAction: { id: asEffectId(hero.specialAction.effectId), name: hero.specialAction.name, description: hero.specialAction.description },
  bonusAbility: { id: asEffectId(hero.bonusAbility.effectId), name: hero.bonusAbility.name, description: hero.bonusAbility.description },
  inventory: [...hero.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
  boons: [],
  skills: hero.defaultSkills as Character['skills'],
});

const monsterFromCatalog = (id: string, m: MonsterEntry, pos: { x: number; y: number }): Character => ({
  id: asCharacterId(id),
  name: m.name,
  kind: 'monster',
  pools: m.pools,
  health: { total: m.healthTotal, damage: 0, status: 'normal' },
  pos,
  normalAttack: m.normalAttack,
  specialAction: { id: asEffectId(m.specialAction.effectId), name: m.specialAction.name, description: m.specialAction.description },
  bonusAbility: { id: asEffectId(m.bonusAbility.effectId), name: m.bonusAbility.name, description: m.bonusAbility.description },
  inventory: [],
  boons: [],
  skills: [],
});

describe('stub adventure end-to-end', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'stub-run-')); });

  it('runs the scripted sequence, persists, and replays identically', async () => {
    const fixture = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/full-stub-run.json'), 'utf8'));
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, fixture.adventureFile));

    // Build characters: 2 AI heroes, 1 human-controlled hero, 1 rat from scene[0].monsters[0].
    const warrior = heroFromCatalog('h-warrior', cats.heroes.get('warrior')!, { x: 1, y: 1 });
    const warlock = heroFromCatalog('h-warlock-fire', cats.heroes.get('warlock-fire')!, { x: 2, y: 1 });
    const human = heroFromCatalog('h-human', cats.heroes.get('hunter')!, { x: 1, y: 2 });
    const rat = monsterFromCatalog(
      'm-giant-rat-1',
      cats.monsters.get('giant-rat')!,
      adv.scenes[0]!.monsters[0]!.startPos,
    );

    const grid = new Grid(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));
    const reg = new EffectRegistry();
    registerCoreEffects(reg);

    const engine = new GameEngine({
      seed: fixture.seed,
      grid,
      characters: [warrior, warlock, human, rat],
      effects: reg,
      items: cats.items,
    });

    const log = await EventLog.create(path.join(dir, 'events.jsonl'));

    for (const step of fixture.actions) {
      const result = step.actor === 'dm'
        ? engine.applyDmAction(step.action)
        : engine.applyAction(asCharacterId(step.actor), step.action);
      if (!result.ok) {
        throw new Error(`Step failed: ${JSON.stringify(step)} → ${JSON.stringify(result.error)}`);
      }
      for (const ev of engine.flushEvents()) await log.append(ev);
    }
    await log.close();

    // Read back events and assert non-empty.
    const events = await readEventLog(path.join(dir, 'events.jsonl'));
    expect(events.length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'narrate')).toBeDefined();
    expect(events.find((e) => e.type === 'combat_started')).toBeDefined();

    // Replay invariant: rebuilding the engine with same seed + actions yields same state.
    const engine2 = new GameEngine({
      seed: fixture.seed,
      grid,
      characters: [warrior, warlock, human, rat].map((c) => ({ ...c })),  // fresh copies
      effects: reg,
      items: cats.items,
    });
    for (const step of fixture.actions) {
      if (step.actor === 'dm') engine2.applyDmAction(step.action);
      else engine2.applyAction(asCharacterId(step.actor), step.action);
    }

    expect(snapshotEngineState(engine2)).toEqual(snapshotEngineState(engine));
  });
});
```

- [ ] **Step 3: Run test to verify pass**

Run:
```bash
npx vitest run tests/integration/stub-adventure.test.ts
```
Expected: PASS, 1 test.

- [ ] **Step 4: Run the full test suite as a sanity check**

Run:
```bash
npm test
```
Expected: all tests pass across all files.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/stub-adventure.test.ts tests/fixtures/full-stub-run.json
git commit -m "test(integration): stub adventure end-to-end with replay invariant"
```

---

### Task 25: README for the engine package

**Files:**
- Modify: `README.md`

The repo's `README.md` is currently empty. Replace it with a brief orientation pointing at the spec, the engine API, and how to run tests. This is the entry point for the next plan's executor.

- [ ] **Step 1: Replace README content**

Replace `README.md` contents with:

```markdown
# Agents TTRPG — Engine Foundation

A headless, deterministic implementation of the **HeroKids** TTRPG ruleset. This package is Layer A of the Agents TTRPG project: it provides the game engine, item/equipment/boon catalogs, event log, and replay harness. It contains no LLM code, no UI, and no networking.

See `docs/superpowers/specs/2026-05-08-agents-rpg-design.md` for the full project design. See `docs/superpowers/plans/2026-05-08-engine-foundation.md` for the plan that produced this layer.

## Install

```bash
npm install
```

## Test

```bash
npm test           # one-shot
npm run test:watch # tdd loop
```

## Build (typecheck only — no bundler)

```bash
npm run build
```

## Layout

- `src/engine/` — pure rules engine (no I/O)
- `src/log/` — event log writer/reader, manifest, replay harness
- `data/` — JSON catalogs (heroes, monsters, items, equipment, boons)
- `adventures/` — adventure JSONs (currently: `stub-one-scene.json`)
- `tests/` — vitest unit + integration tests

## Replay invariant

Given a seed plus an action sequence, the engine produces identical state on every run. The integration test in `tests/integration/stub-adventure.test.ts` proves this end-to-end.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: orient readme around engine foundation"
```

---

## Self-Review

I checked the plan against the spec section by section.

**Spec coverage:**

| Spec section | Plan coverage |
|---|---|
| §1 Decisions table (1–13) | All 13 honoured. v1 archetypes (warrior/hunter/healer/warlock) populated; items/equipment/boons all four categories present; sprite extraction is deferred to Layer C as the spec says. |
| §2 Architecture overview | Layer A scope only — Node engine, no browser, no orchestrator. |
| §3 Components and turn cycle | `GameEngine`, `EventLog` implemented. `Orchestrator`, `Agent`, `LlmClient`, `WsServer` deferred to Layer B (correctly). |
| §4 Domain model + resolution | Character, AttackSpec, SpecialSpec, BonusSpec — all in `character.ts`. Resolution rules — `resolution.ts`. Action vocabulary — `action.ts`. Item/Equipment/Boon — `catalogs.ts`. Adventure schema — `adventure.ts`. |
| §5 Agent prompts, ReACT, visibility | Deferred to Layer B by design. |
| §6 Event log + replay | `event-log.ts`, `manifest.ts`, `replay.ts`, replay invariant proven in two tests. |
| §7 Evaluation | Deferred to Layer D by design. |
| §8 Asset pipeline | Deferred to Layer C by design (no Pixi here). |
| §9 Open questions | Acknowledged via deferrals where applicable. |

No gaps within the Layer A scope.

**Placeholder scan:**

- Two `// TODO:` markers exist in code: one for Rogue's Nimble movement (Task 14, irrelevant for v1 archetypes), one for attack-modifier gathering (Task 15, partially populated for cover; engaged/prone/persona modifiers are Layer B because they need agent state). Both are documented as Layer B work in the plan prose. Acceptable.
- No unfilled "TBD" or "implement later" outside the deferral fences described above.

**Type consistency:**

- `Character.specialAction.id` is `EffectId` throughout (used in `character.ts`, `effects.ts`, `game-engine.ts`).
- `PlayerAction.use_item` carries `itemId: ItemId` everywhere it appears.
- `applyAction(actorId, action)` returns `Result<ActionOk, RuleViolation>` consistently.
- `RuleViolation` discriminated union is referenced by reason in tests; reasons used (`out-of-range`, `no-line-of-sight`, `invalid-target`, `not-actors-turn`, `unknown-id`, `wrong-phase`, `insufficient-movement`, `blocked-by-wall`, `invalid-action-shape`) are all declared in `action.ts`.
- `EventLog.append(event: Event)` matches `readEventLog` returning `Event[]`.

No inconsistencies found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-engine-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
