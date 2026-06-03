# Tavern-Basement Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Basement O' Rats encounter 1 to its canonical 11×7 layout with pixel-art tileset and per-cell prop sprites, with engine support for obstacles + step-on exit triggers and a renderer that layers props on top of an assembled tile floor.

**Architecture:** Engine schema and Grid construction read scene `obstacles[]` and turn matching cells into `wall` (full block on movement + LoS). New scene map fields `decorations[]` and `exits[].trigger` are typed but currently no-op (defer behavior to encounter 2). Renderer gains a tilemap layer (replaces the single scaled bg sprite) and a props layer (above the tilemap, below character tokens). Asset manifest gains `tilesets` and `props` sections validated at WS boot.

**Tech Stack:** TypeScript, Vitest, Pixi.js (renderer), Zod (schema), PixelLab MCP (asset generation).

**Source spec:** `docs/superpowers/specs/2026-05-10-tavern-basement-map-design.md`

---

## File structure

**Files modified:**
- `src/engine/adventure.ts` — extend SceneMapSchema for typed obstacles/decorations/exits
- `src/engine/snapshot.ts` — extend RedactedSnapshot.scene with map data
- `src/runtime/ws/manifest.ts` — extend AssetManifest with tilesets + props
- `web/store.ts` — passes scene map data through unchanged (already polymorphic via type)
- `web/components/Board.ts` — wire tilemap + props layers, fall back to single-bg path for legacy maps
- `bin/play.ts` — call new `buildSceneGrid` instead of hard-coded all-floor; update hero spawns
- `adventures/basement-o-rats.json` — re-encode scene 1 to 11×7 with obstacles + decorations + exits
- `assets/manifest.json` — add tilesets + props sections, repoint maps.tavern-basement at the new tileset image

**Files created:**
- `src/engine/scene-grid.ts` — pure helper `buildSceneGrid(scene): Grid` consumed by `bin/play.ts`
- `web/components/TileMap.ts` — pure module that produces a Pixi Container of tile sprites for a scene
- `web/components/Props.ts` — pure module that produces a Pixi Container of prop sprites for obstacles + decorations + exits
- `tests/engine/scene-grid.test.ts` — unit tests for buildSceneGrid
- `tests/engine/adventure-schema.test.ts` — unit tests for the extended schema
- `tests/web/tilemap.test.ts` — unit tests for the pure tilemap-assembly logic
- `tests/web/props.test.ts` — unit tests for the pure prop-resolution logic
- `assets/maps/tavern-basement/tileset.png` — PixelLab output
- `assets/maps/tavern-basement/tileset.json` — hand-written tile metadata describing sub-rects
- `assets/props/{barrel-stack,wooden-wall-section,tunnel-hole,stairs-down}/south.png` — PixelLab outputs
- `assets/_legacy/tavern-basement.png` — moved from existing `assets/maps/tavern-basement.png`
- `docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/{tileset.png,...}` — exemplar mirrors

**Phases:**
- Phase A (Tasks 1–4) — engine + schema. Pure code, all TDD. No assets required.
- Phase B (Tasks 5–7) — asset generation via PixelLab + manifest install. Non-TDD (external service).
- Phase C (Tasks 8–10) — renderer. Pure modules TDD'd; Board.ts integration manually verified.
- Phase D (Tasks 11–13) — integration: encode the scene JSON, update spawns, run tests + live smoke.

---

## Phase A — Engine & schema

### Task 1: Extend SceneMapSchema for typed obstacles, decorations, and exits with triggers

**Files:**
- Modify: `src/engine/adventure.ts:6-12, 11`
- Test: `tests/engine/adventure-schema.test.ts` (create)

The current schema declares `obstacles: array(SquareSchema)` (just `{x,y}`) and `exits: array({to, at})` — no `type` field, no `trigger`. We need:
- `obstacles[]` entries to carry `{ type, x, y }` so the renderer can pick the right prop sprite
- a new `decorations[]` array (defaults to empty) for visual-only props
- `exits[]` entries to carry an optional `trigger` enum (defaults to `'manual'`)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/adventure-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdventure } from '../../src/engine/adventure.js';

const writeAdventure = (json: unknown): { path: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'adventure-schema-'));
  const path = join(root, 'adv.json');
  writeFileSync(path, JSON.stringify(json));
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const baseScene = {
  id: 'scene-1', intro: 'i', tactics: 't', conclusion: 'c',
  abilityTests: [], transitions: [], monsters: [],
};

describe('SceneMapSchema (extended)', () => {
  it('parses obstacles with type, x, y', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: {
          width: 5, height: 5, background: 'bg',
          obstacles: [{ type: 'barrel-stack', x: 1, y: 2 }],
          exits: [],
        },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.obstacles).toEqual([{ type: 'barrel-stack', x: 1, y: 2 }]);
    } finally { cleanup(); }
  });

  it('defaults decorations to [] when omitted', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.decorations).toEqual([]);
    } finally { cleanup(); }
  });

  it('parses decorations with type, x, y', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [{
        ...baseScene,
        map: {
          width: 5, height: 5, background: 'bg',
          obstacles: [],
          decorations: [{ type: 'stairs-down', x: 4, y: 2 }],
          exits: [],
        },
      }],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.decorations).toEqual([{ type: 'stairs-down', x: 4, y: 2 }]);
    } finally { cleanup(); }
  });

  it('parses exits with at and trigger', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [
        { ...baseScene,
          map: {
            width: 5, height: 5, background: 'bg', obstacles: [],
            exits: [{ to: 'scene-2', at: { x: 0, y: 4 }, trigger: 'step-on' }],
          },
        },
        { ...baseScene, id: 'scene-2',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
        },
      ],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.exits[0]).toEqual({
        to: 'scene-2', at: { x: 0, y: 4 }, trigger: 'step-on',
      });
    } finally { cleanup(); }
  });

  it('defaults exit trigger to "manual" when omitted (back-compat)', async () => {
    const { path, cleanup } = writeAdventure({
      id: 'a', title: 't', estimatedDurationMin: 10,
      scenes: [
        { ...baseScene,
          map: {
            width: 5, height: 5, background: 'bg', obstacles: [],
            exits: [{ to: 'scene-2', at: { x: 0, y: 4 } }],
          },
        },
        { ...baseScene, id: 'scene-2',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], exits: [] },
        },
      ],
    });
    try {
      const adv = await loadAdventure(path);
      expect(adv.scenes[0]!.map.exits[0]!.trigger).toBe('manual');
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/adventure-schema.test.ts`
Expected: 5 failing tests — `obstacles` schema rejects `type` field; `decorations` parses as undefined; `trigger` parses as undefined.

- [ ] **Step 3: Update SceneMapSchema in `src/engine/adventure.ts`**

Replace lines 6–12:

```typescript
const SquareSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });

const PropPlacementSchema = z.object({
  type: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

const SceneExitSchema = z.object({
  to: z.string().min(1),
  at: SquareSchema,
  trigger: z.enum(['manual', 'step-on']).default('manual'),
});

const SceneMapSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  background: z.string().min(1),
  obstacles: z.array(PropPlacementSchema),
  decorations: z.array(PropPlacementSchema).default([]),
  exits: z.array(SceneExitSchema),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/adventure-schema.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Run the full suite to confirm no other test broke**

Run: `npm test`
Expected: green. Note: existing `adventures/*.json` and test fixtures with empty `obstacles: []` continue to parse because empty arrays don't trigger per-element validation. If any test fixture has `obstacles: [{x, y}]` style with no type, it'll fail and you need to either update that fixture (preferred — add `type`) or extend the schema with `.passthrough()`. Inspect the failing fixture and update it to the new shape.

- [ ] **Step 6: Commit**

```bash
git add src/engine/adventure.ts tests/engine/adventure-schema.test.ts
git commit -m "feat(engine): typed obstacles/decorations/exits in scene map schema"
```

---

### Task 2: Build a `buildSceneGrid(scene)` helper that constructs a Grid from a Scene

**Files:**
- Create: `src/engine/scene-grid.ts`
- Test: `tests/engine/scene-grid.test.ts` (create)
- Modify (in Task 12, not now): `bin/play.ts:89-92` will adopt this helper

`bin/play.ts:89-92` currently builds an all-floor Grid by ignoring `scene.map.obstacles`. We move that construction to a pure module and have it honor obstacles. Per the spec, every entry in `obstacles[]` (regardless of `type`, since both `barrel-stack` and `wooden-wall-section` block fully) maps to a grid cell of kind `'wall'`. `decorations[]` cells stay `'floor'` (visual only). `exits[]` cells stay `'floor'` (walkable; trigger is no-op until encounter 2 lands).

- [ ] **Step 1: Write the failing test**

Create `tests/engine/scene-grid.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import type { Scene } from '../../src/engine/adventure.js';

const baseScene = (overrides: Partial<Scene['map']>): Scene => ({
  id: 's', intro: '', tactics: '', conclusion: '',
  abilityTests: [], transitions: [], monsters: [],
  map: {
    width: 3, height: 3, background: 'bg',
    obstacles: [], decorations: [], exits: [],
    ...overrides,
  },
});

describe('buildSceneGrid', () => {
  it('returns an all-floor grid when no obstacles', () => {
    const g = buildSceneGrid(baseScene({}));
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(g.cellAt({ x, y }).kind).toBe('floor');
      }
    }
  });

  it('marks obstacle cells as wall (full block)', () => {
    const g = buildSceneGrid(baseScene({
      obstacles: [
        { type: 'barrel-stack', x: 1, y: 1 },
        { type: 'wooden-wall-section', x: 2, y: 0 },
      ],
    }));
    expect(g.cellAt({ x: 1, y: 1 }).kind).toBe('wall');
    expect(g.cellAt({ x: 2, y: 0 }).kind).toBe('wall');
    expect(g.cellAt({ x: 0, y: 0 }).kind).toBe('floor');
  });

  it('leaves decoration cells as floor', () => {
    const g = buildSceneGrid(baseScene({
      decorations: [{ type: 'stairs-down', x: 1, y: 2 }],
    }));
    expect(g.cellAt({ x: 1, y: 2 }).kind).toBe('floor');
  });

  it('leaves exit cells as floor (walkable)', () => {
    const g = buildSceneGrid(baseScene({
      exits: [{ to: 'next', at: { x: 0, y: 0 }, trigger: 'step-on' }],
    }));
    expect(g.cellAt({ x: 0, y: 0 }).kind).toBe('floor');
  });

  it('grid dimensions match scene width × height', () => {
    const g = buildSceneGrid(baseScene({ width: 11, height: 7 }));
    expect(g.width).toBe(11);
    expect(g.height).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/scene-grid.test.ts`
Expected: FAIL — `buildSceneGrid is not exported` / module not found.

- [ ] **Step 3: Implement `src/engine/scene-grid.ts`**

```typescript
import { Grid, type GridCell } from './grid.js';
import type { Scene } from './adventure.js';

/**
 * Construct a Grid from a Scene, honoring `map.obstacles[]`. Every obstacle
 * entry becomes a `wall` cell (full block on movement and LoS) regardless of
 * its `type`, since the v1 prop set (barrel-stack, wooden-wall-section) all
 * fully block per the tavern-basement design spec. `decorations[]` and
 * `exits[]` cells remain `floor`.
 */
export const buildSceneGrid = (scene: Scene): Grid => {
  const { width, height, obstacles } = scene.map;
  const cells: GridCell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ kind: 'floor' as const })),
  );
  for (const o of obstacles) {
    if (o.x >= 0 && o.x < width && o.y >= 0 && o.y < height) {
      cells[o.y]![o.x] = { kind: 'wall' };
    }
  }
  return new Grid(cells);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/scene-grid.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/scene-grid.ts tests/engine/scene-grid.test.ts
git commit -m "feat(engine): buildSceneGrid honors scene obstacles as wall cells"
```

---

### Task 3: Extend `RedactedSnapshot.scene` to include map data so the renderer receives obstacles/decorations/exits

**Files:**
- Modify: `src/engine/snapshot.ts:24` — extend the scene type
- Modify: `src/engine/game-engine.ts` — wherever `getRedactedSnapshot` builds the scene field, include map data (search for `assetId` and `gridW`)
- Test: extend `tests/engine/snapshot.test.ts` (create if absent) OR add an assertion to an existing snapshot test

The current `RedactedSnapshot.scene` is `{ id, assetId, gridW, gridH } | null`. The browser's renderer needs `obstacles[]`, `decorations[]`, and `exits[]` to layer prop sprites. Extend the type and the engine builder.

- [ ] **Step 1: Locate the snapshot builder**

Run: `grep -n 'gridW' src/engine/game-engine.ts`
Expected: a single match in the `getRedactedSnapshot` method building `{ id, assetId, gridW, gridH }`. Note the line number for Step 3.

- [ ] **Step 2: Write the failing test**

Find or create `tests/engine/snapshot.test.ts`. Append:

```typescript
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId } from '../../src/engine/ids.js';
import type { Adventure } from '../../src/engine/adventure.js';

describe('RedactedSnapshot.scene includes map data', () => {
  it('exposes obstacles, decorations, and exits from the active scene', () => {
    const adventure: Adventure = {
      id: 'a', title: 't', estimatedDurationMin: 1,
      scenes: [{
        id: 'scene-1', intro: '', tactics: '', conclusion: '',
        abilityTests: [], transitions: [],
        monsters: [],
        map: {
          width: 3, height: 3, background: 'bg',
          obstacles: [{ type: 'barrel-stack', x: 1, y: 1 }],
          decorations: [{ type: 'stairs-down', x: 2, y: 0 }],
          exits: [{ to: 'END', at: { x: 0, y: 2 }, trigger: 'step-on' }],
        },
      }],
    };
    const grid = new Grid(Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))));
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const engine = new GameEngine({
      seed: 1, grid, characters: [],
      effects: reg, items: new Map(), boons: new Map(),
      adventure, monsters: new Map(),
    });
    engine.applyDmAction({ type: 'set_scene', sceneId: 'scene-1' });
    const snap = engine.getRedactedSnapshot({ kind: 'human' });
    expect(snap.scene?.obstacles).toEqual([{ type: 'barrel-stack', x: 1, y: 1 }]);
    expect(snap.scene?.decorations).toEqual([{ type: 'stairs-down', x: 2, y: 0 }]);
    expect(snap.scene?.exits).toEqual([
      { to: 'END', at: { x: 0, y: 2 }, trigger: 'step-on' },
    ]);
  });
});
```

(Adjust the `applyDmAction` shape and the `getRedactedSnapshot` viewer arg to match the project's actual signatures — verify by reading the surrounding `game-engine.ts` and existing snapshot tests.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/engine/snapshot.test.ts`
Expected: FAIL — `obstacles` etc. not on `snap.scene`.

- [ ] **Step 4: Extend the type in `src/engine/snapshot.ts:24`**

Replace the line:

```typescript
  scene: { id: string; assetId: string; gridW: number; gridH: number } | null;
```

with:

```typescript
  scene: {
    id: string;
    assetId: string;
    gridW: number;
    gridH: number;
    obstacles: { type: string; x: number; y: number }[];
    decorations: { type: string; x: number; y: number }[];
    exits: { to: string; at: Square; trigger: 'manual' | 'step-on' }[];
  } | null;
```

- [ ] **Step 5: Update the snapshot builder in `src/engine/game-engine.ts`**

Find the snippet (located in Step 1) that constructs the `{ id, assetId, gridW, gridH }` object inside `getRedactedSnapshot`. Add the three new fields, sourcing from the active scene's `map`:

```typescript
const activeScene = /* existing accessor */;
const sceneField = activeScene ? {
  id: activeScene.id,
  assetId: activeScene.map.background,
  gridW: activeScene.map.width,
  gridH: activeScene.map.height,
  obstacles: activeScene.map.obstacles,
  decorations: activeScene.map.decorations,
  exits: activeScene.map.exits,
} : null;
```

(Wire whatever existing variable name `activeScene` happens to be in the file.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/engine/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npm test && npm run typecheck`
Expected: green. The `RedactedSnapshot` type change is non-breaking for consumers that only read `id/assetId/gridW/gridH`; the new fields are additive.

- [ ] **Step 8: Commit**

```bash
git add src/engine/snapshot.ts src/engine/game-engine.ts tests/engine/snapshot.test.ts
git commit -m "feat(engine): expose scene obstacles/decorations/exits in redacted snapshot"
```

---

### Task 4: Extend AssetManifest with `tilesets` and `props` sections

**Files:**
- Modify: `src/runtime/ws/manifest.ts:4-40`
- Test: `tests/runtime/ws/manifest.test.ts` (extend)

Add two new manifest sections:
- `tilesets`: `Record<string, { image: string; metadata: string }>` — each entry maps a tileset id to its image path and JSON metadata path.
- `props`: `Record<string, string>` — each entry maps a prop id to a single sprite path (matches the per-cell prop convention).

`loadManifest` defaults both to empty. `validateManifest` calls `statSync` on every referenced file.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/ws/manifest.test.ts`:

```typescript
describe('manifest validator — tilesets and props', () => {
  it('passes when tileset image + metadata exist and props files exist', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'maps', 'tavern'),  { recursive: true });
      mkdirSync(join(root, 'props', 'barrel'), { recursive: true });
      writeFileSync(join(root, 'maps', 'tavern', 'tileset.png'), 'png');
      writeFileSync(join(root, 'maps', 'tavern', 'tileset.json'), '{}');
      writeFileSync(join(root, 'props', 'barrel', 'south.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: { tavern: { image: 'maps/tavern/tileset.png',
                              metadata: 'maps/tavern/tileset.json' } },
        props:    { barrel: 'props/barrel/south.png' },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
      expect(m.tilesets.tavern).toEqual({
        image: 'maps/tavern/tileset.png', metadata: 'maps/tavern/tileset.json',
      });
      expect(m.props.barrel).toBe('props/barrel/south.png');
    } finally { cleanup(); }
  });

  it('throws on missing tileset image', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: { tavern: { image: 'maps/tavern/tileset.png', metadata: 'x.json' } },
        props: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/tileset.*tavern.*image/i);
    } finally { cleanup(); }
  });

  it('throws on missing prop file', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: {},
        props: { barrel: 'props/barrel/south.png' },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/props\.barrel.*south\.png/);
    } finally { cleanup(); }
  });

  it('defaults tilesets and props to {} when omitted', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(m.tilesets).toEqual({});
      expect(m.props).toEqual({});
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runtime/ws/manifest.test.ts`
Expected: 4 new failing tests (`tilesets` undefined, `props` undefined, validator doesn't check new sections).

- [ ] **Step 3: Update `src/runtime/ws/manifest.ts`**

Replace the entire file content with:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AssetManifest {
  heroes:    Record<string, string>;
  monsters:  Record<string, string>;
  maps:      Record<string, string>;
  items:     Record<string, string>;
  equipment: Record<string, string>;
  boons:     Record<string, string>;
  tilesets:  Record<string, { image: string; metadata: string }>;
  props:     Record<string, string>;
}

export const loadManifest = (path: string): AssetManifest => {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AssetManifest>;
  return {
    heroes:    parsed.heroes    ?? {},
    monsters:  parsed.monsters  ?? {},
    maps:      parsed.maps      ?? {},
    items:     parsed.items     ?? {},
    equipment: parsed.equipment ?? {},
    boons:     parsed.boons     ?? {},
    tilesets:  parsed.tilesets  ?? {},
    props:     parsed.props     ?? {},
  };
};

const FLAT_GROUPS = ['heroes', 'monsters', 'maps', 'items', 'equipment', 'boons', 'props'] as const;

const checkFile = (full: string, label: string): void => {
  try {
    const s = statSync(full);
    if (!s.isFile()) throw new Error(`Manifest asset is not a file: ${label}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Missing manifest asset ${label} (${msg})`);
  }
};

export const validateManifest = (m: AssetManifest, assetsRoot: string): void => {
  for (const g of FLAT_GROUPS) {
    for (const [id, rel] of Object.entries(m[g])) {
      checkFile(join(assetsRoot, rel), `${g}.${id}: ${rel}`);
    }
  }
  for (const [id, ts] of Object.entries(m.tilesets)) {
    checkFile(join(assetsRoot, ts.image),    `tilesets.${id}.image: ${ts.image}`);
    checkFile(join(assetsRoot, ts.metadata), `tilesets.${id}.metadata: ${ts.metadata}`);
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runtime/ws/manifest.test.ts`
Expected: all PASS (the original 2 plus the 4 new ones).

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: green. The `AssetManifest` change is additive but the `tilesets` and `props` fields are now required on the type, which will surface anywhere consumers spread or construct the type literally. Fix any compile errors by adding `tilesets: {}, props: {}` to the offending object literals. Test fixtures that construct manifests in-line will need this update too.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/ws/manifest.ts tests/runtime/ws/manifest.test.ts
# Plus any test fixtures that needed `tilesets: {}, props: {}` added
git commit -m "feat(ws): manifest gains tilesets and props sections"
```

---

## Phase B — Asset generation (PixelLab)

### Task 5: Generate the floor/wall tileset via PixelLab

**Files:**
- Create: `assets/maps/tavern-basement/tileset.png` (PixelLab output)
- Create: `assets/maps/tavern-basement/tileset.json` (hand-written metadata)

This task uses the PixelLab MCP. It runs against an external service and is not TDD'd.

- [ ] **Step 1: Verify the existing cartoon background is archived**

Run:

```bash
test -f assets/maps/tavern-basement.png && \
  mkdir -p assets/_legacy && \
  git mv assets/maps/tavern-basement.png assets/_legacy/tavern-basement.png
```

Expected: file is moved to legacy. Skip if already archived from a prior task.

- [ ] **Step 2: Call `mcp__pixellab__create_topdown_tileset`**

Use the parameters from the spec (`docs/superpowers/specs/2026-05-10-tavern-basement-map-design.md` §"Locked PixelLab parameters"):

- `mode`: `standard`
- Tile size: `64`
- Description: *warm tavern cellar — dark wooden plank floor with subtle grain variation, stone-and-plaster wall sections with wooden support beams, ambient warm lantern lighting, basic shading, single color black outline, medium detail*
- Request both floor variants AND wall edges (corners + sides) so the renderer can assemble the room shell

The tool returns a job id. Poll `mcp__pixellab__get_topdown_tileset` until complete (~2–3 minutes is the typical wait per the prior pixel-art-direction spec; if it stalls past 6 minutes with growing ETA, see the warlock-generation lesson in the prior spec's "Lessons from this session" section).

- [ ] **Step 3: Inspect the generated tileset and document its layout**

The `create_topdown_tileset` output format is not fully predictable in advance. After download, open the image and identify:
- Image dimensions (e.g., 256×256 for 4×4 tiles at 64 px each)
- Which tile index corresponds to which logical tile (floor variants, wall N/S/E/W, corners NW/NE/SW/SE, interior straight)

Save the image to `assets/maps/tavern-basement/tileset.png`. Hand-write `assets/maps/tavern-basement/tileset.json`:

```json
{
  "image": "tileset.png",
  "tileSize": 64,
  "tiles": {
    "floor":    { "x": 0,  "y": 0  },
    "floor_b":  { "x": 64, "y": 0  },
    "wall_n":   { "x": 0,  "y": 64 },
    "wall_s":   { "x": 64, "y": 64 },
    "wall_w":   { "x": 0,  "y": 128 },
    "wall_e":   { "x": 64, "y": 128 },
    "corner_nw": { "x": 0,   "y": 192 },
    "corner_ne": { "x": 64,  "y": 192 },
    "corner_sw": { "x": 128, "y": 192 },
    "corner_se": { "x": 192, "y": 192 }
  }
}
```

(Adjust the keys and pixel coordinates to match the actual tile layout PixelLab returns. If the tileset only has interior floor + perimeter walls without distinct corners, omit the corner keys and have the renderer fall back to a wall_n/wall_s tile at corners.)

- [ ] **Step 4: Mirror the tileset to spec exemplars**

```bash
mkdir -p docs/superpowers/specs/assets/2026-05-10-tavern-basement-map
cp assets/maps/tavern-basement/tileset.png  docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/
cp assets/maps/tavern-basement/tileset.json docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/
```

- [ ] **Step 5: Commit (manifest update happens in Task 7)**

```bash
git add assets/_legacy/tavern-basement.png \
        assets/maps/tavern-basement/tileset.png \
        assets/maps/tavern-basement/tileset.json \
        docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/
git commit -m "feat(assets): pixel-art tileset for tavern-basement map"
```

---

### Task 6: Generate the 4 prop sprites via PixelLab (parallel)

**Files:**
- Create: `assets/props/barrel-stack/south.png`
- Create: `assets/props/wooden-wall-section/south.png`
- Create: `assets/props/tunnel-hole/south.png`
- Create: `assets/props/stairs-down/south.png`
- Mirrors under `docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/`

- [ ] **Step 1: Call `mcp__pixellab__create_object` 4 times in parallel**

Per the spec's locked parameters: `mode: standard`, `view: 'low top-down'`, `n_directions: 1`, `size: 64`, `outline: 'single color black outline'`, `shading: 'basic shading'`, `detail: 'medium detail'`, transparent background.

Descriptions (from the spec):

| id | description |
|---|---|
| `barrel-stack` | single wooden barrel viewed slightly from above, dark oak staves with iron hoops, top of barrel visible |
| `wooden-wall-section` | vertical wooden plank wall section about 5 feet tall, rough-hewn timber, viewed slightly from south |
| `tunnel-hole` | jagged hole in plank floor with broken floorboards, dark void below, hint of dirt tunnel visible |
| `stairs-down` | bottom of a wooden staircase descending from above, viewed top-down, three or four wooden steps fading into darkness at the top |

Submit all four jobs concurrently in a single tool-call batch, then poll each with `mcp__pixellab__get_object` until completion. Allow up to ~6 min wall time per job in the worst case (the `tunnel-hole` and `stairs-down` prompts have the same kind of details that stalled the warlock and king-rat in the prior session — be patient before regenerating).

- [ ] **Step 2: Download and place sprites**

For each completed sprite:

```bash
mkdir -p assets/props/<id>
# (download the south-facing render to assets/props/<id>/south.png)
```

Verify each PNG has a transparent background:

```bash
file assets/props/barrel-stack/south.png
# Expect: "PNG image data, 64 x 64, 8-bit/color RGBA, non-interlaced"
```

- [ ] **Step 3: Mirror to spec exemplars**

```bash
for p in barrel-stack wooden-wall-section tunnel-hole stairs-down; do
  mkdir -p "docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/$p"
  cp "assets/props/$p/south.png" "docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/$p/south.png"
done
```

- [ ] **Step 4: Visual sanity check**

Open each sprite in a viewer at 64 px and confirm the validation gate (3) holds: each is unambiguous, distinct from the other three, and the aesthetic is consistent with the heroes/monsters from the prior session. If any prop fails — regenerate that prop with an adjusted description per the validation gate's escalation rule (re-prompt twice in `standard` before falling back to `pro` mode).

- [ ] **Step 5: Commit**

```bash
git add assets/props/ docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/
git commit -m "feat(assets): pixel-art prop sprites for tavern-basement obstacles"
```

---

### Task 7: Update `assets/manifest.json` with the new tileset and props, and verify validation

**Files:**
- Modify: `assets/manifest.json`

- [ ] **Step 1: Update `assets/manifest.json`**

Replace the file content with:

```json
{
  "heroes": {
    "warrior":  "heroes/warrior/south.png",
    "hunter":   "heroes/hunter/south.png",
    "healer":   "heroes/healer/south.png",
    "warlock":  "heroes/warlock/south.png"
  },
  "monsters": {
    "giant-rat": "monsters/giant-rat/south.png",
    "king-rat":  "monsters/king-rat/south.png"
  },
  "maps": {
    "tavern-basement":     "maps/tavern-basement/tileset.png",
    "rat-tunnel":          "maps/rat-tunnel.png",
    "underground-choices": "maps/underground-choices.png",
    "momentary-detour":    "maps/momentary-detour.png",
    "rat-den":             "maps/rat-den.png"
  },
  "tilesets": {
    "tavern-basement": {
      "image":    "maps/tavern-basement/tileset.png",
      "metadata": "maps/tavern-basement/tileset.json"
    }
  },
  "props": {
    "barrel-stack":         "props/barrel-stack/south.png",
    "wooden-wall-section":  "props/wooden-wall-section/south.png",
    "tunnel-hole":          "props/tunnel-hole/south.png",
    "stairs-down":          "props/stairs-down/south.png"
  },
  "items": {},
  "equipment": {},
  "boons": {}
}
```

- [ ] **Step 2: Run a manifest-validation smoke**

Write a one-shot verification that calls `validateManifest`:

```bash
node --experimental-strip-types -e "
import('./src/runtime/ws/manifest.ts').then(({ loadManifest, validateManifest }) => {
  const m = loadManifest('./assets/manifest.json');
  validateManifest(m, './assets');
  console.log('manifest OK');
});
"
```

Expected: `manifest OK` printed; no exception. If a path is missing, the error message will name it — go fix the missing asset.

- [ ] **Step 3: Commit**

```bash
git add assets/manifest.json
git commit -m "chore(assets): manifest entries for tavern-basement tileset and props"
```

---

## Phase C — Renderer

### Task 8: Pure tilemap-assembly module + tests

**Files:**
- Create: `web/components/TileMap.ts`
- Test: `tests/web/tilemap.test.ts`

The pure module exports two functions:
1. `loadTilesetMetadata(json)` — validates the JSON shape, returns a typed metadata object.
2. `chooseTile(x, y, gridW, gridH, metadata)` — pure resolver: given a cell coordinate and the room dimensions, returns the tile id to render at that cell (e.g., `"corner_nw"` at (0,0), `"wall_n"` at top edge interior, `"floor"` at interior cells). Renderer integration in Task 10 calls this for each cell and draws the corresponding sub-rect of the tileset image.

This task tests only the pure logic. The Pixi rendering side-effect lives in Task 10.

- [ ] **Step 1: Write the failing tests**

Create `tests/web/tilemap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chooseTile, loadTilesetMetadata } from '../../web/components/TileMap.js';

const META = loadTilesetMetadata({
  image: 'tileset.png', tileSize: 64,
  tiles: {
    floor:     { x: 0,   y: 0 },
    wall_n:    { x: 0,   y: 64 },
    wall_s:    { x: 64,  y: 64 },
    wall_w:    { x: 0,   y: 128 },
    wall_e:    { x: 64,  y: 128 },
    corner_nw: { x: 0,   y: 192 },
    corner_ne: { x: 64,  y: 192 },
    corner_sw: { x: 128, y: 192 },
    corner_se: { x: 192, y: 192 },
  },
});

describe('chooseTile (11×7 room)', () => {
  it('returns corner_nw at (0,0)', () => {
    expect(chooseTile(0, 0, 11, 7, META)).toBe('corner_nw');
  });
  it('returns corner_ne at (10,0)', () => {
    expect(chooseTile(10, 0, 11, 7, META)).toBe('corner_ne');
  });
  it('returns corner_sw at (0,6)', () => {
    expect(chooseTile(0, 6, 11, 7, META)).toBe('corner_sw');
  });
  it('returns corner_se at (10,6)', () => {
    expect(chooseTile(10, 6, 11, 7, META)).toBe('corner_se');
  });
  it('returns wall_n along the top edge interior', () => {
    expect(chooseTile(5, 0, 11, 7, META)).toBe('wall_n');
  });
  it('returns wall_s along the bottom edge interior', () => {
    expect(chooseTile(5, 6, 11, 7, META)).toBe('wall_s');
  });
  it('returns wall_w along the left edge interior', () => {
    expect(chooseTile(0, 3, 11, 7, META)).toBe('wall_w');
  });
  it('returns wall_e along the right edge interior', () => {
    expect(chooseTile(10, 3, 11, 7, META)).toBe('wall_e');
  });
  it('returns floor for interior cells', () => {
    expect(chooseTile(5, 3, 11, 7, META)).toBe('floor');
  });
});

describe('chooseTile fallback', () => {
  it('falls back to wall_n at corners when corner tiles are absent', () => {
    const partial = loadTilesetMetadata({
      image: 'x.png', tileSize: 64,
      tiles: { floor: { x: 0, y: 0 }, wall_n: { x: 0, y: 64 } },
    });
    expect(chooseTile(0, 0, 5, 5, partial)).toBe('wall_n');
  });
  it('falls back to floor when no wall tiles are defined', () => {
    const floorOnly = loadTilesetMetadata({
      image: 'x.png', tileSize: 64, tiles: { floor: { x: 0, y: 0 } },
    });
    expect(chooseTile(0, 0, 5, 5, floorOnly)).toBe('floor');
  });
});

describe('loadTilesetMetadata', () => {
  it('rejects missing required keys', () => {
    expect(() => loadTilesetMetadata({} as never)).toThrow();
    expect(() => loadTilesetMetadata({ image: 'x' } as never)).toThrow();
    expect(() => loadTilesetMetadata({ image: 'x', tileSize: 64 } as never)).toThrow();
    expect(() => loadTilesetMetadata({ image: 'x', tileSize: 64, tiles: {} })).toThrow(/floor/);
  });
  it('accepts a minimal floor-only tileset', () => {
    const meta = loadTilesetMetadata({
      image: 'x.png', tileSize: 64, tiles: { floor: { x: 0, y: 0 } },
    });
    expect(meta.tileSize).toBe(64);
    expect(meta.tiles.floor).toEqual({ x: 0, y: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/tilemap.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `web/components/TileMap.ts`**

```typescript
export interface TilesetMetadata {
  image: string;
  tileSize: number;
  tiles: Record<string, { x: number; y: number }>;
}

export const loadTilesetMetadata = (raw: unknown): TilesetMetadata => {
  if (!raw || typeof raw !== 'object') throw new Error('tileset metadata must be an object');
  const r = raw as Partial<TilesetMetadata>;
  if (typeof r.image !== 'string') throw new Error('tileset metadata: image must be a string');
  if (typeof r.tileSize !== 'number') throw new Error('tileset metadata: tileSize must be a number');
  if (!r.tiles || typeof r.tiles !== 'object') throw new Error('tileset metadata: tiles must be an object');
  if (!('floor' in r.tiles)) throw new Error('tileset metadata: tiles.floor is required');
  return r as TilesetMetadata;
};

export type TileId =
  | 'floor' | 'wall_n' | 'wall_s' | 'wall_w' | 'wall_e'
  | 'corner_nw' | 'corner_ne' | 'corner_sw' | 'corner_se' | string;

/**
 * Pure: pick the tile id for cell (x,y) in a (gridW × gridH) rectangular room.
 * Falls back to `wall_<edge>` when corner tiles are absent, then to `floor`
 * when the tileset is interior-only.
 */
export const chooseTile = (
  x: number, y: number, gridW: number, gridH: number, meta: TilesetMetadata,
): TileId => {
  const has = (id: string): boolean => id in meta.tiles;
  const top = y === 0;
  const bot = y === gridH - 1;
  const left = x === 0;
  const right = x === gridW - 1;

  // Corners — prefer dedicated corner tile, else fall to the edge tile, else floor.
  if (top && left)   return has('corner_nw') ? 'corner_nw' : has('wall_n') ? 'wall_n' : 'floor';
  if (top && right)  return has('corner_ne') ? 'corner_ne' : has('wall_n') ? 'wall_n' : 'floor';
  if (bot && left)   return has('corner_sw') ? 'corner_sw' : has('wall_s') ? 'wall_s' : 'floor';
  if (bot && right)  return has('corner_se') ? 'corner_se' : has('wall_s') ? 'wall_s' : 'floor';

  // Edges
  if (top)   return has('wall_n') ? 'wall_n' : 'floor';
  if (bot)   return has('wall_s') ? 'wall_s' : 'floor';
  if (left)  return has('wall_w') ? 'wall_w' : 'floor';
  if (right) return has('wall_e') ? 'wall_e' : 'floor';

  return 'floor';
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web/tilemap.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/TileMap.ts tests/web/tilemap.test.ts
git commit -m "feat(web): pure tilemap assembly logic with edge/corner fallback"
```

---

### Task 9: Pure prop-resolution module + tests

**Files:**
- Create: `web/components/Props.ts`
- Test: `tests/web/props.test.ts`

The pure module exports `resolvePropPlacements(scene, manifest)` — given a scene's `obstacles[]`, `decorations[]`, and `exits[]` arrays plus the manifest's `props` table, returns an ordered list of `{ x, y, assetRel, layer }` ready for the Pixi renderer. The order is `decorations[]` (lowest), then `obstacles[]`, then `exits[]` so visual layering reads cleanly (e.g., a barrel obscures decorative dust).

Additionally, `exits[]` resolution: each exit translates to a prop using a convention. Since `exits[]` entries don't carry a `type`, we map by `to` field lookup OR derive from the spec — the basement uses `to: "rat-tunnel"` which corresponds to the `tunnel-hole` prop. We support this with an explicit mapping passed in by the caller (in Task 10 the caller will provide `{ "rat-tunnel": "tunnel-hole" }`); the pure module just consumes the mapping.

- [ ] **Step 1: Write the failing tests**

Create `tests/web/props.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolvePropPlacements } from '../../web/components/Props.js';

const SCENE = {
  obstacles: [
    { type: 'barrel-stack',        x: 1, y: 1 },
    { type: 'wooden-wall-section', x: 3, y: 0 },
  ],
  decorations: [
    { type: 'stairs-down', x: 4, y: 2 },
  ],
  exits: [
    { to: 'rat-tunnel', at: { x: 0, y: 6 }, trigger: 'step-on' as const },
  ],
};
const PROPS = {
  'barrel-stack':        'props/barrel-stack/south.png',
  'wooden-wall-section': 'props/wooden-wall-section/south.png',
  'stairs-down':         'props/stairs-down/south.png',
  'tunnel-hole':         'props/tunnel-hole/south.png',
};
const EXIT_MAP = { 'rat-tunnel': 'tunnel-hole' };

describe('resolvePropPlacements', () => {
  it('emits decorations first, then obstacles, then exits', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    expect(out.map((p) => p.layer)).toEqual([
      'decoration', 'decoration',  // none if 1 deco — see test below for exact count
      'obstacle', 'obstacle',
      'exit',
    ].filter(Boolean));
  });

  it('resolves a barrel-stack obstacle to its sprite path', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const barrel = out.find((p) => p.x === 1 && p.y === 1);
    expect(barrel).toEqual({
      x: 1, y: 1, assetRel: 'props/barrel-stack/south.png', layer: 'obstacle',
    });
  });

  it('resolves an exit using the exit-to-prop map', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const hole = out.find((p) => p.layer === 'exit');
    expect(hole).toEqual({
      x: 0, y: 6, assetRel: 'props/tunnel-hole/south.png', layer: 'exit',
    });
  });

  it('skips entries whose prop type is not in the manifest', () => {
    const out = resolvePropPlacements(
      { obstacles: [{ type: 'unknown-thing', x: 0, y: 0 }], decorations: [], exits: [] },
      PROPS, EXIT_MAP,
    );
    expect(out).toEqual([]);
  });

  it('skips exits whose target is not in the exit-to-prop map', () => {
    const out = resolvePropPlacements(
      { obstacles: [], decorations: [],
        exits: [{ to: 'unmapped-scene', at: { x: 0, y: 0 }, trigger: 'manual' as const }] },
      PROPS, {},
    );
    expect(out).toEqual([]);
  });

  it('order within a layer matches scene array order', () => {
    const out = resolvePropPlacements(SCENE, PROPS, EXIT_MAP);
    const obstacles = out.filter((p) => p.layer === 'obstacle');
    expect(obstacles[0]).toMatchObject({ x: 1, y: 1 });
    expect(obstacles[1]).toMatchObject({ x: 3, y: 0 });
  });
});
```

(The first test's `expected` array should be `['decoration', 'obstacle', 'obstacle', 'exit']` — fix that during Step 3 when you spot it; the assertion above with `.filter(Boolean)` is a placeholder reminder. Write the test as: `expect(out.map((p) => p.layer)).toEqual(['decoration', 'obstacle', 'obstacle', 'exit'])`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/props.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `web/components/Props.ts`**

```typescript
export type PropLayer = 'decoration' | 'obstacle' | 'exit';

export interface PropPlacement {
  x: number;
  y: number;
  assetRel: string;
  layer: PropLayer;
}

export interface SceneMapForProps {
  obstacles:   { type: string; x: number; y: number }[];
  decorations: { type: string; x: number; y: number }[];
  exits:       { to: string; at: { x: number; y: number }; trigger: 'manual' | 'step-on' }[];
}

/**
 * Pure: resolve every prop placement (decorations + obstacles + exits) into a
 * list of {x, y, assetRel, layer}. Layer order is decoration → obstacle → exit
 * so renderers that draw in array order produce the right z-stacking. Any
 * placement whose `type` (or, for exits, whose `to`-mapped prop) is absent
 * from the manifest is silently skipped — the caller can detect missing props
 * by comparing the count of input vs output entries if needed.
 */
export const resolvePropPlacements = (
  scene: SceneMapForProps,
  props: Record<string, string>,
  exitToProp: Record<string, string>,
): PropPlacement[] => {
  const out: PropPlacement[] = [];
  for (const d of scene.decorations) {
    const rel = props[d.type];
    if (rel) out.push({ x: d.x, y: d.y, assetRel: rel, layer: 'decoration' });
  }
  for (const o of scene.obstacles) {
    const rel = props[o.type];
    if (rel) out.push({ x: o.x, y: o.y, assetRel: rel, layer: 'obstacle' });
  }
  for (const e of scene.exits) {
    const propId = exitToProp[e.to];
    const rel = propId ? props[propId] : undefined;
    if (rel) out.push({ x: e.at.x, y: e.at.y, assetRel: rel, layer: 'exit' });
  }
  return out;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web/props.test.ts`
Expected: all tests PASS. Fix the placeholder assertion in Step 1's first test (replace the `.filter(Boolean)` line with the explicit `['decoration', 'obstacle', 'obstacle', 'exit']` array).

- [ ] **Step 5: Commit**

```bash
git add web/components/Props.ts tests/web/props.test.ts
git commit -m "feat(web): pure prop-placement resolver for scene obstacles/decorations/exits"
```

---

### Task 10: Wire tilemap and prop layers into `Board.ts`

**Files:**
- Modify: `web/components/Board.ts:49-176`

Replace the single-bg-sprite path with a tilemap (when the active scene has a `tilesets[scene.assetId]` entry) and add a prop-sprite layer above the tilemap, below the character tokens.

This task has render-time side-effects in Pixi that are not unit-testable in jsdom. We rely on the unit-tested pure modules (TileMap.chooseTile, Props.resolvePropPlacements) for correctness; the Pixi wiring is verified in Task 13's live smoke.

- [ ] **Step 1: Add the imports and a constant for the exit-to-prop mapping at the top of `Board.ts`**

```typescript
import { Application, Assets, Sprite, Container, Texture, Rectangle } from 'pixi.js';
import { chooseTile, loadTilesetMetadata, type TilesetMetadata } from './TileMap.js';
import { resolvePropPlacements } from './Props.js';
// ... existing imports
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { AssetManifest } from '../../src/runtime/ws/manifest.js';
import type { Store, StoreState } from '../store.js';
import { flashRoll } from './RollOverlay.js';

/** Convention: maps `exits[].to` → prop id used to render the exit cell. */
const EXIT_TO_PROP: Record<string, string> = {
  'rat-tunnel': 'tunnel-hole',
};
```

- [ ] **Step 2: Add a tilemap-render helper above `mountBoard`**

```typescript
const mountTilemap = async (
  parent: Container,
  tilesetImagePath: string,
  meta: TilesetMetadata,
  gridW: number,
  gridH: number,
): Promise<Container> => {
  const layer = new Container();
  const sheet = await Assets.load(tilesetImagePath);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const id = chooseTile(x, y, gridW, gridH, meta);
      const at = meta.tiles[id] ?? meta.tiles['floor']!;
      const tex = new Texture({
        source: sheet.source,
        frame: new Rectangle(at.x, at.y, meta.tileSize, meta.tileSize),
      });
      const tile = new Sprite(tex);
      tile.x = x * CELL_PX;
      tile.y = y * CELL_PX;
      tile.width = CELL_PX;
      tile.height = CELL_PX;
      layer.addChild(tile);
    }
  }
  parent.addChild(layer);
  return layer;
};

const mountProps = async (
  parent: Container,
  scene: NonNullable<StoreState['scene']>,
  manifest: AssetManifest,
  assetsBase: string,
): Promise<Container> => {
  const layer = new Container();
  const placements = resolvePropPlacements(scene, manifest.props, EXIT_TO_PROP);
  for (const p of placements) {
    const tex = await Assets.load(`${assetsBase}/${p.assetRel}`);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1.0);
    const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
    sprite.width = fit.w;
    sprite.height = fit.h;
    sprite.x = p.x * CELL_PX + CELL_PX / 2;
    sprite.y = p.y * CELL_PX + CELL_PX;
    layer.addChild(sprite);
  }
  parent.addChild(layer);
  return layer;
};
```

- [ ] **Step 3: Replace the bg-sprite block in `mountBoard.update`**

Locate the block in `Board.ts:82-97` (the section beginning with `// Background — scale to fill the canvas` and ending with the `bgSprite.height = canvasH;` assignment). Replace with:

```typescript
    // Background — assemble from tileset when one exists, else fall back to a
    // single scaled sprite (legacy maps that haven't been upgraded yet).
    const sceneAssetId = snap.scene.assetId;
    const ts = manifest.tilesets[sceneAssetId];
    if (ts) {
      // Tilemap-driven map: assemble per-cell sprites from the tileset image.
      if (lastSceneId !== snap.scene.id || !tileLayer) {
        if (tileLayer) board.removeChild(tileLayer);
        if (propLayer) board.removeChild(propLayer);
        const metaRaw = await fetch(`${assetsBase}/${ts.metadata}`).then((r) => r.json());
        const meta = loadTilesetMetadata(metaRaw);
        tileLayer = await mountTilemap(
          board, `${assetsBase}/${ts.image}`, meta,
          snap.scene.gridW, snap.scene.gridH,
        );
        propLayer = await mountProps(board, snap.scene, manifest, assetsBase);
        bgSprite = null; bgPath = null;
      }
    } else {
      // Legacy single-bg path (rat-tunnel, rat-den, etc., until those upgrade).
      const sceneRel = sceneAssetId ? manifest.maps[sceneAssetId] : undefined;
      const sceneFull = sceneRel ? `${assetsBase}/${sceneRel}` : null;
      if (sceneFull && sceneFull !== bgPath) {
        if (bgSprite) board.removeChild(bgSprite);
        const tex = await Assets.load(sceneFull);
        bgSprite = new Sprite(tex);
        bgSprite.x = 0; bgSprite.y = 0;
        bgPath = sceneFull;
        board.addChildAt(bgSprite, 0);
      }
      if (bgSprite) {
        bgSprite.width = canvasW;
        bgSprite.height = canvasH;
      }
    }
```

Add the new mutable refs at the top of `mountBoard` alongside `bgPath` and `bgSprite`:

```typescript
  let tileLayer: Container | null = null;
  let propLayer: Container | null = null;
```

- [ ] **Step 4: Build the web bundle and run typecheck**

```bash
npm run typecheck
npm run build:web
```

Expected: typecheck clean. The Pixi 8 `Texture` constructor with `{ source, frame }` requires Pixi 8 — verify with `node -e "console.log(require('./node_modules/pixi.js/package.json').version)"` and adjust the API if Pixi 7 is in use (Pixi 7 uses `new Texture(baseTexture, frame)`).

- [ ] **Step 5: Run web-side unit tests**

Run: `npx vitest run tests/web/`
Expected: green. The pure modules (TileMap, Props) are tested; Board.ts is not unit-tested at the Pixi level.

- [ ] **Step 6: Commit**

```bash
git add web/components/Board.ts
git commit -m "feat(web): board renders tilemap + props for scenes that declare a tileset"
```

---

## Phase D — Integration

### Task 11: Re-encode `adventures/basement-o-rats.json` with the 11×7 layout

**Files:**
- Modify: `adventures/basement-o-rats.json`

Pure data change. Replace the scene 1 `map`, `monsters` (and add nothing to `transitions` — `step-on` triggers are no-op for now per the spec).

- [ ] **Step 1: Update `adventures/basement-o-rats.json`**

Replace the file content with:

```json
{
  "id": "basement-o-rats",
  "title": "Basement O' Rats — Encounter 1: The Tavern Basement",
  "estimatedDurationMin": 15,
  "scenes": [
    {
      "id": "tavern-basement",
      "intro": "The hatch creaks as you pry it open. Rotten cabbage and damp fur fill your nose. From below: the skitter of claws. You lower yourselves down a short ladder into the dim basement — eleven paces wide, seven deep — and the rats turn to face you.",
      "map": {
        "width": 11,
        "height": 7,
        "background": "tavern-basement",
        "obstacles": [
          { "type": "barrel-stack",        "x": 0, "y": 0 },
          { "type": "barrel-stack",        "x": 1, "y": 0 },
          { "type": "barrel-stack",        "x": 2, "y": 0 },
          { "type": "barrel-stack",        "x": 5, "y": 0 },
          { "type": "barrel-stack",        "x": 6, "y": 0 },
          { "type": "barrel-stack",        "x": 6, "y": 2 },
          { "type": "barrel-stack",        "x": 7, "y": 2 },
          { "type": "barrel-stack",        "x": 6, "y": 3 },
          { "type": "barrel-stack",        "x": 7, "y": 3 },
          { "type": "barrel-stack",        "x": 5, "y": 6 },
          { "type": "barrel-stack",        "x": 6, "y": 6 },
          { "type": "wooden-wall-section", "x": 3, "y": 0 },
          { "type": "wooden-wall-section", "x": 3, "y": 1 },
          { "type": "wooden-wall-section", "x": 3, "y": 3 },
          { "type": "wooden-wall-section", "x": 3, "y": 5 },
          { "type": "wooden-wall-section", "x": 3, "y": 6 }
        ],
        "decorations": [
          { "type": "stairs-down", "x": 10, "y": 3 },
          { "type": "stairs-down", "x": 10, "y": 4 }
        ],
        "exits": [
          { "to": "rat-tunnel", "at": { "x": 0, "y": 6 }, "trigger": "step-on" }
        ]
      },
      "monsters": [
        { "type": "giant-rat", "startPos": { "x": 7, "y": 1 } },
        { "type": "giant-rat", "startPos": { "x": 1, "y": 3 } },
        { "type": "giant-rat", "startPos": { "x": 2, "y": 5 } },
        { "type": "giant-rat", "startPos": { "x": 7, "y": 5 } }
      ],
      "tactics": "The rats charge the closest hero on their first turn. They show coward behaviour after being attacked (move 2 extra squares). Pack-attack triggers when two rats flank a hero. Barrel stacks and the central plank wall block movement and ranged/magic attacks; route through the doorways at (3,2) and (3,4) to reach the west room.",
      "abilityTests": [],
      "conclusion": "The last rat squeals and falls still. The basement reeks but it is yours. From the south-west corner, broken floorboards yawn open over a rough dirt tunnel — the rats came from somewhere.",
      "transitions": [{ "to": "END", "trigger": "all-monsters-ko" }]
    }
  ]
}
```

- [ ] **Step 2: Verify the JSON parses**

Run:

```bash
node --experimental-strip-types -e "
import('./src/engine/adventure.ts').then(({ loadAdventure }) =>
  loadAdventure('./adventures/basement-o-rats.json'))
  .then((a) => console.log('parsed', a.scenes[0].map.width, 'x', a.scenes[0].map.height,
    'obstacles', a.scenes[0].map.obstacles.length));
"
```

Expected: `parsed 11 x 7 obstacles 16`.

- [ ] **Step 3: Commit**

```bash
git add adventures/basement-o-rats.json
git commit -m "feat(adventure): encode tavern-basement at 11x7 with canonical obstacles"
```

---

### Task 12: Update `bin/play.ts` to use `buildSceneGrid` and move hero spawns to the east wall

**Files:**
- Modify: `bin/play.ts:81-92`

The hard-coded all-floor Grid and the (0,0)/(1,0)/(0,1) spawn positions both change. After this task, `bin/play.ts` honors scene obstacles via the new helper and spawns the three heroes on the east edge adjacent to the stairs.

- [ ] **Step 1: Replace the Grid construction at line 89-92**

Add the import at the top of the file (alongside `Grid`):

```typescript
import { buildSceneGrid } from '../src/engine/scene-grid.js';
```

Replace lines 89–92:

```typescript
  const scene0 = adventure.scenes[0]!;

  const grid = buildSceneGrid(scene0);
```

- [ ] **Step 2: Update hero spawn positions at lines 81-83**

Replace:

```typescript
  const p1 = heroFromCatalog(scenario.agents.p1.characterId, scenario.agents.p1.archetype, { x: 0, y: 0 }, scenario.agents.p1.name);
  const p2 = heroFromCatalog(scenario.agents.p2.characterId, scenario.agents.p2.archetype, { x: 1, y: 0 }, scenario.agents.p2.name);
  const human = heroFromCatalog(scenario.human.characterId, scenario.human.archetype, { x: 0, y: 1 }, scenario.human.name);
```

with:

```typescript
  // Spawn party on the east wall, adjacent to the stairs (10,3)/(10,4) baked
  // into the basement scene's decorations. (10,5) is reserved for a future
  // fourth hero. See docs/superpowers/specs/2026-05-10-tavern-basement-map-design.md.
  const p1    = heroFromCatalog(scenario.agents.p1.characterId, scenario.agents.p1.archetype, { x: 10, y: 2 }, scenario.agents.p1.name);
  const p2    = heroFromCatalog(scenario.agents.p2.characterId, scenario.agents.p2.archetype, { x: 10, y: 3 }, scenario.agents.p2.name);
  const human = heroFromCatalog(scenario.human.characterId,    scenario.human.archetype,    { x: 10, y: 4 }, scenario.human.name);
```

- [ ] **Step 3: Run typecheck and the integration test that exercises bin/play.ts wiring**

Run:

```bash
npm run typecheck
npx vitest run tests/integration/
```

Expected: green. If `tests/integration/ws-stub-adventure.test.ts` (or similar) hard-codes spawn positions in its assertions, update those assertions to the new coordinates — the test was checking spawn locations, not the engine, so the spawn move is the new ground truth.

- [ ] **Step 4: Commit**

```bash
git add bin/play.ts
# plus any integration test fixture that needed coordinate updates
git commit -m "feat(play): basement spawns on east wall; grid honors scene obstacles"
```

---

### Task 13: Run full test suite + live smoke + spec validation gate

**Files:** None changed. This task is verification.

- [ ] **Step 1: Full test suite + typecheck + lint**

```bash
npm test
npm run typecheck
npm run lint
```

Expected: green across the board. Investigate any failure before continuing — none of the prior tasks should leave a broken state.

- [ ] **Step 2: Build the web bundle**

```bash
npm run build:web
```

Expected: clean Vite build into `dist/web/`.

- [ ] **Step 3: Manifest check (one more time, paranoid)**

```bash
node --experimental-strip-types -e "
import('./src/runtime/ws/manifest.ts').then(({ loadManifest, validateManifest }) => {
  const m = loadManifest('./assets/manifest.json');
  validateManifest(m, './assets');
  console.log('manifest OK');
});
"
```

Expected: `manifest OK`.

- [ ] **Step 4: Live smoke against Sonnet**

```bash
ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/basement-o-rats.json \
  --human-script tests/fixtures/layer-c/human-bran-script.jsonl
```

Open the browser, observe:
- Tavern basement renders at 11 × 7 cells (704 × 448 px canvas).
- Floor reads as warm-tavern wood plank; walls visible at room edges.
- Barrel stacks, dividing wall, stairs-down, and tunnel-hole are all visible at their declared coordinates.
- Heroes spawn at (10,2)/(10,3)/(10,4); rats at (7,1)/(1,3)/(2,5)/(7,5).
- Combat resolves; rats can't path through obstacles; ranged attacks across a barrel stack get blocked (the engine returns an error event in the chat log).
- All four rats KO → scene transition fires (`all-monsters-ko` → END).

- [ ] **Step 5: Validate against the spec's validation gate**

Check each of the 5 gate items in `docs/superpowers/specs/2026-05-10-tavern-basement-map-design.md` §"Validation gate":

1. Aesthetic consistency (palette / outline / shading / detail match heroes/monsters) — ✓ side-by-side at 64 px.
2. Tileset seamlessness — ✓ no visible seams.
3. Prop legibility at 64 px — ✓ four prop types visually distinct.
4. Engine correctness (rats can't path through obstacles; ranged blocked; (0,6) trigger) — the third sub-check is no-op until encounter 2 lands; mark "deferred".
5. No regression (vitest green; live playthrough end-to-end) — ✓.

If any check fails: regenerate the failing asset per the spec's escalation rule, or fix the failing engine/renderer code with a targeted commit.

- [ ] **Step 6: Final commit (no code change; trail marker)**

```bash
git commit --allow-empty -m "chore(layer-c): tavern-basement map upgrade complete

Encoded 11x7 canonical layout with 16 obstacles + 2 stair decorations + 1
exit; pixel-art tileset and four prop sprites generated and validated.
Live smoke against Sonnet passes the validation gate (4/5 ✓; #4 sub-check
on step-on triggers deferred until encounter 2 lands)."
```

---

## Self-review

**Spec coverage check.** Walking the spec section by section:

- **Locked decisions §1–4** (scope, grid, approach, aesthetic) — all encoded into Tasks 1–10.
- **Asset inventory** — 1 tileset (Task 5), 4 props (Task 6), manifest install (Task 7).
- **Locked PixelLab parameters** — Task 5 step 2 and Task 6 step 1 quote them inline.
- **Obstacle layout coordinates** — Task 11 encodes them in the JSON; Task 8 has tests checking corner/edge tile selection at the exact 11×7 footprint.
- **JSON encoding** — Task 11 is the verbatim deliverable; Task 1 introduces the schema that supports the new shape; Task 11's `at: {x,y}` form normalizes the spec's flat `x, y` form to match the existing `SceneExitSchema` convention (called out in the spec doc as a refinement).
- **File layout** — Task 5 archives the legacy bg, Task 6 creates `assets/props/<id>/south.png`, both mirror to the spec's exemplar dir.
- **Manifest changes** — Task 4 (type + validator), Task 7 (data).
- **Downstream code work §1–5** — Engine obstacle handling (Tasks 1–3); engine exit-trigger no-op (covered in spec, Task 1 supports the schema, no engine behavior task needed since it's a no-op); renderer (Tasks 8–10); manifest validator (Task 4); bin/play.ts spawn (Task 12).
- **Validation gate** — Task 13 walks all 5 items.
- **Tunnel-hole rendering** — Task 9 introduces the `EXIT_TO_PROP` mapping; Task 10 wires it; the spec's omission of `tunnel-hole` from `decorations[]` is preserved (the prop sprite is rendered via the exit, not as a decoration).

**Placeholder scan.** No "TBD"/"TODO"/"add appropriate error handling" patterns. Two soft-uncertainty spots:
- Task 5 step 3 says "Adjust the keys and pixel coordinates to match the actual tile layout PixelLab returns." This is unavoidable — the tool's output isn't fully predictable. The plan handles this with explicit fallback in Task 8's `chooseTile` (works even if `corner_*` keys are absent).
- Task 3 step 5 says "Wire whatever existing variable name `activeScene` happens to be in the file." This is honest — I don't have line-precise visibility into `getRedactedSnapshot`'s internals, so the implementer matches the local naming. Task 3 step 1 explicitly directs the implementer to grep for the variable first.

**Type consistency.**
- `PropPlacementSchema` (Task 1) ↔ `scene.map.obstacles` consumption in `buildSceneGrid` (Task 2) ↔ `RedactedSnapshot.scene.obstacles` (Task 3) ↔ `SceneMapForProps` (Task 9) — same shape `{ type, x, y }` everywhere. ✓
- `SceneExitSchema` (Task 1) ↔ `RedactedSnapshot.scene.exits` (Task 3) ↔ `resolvePropPlacements` exits arg (Task 9) — `{ to, at: {x,y}, trigger }`. ✓
- `TilesetMetadata` (Task 8) ↔ tileset JSON file (Task 5) — both use `{ image, tileSize, tiles: { [id]: {x,y} } }`. ✓
- `AssetManifest.props` is `Record<string, string>` everywhere. ✓
- `EXIT_TO_PROP` map only used inside the renderer (Task 10) and consumed by the resolver (Task 9 + Task 10). Single source of truth. ✓

No type drift detected.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-tavern-basement-map.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
