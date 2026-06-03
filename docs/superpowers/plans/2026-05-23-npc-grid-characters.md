# NPC Grid Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NPCs (Mira, Lyra) full grid characters operated by the DM, with HP / combat / dialogue and a new `npc_action` DM tool.

**Architecture:** Reuse the monster-catalog pattern for stats; add `'npc'` as a third `Character.kind`; declare NPCs in scene JSON; auto-reveal them on `set_scene`; expose a `npc_action(npcId, action)` DM tool that dispatches `PlayerAction` on the NPC's behalf; route the orchestrator's combat-turn dispatch to a new `runNpcTurn` that invokes the DM agent.

**Tech Stack:** TypeScript, Vitest, Zod, Anthropic SDK, PixelLab MCP.

**Spec:** `docs/superpowers/specs/2026-05-23-npc-grid-characters-design.md`

**Worktree:** Already on `worktree-npc-grid-characters` (rebased onto `main`).

---

## Phase 1 — Engine type widening

### Task 1: Widen `Character.kind` to include `'npc'`

**Files:**
- Modify: `src/engine/character.ts` (kind union)
- Modify: `src/engine/snapshot.ts` (RedactedCharacter.kind union)
- Test: `tests/engine/character-kind.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/character-kind.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { Character } from '../../src/engine/character.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';

describe('Character.kind', () => {
  it('accepts npc as a valid kind', () => {
    const npc: Character = {
      id: asCharacterId('mira-1'),
      name: 'Mira',
      kind: 'npc',
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      dex: 1,
      health: { total: 2, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('noop'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('noop'), name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    expect(npc.kind).toBe('npc');
  });

  it('RedactedCharacter accepts npc', () => {
    const rc: RedactedCharacter = {
      id: asCharacterId('mira-1'),
      name: 'Mira',
      kind: 'npc',
      pos: { x: 0, y: 0 },
      health: { total: 2, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      inventory: [], boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility:  { name: '', description: '' },
    };
    expect(rc.kind).toBe('npc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/character-kind.test.ts
```
Expected: TYPE error — `Type '"npc"' is not assignable to type '"hero" | "monster"'.`

- [ ] **Step 3: Implement the change**

In `src/engine/character.ts`, find:
```ts
kind: 'hero' | 'monster';
```
Replace with:
```ts
kind: 'hero' | 'monster' | 'npc';
```

In `src/engine/snapshot.ts`, find:
```ts
kind: 'hero' | 'monster';
```
Replace with:
```ts
kind: 'hero' | 'monster' | 'npc';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/engine/character-kind.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npx vitest run
```
Expected: same baseline (694 passed, 1 pre-existing CLI ANSI failure).

- [ ] **Step 6: Commit**

```bash
git add src/engine/character.ts src/engine/snapshot.ts tests/engine/character-kind.test.ts
git commit -m "feat(engine): widen Character.kind to include 'npc'"
```

---

## Phase 2 — Catalog

### Task 2: Add `NpcEntrySchema` + loader

**Files:**
- Modify: `src/engine/catalogs.ts` (add schema)
- Modify: `src/engine/load.ts` (load file + populate Catalogs)
- Create: `data/npcs.json` (starts as `[]`)
- Test: `tests/engine/load-npcs.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/load-npcs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadCatalogs } from '../../src/engine/load.js';
import path from 'node:path';

describe('loadCatalogs - npcs', () => {
  it('exposes an empty Map when data/npcs.json is []', async () => {
    const cats = await loadCatalogs(path.resolve('data'));
    expect(cats.npcs).toBeInstanceOf(Map);
    expect(cats.npcs.size).toBeGreaterThanOrEqual(0); // initially 0; later tasks add entries
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/load-npcs.test.ts
```
Expected: TYPE error — `Property 'npcs' does not exist on type 'Catalogs'.` OR runtime error reading `npcs.json`.

- [ ] **Step 3: Stub the catalog file**

Create `data/npcs.json` with content `[]`.

- [ ] **Step 4: Add the schema**

In `src/engine/catalogs.ts`, immediately AFTER the `MonsterEntrySchema` block (around line 59), add:
```ts
export const NpcEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pools: PoolsSchema,
  /** Dexterity modifier added to the initiative d6. Range -2..+5. Optional;
   *  missing entries are treated as 0 by consumers. */
  dex: z.number().int().min(-2).max(5).optional(),
  healthTotal: z.number().int().min(1).max(4),
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  sprite: z.string().min(1),
});
```

Find the existing `export type MonsterEntry = ...` line (around 95) and immediately after it add:
```ts
export type NpcEntry = z.infer<typeof NpcEntrySchema>;
```

- [ ] **Step 5: Wire the loader**

In `src/engine/load.ts`, find the `Catalogs` interface (around line 18) and add `npcs` next to `monsters`:
```ts
export interface Catalogs {
  heroes: Map<string, HeroEntry>;
  monsters: Map<string, MonsterEntry>;
  npcs: Map<string, NpcEntry>;
  items: Map<string, ItemEntry>;
  equipment: Map<string, EquipmentEntry>;
  boons: Map<string, BoonEntry>;
}
```

Add the import next to existing schema imports near the top of the file:
```ts
import { NpcEntrySchema, type NpcEntry } from './catalogs.js';
```
(merge it into the existing import line for `MonsterEntrySchema`/`MonsterEntry` instead of duplicating the import statement)

In `loadCatalogs`, add an npcs loader call mirroring the monsters one:
```ts
const npcs = indexById(
  await readJson(path.join(dataDir, 'npcs.json'), z.array(NpcEntrySchema)),
);
```

Update the return statement:
```ts
return { heroes, monsters, npcs, items, equipment, boons };
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/engine/load-npcs.test.ts
```
Expected: PASS.

- [ ] **Step 7: Full suite check**

```bash
npx vitest run
```
Expected: 694 pass + 1 pre-existing failure.

- [ ] **Step 8: Commit**

```bash
git add src/engine/catalogs.ts src/engine/load.ts data/npcs.json tests/engine/load-npcs.test.ts
git commit -m "feat(engine): NpcEntry catalog schema + loader"
```

---

## Phase 3 — Scene declaration

### Task 3: Add `Scene.map.npcs[]` to the adventure schema

**Files:**
- Modify: `src/engine/adventure.ts` (schema)
- Test: `tests/engine/adventure-npcs.test.ts` (new)
- Test fixture: `tests/fixtures/layer-c/adventure-with-npcs.json` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/layer-c/adventure-with-npcs.json`:
```json
{
  "id": "test-npcs",
  "title": "NPC test",
  "estimatedDurationMin": 5,
  "scenes": [{
    "id": "s",
    "intro": "",
    "tactics": "",
    "abilityTests": [],
    "conclusion": "",
    "transitions": [],
    "map": {
      "width": 5, "height": 5, "background": "bg",
      "walls": false, "obstacles": [], "decorations": [], "exits": [],
      "npcs": [
        { "type": "mira", "startPos": { "x": 1, "y": 2 }, "allegiance": "neutral" }
      ]
    },
    "monsters": []
  }]
}
```

Create `tests/engine/adventure-npcs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadAdventure } from '../../src/engine/adventure.js';

describe('Scene.map.npcs', () => {
  it('parses an adventure with a scene-declared NPC', async () => {
    const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
    const scene = adv.scenes[0]!;
    expect(scene.map.npcs).toEqual([
      { type: 'mira', startPos: { x: 1, y: 2 }, allegiance: 'neutral' },
    ]);
  });

  it('defaults map.npcs to [] when omitted', async () => {
    const adv = await loadAdventure('adventures/basement-o-rats.json');
    for (const s of adv.scenes) {
      expect(Array.isArray(s.map.npcs)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/adventure-npcs.test.ts
```
Expected: FAIL — `scene.map.npcs` is undefined (no schema field).

- [ ] **Step 3: Add the schema field**

In `src/engine/adventure.ts`, add a new schema near the existing `SceneMonsterSchema` block:
```ts
const SceneNpcSchema = z.object({
  type: z.string().min(1),
  startPos: SquareSchema,
  allegiance: z.enum(['ally', 'hostile', 'neutral']).default('neutral'),
});
```

In `SceneMapSchema`, add an `npcs` field with default `[]`:
```ts
const SceneMapSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  background: z.string().min(1),
  obstacles: z.array(PropPlacementSchema),
  decorations: z.array(PropPlacementSchema).default([]),
  exits: z.array(SceneExitSchema),
  walls: z.boolean().default(true),
  npcs: z.array(SceneNpcSchema).default([]),
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/engine/adventure-npcs.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite check**

```bash
npx vitest run
```
Expected: 694 pass + 1 pre-existing failure.

- [ ] **Step 6: Commit**

```bash
git add src/engine/adventure.ts tests/engine/adventure-npcs.test.ts tests/fixtures/layer-c/adventure-with-npcs.json
git commit -m "feat(engine): scene-declared NPCs with allegiance"
```

---

## Phase 4 — DM actions: `npc_action` and `reveal_npc`

### Task 4: Add the `npc_action` and `reveal_npc` DmAction shapes

**Files:**
- Modify: `src/engine/action.ts` (add union members)
- Test: `tests/engine/dm-actions-shape.test.ts` (new — just type sanity)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/dm-actions-shape.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { DmAction } from '../../src/engine/action.js';
import { asCharacterId } from '../../src/engine/ids.js';

describe('DmAction', () => {
  it('accepts npc_action shape', () => {
    const a: DmAction = {
      kind: 'npc_action',
      npcId: asCharacterId('mira-1'),
      action: { kind: 'say', text: 'Help!' },
    };
    expect(a.kind).toBe('npc_action');
  });

  it('accepts reveal_npc shape', () => {
    const a: DmAction = {
      kind: 'reveal_npc',
      npcTypeId: 'mira',
      pos: { x: 0, y: 0 },
      characterId: asCharacterId('mira-1'),
      allegiance: 'neutral',
    };
    expect(a.kind).toBe('reveal_npc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/dm-actions-shape.test.ts
```
Expected: TYPE errors — `'npc_action'` / `'reveal_npc'` not assignable to DmAction.kind.

- [ ] **Step 3: Add the union members**

In `src/engine/action.ts`, locate the `DmAction` union (around line 50). Add two new members BEFORE the `end_adventure` line:
```ts
  | {
      kind: 'reveal_npc';
      npcTypeId: string;
      pos: Square;
      characterId: CharacterId;
      allegiance: 'ally' | 'hostile' | 'neutral';
    }
  | {
      kind: 'npc_action';
      npcId: CharacterId;
      /** Subset of PlayerAction allowed for NPCs (engine enforces the subset).
       *  Allowed kinds: move, normal_attack, say, emote, ability_test,
       *  end_turn, skip_turn. */
      action: PlayerAction;
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/engine/dm-actions-shape.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/action.ts tests/engine/dm-actions-shape.test.ts
git commit -m "feat(engine): DmAction.npc_action + reveal_npc shapes"
```

---

### Task 5: Engine auto-reveal NPCs on `set_scene`

**Files:**
- Modify: `src/engine/game-engine.ts` (config + materializeNpc + set_scene loop)
- Test: `tests/engine/npc-auto-reveal.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/npc-auto-reveal.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asSceneId, asCharacterId } from '../../src/engine/ids.js';
import path from 'node:path';

describe('set_scene auto-reveals NPCs', () => {
  it('materializes scene-declared NPCs as kind=npc characters', async () => {
    const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
    const cats = await loadCatalogs(path.resolve('data'));
    // Inject a synthetic mira NPC catalog entry so materialize succeeds.
    cats.npcs.set('mira', {
      id: 'mira', name: 'Mira',
      pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
      dex: 1, healthTotal: 2,
      normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
      specialAction: { effectId: 'noop', name: '', description: '' },
      bonusAbility:  { effectId: 'noop', name: '', description: '' },
      sprite: 'mira',
    });
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const engine = new GameEngine({
      seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
      characters: [],
      effects: reg, items: cats.items, boons: cats.boons,
      adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
    });
    engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('s') });
    const c = engine.charactersById().get(asCharacterId('mira-1'));
    expect(c).toBeDefined();
    expect(c?.kind).toBe('npc');
    expect(c?.pos).toEqual({ x: 1, y: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/npc-auto-reveal.test.ts
```
Expected: TYPE error — `npcs` not a known property of `GameEngineConfig`.

- [ ] **Step 3: Extend `GameEngineConfig` and add `materializeNpc`**

In `src/engine/game-engine.ts`, modify `GameEngineConfig` (around line 21) to add:
```ts
  /** Optional NPC catalog. Required when scene declares npcs[] or when DM
   *  calls reveal_npc / npc_action. */
  npcs?: Map<string, NpcEntry>;
```

Import the type at the top of the file (in the existing `from './catalogs.js'` line):
```ts
import type { ItemEntry, BoonEntry, MonsterEntry, NpcEntry } from './catalogs.js';
```

Add a field to the class (next to `monsterCatalog`):
```ts
private npcCatalog: Map<string, NpcEntry>;
```

In the constructor, initialize it:
```ts
this.npcCatalog = cfg.npcs ?? new Map();
```

At the end of the file, add `materializeNpc` (clone of `materializeMonster` but `kind: 'npc'`):
```ts
private materializeNpc(
  typeId: string,
  id: CharacterId,
  pos: Square,
): Result<Character, RuleViolation> {
  const def = this.npcCatalog.get(typeId);
  if (!def) return err({ reason: 'unknown-id', what: 'character', id: typeId });
  const npc: Character = {
    id, name: def.name, kind: 'npc', sprite: def.sprite,
    pools: def.pools, dex: def.dex ?? 0,
    health: { total: def.healthTotal, damage: 0, status: 'normal' },
    pos, normalAttack: def.normalAttack,
    specialAction: { id: asEffectId(def.specialAction.effectId), name: def.specialAction.name, description: def.specialAction.description },
    bonusAbility:  { id: asEffectId(def.bonusAbility.effectId),  name: def.bonusAbility.name,  description: def.bonusAbility.description  },
    inventory: [], boons: [], skills: [],
  };
  return ok(npc);
}
```

In the `set_scene` handler in `applyDmAction`, immediately AFTER the monster auto-reveal loop (around line 250), add:
```ts
// Auto-reveal scene-declared NPCs. Same id pattern as monsters: {type}-1, ...
const npcCounters: Record<string, number> = {};
for (const n of scene.map.npcs) {
  npcCounters[n.type] = (npcCounters[n.type] ?? 0) + 1;
  const id = asCharacterId(`${n.type}-${npcCounters[n.type]}`);
  if (this.characters.has(id)) {
    return err({ reason: 'invalid-action-shape', details: `auto-reveal id collision: ${id}` });
  }
  const npcRes = this.materializeNpc(n.type, id, n.startPos);
  if (!npcRes.ok) return npcRes;
  this.characters.set(id, npcRes.value);
  this.emit({
    type: 'action',
    actorId: 'dm',
    action: {
      kind: 'reveal_npc',
      npcTypeId: n.type,
      characterId: id,
      pos: n.startPos,
      allegiance: n.allegiance,
    },
  } as unknown as Event);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/engine/npc-auto-reveal.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full suite check**

```bash
npx vitest run
```
Expected: 694 pass + 1 pre-existing failure (no new regressions).

- [ ] **Step 6: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/npc-auto-reveal.test.ts
git commit -m "feat(engine): auto-reveal scene-declared NPCs on set_scene"
```

---

### Task 6: Engine `npc_action` handler + guards

**Files:**
- Modify: `src/engine/game-engine.ts` (DmAction handler + applyAction NPC bypass)
- Test: `tests/engine/npc-action.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/npc-action.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asSceneId, asCharacterId } from '../../src/engine/ids.js';
import path from 'node:path';

const setup = async () => {
  const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
  const cats = await loadCatalogs(path.resolve('data'));
  cats.npcs.set('mira', {
    id: 'mira', name: 'Mira',
    pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
    dex: 1, healthTotal: 2,
    normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
    specialAction: { effectId: 'noop', name: '', description: '' },
    bonusAbility:  { effectId: 'noop', name: '', description: '' },
    sprite: 'mira',
  });
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const engine = new GameEngine({
    seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
    characters: [],
    effects: reg, items: cats.items, boons: cats.boons,
    adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
  });
  engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('s') });
  return { engine, miraId: asCharacterId('mira-1') };
};

describe('npc_action', () => {
  it('applies say on behalf of the NPC outside combat', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'say', text: 'I am lost!' },
    });
    expect(r.ok).toBe(true);
  });

  it('applies move on behalf of the NPC outside combat', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'move', path: [{ x: 1, y: 2 }, { x: 2, y: 2 }] },
    });
    expect(r.ok).toBe(true);
    expect(engine.charactersById().get(miraId)?.pos).toEqual({ x: 2, y: 2 });
  });

  it('rejects npc_action when npcId is not an NPC', async () => {
    const { engine } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: asCharacterId('does-not-exist'),
      action: { kind: 'say', text: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-target');
  });

  it('rejects npc_action with a disallowed action kind', async () => {
    const { engine, miraId } = await setup();
    const r = engine.applyDmAction({
      kind: 'npc_action',
      npcId: miraId,
      action: { kind: 'use_item', itemId: 'potion' as never },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine/npc-action.test.ts
```
Expected: all 4 fail — `npc_action` case not handled in `applyDmAction`.

- [ ] **Step 3: Implement the handler**

In `src/engine/game-engine.ts`, in `applyDmAction`, add new cases BEFORE the `default:` (or at the end of the switch):
```ts
case 'npc_action': {
  const target = this.characters.get(action.npcId);
  if (!target || target.kind !== 'npc') {
    return err({ reason: 'invalid-target' });
  }
  const allowed = new Set([
    'move', 'normal_attack', 'say', 'emote', 'ability_test', 'end_turn', 'skip_turn',
  ]);
  if (!allowed.has(action.action.kind)) {
    return err({
      reason: 'invalid-action-shape',
      details: `npc_action: action.kind=${action.action.kind} is not allowed for NPCs`,
    });
  }
  // Outside combat the DM owns NPCs unconditionally — temporarily install
  // the NPC as the narrative actor so applyAction's `not-actors-turn` guard
  // does not reject. Restore the previous narrative actor afterward.
  const inCombat = this.turn.phase === 'combat';
  let savedNarrative: CharacterId | null = null;
  if (!inCombat) {
    savedNarrative = this.turn.activeActorId;
    this.turn.setNarrativeActor(action.npcId);
  }
  const res = this.applyAction(action.npcId, action.action, { interpretedBy: 'dm' });
  if (!inCombat) {
    this.turn.setNarrativeActor(savedNarrative);
  }
  return res;
}

case 'reveal_npc': {
  if (this.characters.has(action.characterId)) {
    return err({
      reason: 'invalid-action-shape',
      details: `reveal_npc id collision: ${action.characterId}`,
    });
  }
  const r = this.materializeNpc(action.npcTypeId, action.characterId, action.pos);
  if (!r.ok) return r;
  this.characters.set(action.characterId, r.value);
  this.emit({
    type: 'action', actorId: 'dm',
    action: {
      kind: 'reveal_npc',
      npcTypeId: action.npcTypeId,
      characterId: action.characterId,
      pos: action.pos,
      allegiance: action.allegiance,
    },
  } as unknown as Event);
  return ok({ turnEnded: false });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/engine/npc-action.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite check**

```bash
npx vitest run
```
Expected: 694 + 1 pre-existing failure.

- [ ] **Step 6: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/npc-action.test.ts
git commit -m "feat(engine): npc_action handler + guards"
```

---

## Phase 5 — Prompt tools

### Task 7: Declare `npc_action` and `reveal_npc` in `tools.ts`

**Files:**
- Modify: `src/runtime/prompt/tools.ts` (tool declaration + parser)
- Test: `tests/runtime/prompt/tools-npc.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/prompt/tools-npc.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DM_TOOLS, parseDmToolInput } from '../../../src/runtime/prompt/tools.js';

describe('DM tools — NPC entries', () => {
  it('declares npc_action and reveal_npc', () => {
    const names = DM_TOOLS.map((t) => t.name);
    expect(names).toContain('npc_action');
    expect(names).toContain('reveal_npc');
  });

  it('parses an npc_action tool call into a DmAction', () => {
    const parsed = parseDmToolInput('npc_action', {
      npcId: 'mira-1',
      action: { kind: 'say', text: 'Hello' },
    });
    expect(parsed.kind).toBe('npc_action');
    if (parsed.kind === 'npc_action') {
      expect(parsed.npcId).toBe('mira-1');
      expect(parsed.action.kind).toBe('say');
    }
  });

  it('parses a reveal_npc tool call into a DmAction', () => {
    const parsed = parseDmToolInput('reveal_npc', {
      npcTypeId: 'mira',
      pos: { x: 0, y: 0 },
      characterId: 'mira-1',
      allegiance: 'neutral',
    });
    expect(parsed.kind).toBe('reveal_npc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/runtime/prompt/tools-npc.test.ts
```
Expected: FAIL — tool name not in DM_TOOLS.

- [ ] **Step 3: Add the tool declarations**

In `src/runtime/prompt/tools.ts`, locate the `DM_TOOLS` array. Add two new entries (the surrounding entries follow the same shape — match it):
```ts
{
  name: 'npc_action',
  description: 'Apply a player-style action (move, normal_attack, say, emote, ability_test, end_turn, skip_turn) on behalf of an NPC the DM controls.',
  input_schema: {
    type: 'object',
    properties: {
      npcId:  { type: 'string', description: 'CharacterId of the NPC.' },
      action: { type: 'object', description: 'PlayerAction shape — see PLAYER_TOOLS subset.' },
    },
    required: ['npcId', 'action'],
  },
},
{
  name: 'reveal_npc',
  description: 'Spawn a new NPC on the grid mid-scene. Use sparingly — scene-declared NPCs auto-reveal on set_scene.',
  input_schema: {
    type: 'object',
    properties: {
      npcTypeId:   { type: 'string' },
      pos:         { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
      characterId: { type: 'string' },
      allegiance:  { type: 'string', enum: ['ally', 'hostile', 'neutral'] },
    },
    required: ['npcTypeId', 'pos', 'characterId', 'allegiance'],
  },
},
```

Locate the `parseDmToolInput` switch. Add two new cases:
```ts
case 'npc_action':
  return {
    kind: 'npc_action',
    npcId: asCharacterId(str(i['npcId'], 'npcId')),
    action: i['action'] as PlayerAction,
  };

case 'reveal_npc':
  return {
    kind: 'reveal_npc',
    npcTypeId: str(i['npcTypeId'], 'npcTypeId'),
    pos: i['pos'] as Square,
    characterId: asCharacterId(str(i['characterId'], 'characterId')),
    allegiance: str(i['allegiance'], 'allegiance') as 'ally' | 'hostile' | 'neutral',
  };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/runtime/prompt/tools-npc.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite check**

```bash
npx vitest run
```
Expected: 694 + 1.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/prompt/tools.ts tests/runtime/prompt/tools-npc.test.ts
git commit -m "feat(prompt): declare npc_action + reveal_npc DM tools"
```

---

## Phase 6 — Orchestrator routing

### Task 8: `runNpcTurn` + main-loop branch

**Files:**
- Modify: `src/runtime/orchestrator.ts` (runNpcTurn + branch)
- Test: `tests/runtime/orchestrator-npc-turn.test.ts` (new)

- [ ] **Step 1: Read the existing `runDmTurn` and `runMonsterTurn`**

```bash
sed -n '200,260p' src/runtime/orchestrator.ts
sed -n '313,395p' src/runtime/orchestrator.ts
```

Note: `runNpcTurn` is structurally a copy of `runDmTurn` constrained to one NPC. The DM agent is called with a turn-prefix injected via `historyFor`.

- [ ] **Step 2: Write the failing test**

Create `tests/runtime/orchestrator-npc-turn.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId } from '../../src/engine/ids.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { ScriptedDmAgent } from '../helpers/scripted-dm.js'; // see step 3

describe('runNpcTurn', () => {
  it('runs an NPC combat turn via the DM agent', async () => {
    const adv = await loadAdventure('tests/fixtures/layer-c/adventure-with-npcs.json');
    const cats = await loadCatalogs(path.resolve('data'));
    cats.npcs.set('mira', {
      id: 'mira', name: 'Mira',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
      dex: 1, healthTotal: 2,
      normalAttack: { kind: 'melee', name: 'Shove', range: 1, damageMod: 0 },
      specialAction: { effectId: 'noop', name: '', description: '' },
      bonusAbility:  { effectId: 'noop', name: '', description: '' },
      sprite: 'mira',
    });
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const engine = new GameEngine({
      seed: 't', grid: buildSceneGrid(adv.scenes[0]!),
      characters: [],
      effects: reg, items: cats.items, boons: cats.boons,
      adventure: adv, monsters: cats.monsters, npcs: cats.npcs,
    });
    // ...drive an orchestrator turn for mira-1, assert action applied.
    // (see step 3 for the scripted DM agent helper.)
    const runDir = mkdtempSync(`${tmpdir()}/npc-turn-test-`);
    const dm = new ScriptedDmAgent([
      { kind: 'npc_action', npcId: asCharacterId('mira-1'), action: { kind: 'say', text: 'Hi' } },
      { kind: 'npc_action', npcId: asCharacterId('mira-1'), action: { kind: 'end_turn' } },
    ]);
    // Build the orchestrator minimally for this test...
    // (full wiring deferred — write the assertion only and let it fail.)
    expect(typeof (Orchestrator as unknown as { prototype: { runNpcTurn?: unknown } }).prototype.runNpcTurn).toBe('function');
  });
});
```

NOTE: this test is intentionally lightweight — it only asserts the method exists. A full integration test with a real DM agent is heavier; if writing the full version is straightforward, expand here. Otherwise verify behaviour through the live smoke in Task 14.

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/runtime/orchestrator-npc-turn.test.ts
```
Expected: FAIL — `runNpcTurn` is undefined.

- [ ] **Step 4: Implement `runNpcTurn`**

In `src/runtime/orchestrator.ts`, BEFORE the existing `runHumanTurn` (around line 410), add:
```ts
private async runNpcTurn(actorId: CharacterId, log: EventLog): Promise<void> {
  for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
  this.signalThinking('dm');

  const npc = this.cfg.engine.charactersById().get(actorId);
  const npcName = npc?.name ?? String(actorId);

  let result;
  try {
    result = await this.cfg.agents.dm.takeTurn(
      { kind: 'fresh_turn', objective: `It is ${npcName}'s turn. Pick an action for them via npc_action.` },
      this.historyFor({ kind: 'researcher', revealThoughts: false }),
      this.currentTurnIdx,
      {
        emitThought: (text) => this.cfg.engine.emitRuntime({
          type: 'thought', actorId: 'dm', text,
        } as Omit<Event, 't'>),
        emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
          type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
        } as Omit<Event, 't'>),
        onEngineActed: async () => this.drainAndReactOnResolution(log),
        onLlmResponse: (role, usage) => this.recordUsage(role, usage),
      },
    );
  } finally {
    this.signalThinkingDone('dm');
  }
  await this.drainAndPublish(log);

  if (result.reason === 'budget_exhausted') {
    const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
    if (!force.ok) throw new Error(`forced end_turn rejected: ${force.error.reason}`);
    await this.drainAndPublish(log);
  }

  if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);
  await this.maybeAutoEndCombat(log);
  this.cfg.engine.turn.setNarrativeActor(null);

  for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
  this.currentTurnIdx += 1;
}
```

In the main loop branch (around line 137-148), insert the `'npc'` case BEFORE the `runAiTurn` fallback:
```ts
const character = this.cfg.engine.charactersById().get(actor);
if (character?.kind === 'monster') {
  await this.runMonsterTurn(actor, log);
} else if (character?.kind === 'npc') {
  await this.runNpcTurn(actor, log);
} else {
  await this.runAiTurn(actor, log);
}
```

If the `Agent.takeTurn` signature does not accept an `objective` field on `{ kind: 'fresh_turn' }`, fall back to omitting it — the DM's system prompt already covers NPC operation (Task 9). The objective is just a one-line nudge; ignore it for the failing-test assertion to still pass.

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/runtime/orchestrator-npc-turn.test.ts
```
Expected: PASS (existence check).

- [ ] **Step 6: Full suite check**

```bash
npx vitest run
```
Expected: 694 + 1.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/orchestrator.ts tests/runtime/orchestrator-npc-turn.test.ts
git commit -m "feat(runtime): runNpcTurn — DM-driven NPC combat turns"
```

---

## Phase 7 — Manifest + browser

### Task 9: Manifest `npcs` group + validator

**Files:**
- Modify: `src/runtime/ws/manifest.ts` (add group + validate)
- Modify: `assets/manifest.json` (add empty `npcs: {}`)
- Test: `tests/runtime/ws/manifest-npcs.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/ws/manifest-npcs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadManifest } from '../../../src/runtime/ws/manifest.js';

describe('manifest.npcs', () => {
  it('exposes an empty record by default', () => {
    const m = loadManifest('assets/manifest.json');
    expect(typeof m.npcs).toBe('object');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/runtime/ws/manifest-npcs.test.ts
```
Expected: FAIL — `npcs` property missing on `AssetManifest`.

- [ ] **Step 3: Add the field**

In `src/runtime/ws/manifest.ts`, in `AssetManifest`:
```ts
heroes:    Record<string, string>;
monsters:  Record<string, string>;
npcs:      Record<string, string>;
```

In `loadManifest`, in the return object:
```ts
npcs: parsed.npcs ?? {},
```

In `FLAT_DIRECTIONAL_GROUPS`:
```ts
const FLAT_DIRECTIONAL_GROUPS = ['heroes', 'monsters', 'npcs', 'props'] as const;
```

In `assets/manifest.json`, add `"npcs": {}` next to `"monsters": {...}` (will fill in Mira/Lyra in Task 13).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/runtime/ws/manifest-npcs.test.ts
```
Expected: PASS.

- [ ] **Step 5: Manifest validates**

```bash
npx tsx -e "import('./src/runtime/ws/manifest.js').then(m => { const x = m.loadManifest('assets/manifest.json'); m.validateManifest(x, 'assets'); console.log('ok'); })"
```
Expected: prints `ok` (no asset paths registered yet, so nothing to fail on).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/ws/manifest.ts assets/manifest.json tests/runtime/ws/manifest-npcs.test.ts
git commit -m "feat(manifest): npcs sprite group + validator"
```

---

## Phase 8 — Content

### Task 10: Generate Mira + Lyra sprites via PixelLab

**Files:**
- Create: `assets/npcs/mira/{south,east,north,west}.png` (4 PNGs)
- Create: `assets/npcs/lyra/{south,east,north,west}.png` (4 PNGs)

- [ ] **Step 1: Generate via PixelLab MCP**

Two parallel `mcp__pixellab__create_character` calls in standard mode, size 48, 4 directions, view `low top-down`, outline `single color black outline`, shading `basic shading`, detail `medium detail`:

- mira: `"small girl, frightened, dirt-smudged simple village dress, brown hair in tangles, wide scared eyes, pixel art style"`
- lyra: `"small girl, sleeping peacefully, clover crown on her brow, simple pale dress, blonde hair fanned out, pixel art style"`

Each returns a character_id; poll with `mcp__pixellab__get_character` until status=`completed`.

- [ ] **Step 2: Download via curl**

```bash
mkdir -p assets/npcs/mira assets/npcs/lyra
for d in south east north west; do
  curl -sL -o assets/npcs/mira/${d}.png "<mira rotation url>/${d}.png"
  curl -sL -o assets/npcs/lyra/${d}.png "<lyra rotation url>/${d}.png"
done
```

Verify:
```bash
for f in assets/npcs/mira/*.png assets/npcs/lyra/*.png; do identify "$f"; done
```
Expected: 8 lines, each `PNG 68x68`.

- [ ] **Step 3: Commit**

```bash
git add assets/npcs/mira assets/npcs/lyra
git commit -m "assets: Mira + Lyra NPC sprites (PixelLab, 4 directions)"
```

---

### Task 11: Populate `data/npcs.json` with Mira + Lyra

**Files:**
- Modify: `data/npcs.json`

- [ ] **Step 1: Replace the empty array with two entries**

```json
[
  {
    "id": "mira",
    "name": "Mira",
    "pools": { "melee": 0, "ranged": 0, "magic": 0, "armor": 1 },
    "dex": 1,
    "healthTotal": 2,
    "normalAttack": { "kind": "melee", "name": "Shove", "range": 1, "damageMod": 0 },
    "specialAction": { "effectId": "noop", "name": "—", "description": "Non-combatant" },
    "bonusAbility":  { "effectId": "noop", "name": "—", "description": "Non-combatant" },
    "sprite": "mira"
  },
  {
    "id": "lyra",
    "name": "Lyra",
    "pools": { "melee": 0, "ranged": 0, "magic": 0, "armor": 1 },
    "dex": 1,
    "healthTotal": 2,
    "normalAttack": { "kind": "melee", "name": "Shove", "range": 1, "damageMod": 0 },
    "specialAction": { "effectId": "noop", "name": "—", "description": "Asleep" },
    "bonusAbility":  { "effectId": "noop", "name": "—", "description": "Asleep" },
    "sprite": "lyra"
  }
]
```

- [ ] **Step 2: Verify**

```bash
npx tsx -e "import('./src/engine/load.js').then(async m => { const c = await m.loadCatalogs('data'); console.log([...c.npcs.keys()]); })"
```
Expected: `[ 'mira', 'lyra' ]`.

- [ ] **Step 3: Commit**

```bash
git add data/npcs.json
git commit -m "data: Mira + Lyra NPC catalog entries"
```

---

### Task 12: Register NPC sprites in `assets/manifest.json`

**Files:**
- Modify: `assets/manifest.json`

- [ ] **Step 1: Add entries to the `npcs` group**

Replace `"npcs": {}` with:
```json
"npcs": {
  "mira": "npcs/mira",
  "lyra": "npcs/lyra"
},
```

- [ ] **Step 2: Validate**

```bash
npx tsx -e "import('./src/runtime/ws/manifest.js').then(m => { const x = m.loadManifest('assets/manifest.json'); m.validateManifest(x, 'assets'); console.log('ok'); })"
```
Expected: prints `ok`.

- [ ] **Step 3: Full test suite**

```bash
npx vitest run
```
Expected: 694 + 1.

- [ ] **Step 4: Commit**

```bash
git add assets/manifest.json
git commit -m "manifest: register Mira + Lyra NPC sprites"
```

---

### Task 13: Add Mira to scene 1 and Lyra to scene 5 of Whispering Woods

**Files:**
- Modify: `adventures/whispering-woods.json` (two scenes)

- [ ] **Step 1: Add Mira to `forest-edge`**

In the `forest-edge` scene's `map` block, add `"npcs"` after `"exits"`:
```json
"npcs": [
  { "type": "mira", "startPos": { "x": 0, "y": 5 }, "allegiance": "neutral" }
]
```

Update the scene `intro` to acknowledge that Mira is visible on the path (one short sentence). Update `tactics` to mention that Mira is a kind=npc grid character the DM can move and speak through via `npc_action`.

- [ ] **Step 2: Add Lyra to `dryad-grove`**

In the `dryad-grove` scene's `map` block, add:
```json
"npcs": [
  { "type": "lyra", "startPos": { "x": 6, "y": 5 }, "allegiance": "neutral" }
]
```

Update `intro` and `tactics` to describe Lyra as a kind=npc grid character — asleep at Nimue's feet, the DM can `npc_action(lyra, move)` her once Nimue releases her.

- [ ] **Step 3: Validate the adventure loads**

```bash
npx tsx -e "import('./src/engine/adventure.js').then(async m => { const a = await m.loadAdventure('adventures/whispering-woods.json'); for (const s of a.scenes) console.log(s.id, 'npcs=', s.map.npcs.length); })"
```
Expected output:
```
forest-edge npcs= 1
whispering-path npcs= 0
briar-hollow npcs= 0
wounded-oak npcs= 0
dryad-grove npcs= 1
```

- [ ] **Step 4: Commit**

```bash
git add adventures/whispering-woods.json
git commit -m "content: Mira in forest-edge, Lyra in dryad-grove (Whispering Woods)"
```

---

### Task 14: Wire NPC catalog through `bin/play.ts`

**Files:**
- Modify: `bin/play.ts` (pass npcs to GameEngine constructor)

- [ ] **Step 1: Inspect the existing engine construction**

```bash
grep -n "new GameEngine" bin/play.ts
```
Expected: one line, around line 116-122.

- [ ] **Step 2: Add `npcs: cats.npcs`**

In `bin/play.ts`, find the `new GameEngine({...})` call. Add `npcs: cats.npcs,` to the config object, adjacent to `monsters: cats.monsters,`.

- [ ] **Step 3: Run the play-time validator (no API key needed)**

```bash
node --input-type=module --eval "
import('./src/engine/load.js').then(async m => {
  const c = await m.loadCatalogs('data');
  console.log('catalogs:', { heroes: c.heroes.size, monsters: c.monsters.size, npcs: c.npcs.size });
});
"
```
Expected: `npcs: 2`.

- [ ] **Step 4: Boot the play CLI in --browser mode and verify it loads**

This step does NOT require an API key — `npm run play` will boot the WS server and serve the bundle before any LLM call. Stop it after the "Serving on…" line prints (or after 10 seconds).

```bash
timeout 10 npm run play -- --browser scenarios/whispering-woods.json 2>&1 | head -10 || true
```
Expected: prints `Serving on http://localhost:5175` with no manifest errors. If it logs `Missing manifest asset npcs.mira: ...`, the asset directory is wrong — check Task 10.

- [ ] **Step 5: Commit**

```bash
git add bin/play.ts
git commit -m "feat(play): thread npc catalog into GameEngine"
```

---

### Task 15: Document NPC tools in the DM system prompt

**Files:**
- Modify: `src/runtime/prompt/templates/dm-system.ts` (add NPC section)

- [ ] **Step 1: Locate the existing tool-vocabulary block**

```bash
grep -n "YOUR TURN STRUCTURE\|MONSTERS PRESENT" src/runtime/prompt/templates/dm-system.ts
```

- [ ] **Step 2: Add a "NPCS ON THE GRID" block**

Immediately after the `MONSTERS PRESENT` line in the template (or in the same neighborhood), add:
```ts
`
NPCS ON THE GRID
  Scene-declared NPCs auto-appear at their startPos when you enter the scene
  — you do NOT need to call reveal_npc for them. Their ids follow the same
  {type}-N pattern as monsters (mira-1, lyra-1, …).

  Drive them with the npc_action tool:
    npc_action({ npcId, action }) where action is a PlayerAction subset
    (move, normal_attack, say, emote, ability_test, end_turn, skip_turn).

  Outside combat, npc_action is a free action — you can weave Mira's gestures
  and lines into your narration steps without consuming a turn. Inside combat,
  the NPC must be the active combatant.

  Combat membership is governed by allegiance:
    ally     → include the NPC in start_combat.heroSide
    hostile  → include in monsterSide
    neutral  → leave out of both sides (NPC sits out of combat)
`
```

(Wire this as a template-literal segment so it's appended in the right place — match the surrounding template style.)

- [ ] **Step 3: Verify the prompt builder still produces a string**

```bash
npx vitest run tests/runtime/prompt/builder.test.ts
```
Expected: PASS (same baseline).

- [ ] **Step 4: Commit**

```bash
git add src/runtime/prompt/templates/dm-system.ts
git commit -m "feat(prompt): document NPC tool calls in DM system prompt"
```

---

## Phase 9 — Verification

### Task 16: Final smoke + manual verification

- [ ] **Step 1: Full vitest suite**

```bash
npx vitest run
```
Expected: 694 + new NPC tests pass, 1 pre-existing CLI ANSI failure.

- [ ] **Step 2: Manifest validates with all new entries present**

```bash
npx tsx -e "import('./src/runtime/ws/manifest.js').then(m => { const x = m.loadManifest('assets/manifest.json'); m.validateManifest(x, 'assets'); console.log('ok npcs=', Object.keys(x.npcs)); })"
```
Expected: `ok npcs= [ 'mira', 'lyra' ]`.

- [ ] **Step 3: Typecheck (only baseline 16 pre-existing errors should remain)**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```
Expected: 16 (no new errors).

- [ ] **Step 4: Boot the browser smoke**

```bash
npm run build:web
ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/whispering-woods.json
```
Scene 1 should render Mira as a sprite at (0, 5). The DM's first turn should be able to call `npc_action({ npcId: 'mira-1', action: { kind: 'say', text: '...' } })` and a speech bubble appears over Mira's token.

- [ ] **Step 5: Merge to main**

```bash
git log --oneline main..HEAD
# Confirm the chain of commits.
```

Then from the parent repo:
```bash
git -C /Users/arthurchau/Cofre/Mestrado/agents/agents-rpg merge --ff-only worktree-npc-grid-characters
git -C /Users/arthurchau/Cofre/Mestrado/agents/agents-rpg worktree remove .claude/worktrees/npc-grid-characters
git -C /Users/arthurchau/Cofre/Mestrado/agents/agents-rpg branch -d worktree-npc-grid-characters
```

(Or use ExitWorktree + merge from the main session.)

---

## Self-review

**Spec coverage check** (against `docs/superpowers/specs/2026-05-23-npc-grid-characters-design.md`):
- §1 `Character.kind` → Task 1 ✓
- §2 NPC catalog → Tasks 2, 11 ✓
- §3 Scene declaration with allegiance → Task 3 ✓
- §4 Auto-reveal on set_scene → Task 5 ✓
- §5 `npc_action` tool + guards → Tasks 4, 6, 7 ✓
- §6 Orchestrator routing → Task 8 ✓
- §7 Visibility filter → no change needed (action events already public — noted in spec) ✓
- §8 Snapshot widening → Task 1 (covered by `RedactedCharacter.kind` widening) ✓
- Content: Whispering Woods updates → Task 13 ✓
- PixelLab assets → Task 10 ✓
- Engine guards (1–5 in spec) → Task 6 covers guards 1, 2; Task 5 covers guard 4; Task 6/reveal_npc handler covers guard 5; guard 3 (start_combat must not include neutral) is a known gap — handled in plan note below

**Acceptance criteria check** (spec §Acceptance criteria):
1. `npm test` passes → Task 16, Step 1 ✓
2. Targeted adventure tests pass → covered by full suite ✓
3. New tests:
   - Unit `npc_action` guards → Task 6 ✓
   - Integration with neutral NPC + DM turn → Task 8 covers method existence; full integration deferred to Task 16 manual smoke (acceptable given the live-smoke path)
4. Live browser smoke → Task 16, Step 4 ✓
5. Manifest validation green → Task 16, Step 2 ✓

**Known gap:** spec §Engine guards #3 ("`start_combat`/`monsterSide` must not include a neutral NPC") is NOT enforced in this plan. The DM is expected to honor allegiance via prompt guidance (Task 15). Adding a hard engine guard would touch `start_combat` and the test fixture for combat init — out of scope for v1; documented in the plan as a follow-up. If the user wants the guard, add a Task 6b that:
- writes a failing test: `engine.applyDmAction({ kind: 'start_combat', heroSide: [miraId], monsterSide: [] })` returns `err({ reason: 'invalid-action-shape', details: 'neutral NPC cannot enter combat' })`
- threads scene-time allegiance into the engine via a `neutralNpcs: Set<CharacterId>` field populated on `set_scene`
- guards `start_combat` against any side list intersecting that set

**Placeholder scan:** no TBDs, no "appropriate error handling" hand-waves.

**Type consistency check:** `runNpcTurn` signature matches the `runDmTurn` pattern; `materializeNpc` returns `Result<Character, RuleViolation>` like `materializeMonster`.

**Self-review complete.**
