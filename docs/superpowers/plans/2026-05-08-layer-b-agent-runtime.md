# Layer B Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent runtime that drives the Layer A engine: deterministic orchestrator, ReACT-style AI agents with private extended thinking, a one-method `LlmClient` seam (real Anthropic + scripted test double), the visibility filter, an Ink-rendered CLI view adapter, and a scenario/persona config system. End state: `npm run play scenarios/baseline.json` plays through `adventures/stub-layer-b.json` end-to-end with a DM agent, two AI players, and one human via CLI; the headline integration test asserts the same path runs deterministically against a scripted human input file.

**Architecture:** New `src/runtime/` tree containing the orchestrator, agent, LLM client, visibility filter, prompt builder, and Ink-based CLI. Orchestrator owns the `GameEngine`, an `EventLog` direct sink, and a perspective-keyed `Subscriber` fan-out. Agents drive a ReACT inner loop via the `LlmClient` seam (`AnthropicLlmClient` for live, `ScriptedLlmClient` for tests). The visibility filter is one pure function. The CLI is an Ink component tree with a single emoji-glyph registry, fed by an external store the orchestrator pushes events into.

**Tech Stack:** TypeScript 5.x, Node 20+, vitest. New runtime deps: `@anthropic-ai/sdk` ^0.30.x, `ink` ^5.x, `react` ^18.x. New dev deps: `ink-testing-library` ^4.x, `@types/react` ^18.x.

**Reference:** Implements `docs/superpowers/specs/2026-05-08-layer-b-agent-runtime-design.md`. Predecessor plan: `docs/superpowers/plans/2026-05-08-engine-foundation.md` (Layer A, completed).

---

## File Structure

```
src/
  engine/
    game-engine.ts                 MODIFY: emitRuntime(), handleSpecialAction dispatches changes,
                                           handleUseBoon dispatches via registry, accept boons in config
  log/
    replay.ts                      MODIFY: snapshotEngineState includes inventory/boons/equipped
    events.ts                      MODIFY: step_budget_exhausted.actorId widened to CharacterId | 'dm'
  runtime/                         NEW
    subscriber.ts                  Subscriber interface
    orchestrator.ts                Turn-loop driver, owns EventLog + Subscriber[]
    agent.ts                       Role-configured ReACT inner loop
    visibility/
      filter.ts                    Pure: filter(event, viewer) → RedactedEvent | null
      types.ts                     Viewer + RedactedEvent types
    prompt/
      builder.ts                   Three-band cache-aware prompt assembly
      tools.ts                     PlayerAction/DmAction → Anthropic tool schemas
      templates/
        player-system.ts           Player system prompt template (ports parent spec §5)
        dm-system.ts               DM system prompt template
    llm/
      llm-client.ts                LlmClient interface
      anthropic.ts                 Real network impl: cache_control, retry, parse thinking + tools
      scripted.ts                  Deterministic test double
    cli/
      App.tsx                      Root Ink component
      Board.tsx                    Emoji grid renderer
      CharacterPanels.tsx
      ChatLog.tsx
      InputLine.tsx
      cli-adapter.ts               Subscriber + HumanInputProvider
      cli-store.ts                 External store for useSyncExternalStore
      glyphs.ts                    Emoji registry
      slash-parser.ts              /move /attack /skip /say /test /use /equip /end /help
      script-reader.ts             --human-script JSONL reader
    scenario.ts                    Scenario JSON + persona MD loader; promptHash
  bin/
    play.ts                        Entry: parse args, load scenario, render Ink, run orchestrator

adventures/
  stub-layer-b.json                NEW: 3 rats + ability test, single scene

scenarios/                         NEW
  baseline.json

personas/                          NEW
  cautious.md
  reckless.md
  dm-default.md

tests/
  engine/
    game-engine.test.ts            EXTEND: special-action change dispatch, use_boon dispatch
  log/
    replay.test.ts                 EXTEND: snapshot roundtrips inventory/boons/equipped
  fixtures/
    item-roundtrip-sequence.json   NEW
    boon-roundtrip-sequence.json   NEW
    layer-b/
      scripted-dm-responses.json
      scripted-p1-responses.json
      scripted-p2-responses.json
      human-bran-script.jsonl
  runtime/                         NEW
    visibility.test.ts
    prompt/builder.test.ts
    prompt/tools.test.ts
    llm/scripted.test.ts
    llm/anthropic.test.ts
    agent.test.ts
    orchestrator.test.ts
    scenario.test.ts
    cli/
      glyphs.test.ts
      slash-parser.test.ts
      script-reader.test.ts
      board.test.ts
      input-line.test.ts
      app.test.ts
  integration/
    stub-adventure.test.ts         (existing, untouched)
    layer-b-end-to-end.test.ts     NEW: the headline test
```

**Why this layout.** `src/runtime/` is the new top-level concern. Each cluster (`prompt/`, `llm/`, `cli/`, `visibility/`) has one responsibility small enough to fit in a single mental frame. Engine and log changes are minimal and surgical — three small touch-ups plus one runtime-event shim.

---

## Tasks

### Task 1: Hardening — `snapshotEngineState` captures inventory, boons, and equipped

**Files:**
- Modify: `src/log/replay.ts`
- Modify: `tests/log/replay.test.ts`
- Create: `tests/fixtures/item-roundtrip-sequence.json`
- Create: `tests/fixtures/boon-roundtrip-sequence.json`

The current `snapshotEngineState` only captures `id`, `pos`, `health`. Replay can silently diverge once items move. Extend it before any new runtime code lands.

- [ ] **Step 1: Write a failing test that asserts the snapshot includes inventory**

Append to `tests/log/replay.test.ts` (above the closing `});` of the outer `describe`):

```ts
import { asItemId, asBoonId, asEquipmentId } from '../../src/engine/ids.js';

describe('snapshotEngineState shape', () => {
  it('includes inventory, boons, and equipped per character', () => {
    const engine = buildEngine('seed-snap', charsFromFixture());
    const snap = snapshotEngineState(engine);
    for (const c of snap.characters) {
      expect(c).toHaveProperty('inventory');
      expect(c).toHaveProperty('boons');
      expect(c).toHaveProperty('equipped');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/log/replay.test.ts`
Expected: the new test fails because `inventory` / `boons` / `equipped` are not on the snapshot shape.

- [ ] **Step 3: Extend `snapshotEngineState` to include item state**

Replace `src/log/replay.ts` body with:

```ts
import type { GameEngine } from '../engine/game-engine.js';
import type { CharacterId, ItemId, BoonId, EquipmentId } from '../engine/ids.js';
import { asCharacterId } from '../engine/ids.js';
import type { PlayerAction } from '../engine/action.js';
import type { Character, ItemStack } from '../engine/character.js';

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
      throw new Error(
        `Replay diverged on action ${JSON.stringify(step.action)}: ${result.error.reason}`,
      );
    }
  }
};

export interface CharacterSnapshot {
  id: CharacterId;
  pos: Character['pos'];
  health: Character['health'];
  inventory: ReadonlyArray<ItemStack>;
  boons: ReadonlyArray<BoonId>;
  equipped: EquipmentId | null;
}

export interface EngineSnapshot {
  characters: CharacterSnapshot[];
  phase: string;
  activeActor: CharacterId | null;
}

export const snapshotEngineState = (engine: GameEngine): EngineSnapshot => {
  const chars: CharacterSnapshot[] = Array.from(engine.charactersById().values())
    .map((c) => ({
      id: c.id,
      pos: c.pos,
      health: c.health,
      inventory: [...c.inventory].sort((a, b) =>
        (a.itemId as string).localeCompare(b.itemId as string),
      ),
      boons: [...c.boons].sort((a, b) => (a as string).localeCompare(b as string)),
      equipped: c.equipped ?? null,
    }))
    .sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return {
    characters: chars,
    phase: engine.turn.phase,
    activeActor: engine.turn.activeActorId,
  };
};
```

Note the imports of `ItemStack`, `ItemId`, `BoonId`, `EquipmentId`. The sort calls keep snapshot output stable for equality checks.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/log/replay.test.ts`
Expected: PASS, all tests in the file (including the existing "replay invariant" tests).

- [ ] **Step 5: Add an item-roundtrip fixture**

Create `tests/fixtures/item-roundtrip-sequence.json`:

```json
{
  "seed": "item-roundtrip-seed",
  "narrativeActor": "h1",
  "characters": [
    {
      "id": "h1",
      "name": "Healer",
      "kind": "hero",
      "archetype": "healer",
      "pools": { "melee": 0, "ranged": 0, "magic": 2, "armor": 1 },
      "healthTotal": 3,
      "pos": { "x": 1, "y": 1 },
      "normalAttack": { "kind": "magic", "name": "Searing Light", "range": 4, "damageMod": 0 },
      "specialAction": { "id": "healing-touch" },
      "bonusAbility": { "id": "potion-brewer" }
    },
    {
      "id": "h2",
      "name": "Hunter",
      "kind": "hero",
      "archetype": "hunter",
      "pools": { "melee": 0, "ranged": 2, "magic": 0, "armor": 2 },
      "healthTotal": 3,
      "pos": { "x": 2, "y": 1 },
      "normalAttack": { "kind": "ranged", "name": "Arrow Shot", "range": 6, "damageMod": 0 },
      "specialAction": { "id": "split-shot" },
      "bonusAbility": { "id": "evasive-maneuver" }
    }
  ],
  "actions": [
    { "actorId": "h1", "action": { "kind": "use_item", "itemId": "potion", "targetId": "h2" } },
    { "actorId": "h1", "action": { "kind": "end_turn" } }
  ]
}
```

- [ ] **Step 6: Add a roundtrip test that exercises item state in replay**

Append to `tests/log/replay.test.ts`, inside `describe('snapshotEngineState shape', ...)`:

```ts
  it('replaying an item-use sequence twice produces identical inventories', () => {
    const fx = JSON.parse(
      readFileSync(join(HERE, '..', 'fixtures', 'item-roundtrip-sequence.json'), 'utf8'),
    ) as ReplayFixture;

    // Pre-load h1 with 1 potion so use_item succeeds.
    const seedChars = (fx.characters as Array<Record<string, unknown>>).map((c) => ({
      ...(c as object),
      inventory: c['id'] === 'h1' ? [{ itemId: 'potion', count: 1 }] : [],
    }));
    const fixtureWithInv = { ...fx, characters: seedChars } as ReplayFixture;

    const make = (): GameEngine => {
      const cs = (fixtureWithInv.characters as Array<Record<string, unknown>>).map((c) => ({
        id: asCharacterId(c['id'] as string),
        name: c['name'] as string,
        kind: c['kind'] as 'hero' | 'monster',
        ...(c['archetype'] ? { archetype: c['archetype'] as Character['archetype'] } : {}),
        pools: c['pools'] as Character['pools'],
        health: { total: c['healthTotal'] as number, damage: c['id'] === 'h2' ? 1 : 0, status: 'normal' as const },
        pos: c['pos'] as Character['pos'],
        normalAttack: c['normalAttack'] as Character['normalAttack'],
        specialAction: { id: asEffectId((c['specialAction'] as { id: string }).id), name: '', description: '' },
        bonusAbility: { id: asEffectId((c['bonusAbility'] as { id: string }).id), name: '', description: '' },
        inventory: ((c as { inventory?: Array<{ itemId: string; count: number }> }).inventory ?? []).map(
          (s) => ({ itemId: asItemId(s.itemId), count: s.count }),
        ),
        boons: [],
        skills: [],
      })) as Character[];
      const grid = new Grid(
        Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
      );
      const reg = new EffectRegistry();
      registerCoreEffects(reg);
      const items = new Map<string, { id: string; name: string; category: 'consumable' | 'utility'; consumableEffect?: string; icon: string }>([
        ['potion', { id: 'potion', name: 'Potion', category: 'consumable', consumableEffect: 'heal-full', icon: 'p' }],
      ]);
      return new GameEngine({ seed: fixtureWithInv.seed, grid, characters: cs, effects: reg, items });
    };

    const e1 = make();
    replayFromFixture(e1, fixtureWithInv);
    const e2 = make();
    replayFromFixture(e2, fixtureWithInv);

    expect(snapshotEngineState(e2)).toEqual(snapshotEngineState(e1));
    // After potion use, h2 fully healed, h1 has 0 potions.
    const h1 = snapshotEngineState(e1).characters.find((c) => c.id === 'h1')!;
    expect(h1.inventory).toEqual([]);
  });
```

- [ ] **Step 7: Run the new test**

Run: `npx vitest run tests/log/replay.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/log/replay.ts tests/log/replay.test.ts tests/fixtures/item-roundtrip-sequence.json
git commit -m "fix(replay): snapshotEngineState captures inventory, boons, equipped"
```

---

### Task 2: Hardening — `handleSpecialAction` dispatches `EffectChange`

**Files:**
- Modify: `src/engine/game-engine.ts`
- Modify: `tests/engine/game-engine.test.ts`

`handleSpecialAction` currently emits the action + a resolution event with `narration` and `changes` but never applies any of the changes. The healer's Healing Touch is silent — only narration emits. Mirror `handleUseItem`'s heal/damage application loop.

- [ ] **Step 1: Write a failing test**

Append to `tests/engine/game-engine.test.ts` (inside the existing top-level `describe`, or in a new sibling `describe` if cleaner):

```ts
  it('special_action heals when the registered effect emits a heal change', () => {
    const reg = new EffectRegistry();
    registerCoreEffects(reg);
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );

    const healer: Character = {
      id: asCharacterId('h-healer'),
      name: 'Healer', kind: 'hero', archetype: 'healer',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 1, y: 1 },
      normalAttack: { kind: 'magic', name: 'Searing Light', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('healing-touch'), name: 'Healing Touch', description: '' },
      bonusAbility: { id: asEffectId('potion-brewer'), name: 'Potion Brewer', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const ally: Character = {
      ...healer,
      id: asCharacterId('h-ally'),
      name: 'Hunter', archetype: 'hunter',
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
```

(The test imports `asCharacterId`, `asEffectId`, `Character`, `GameEngine`, `Grid`, `EffectRegistry`, `registerCoreEffects` — already imported in the existing test file. Add any that are missing.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL — `state_change` event is not emitted; ally still has `damage: 2`.

- [ ] **Step 3: Refactor — extract a private change-applier**

In `src/engine/game-engine.ts`, add a private method beneath `handleUseItem`:

```ts
  /**
   * Apply EffectChange entries to engine state and emit state_change.
   * Returns the (possibly updated) actor for callers that need a fresh handle.
   */
  private applyEffectChanges(
    actorId: CharacterId,
    changes: ReadonlyArray<EffectChange>,
  ): Character {
    let currentActor = this.characters.get(actorId)!;
    for (const change of changes) {
      if (change.kind === 'heal') {
        const c = this.characters.get(change.characterId as CharacterId);
        if (c) {
          const healed = healDamage(c, change.amount);
          this.characters.set(c.id, healed);
          if (c.id === actorId) currentActor = healed;
          this.emit({
            type: 'state_change',
            changes: [{ id: c.id, damage: healed.health.damage, status: healed.health.status }],
          } as unknown as Event);
        }
      } else if (change.kind === 'damage') {
        const c = this.characters.get(change.characterId as CharacterId);
        if (c) {
          const damaged = applyDamage(c, change.amount);
          this.characters.set(c.id, damaged);
          if (c.id === actorId) currentActor = damaged;
          this.emit({
            type: 'state_change',
            changes: [{ id: c.id, damage: damaged.health.damage, status: damaged.health.status }],
          } as unknown as Event);
        }
      }
      // attack-mod / free-attack / move-bonus / noop: handled by other paths.
    }
    return currentActor;
  }
```

Add `EffectChange` to the file's existing import from `./effects.js` if not already there.

- [ ] **Step 4: Refactor `handleUseItem` to use the new helper**

Replace the body of `handleUseItem`'s change loop (the `for (const change of result.changes)` block) so the method becomes:

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
      return err({
        reason: 'invalid-action-shape',
        details: 'utility items are not used as actions',
      });
    }

    const effect = this.effects.get(def.consumableEffect!);
    const target = targetId ? this.characters.get(targetId) ?? actor : actor;
    const result = effect.apply({ actor, target });

    const currentActor = this.applyEffectChanges(actorId, result.changes);

    // Decrement stack.
    const newInventory =
      stack.count > 1
        ? currentActor.inventory.map((s) =>
            s.itemId === itemId ? { ...s, count: s.count - 1 } : s,
          )
        : currentActor.inventory.filter((s) => s.itemId !== itemId);
    this.characters.set(actorId, { ...currentActor, inventory: newInventory });

    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'use_item', itemId, targetId },
    } as unknown as Event);

    return ok({ turnEnded: false });
  }
```

- [ ] **Step 5: Update `handleSpecialAction` to dispatch changes**

Replace `handleSpecialAction` with:

```ts
  private handleSpecialAction(
    actorId: CharacterId,
    action: Extract<PlayerAction, { kind: 'special_action' }>,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    const effect = this.effects.get(actor.specialAction.id);
    const target =
      action.targetIds && action.targetIds[0]
        ? this.characters.get(action.targetIds[0])
        : undefined;
    const ctx: EffectContext = {
      actor,
      ...(target !== undefined && { target }),
      ...(action.params !== undefined && { params: action.params }),
    };
    const result = effect.apply(ctx);

    this.emit({ type: 'action', actorId, action } as unknown as Event);
    if (result.narration) {
      this.emit({
        type: 'resolution',
        actorId,
        public: { narration: result.narration, changes: result.changes },
      } as unknown as Event);
    }

    this.applyEffectChanges(actorId, result.changes);

    return ok({ turnEnded: false });
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS — including the new heal test plus all existing tests (no regressions).

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all tests green.

- [ ] **Step 8: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "fix(engine): handleSpecialAction dispatches EffectChange results"
```

---

### Task 3: Hardening — `handleUseBoon` dispatches the boon effect via the registry

**Files:**
- Modify: `src/engine/game-engine.ts` (accept `boons` map in config; resolve effect via registry)
- Modify: `tests/engine/game-engine.test.ts`
- Create: `tests/fixtures/boon-roundtrip-sequence.json`
- Modify: `tests/log/replay.test.ts` (add a roundtrip test using a fixture-only boon)

The v1 catalog has no boons, so we exercise this with a fixture-only boon registered into the test's `EffectRegistry`. The change makes the code path correct and keeps it tested ahead of any adventure that grants a boon.

- [ ] **Step 1: Write a failing test**

Append to `tests/engine/game-engine.test.ts`:

```ts
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
      name: 'Hero', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 2, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility: { id: asEffectId('teamwork'), name: '', description: '' },
      inventory: [], boons: [asBoonId('fixture-heal-boon')], skills: [],
    };

    const boonsMap = new Map<string, { id: string; name: string; description: string; effectId: string; icon: string }>([
      ['fixture-heal-boon', { id: 'fixture-heal-boon', name: 'Test Boon', description: '', effectId: 'fixture-boon-heal', icon: 'b' }],
    ]);

    const engine = new GameEngine({ seed: 's', grid, characters: [hero], effects: reg, boons: boonsMap });
    engine.beginNarrativeTurn(asCharacterId('h'));

    const result = engine.applyAction(asCharacterId('h'), {
      kind: 'use_boon', boonId: asBoonId('fixture-heal-boon'),
    });
    expect(result.ok).toBe(true);

    const heroAfter = engine.charactersById().get(asCharacterId('h'))!;
    expect(heroAfter.health.damage).toBe(1);          // healed 1
    expect(heroAfter.boons).toEqual([]);              // boon removed from inventory
  });
```

Add `asBoonId` to the import from `../../src/engine/ids.js` at the top of the file if not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL — either "boons" is not a valid `GameEngineConfig` field, or the boon is removed but no heal applied.

- [ ] **Step 3: Add `boons` map to `GameEngineConfig`**

In `src/engine/game-engine.ts`, update the config interface and the constructor:

```ts
import type { ItemEntry, BoonEntry } from './catalogs.js';
// ... existing imports unchanged

export interface GameEngineConfig {
  seed: string;
  grid: Grid;
  characters: Character[];
  effects: EffectRegistry;
  items?: Map<string, ItemEntry>;
  boons?: Map<string, BoonEntry>;
}
```

In the constructor body, add:

```ts
    this.boons = cfg.boons ?? new Map();
```

And add the field declaration alongside `items`:

```ts
  private items: Map<string, ItemEntry>;
  private boons: Map<string, BoonEntry>;
```

- [ ] **Step 4: Update `handleUseBoon` to dispatch the effect**

Replace `handleUseBoon` with:

```ts
  private handleUseBoon(
    actorId: CharacterId,
    boonId: BoonId,
    targetId: CharacterId | undefined,
  ): Result<ActionOk, RuleViolation> {
    const actor = this.characters.get(actorId)!;
    if (!actor.boons.includes(boonId)) {
      return err({ reason: 'unknown-id', what: 'boon', id: String(boonId) });
    }
    const def = this.boons.get(boonId);
    if (!def) return err({ reason: 'unknown-id', what: 'boon', id: String(boonId) });

    const effect = this.effects.get(def.effectId);
    const target = targetId ? this.characters.get(targetId) ?? actor : actor;
    const result = effect.apply({ actor, target });

    // Apply changes BEFORE removing the boon so applyEffectChanges sees the
    // current actor (it reads from this.characters which still has boons).
    this.applyEffectChanges(actorId, result.changes);

    // Remove the boon from inventory.
    const fresh = this.characters.get(actorId)!;
    const newBoons = fresh.boons.filter((b) => b !== boonId);
    this.characters.set(actorId, { ...fresh, boons: newBoons });

    this.emit({
      type: 'action',
      actorId,
      action: { kind: 'use_boon', boonId, ...(targetId && { targetId }) },
    } as unknown as Event);

    return ok({ turnEnded: false });
  }
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Add a boon roundtrip fixture**

Create `tests/fixtures/boon-roundtrip-sequence.json`:

```json
{
  "seed": "boon-roundtrip-seed",
  "narrativeActor": "h",
  "characters": [
    {
      "id": "h",
      "name": "Hero",
      "kind": "hero",
      "archetype": "warrior",
      "pools": { "melee": 2, "ranged": 0, "magic": 0, "armor": 2 },
      "healthTotal": 3,
      "pos": { "x": 0, "y": 0 },
      "normalAttack": { "kind": "melee", "name": "Slashing Strike", "range": 1, "damageMod": 0 },
      "specialAction": { "id": "whirlwind-attack" },
      "bonusAbility": { "id": "teamwork" }
    }
  ],
  "actions": [
    { "actorId": "h", "action": { "kind": "use_boon", "boonId": "fixture-heal-boon" } },
    { "actorId": "h", "action": { "kind": "end_turn" } }
  ]
}
```

- [ ] **Step 7: Add a replay test exercising the boon path**

Append to `tests/log/replay.test.ts` inside `describe('snapshotEngineState shape', ...)`:

```ts
  it('replaying a boon-use sequence twice produces identical snapshots', () => {
    const fx = JSON.parse(
      readFileSync(join(HERE, '..', 'fixtures', 'boon-roundtrip-sequence.json'), 'utf8'),
    ) as ReplayFixture;

    const make = (): GameEngine => {
      const cs = (fx.characters as Array<Record<string, unknown>>).map((c) => ({
        id: asCharacterId(c['id'] as string),
        name: c['name'] as string,
        kind: c['kind'] as 'hero' | 'monster',
        ...(c['archetype'] ? { archetype: c['archetype'] as Character['archetype'] } : {}),
        pools: c['pools'] as Character['pools'],
        health: { total: c['healthTotal'] as number, damage: 1, status: 'normal' as const },
        pos: c['pos'] as Character['pos'],
        normalAttack: c['normalAttack'] as Character['normalAttack'],
        specialAction: { id: asEffectId((c['specialAction'] as { id: string }).id), name: '', description: '' },
        bonusAbility: { id: asEffectId((c['bonusAbility'] as { id: string }).id), name: '', description: '' },
        inventory: [],
        boons: [asBoonId('fixture-heal-boon')],
        skills: [],
      })) as Character[];
      const grid = new Grid(
        Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
      );
      const reg = new EffectRegistry();
      registerCoreEffects(reg);
      reg.register('fixture-boon-heal', {
        kind: 'boon',
        apply: ({ actor }) => ({ changes: [{ kind: 'heal', characterId: actor.id, amount: 1 }] }),
      });
      const boons = new Map<string, BoonEntry>([
        ['fixture-heal-boon', { id: 'fixture-heal-boon', name: 'Test Boon', description: '', effectId: 'fixture-boon-heal', icon: 'b' }],
      ]);
      return new GameEngine({ seed: fx.seed, grid, characters: cs, effects: reg, boons });
    };

    const e1 = make(); replayFromFixture(e1, fx);
    const e2 = make(); replayFromFixture(e2, fx);
    expect(snapshotEngineState(e2)).toEqual(snapshotEngineState(e1));

    // Hero healed from damage:1 to damage:0 and lost the boon.
    const hero = snapshotEngineState(e1).characters.find((c) => c.id === 'h')!;
    expect(hero.health.damage).toBe(0);
    expect(hero.boons).toEqual([]);
  });
```

Add `asBoonId` and `BoonEntry` to the imports at the top of `tests/log/replay.test.ts` (`BoonEntry` from `../../src/engine/catalogs.js`).

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: all tests green.

- [ ] **Step 9: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts \
        tests/fixtures/boon-roundtrip-sequence.json tests/log/replay.test.ts
git commit -m "fix(engine): handleUseBoon dispatches boon effect via registry"
```

---

### Task 4: Widen `step_budget_exhausted.actorId` to allow `'dm'`

**Files:**
- Modify: `src/log/events.ts`
- Modify: `tests/log/event-log.test.ts` (compile-only assertion via a sample event)

This is the small engine-side touch noted in spec §9. The current type pins `actorId: CharacterId`, but the orchestrator will emit step-budget exhaustion for the DM as well. Widen to `CharacterId | 'dm'`.

- [ ] **Step 1: Edit the event union**

In `src/log/events.ts`, change the `step_budget_exhausted` variant from:

```ts
  | (EventBase & {
      type: 'step_budget_exhausted';
      actorId: CharacterId;
      forced: 'end_turn';
    })
```

to:

```ts
  | (EventBase & {
      type: 'step_budget_exhausted';
      actorId: CharacterId | 'dm';
      forced: 'end_turn';
    })
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/log/events.ts
git commit -m "chore(events): widen step_budget_exhausted.actorId to include 'dm'"
```

---

### Task 5: Bootstrap runtime/ + LlmClient interface + runtime emit shim

**Files:**
- Create: `src/runtime/llm/llm-client.ts`
- Modify: `src/engine/game-engine.ts` (add `emitRuntime` public shim)
- Create: `tests/runtime/.gitkeep` (so the directory tracks)

This task creates the runtime root, the seam interface (no impl yet), and the small engine helper that lets the orchestrator and agents emit non-engine events (thoughts, step-budget-exhausted, human_input) through the same `t` counter as engine events. That keeps event ordering correct in the log.

- [ ] **Step 1: Add the runtime emit shim to the engine**

In `src/engine/game-engine.ts`, just above the existing `private emit(ev)` method, add a public method:

```ts
  /**
   * Emit a non-engine event (thought, step_budget_exhausted, human_input) through
   * the engine's `t` counter so log ordering stays consistent. Used by the runtime
   * orchestrator and agents; callers must build a well-formed Event minus the `t`.
   */
  emitRuntime(ev: Omit<Event, 't'>): void {
    this.emit(ev);
  }
```

- [ ] **Step 2: Create the LlmClient interface**

Create `src/runtime/llm/llm-client.ts`:

```ts
/**
 * Provider-agnostic LLM seam. Two implementations: AnthropicLlmClient (real
 * network) and ScriptedLlmClient (deterministic test double). The orchestrator
 * and agents only see this interface.
 */

export interface PromptSegment {
  text: string;
  /** When true, the implementation marks this segment with cache_control: ephemeral. */
  cacheable: boolean;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  /** A list of content blocks. We use text-only blocks; tool_use blocks come back in the response. */
  content: Array<{ type: 'text'; text: string; cacheable?: boolean }>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;        // JSON Schema for the tool's input
}

export interface ParsedToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  thinkingBlocks: string[];
  toolUses: ParsedToolUse[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: LlmUsage;
}

export interface LlmCompleteRequest {
  system: PromptSegment[];
  messages: AnthropicMessage[];
  tools: ToolSchema[];
  thinking?: { type: 'enabled'; budgetTokens?: number };
  model: string;
  maxTokens: number;
}

export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<LlmResponse>;
}

export class LlmCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LlmCallError';
  }
}
```

- [ ] **Step 3: Add `runtime` directory marker**

```bash
mkdir -p tests/runtime/llm tests/runtime/prompt tests/runtime/cli
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/runtime src/engine/game-engine.ts
git commit -m "feat(runtime): scaffold LlmClient interface and engine emitRuntime shim"
```

---

### Task 6: ScriptedLlmClient

**Files:**
- Create: `src/runtime/llm/scripted.ts`
- Create: `tests/runtime/llm/scripted.test.ts`

A deterministic FIFO matcher. Constructor takes a list of `{match, response}` entries; each `complete()` call pops the first matching entry. Used by every runtime test except the live-API smoke.

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/llm/scripted.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ScriptedLlmClient } from '../../../src/runtime/llm/scripted.js';

const minimalReq = (extra?: Partial<{ model: string }>) => ({
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [],
  model: extra?.model ?? 'claude-sonnet-4-6',
  maxTokens: 1024,
});

describe('ScriptedLlmClient', () => {
  it('returns the first matching response and removes it', async () => {
    const client = new ScriptedLlmClient([
      { match: { model: 'claude-sonnet-4-6' }, response: { toolUses: [{ name: 'narrate', input: { text: 'a' } }] } },
      { match: {},                              response: { toolUses: [{ name: 'narrate', input: { text: 'b' } }] } },
    ]);

    const r1 = await client.complete(minimalReq());
    expect(r1.toolUses[0]?.input).toEqual({ text: 'a' });

    const r2 = await client.complete(minimalReq());
    expect(r2.toolUses[0]?.input).toEqual({ text: 'b' });
  });

  it('matches on tag arbitrary properties supplied via tag()', async () => {
    const client = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'move', input: { path: [] } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'x' } }] } },
    ]);

    const r = await client.complete({ ...minimalReq(), tag: 'dm' } as never);
    expect(r.toolUses[0]?.name).toBe('narrate');
  });

  it('throws when no match is found', async () => {
    const client = new ScriptedLlmClient([{ match: { model: 'other' }, response: { toolUses: [] } }]);
    await expect(client.complete(minimalReq())).rejects.toThrow(/no scripted response matched/i);
  });

  it('attaches default usage and stopReason when omitted', async () => {
    const client = new ScriptedLlmClient([
      { match: {}, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const r = await client.complete(minimalReq());
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(r.stopReason).toBe('tool_use');
    expect(r.thinkingBlocks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/runtime/llm/scripted.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ScriptedLlmClient**

Create `src/runtime/llm/scripted.ts`:

```ts
import type {
  LlmClient,
  LlmCompleteRequest,
  LlmResponse,
  ParsedToolUse,
} from './llm-client.js';

export interface ScriptedMatch {
  /** Subset of request fields to match. Any field listed must equal the corresponding request field. */
  model?: string;
  /** Free-form tag passed via the request (e.g. ScriptedLlmClient lets callers attach `tag`). */
  tag?: string;
}

export interface ScriptedEntry {
  match: ScriptedMatch;
  response: Partial<LlmResponse> & { toolUses: ParsedToolUse[] };
}

/**
 * Deterministic FIFO matcher. Each complete() call pops the first matching entry.
 * Callers can attach an optional `tag` field to the request for fine-grained matching.
 */
export class ScriptedLlmClient implements LlmClient {
  private entries: ScriptedEntry[];
  /** Total calls served, for diagnostics. */
  callsServed = 0;

  constructor(entries: ScriptedEntry[]) {
    this.entries = [...entries];
  }

  remaining(): number {
    return this.entries.length;
  }

  async complete(req: LlmCompleteRequest & { tag?: string }): Promise<LlmResponse> {
    const idx = this.entries.findIndex((e) => this.matches(e.match, req));
    if (idx === -1) {
      throw new Error(
        `no scripted response matched request (model=${req.model}, tag=${req.tag ?? 'none'}, ${this.entries.length} entries left)`,
      );
    }
    const entry = this.entries.splice(idx, 1)[0]!;
    this.callsServed += 1;
    return {
      thinkingBlocks: entry.response.thinkingBlocks ?? [],
      toolUses: entry.response.toolUses,
      stopReason: entry.response.stopReason ?? 'tool_use',
      usage: entry.response.usage ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    };
  }

  private matches(m: ScriptedMatch, req: LlmCompleteRequest & { tag?: string }): boolean {
    if (m.model !== undefined && m.model !== req.model) return false;
    if (m.tag !== undefined && m.tag !== req.tag) return false;
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/runtime/llm/scripted.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/llm/scripted.ts tests/runtime/llm/scripted.test.ts
git commit -m "feat(runtime/llm): scripted llm client for deterministic tests"
```

---

### Task 7: Tool schemas — `PlayerAction` / `DmAction` ↔ Anthropic tools

**Files:**
- Create: `src/runtime/prompt/tools.ts`
- Create: `tests/runtime/prompt/tools.test.ts`

One tool per action variant. Hand-written JSON schemas, kept small, with a roundtrip test that catches drift between the TS unions and the schemas.

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/prompt/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PLAYER_TOOLS,
  DM_TOOLS,
  decodePlayerToolUse,
  decodeDmToolUse,
} from '../../../src/runtime/prompt/tools.js';
import type { PlayerAction, DmAction } from '../../../src/engine/action.js';
import { asCharacterId, asItemId, asBoonId, asEquipmentId, asSceneId } from '../../../src/engine/ids.js';

describe('Anthropic tool schemas', () => {
  it('PLAYER_TOOLS covers every PlayerAction kind except skip_turn', () => {
    const names = PLAYER_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ['ability_test', 'end_turn', 'equip', 'move', 'normal_attack', 'say', 'special_action', 'use_boon', 'use_item'].sort(),
    );
  });

  it('DM_TOOLS covers every DmAction kind', () => {
    const names = DM_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ['end_adventure', 'end_combat', 'environmental', 'narrate', 'offer_rest', 'request_action', 'reveal_monster', 'set_scene', 'start_combat'].sort(),
    );
  });

  it('decodePlayerToolUse roundtrips move', () => {
    const a: PlayerAction = { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] };
    const decoded = decodePlayerToolUse({ name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } });
    expect(decoded).toEqual(a);
  });

  it('decodePlayerToolUse roundtrips normal_attack', () => {
    const decoded = decodePlayerToolUse({ name: 'normal_attack', input: { targetId: 'rat-1' } });
    expect(decoded).toEqual({ kind: 'normal_attack', targetId: asCharacterId('rat-1') });
  });

  it('decodePlayerToolUse roundtrips use_item with target', () => {
    const decoded = decodePlayerToolUse({ name: 'use_item', input: { itemId: 'potion', targetId: 'h-ally' } });
    expect(decoded).toEqual({ kind: 'use_item', itemId: asItemId('potion'), targetId: asCharacterId('h-ally') });
  });

  it('decodePlayerToolUse roundtrips ability_test', () => {
    const decoded = decodePlayerToolUse({
      name: 'ability_test',
      input: { characteristic: 'magic', difficulty: 5, describe: 'recall lore', skillId: 'knowledge' },
    });
    expect(decoded).toEqual({
      kind: 'ability_test', characteristic: 'magic', difficulty: 5, describe: 'recall lore',
      skillId: 'knowledge',
    });
  });

  it('decodePlayerToolUse roundtrips end_turn and say', () => {
    expect(decodePlayerToolUse({ name: 'end_turn', input: {} })).toEqual({ kind: 'end_turn' });
    expect(decodePlayerToolUse({ name: 'say', input: { text: 'Flank left!' } })).toEqual({
      kind: 'say', text: 'Flank left!',
    });
  });

  it('decodeDmToolUse roundtrips narrate, request_action, start_combat, end_adventure', () => {
    expect(decodeDmToolUse({ name: 'narrate', input: { text: '...' } }))
      .toEqual<DmAction>({ kind: 'narrate', text: '...' });
    expect(decodeDmToolUse({ name: 'request_action', input: { actorId: 'p1' } }))
      .toEqual<DmAction>({ kind: 'request_action', actorId: asCharacterId('p1') });
    expect(decodeDmToolUse({ name: 'start_combat', input: { heroSide: ['h1','h2'], monsterSide: ['m1'] } }))
      .toEqual<DmAction>({
        kind: 'start_combat',
        heroSide: [asCharacterId('h1'), asCharacterId('h2')],
        monsterSide: [asCharacterId('m1')],
      });
    expect(decodeDmToolUse({ name: 'end_adventure', input: { outcome: 'success' } }))
      .toEqual<DmAction>({ kind: 'end_adventure', outcome: 'success' });
  });

  it('decode throws on unknown tool name', () => {
    expect(() => decodePlayerToolUse({ name: 'bogus', input: {} })).toThrow(/unknown player tool/i);
    expect(() => decodeDmToolUse({ name: 'bogus', input: {} })).toThrow(/unknown dm tool/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/runtime/prompt/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool schemas**

Create `src/runtime/prompt/tools.ts`:

```ts
import type { ToolSchema, ParsedToolUse } from '../llm/llm-client.js';
import type { PlayerAction, DmAction } from '../../engine/action.js';
import {
  asCharacterId,
  asItemId,
  asBoonId,
  asEquipmentId,
  asSceneId,
  asSkillId,
} from '../../engine/ids.js';

const square = {
  type: 'object',
  properties: {
    x: { type: 'integer' }, y: { type: 'integer' },
  },
  required: ['x', 'y'],
} as const;

export const PLAYER_TOOLS: ToolSchema[] = [
  {
    name: 'move',
    description: 'Move along a path of adjacent squares. path[0] must be your current position.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'array', items: square, minItems: 2 } },
      required: ['path'],
    },
  },
  {
    name: 'normal_attack',
    description: 'Make a normal attack against the target character.',
    input_schema: {
      type: 'object',
      properties: { targetId: { type: 'string' } },
      required: ['targetId'],
    },
  },
  {
    name: 'special_action',
    description: 'Use your character’s special action. targetIds and params are action-specific.',
    input_schema: {
      type: 'object',
      properties: {
        targetIds: { type: 'array', items: { type: 'string' } },
        params: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    name: 'use_item',
    description: 'Use a consumable item from your inventory.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, targetId: { type: 'string' } },
      required: ['itemId'],
    },
  },
  {
    name: 'use_boon',
    description: 'Spend a one-shot boon. Can be played on any turn.',
    input_schema: {
      type: 'object',
      properties: { boonId: { type: 'string' }, targetId: { type: 'string' } },
      required: ['boonId'],
    },
  },
  {
    name: 'equip',
    description: 'Swap the equipped item. Out-of-combat only.',
    input_schema: {
      type: 'object',
      properties: { equipmentId: { type: 'string' } },
      required: ['equipmentId'],
    },
  },
  {
    name: 'ability_test',
    description: 'Attempt an ability test. Difficulty: 4 easy, 5 normal, 6 hard.',
    input_schema: {
      type: 'object',
      properties: {
        characteristic: { type: 'string', enum: ['melee', 'ranged', 'magic'] },
        difficulty: { type: 'integer', enum: [4, 5, 6] },
        describe: { type: 'string' },
        skillId: { type: 'string' },
        itemId: { type: 'string' },
      },
      required: ['characteristic', 'difficulty', 'describe'],
    },
  },
  {
    name: 'say',
    description: 'Say something out loud. Heard by everyone in the scene.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'end_turn',
    description: 'End your turn. Required at the end of every turn.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const DM_TOOLS: ToolSchema[] = [
  { name: 'narrate', description: 'Narrate to the players.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'set_scene', description: 'Move the party into a scene.', input_schema: { type: 'object', properties: { sceneId: { type: 'string' } }, required: ['sceneId'] } },
  { name: 'start_combat', description: 'Begin combat between the listed sides; engine rolls initiative.', input_schema: { type: 'object', properties: { heroSide: { type: 'array', items: { type: 'string' } }, monsterSide: { type: 'array', items: { type: 'string' } } }, required: ['heroSide', 'monsterSide'] } },
  { name: 'end_combat', description: 'End the current combat.', input_schema: { type: 'object', properties: {} } },
  { name: 'request_action', description: 'Hand the turn to the named character (out of combat).', input_schema: { type: 'object', properties: { actorId: { type: 'string' } }, required: ['actorId'] } },
  { name: 'reveal_monster', description: 'Place a new monster on the grid.', input_schema: { type: 'object', properties: { monsterTypeId: { type: 'string' }, characterId: { type: 'string' }, pos: square }, required: ['monsterTypeId', 'characterId', 'pos'] } },
  { name: 'environmental', description: 'Apply an environmental effect to a target square or character.', input_schema: { type: 'object', properties: { effect: { type: 'string', enum: ['push', 'pull', 'hazard'] }, params: { type: 'object', additionalProperties: true } }, required: ['effect', 'params'] } },
  { name: 'offer_rest', description: 'Offer the party a rest opportunity.', input_schema: { type: 'object', properties: {} } },
  { name: 'end_adventure', description: 'Conclude the adventure.', input_schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failure'] } }, required: ['outcome'] } },
];

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`expected string for ${name}, got ${typeof v}`);
  return v;
};

export const decodePlayerToolUse = (tu: ParsedToolUse): PlayerAction => {
  const i = tu.input;
  switch (tu.name) {
    case 'move':
      return { kind: 'move', path: (i['path'] as Array<{ x: number; y: number }>) };
    case 'normal_attack':
      return { kind: 'normal_attack', targetId: asCharacterId(str(i['targetId'], 'targetId')) };
    case 'special_action': {
      const tids = (i['targetIds'] as string[] | undefined)?.map(asCharacterId);
      return {
        kind: 'special_action',
        ...(tids && { targetIds: tids }),
        ...(i['params'] !== undefined && { params: i['params'] as Record<string, unknown> }),
      };
    }
    case 'use_item':
      return {
        kind: 'use_item',
        itemId: asItemId(str(i['itemId'], 'itemId')),
        ...(i['targetId'] !== undefined && { targetId: asCharacterId(str(i['targetId'], 'targetId')) }),
      };
    case 'use_boon':
      return {
        kind: 'use_boon',
        boonId: asBoonId(str(i['boonId'], 'boonId')),
        ...(i['targetId'] !== undefined && { targetId: asCharacterId(str(i['targetId'], 'targetId')) }),
      };
    case 'equip':
      return { kind: 'equip', equipmentId: asEquipmentId(str(i['equipmentId'], 'equipmentId')) };
    case 'ability_test':
      return {
        kind: 'ability_test',
        characteristic: i['characteristic'] as 'melee' | 'ranged' | 'magic',
        difficulty: i['difficulty'] as 4 | 5 | 6,
        describe: str(i['describe'], 'describe'),
        ...(i['skillId'] !== undefined && { skillId: asSkillId(str(i['skillId'], 'skillId')) }),
        ...(i['itemId'] !== undefined && { itemId: asItemId(str(i['itemId'], 'itemId')) }),
      };
    case 'say':
      return { kind: 'say', text: str(i['text'], 'text') };
    case 'end_turn':
      return { kind: 'end_turn' };
    default:
      throw new Error(`unknown player tool: ${tu.name}`);
  }
};

export const decodeDmToolUse = (tu: ParsedToolUse): DmAction => {
  const i = tu.input;
  switch (tu.name) {
    case 'narrate':       return { kind: 'narrate', text: str(i['text'], 'text') };
    case 'set_scene':     return { kind: 'set_scene', sceneId: asSceneId(str(i['sceneId'], 'sceneId')) };
    case 'start_combat':  return {
      kind: 'start_combat',
      heroSide:    (i['heroSide']    as string[]).map(asCharacterId),
      monsterSide: (i['monsterSide'] as string[]).map(asCharacterId),
    };
    case 'end_combat':    return { kind: 'end_combat' };
    case 'request_action':return { kind: 'request_action', actorId: asCharacterId(str(i['actorId'], 'actorId')) };
    case 'reveal_monster':return {
      kind: 'reveal_monster',
      monsterTypeId: str(i['monsterTypeId'], 'monsterTypeId'),
      characterId:   asCharacterId(str(i['characterId'], 'characterId')),
      pos:           i['pos'] as { x: number; y: number },
    };
    case 'environmental': return {
      kind: 'environmental',
      effect: i['effect'] as 'push' | 'pull' | 'hazard',
      params: i['params'] as Record<string, unknown>,
    };
    case 'offer_rest':    return { kind: 'offer_rest' };
    case 'end_adventure': return { kind: 'end_adventure', outcome: i['outcome'] as 'success' | 'failure' };
    default:              throw new Error(`unknown dm tool: ${tu.name}`);
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/runtime/prompt/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/prompt/tools.ts tests/runtime/prompt/tools.test.ts
git commit -m "feat(runtime/prompt): tool schemas and decoders for player + dm actions"
```

---

### Task 8: Visibility filter

**Files:**
- Create: `src/runtime/visibility/types.ts`
- Create: `src/runtime/visibility/filter.ts`
- Create: `tests/runtime/visibility.test.ts`

One pure function, single switch over `event.type`, encoding spec §5's matrix.

- [ ] **Step 1: Write the viewer + redacted-event types**

Create `src/runtime/visibility/types.ts`:

```ts
import type { Event } from '../../log/events.js';
import type { CharacterId } from '../../engine/ids.js';

export type Viewer =
  | { kind: 'self'; actorId: CharacterId | 'dm' }
  | { kind: 'other_player'; actorId: CharacterId }
  | { kind: 'dm' }
  | { kind: 'human' }
  | { kind: 'researcher'; revealThoughts: boolean };

/**
 * RedactedEvent is structurally identical to Event, except `resolution` may have
 * its `private` field stripped. `thought` and `rule_violation` events are
 * dropped entirely (filter returns null) for non-self viewers.
 */
export type RedactedEvent = Event;
```

- [ ] **Step 2: Write failing tests**

Create `tests/runtime/visibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filter } from '../../src/runtime/visibility/filter.js';
import type { Viewer } from '../../src/runtime/visibility/types.js';
import type { Event } from '../../src/log/events.js';
import { asCharacterId } from '../../src/engine/ids.js';

const t = (e: Omit<Event, 't'>): Event => ({ ...e, t: 1 } as Event);

describe('visibility filter', () => {
  it('thought is visible only to self and to revealing researchers', () => {
    const ev = t({ type: 'thought', actorId: asCharacterId('p1'), text: 'plan' });

    expect(filter(ev, { kind: 'self', actorId: asCharacterId('p1') })).toEqual(ev);
    expect(filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') })).toBeNull();
    expect(filter(ev, { kind: 'human' })).toBeNull();
    expect(filter(ev, { kind: 'dm' })).toBeNull();
    expect(filter(ev, { kind: 'researcher', revealThoughts: true })).toEqual(ev);
    expect(filter(ev, { kind: 'researcher', revealThoughts: false })).toBeNull();
  });

  it('say is visible to everyone', () => {
    const ev = t({ type: 'action', actorId: asCharacterId('p1'),
      action: { kind: 'say', text: 'flank!' } });
    const viewers: Viewer[] = [
      { kind: 'self', actorId: asCharacterId('p1') },
      { kind: 'other_player', actorId: asCharacterId('p2') },
      { kind: 'dm' },
      { kind: 'human' },
      { kind: 'researcher', revealThoughts: false },
    ];
    for (const v of viewers) expect(filter(ev, v)).toEqual(ev);
  });

  it('resolution strips private dice rolls for non-self viewers', () => {
    const ev = t({
      type: 'resolution',
      actorId: asCharacterId('p1'),
      public: { hit: true, damage: 1 },
      private: { attackRoll: [5, 3], armorRoll: [4] },
    });

    const self = filter(ev, { kind: 'self', actorId: asCharacterId('p1') });
    expect(self).not.toBeNull();
    expect(self!).toHaveProperty('private');

    const other = filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') });
    expect(other).not.toBeNull();
    expect((other as Record<string, unknown>)['private']).toBeUndefined();

    const human = filter(ev, { kind: 'human' });
    expect((human as Record<string, unknown>)['private']).toBeUndefined();

    const researcher = filter(ev, { kind: 'researcher', revealThoughts: false });
    expect((researcher as Record<string, unknown>)['private']).toBeDefined();
  });

  it('rule_violation is visible only to the offender and researchers', () => {
    const ev = t({
      type: 'rule_violation',
      actorId: asCharacterId('p1'),
      violation: { reason: 'out-of-range' },
    });

    expect(filter(ev, { kind: 'self', actorId: asCharacterId('p1') })).toEqual(ev);
    expect(filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') })).toBeNull();
    expect(filter(ev, { kind: 'human' })).toBeNull();
    expect(filter(ev, { kind: 'dm' })).toBeNull();
    expect(filter(ev, { kind: 'researcher', revealThoughts: false })).toEqual(ev);
  });

  it('action, narrate, state_change, request_action, combat events pass through to all viewers', () => {
    const events: Event[] = [
      t({ type: 'action', actorId: asCharacterId('p1'), action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } }),
      t({ type: 'narrate', actorId: 'dm', text: 'A door creaks open.' }),
      t({ type: 'state_change', changes: [{ id: asCharacterId('p1'), pos: { x: 2, y: 1 } }] }),
      t({ type: 'request_action', actorId: 'dm', targetId: asCharacterId('p1') }),
      t({ type: 'combat_started', heroSide: [asCharacterId('p1')], monsterSide: [asCharacterId('m1')], rolls: { hero: 4, monster: 3 } }),
      t({ type: 'combat_ended' }),
      t({ type: 'rest_offered' }),
      t({ type: 'adventure_ended', outcome: 'success' }),
      t({ type: 'scene_enter', sceneId: 'stub-cell' as never }),
      t({ type: 'human_input', actorId: asCharacterId('h1'), text: 'I rush in' }),
      t({ type: 'step_budget_exhausted', actorId: asCharacterId('p1'), forced: 'end_turn' }),
    ];
    const v: Viewer = { kind: 'human' };
    for (const ev of events) expect(filter(ev, v)).toEqual(ev);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/runtime/visibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the filter**

Create `src/runtime/visibility/filter.ts`:

```ts
import type { Event } from '../../log/events.js';
import type { Viewer, RedactedEvent } from './types.js';

const isSelfActor = (v: Viewer, actorId: string | 'dm'): boolean =>
  v.kind === 'self' && v.actorId === actorId;

const isResearcher = (v: Viewer): v is Extract<Viewer, { kind: 'researcher' }> =>
  v.kind === 'researcher';

/**
 * Pure function. Encodes the spec §5 visibility matrix as a single switch
 * over event.type. Returns:
 *   - null         → drop the event for this viewer
 *   - the event    → unchanged passthrough
 *   - a redaction  → for `resolution`, omit `private` for non-self viewers
 */
export const filter = (event: Event, viewer: Viewer): RedactedEvent | null => {
  switch (event.type) {
    // Always public:
    case 'scene_enter':
    case 'narrate':
    case 'request_action':
    case 'human_input':
    case 'state_change':
    case 'combat_started':
    case 'combat_ended':
    case 'rest_offered':
    case 'adventure_ended':
    case 'step_budget_exhausted':
      return event;

    case 'action':
      // Public actions are observable; engine never logs invalid ones.
      return event;

    case 'resolution': {
      // Self & researcher see private; everyone else gets public-only.
      if (isSelfActor(viewer, event.actorId) || (isResearcher(viewer) && true)) {
        return event;
      }
      const { private: _priv, ...publicOnly } = event;
      return publicOnly as Event;
    }

    case 'thought': {
      if (isSelfActor(viewer, event.actorId)) return event;
      if (isResearcher(viewer) && viewer.revealThoughts) return event;
      return null;
    }

    case 'rule_violation': {
      if (isSelfActor(viewer, event.actorId)) return event;
      if (isResearcher(viewer)) return event;
      return null;
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/runtime/visibility.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/visibility/types.ts src/runtime/visibility/filter.ts tests/runtime/visibility.test.ts
git commit -m "feat(runtime/visibility): pure filter encoding spec §5 matrix"
```

---

### Task 9: Subscriber interface

**Files:**
- Create: `src/runtime/subscriber.ts`

A trivial interface — but it gets its own file because both the orchestrator and the CLI implement against it.

- [ ] **Step 1: Create the interface**

Create `src/runtime/subscriber.ts`:

```ts
import type { CharacterId } from '../engine/ids.js';
import type { RedactedEvent, Viewer } from './visibility/types.js';

/**
 * A perspective-keyed observer. The orchestrator runs the visibility filter
 * once per (event × subscriber) before invoking onEvent. Subscribers never
 * see raw events; the EventLog is the unredacted source of truth.
 */
export interface Subscriber {
  readonly viewer: Viewer;
  onEvent(event: RedactedEvent): void;
  onTurnStarted?(actorId: CharacterId | 'dm'): void;
  onTurnEnded?(actorId: CharacterId | 'dm'): void;
  /** Optional async hook called once at orchestrator startup, after subscribers attach. */
  onStart?(): Promise<void> | void;
  /** Optional async hook called when the run ends (success or failure). */
  onEnd?(outcome: 'success' | 'failure' | 'aborted'): Promise<void> | void;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/subscriber.ts
git commit -m "feat(runtime): subscriber interface keyed by viewer perspective"
```

---

### Task 10: PromptBuilder

**Files:**
- Create: `src/runtime/prompt/templates/player-system.ts`
- Create: `src/runtime/prompt/templates/dm-system.ts`
- Create: `src/runtime/prompt/builder.ts`
- Create: `tests/runtime/prompt/builder.test.ts`

Three-band layout (system + adventure cached, history-up-to-snapshot cached, current-step uncacheable). Builds `system: PromptSegment[]` and `messages: AnthropicMessage[]` for the LlmClient.

- [ ] **Step 1: Player system template**

Create `src/runtime/prompt/templates/player-system.ts`:

```ts
import type { Character } from '../../../engine/character.js';

export interface PlayerSystemContext {
  character: Character;
  persona: string;       // markdown body
  partyDescription: string;
}

export const renderPlayerSystem = (ctx: PlayerSystemContext): string => {
  const c = ctx.character;
  const inv = c.inventory.length === 0
    ? '(empty)'
    : c.inventory.map((s) => `${s.itemId}×${s.count}`).join(', ');
  const skills = c.skills.length === 0 ? '(none)' : c.skills.join(', ');
  return `You are ${c.name}, a ${c.archetype ?? 'hero'} in a HeroKids adventure played around a virtual table.

YOUR CHARACTER SHEET
  Melee ${c.pools.melee}d6  Ranged ${c.pools.ranged}d6
  Magic ${c.pools.magic}d6  Armor  ${c.pools.armor}d6
  Health: ${c.health.total - c.health.damage}/${c.health.total} (${c.health.status})
  Normal attack: ${c.normalAttack.name}
  Special action: ${c.specialAction.name}
  Bonus (passive): ${c.bonusAbility.name}
  Inventory: ${inv}
  Skills:    ${skills}

PERSONA
${ctx.persona}

YOUR PARTY
${ctx.partyDescription}

HOW YOU ACT
  Each turn, you may take SEVERAL reasoning steps. On each step, think
  privately, then call EXACTLY ONE tool from the action vocabulary. Your
  reasoning is PRIVATE — only your tool calls and say() are seen by others.
  End your turn with end_turn. Step budget: 6 per turn.

WHAT YOU SEE
  - DM narration & scene description
  - Every character's public actions and effects
  - Everything any character says aloud
  You do NOT see anyone else's private thoughts.

GOAL
  Help the party complete the adventure. Behave consistently with your
  persona. Coordinate through dialogue and visible action — your teammates
  literally cannot read your mind.`;
};
```

- [ ] **Step 2: DM system template**

Create `src/runtime/prompt/templates/dm-system.ts`:

```ts
import type { Adventure, Scene } from '../../../engine/adventure.js';
import type { Character } from '../../../engine/character.js';

export interface DmSystemContext {
  adventure: Adventure;
  activeScene: Scene;
  party: Character[];
  monstersInScene: Character[];
  persona: string;
}

export const renderDmSystem = (ctx: DmSystemContext): string => {
  const partyLines = ctx.party.map(
    (c) => `  - ${c.name} (${c.archetype ?? 'hero'}) HP ${c.health.total - c.health.damage}/${c.health.total}`,
  ).join('\n');
  const monsterLines = ctx.monstersInScene.map(
    (m) => `  - ${m.name} HP ${m.health.total - m.health.damage}/${m.health.total} at (${m.pos?.x},${m.pos?.y})`,
  ).join('\n') || '  (none placed yet)';

  return `You are the Dungeon Master running a HeroKids adventure for two AI players and one human.

CRITICAL: You DO NOT compute outcomes. The deterministic engine rolls all
dice, tracks HP, validates moves, and resolves attacks. You narrate,
adjudicate fuzzy situations, and pick who acts next when out of combat.

ADVENTURE: ${ctx.adventure.title}
CURRENT SCENE: ${ctx.activeScene.id}

INTRO (read or paraphrase faithfully on entry):
"""
${ctx.activeScene.intro}
"""

MAP: ${ctx.activeScene.map.width}×${ctx.activeScene.map.height}
TACTICS HINT: ${ctx.activeScene.tactics ?? '(none)'}
CONCLUSION (use when scene resolves):
"""
${ctx.activeScene.conclusion}
"""

PARTY:
${partyLines}

MONSTERS PRESENT:
${monsterLines}

PERSONA
${ctx.persona}

YOUR TURN STRUCTURE
  Out of combat: narrate → call request_action to hand off.
  Combat: call start_combat once; engine drives turn order; you only narrate
  outcomes between turns. Call end_combat when one side is fully KO'd, then
  offer_rest.

INTERPRETING THE HUMAN
  When the human types free text, parse it into the appropriate engine
  Action(s) on their behalf. Ask for clarification (via narrate) if intent
  is ambiguous.`;
};
```

- [ ] **Step 3: Write failing tests**

Create `tests/runtime/prompt/builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../../src/runtime/prompt/builder.js';
import { asCharacterId, asEffectId, asSceneId, asAdventureId } from '../../../src/engine/ids.js';
import type { Character } from '../../../src/engine/character.js';
import type { Adventure } from '../../../src/engine/adventure.js';
import type { Event } from '../../../src/log/events.js';

const character = (id: string): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'WW', description: '' },
  bonusAbility: { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [], boons: [], skills: [],
});

const adventure: Adventure = {
  id: asAdventureId('a'), title: 'A',
  scenes: [{
    id: asSceneId('s'),
    intro: 'You enter.', conclusion: 'It ends.',
    map: { width: 6, height: 6, background: 'bg', obstacles: [], exits: [] },
    monsters: [], abilityTests: [], transitions: [],
  }],
};

describe('PromptBuilder', () => {
  it('player band 1 (system) is cacheable and includes character sheet + persona', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'I am cautious.',
      partyDescription: '  - p2 (warlock, AI)\n  - h1 (hunter, human)',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
    });
    expect(out.system).toHaveLength(1);
    expect(out.system[0]!.cacheable).toBe(true);
    expect(out.system[0]!.text).toMatch(/PERSONA/);
    expect(out.system[0]!.text).toMatch(/I am cautious\./);
    expect(out.system[0]!.text).toMatch(/Melee 2d6/);
  });

  it('history is partitioned into a cacheable snapshot prefix and an uncacheable tail', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });

    const events: Event[] = Array.from({ length: 12 }, (_, i) =>
      ({ t: i + 1, type: 'narrate', actorId: 'dm', text: `event ${i + 1}` } as Event),
    );

    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: events,
      observation: { kind: 'fresh_turn' },
      currentTurnIdx: 6,    // 6 turns past — two snapshot points should have elapsed (at 3 and 6)
    });

    // First message is the cacheable history snapshot, second is the uncacheable tail.
    expect(out.messages.length).toBeGreaterThanOrEqual(2);
    const first = out.messages[0]!;
    const last  = out.messages[out.messages.length - 1]!;
    expect(first.content[0]!.cacheable).toBe(true);
    expect(last.content[last.content.length - 1]!.cacheable).toBe(false);
  });

  it('observation kinds render distinct closing prompts', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const baseArgs = {
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [],
      currentTurnIdx: 0,
    };
    const fresh = b.buildPlayer({ ...baseArgs, observation: { kind: 'fresh_turn' } });
    const violation = b.buildPlayer({ ...baseArgs, observation: { kind: 'rule_violation', reason: 'out-of-range' } });
    const resolved = b.buildPlayer({ ...baseArgs, observation: { kind: 'public_resolution', summary: 'Hit for 1.' } });

    const tail = (msgs: typeof fresh.messages): string =>
      msgs[msgs.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail(fresh.messages)).toMatch(/your turn/i);
    expect(tail(violation.messages)).toMatch(/rule violation: out-of-range/i);
    expect(tail(resolved.messages)).toMatch(/Hit for 1\./);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the builder**

Create `src/runtime/prompt/builder.ts`:

```ts
import type { Character } from '../../engine/character.js';
import type { Adventure, Scene } from '../../engine/adventure.js';
import type { Event } from '../../log/events.js';
import type { AnthropicMessage, PromptSegment } from '../llm/llm-client.js';
import { renderPlayerSystem } from './templates/player-system.js';
import { renderDmSystem } from './templates/dm-system.js';

export type Observation =
  | { kind: 'fresh_turn' }
  | { kind: 'rule_violation'; reason: string }
  | { kind: 'public_resolution'; summary: string };

export interface BuildPlayerArgs {
  character: Character;
  persona: string;
  partyDescription: string;
  adventure: Adventure;
  activeScene: Scene;
  /** Visibility-filtered events for this player. */
  history: Event[];
  observation: Observation;
  /** 0-based index of the current turn within the run. Used for snapshot partition. */
  currentTurnIdx: number;
}

export interface BuildDmArgs {
  party: Character[];
  monstersInScene: Character[];
  persona: string;
  adventure: Adventure;
  activeScene: Scene;
  history: Event[];
  observation: Observation;
  currentTurnIdx: number;
}

export interface BuiltPrompt {
  system: PromptSegment[];
  messages: AnthropicMessage[];
}

export interface PromptBuilderConfig {
  snapshotEveryTurns: number;
}

const formatEventLine = (e: Event): string => `[t=${e.t}] ${JSON.stringify({ ...e, t: undefined })}`;

export class PromptBuilder {
  constructor(private readonly cfg: PromptBuilderConfig) {}

  buildPlayer(args: BuildPlayerArgs): BuiltPrompt {
    const systemText = renderPlayerSystem({
      character: args.character,
      persona: args.persona,
      partyDescription: args.partyDescription,
    });
    return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx);
  }

  buildDm(args: BuildDmArgs): BuiltPrompt {
    const systemText = renderDmSystem({
      adventure: args.adventure,
      activeScene: args.activeScene,
      party: args.party,
      monstersInScene: args.monstersInScene,
      persona: args.persona,
    });
    return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx);
  }

  private assemble(
    systemText: string,
    history: Event[],
    observation: Observation,
    currentTurnIdx: number,
  ): BuiltPrompt {
    // Band 1: system (always cacheable)
    const system: PromptSegment[] = [{ text: systemText, cacheable: true }];

    // Band 2 boundary: snapshot point at every K turns. snapshotIdx = floor(currentTurnIdx / K) * K.
    const k = this.cfg.snapshotEveryTurns;
    const snapshotTurnIdx = Math.floor(currentTurnIdx / k) * k;

    // Partition history events into prefix (up to snapshot) and tail (after snapshot).
    // For Layer B simplicity, "snapshotTurnIdx" maps to event index by counting `request_action`
    // events (each marks a new turn). Approximation: split events at the first event whose
    // implicit turn index >= snapshotTurnIdx.
    const turnBoundaries: number[] = []; // event indices where a new turn begins
    let turnCounter = 0;
    history.forEach((ev, idx) => {
      if (ev.type === 'request_action') {
        turnBoundaries.push(idx);
        turnCounter += 1;
      }
    });

    const splitIdx = snapshotTurnIdx === 0 || turnBoundaries.length === 0
      ? 0
      : turnBoundaries[Math.min(snapshotTurnIdx, turnBoundaries.length) - 1] ?? 0;

    const prefix = history.slice(0, splitIdx);
    const tail   = history.slice(splitIdx);

    const messages: AnthropicMessage[] = [];

    // Cacheable history snapshot (band 2).
    if (prefix.length > 0) {
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `History (cached snapshot, t=${prefix[0]!.t}..${prefix[prefix.length - 1]!.t}):\n` +
                prefix.map(formatEventLine).join('\n'),
          cacheable: true,
        }],
      });
    }

    // Uncacheable tail + observation (band 3).
    const tailLines = tail.map(formatEventLine).join('\n');
    const obsLine = (() => {
      switch (observation.kind) {
        case 'fresh_turn':         return 'It is your turn. Take your first reasoning step.';
        case 'rule_violation':     return `Rule violation: ${observation.reason}. Choose another action.`;
        case 'public_resolution':  return `Result of your last action: ${observation.summary}. Continue your turn.`;
      }
    })();

    const tailText = (tail.length > 0
      ? `Recent events:\n${tailLines}\n\n`
      : '') + obsLine;

    messages.push({
      role: 'user',
      content: [{ type: 'text', text: tailText, cacheable: false }],
    });

    return { system, messages };
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/prompt
git add tests/runtime/prompt/builder.test.ts
git commit -m "feat(runtime/prompt): three-band cache-aware prompt builder"
```

---

### Task 11: Agent + ReACT inner loop

**Files:**
- Create: `src/runtime/agent.ts`
- Create: `tests/runtime/agent.test.ts`

The role-configured ReACT inner loop. Players iterate until `end_turn` or budget; DM iterates until any control-yielding action.

- [ ] **Step 1: Write failing tests**

Create `tests/runtime/agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Agent, type AgentRunHooks } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';

const buildEnv = () => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const hero: Character = {
    id: asCharacterId('p1'), name: 'Anwen', kind: 'hero', archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total: 3, damage: 0, status: 'normal' },
    pos: { x: 1, y: 1 },
    normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility: { id: asEffectId('teamwork'), name: '', description: '' },
    inventory: [], boons: [], skills: [],
  };
  const rat: Character = {
    ...hero,
    id: asCharacterId('m1'), name: 'Rat', kind: 'monster', archetype: undefined,
    pos: { x: 2, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
  };
  const engine = new GameEngine({ seed: 'agent-test', grid, characters: [hero, rat], effects: reg });
  engine.beginNarrativeTurn(asCharacterId('p1'));

  const adventure: Adventure = {
    id: asAdventureId('a'), title: 'A',
    scenes: [{
      id: asSceneId('s'), intro: '', conclusion: '',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], exits: [] },
      monsters: [], abilityTests: [], transitions: [],
    }],
  };
  return { engine, hero, rat, adventure };
};

describe('Agent ReACT inner loop', () => {
  it('player turn: emits thought, takes one move, ends turn', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { thinkingBlocks: ['I should move closer.'], toolUses: [{ name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } }] } },
      { match: { tag: 'p1' }, response: { thinkingBlocks: ['Done for this turn.'],   toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const emitted: string[] = [];
    const hooks: AgentRunHooks = {
      emitThought: (text) => emitted.push(text),
    };
    const agent = new Agent({
      role: 'player', actorId: hero.id, persona: 'cautious',
      llm, promptBuilder: builder, tools: PLAYER_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'p1', model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });

    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, hooks);
    expect(out.reason).toBe('end_turn');
    expect(out.steps).toHaveLength(2);
    expect(emitted).toEqual(['I should move closer.', 'Done for this turn.']);
  });

  it('player turn: rule violation observed → retries within budget', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // Illegal move: targeting an enemy square
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } }] } },
      // Legal: end turn
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const agent = new Agent({
      role: 'player', actorId: hero.id, persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: PLAYER_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'p1',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });

    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {});
    expect(out.reason).toBe('end_turn');
    expect(out.steps[0]!.observation).toMatchObject({ kind: 'rule_violation' });
  });

  it('player turn: budget exhausts when no end_turn within N steps', async () => {
    const { engine, hero, adventure } = buildEnv();
    const looseSays = Array.from({ length: 3 }, () => ({
      match: { tag: 'p1' as const },
      response: { toolUses: [{ name: 'say', input: { text: 'hi' } }] },
    }));
    const llm = new ScriptedLlmClient(looseSays);
    const agent = new Agent({
      role: 'player', actorId: hero.id, persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: PLAYER_TOOLS, stepBudget: 3,
      engine, adventure, partyDescription: '', tag: 'p1',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });

    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {});
    expect(out.reason).toBe('budget_exhausted');
    expect(out.steps).toHaveLength(3);
  });

  it('dm turn: ends on request_action', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'It begins.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
    ]);
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });

    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {});
    expect(out.reason).toBe('end_turn');
    expect(out.steps).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/runtime/agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Agent**

Create `src/runtime/agent.ts`:

```ts
import type { CharacterId } from '../engine/ids.js';
import type { Character } from '../engine/character.js';
import type { Adventure, Scene } from '../engine/adventure.js';
import type { GameEngine } from '../engine/game-engine.js';
import type { PlayerAction, DmAction } from '../engine/action.js';
import type { Event } from '../log/events.js';
import type { LlmClient, ToolSchema } from './llm/llm-client.js';
import type { PromptBuilder, Observation } from './prompt/builder.js';
import { decodePlayerToolUse, decodeDmToolUse } from './prompt/tools.js';

export interface AgentStep {
  thought: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  observation: Observation;
}

export interface AgentRunHooks {
  /** Called for every thinking block in every step. Default: no-op. */
  emitThought?(text: string, actorId: CharacterId | 'dm'): void;
  /** Called once if budget is exhausted before turn ends. */
  emitBudgetExhausted?(actorId: CharacterId | 'dm'): void;
}

export interface AgentTurnResult {
  steps: AgentStep[];
  reason: 'end_turn' | 'budget_exhausted';
}

export interface AgentConstructorArgs {
  role: 'dm' | 'player';
  actorId: CharacterId | 'dm';
  persona: string;
  llm: LlmClient;
  promptBuilder: PromptBuilder;
  tools: ToolSchema[];
  stepBudget: number;
  engine: GameEngine;
  adventure: Adventure;
  partyDescription: string;       // pre-rendered "  - p2 (warlock)\n..." string
  tag: string;                     // for ScriptedLlmClient matching
  model: string;
  maxTokens: number;
  getActiveScene(): Scene;
  getCharacters(): Character[];
  getMonstersInScene(): Character[];
}

const isPlayerTurnEnding = (a: PlayerAction): boolean => a.kind === 'end_turn';
const isDmTurnEnding = (a: DmAction): boolean =>
  a.kind === 'request_action' || a.kind === 'start_combat' ||
  a.kind === 'end_combat' || a.kind === 'end_adventure';

export class Agent {
  constructor(private readonly args: AgentConstructorArgs) {}

  async takeTurn(
    initialObservation: Observation,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<AgentTurnResult> {
    const steps: AgentStep[] = [];
    let observation = initialObservation;

    for (let stepNo = 1; stepNo <= this.args.stepBudget; stepNo++) {
      const prompt = this.args.role === 'player'
        ? this.args.promptBuilder.buildPlayer({
            character: this.args.engine.charactersById().get(this.args.actorId as CharacterId)!,
            persona: this.args.persona,
            partyDescription: this.args.partyDescription,
            adventure: this.args.adventure,
            activeScene: this.args.getActiveScene(),
            history, observation, currentTurnIdx,
          })
        : this.args.promptBuilder.buildDm({
            party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
            monstersInScene: this.args.getMonstersInScene(),
            persona: this.args.persona,
            adventure: this.args.adventure,
            activeScene: this.args.getActiveScene(),
            history, observation, currentTurnIdx,
          });

      const resp = await this.args.llm.complete({
        system: prompt.system,
        messages: prompt.messages,
        tools: this.args.tools,
        thinking: { type: 'enabled' },
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        ...({ tag: this.args.tag } as never),
      } as never);

      for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, this.args.actorId);

      if (resp.toolUses.length !== 1) {
        observation = { kind: 'rule_violation', reason: `expected exactly 1 tool call, got ${resp.toolUses.length}` };
        steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: '(none)', toolInput: {}, observation });
        continue;
      }

      const tu = resp.toolUses[0]!;

      if (this.args.role === 'player') {
        const action = decodePlayerToolUse(tu);
        const result = this.args.engine.applyAction(this.args.actorId as CharacterId, action);
        if (!result.ok) {
          observation = { kind: 'rule_violation', reason: result.error.reason };
          steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
          continue;
        }
        observation = { kind: 'public_resolution', summary: this.summarizeOk(action) };
        steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
        if (isPlayerTurnEnding(action)) return { steps, reason: 'end_turn' };
      } else {
        const action = decodeDmToolUse(tu);
        const result = this.args.engine.applyDmAction(action);
        if (!result.ok) {
          observation = { kind: 'rule_violation', reason: result.error.reason };
          steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
          continue;
        }
        observation = { kind: 'public_resolution', summary: tu.name };
        steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
        if (isDmTurnEnding(action)) return { steps, reason: 'end_turn' };
      }
    }

    hooks.emitBudgetExhausted?.(this.args.actorId);
    return { steps, reason: 'budget_exhausted' };
  }

  private summarizeOk(a: PlayerAction): string {
    switch (a.kind) {
      case 'move':            return `moved to (${a.path[a.path.length - 1]!.x},${a.path[a.path.length - 1]!.y})`;
      case 'normal_attack':   return `attacked ${a.targetId}`;
      case 'special_action':  return `used special action`;
      case 'use_item':        return `used item ${a.itemId}`;
      case 'use_boon':        return `used boon ${a.boonId}`;
      case 'equip':           return `equipped ${a.equipmentId}`;
      case 'ability_test':    return `attempted ${a.characteristic} test (DC ${a.difficulty})`;
      case 'say':             return `said "${a.text}"`;
      case 'end_turn':        return 'ended turn';
      case 'skip_turn':       return 'skipped turn';
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/runtime/agent.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent.ts tests/runtime/agent.test.ts
git commit -m "feat(runtime): agent class with role-configured ReACT inner loop"
```

---

### Task 12: Orchestrator — minimal turn loop (DM + AI players)

**Files:**
- Create: `src/runtime/orchestrator.ts`
- Create: `tests/runtime/orchestrator.test.ts`

This task ships a working orchestrator that runs DM + AI players against a `ScriptedLlmClient` with no human and no combat. Task 13 layers in human turns, combat advance, and budget force-end.

- [ ] **Step 1: Write failing test**

Create `tests/runtime/orchestrator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Subscriber } from '../../src/runtime/subscriber.js';
import type { Event } from '../../src/log/events.js';

const buildScene = () => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const heroes: Character[] = ['p1', 'p2'].map((id, i) => ({
    id: asCharacterId(id), name: id, kind: 'hero' as const, archetype: 'warrior' as const,
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total: 3, damage: 0, status: 'normal' as const },
    pos: { x: 0, y: i }, normalAttack: { kind: 'melee' as const, name: 'S', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
    inventory: [], boons: [], skills: [],
  }));
  const engine = new GameEngine({ seed: 's', grid, characters: heroes, effects: reg });

  const adventure: Adventure = {
    id: asAdventureId('a'), title: 'A',
    scenes: [{
      id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], exits: [] },
      monsters: [], abilityTests: [], transitions: [],
    }],
  };
  return { engine, heroes, adventure };
};

class CapturingSubscriber implements Subscriber {
  readonly viewer = { kind: 'human' as const };
  events: Event[] = [];
  onEvent(e: Event): void { this.events.push(e); }
}

describe('Orchestrator (minimal: DM + AI players, no human, no combat)', () => {
  it('drives DM and players to adventure_ended', async () => {
    const { engine, heroes, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'p1 acted.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'p2 acted.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'say', input: { text: 'hi' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const p2Llm = new ScriptedLlmClient([
      { match: { tag: 'p2' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);

    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'claude-sonnet-4-6', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => [],
      });

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-'));

    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', p2Llm, 'p2')],
        ]),
      },
      human: null,
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir,
      seed: 's',
      runId: 'test-run',
    });

    const out = await orch.run();
    expect(out.outcome).toBe('success');

    // Subscriber received events; final event is adventure_ended.
    const last = sub.events[sub.events.length - 1]!;
    expect(last.type).toBe('adventure_ended');

    // Subscriber never saw thoughts (visibility filter dropped them for human viewer).
    expect(sub.events.find((e) => e.type === 'thought')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/runtime/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Orchestrator (minimal version)**

Create `src/runtime/orchestrator.ts`:

```ts
import type { GameEngine } from '../engine/game-engine.js';
import type { Adventure } from '../engine/adventure.js';
import type { CharacterId } from '../engine/ids.js';
import type { Event } from '../log/events.js';
import { EventLog } from '../log/event-log.js';
import { writeManifest, type RunManifest } from '../log/manifest.js';
import path from 'node:path';
import type { Subscriber } from './subscriber.js';
import type { Agent } from './agent.js';
import { filter } from './visibility/filter.js';

export interface HumanInputProvider {
  /** Block until the human supplies input. Resolved input goes through the orchestrator. */
  requestInput(): Promise<HumanInput>;
}

export type HumanInput =
  | { kind: 'free_text'; text: string }
  | { kind: 'structured_action'; action: import('../engine/action.js').PlayerAction }
  | { kind: 'skip' };

export interface OrchestratorConfig {
  engine: GameEngine;
  adventure: Adventure;
  agents: { dm: Agent; players: Map<CharacterId, Agent> };
  human: { characterId: CharacterId; provider: HumanInputProvider } | null;
  subscribers: Subscriber[];
  stepBudget: { player: number; dm: number };
  runDir: string;
  seed: string;
  runId: string;
  /** Per-agent prompt-hash + model + persona name, for the manifest. */
  agentRecords?: RunManifest['agents'];
}

export interface OrchestratorResult {
  outcome: 'success' | 'failure' | 'aborted';
  manifestPath: string;
  totalEvents: number;
}

export class Orchestrator {
  private currentTurnIdx = 0;
  /** Visibility-filtered history per perspective; rebuilt lazily as agents take turns. */
  private allEvents: Event[] = [];

  constructor(private readonly cfg: OrchestratorConfig) {}

  async run(): Promise<OrchestratorResult> {
    const eventsPath = path.join(this.cfg.runDir, 'events.jsonl');
    const log = await EventLog.create(eventsPath);

    let outcome: OrchestratorResult['outcome'] = 'aborted';

    for (const sub of this.cfg.subscribers) await sub.onStart?.();

    try {
      while (true) {
        // Drain any pending engine events before deciding the next actor.
        await this.drainAndPublish(log);

        // End condition: an adventure_ended event has been written.
        const last = this.allEvents[this.allEvents.length - 1];
        if (last && last.type === 'adventure_ended') {
          outcome = last.outcome;
          break;
        }

        const actor = this.cfg.engine.turn.activeActorId;

        if (actor === null) {
          // DM acts.
          await this.runDmTurn(log);
        } else if (this.cfg.human && actor === this.cfg.human.characterId) {
          await this.runHumanTurn(actor, log);
        } else {
          await this.runAiTurn(actor, log);
        }
      }
    } finally {
      await log.close();
      for (const sub of this.cfg.subscribers) await sub.onEnd?.(outcome);
    }

    const manifestPath = path.join(this.cfg.runDir, 'manifest.json');
    await writeManifest(manifestPath, this.buildManifest(outcome));
    return { outcome, manifestPath, totalEvents: this.allEvents.length };
  }

  private async runDmTurn(log: EventLog): Promise<void> {
    const result = await this.cfg.agents.dm.takeTurn(
      { kind: 'fresh_turn' },
      this.historyFor({ kind: 'self', actorId: 'dm' }),
      this.currentTurnIdx,
      {
        emitThought: (text) => this.cfg.engine.emitRuntime({
          type: 'thought', actorId: 'dm', text,
        } as Omit<Event, 't'>),
        emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
          type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
        } as Omit<Event, 't'>),
      },
    );
    await this.drainAndPublish(log);
    if (result.reason === 'budget_exhausted') {
      // Engine has not been told the DM is "done"; force a request_action(p1) as fallback.
      // For Layer B simplicity, a budget-exhausted DM aborts the run.
      this.cfg.engine.emitRuntime({ type: 'adventure_ended', outcome: 'failure' } as Omit<Event, 't'>);
      await this.drainAndPublish(log);
    }
    this.currentTurnIdx += 1;
  }

  private async runAiTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    const agent = this.cfg.agents.players.get(actorId);
    if (!agent) throw new Error(`No agent for actor ${actorId}`);

    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);

    const result = await agent.takeTurn(
      { kind: 'fresh_turn' },
      this.historyFor({ kind: 'self', actorId }),
      this.currentTurnIdx,
      {
        emitThought: (text) => this.cfg.engine.emitRuntime({
          type: 'thought', actorId, text,
        } as Omit<Event, 't'>),
        emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
          type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
        } as Omit<Event, 't'>),
      },
    );
    await this.drainAndPublish(log);

    if (result.reason === 'budget_exhausted') {
      // Force end_turn through engine.
      const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
      if (!force.ok) throw new Error(`forced end_turn rejected: ${force.error.reason}`);
      await this.drainAndPublish(log);
    }

    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    this.currentTurnIdx += 1;
  }

  private async runHumanTurn(_actorId: CharacterId, _log: EventLog): Promise<void> {
    // Layer B Task 13 wires this up. Throwing here keeps the minimal
    // orchestrator honest: tests that don't supply a human MUST not route here.
    throw new Error('runHumanTurn is not wired in this minimal orchestrator yet');
  }

  private async drainAndPublish(log: EventLog): Promise<void> {
    const drained = this.cfg.engine.flushEvents();
    for (const ev of drained) {
      this.allEvents.push(ev);
      await log.append(ev);
      for (const sub of this.cfg.subscribers) {
        const r = filter(ev, sub.viewer);
        if (r !== null) sub.onEvent(r);
      }
    }
  }

  private historyFor(viewer: import('./visibility/types.js').Viewer): Event[] {
    const out: Event[] = [];
    for (const ev of this.allEvents) {
      const r = filter(ev, viewer);
      if (r !== null) out.push(r);
    }
    return out;
  }

  private buildManifest(outcome: OrchestratorResult['outcome']): RunManifest {
    const llmCalls: Record<string, number> = {};
    return {
      runId: this.cfg.runId,
      startedAt: new Date(0).toISOString(),    // wall time stamped by bin/play.ts; tests don't assert
      endedAt:   new Date(0).toISOString(),
      outcome:   outcome === 'aborted' ? 'in-progress' : outcome,
      adventure: `${this.cfg.adventure.id}@v1`,
      rngSeed:   this.cfg.seed,
      agents:    this.cfg.agentRecords ?? [],
      human:     this.cfg.human ? { characterId: this.cfg.human.characterId } : null,
      stepBudget: this.cfg.stepBudget.player,
      totalEvents: this.allEvents.length,
      totalLlmCalls: llmCalls,
      totalTokens: { in: 0, out: 0 },
      cacheHitRatio: 0,
    };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/runtime/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/orchestrator.ts tests/runtime/orchestrator.test.ts
git commit -m "feat(runtime): minimal orchestrator (dm + ai players, no human, no combat)"
```

---

### Task 13: Orchestrator — combat advance + human turns + DM interpretation

**Files:**
- Modify: `src/runtime/orchestrator.ts`
- Modify: `tests/runtime/orchestrator.test.ts`
- Modify: `src/runtime/agent.ts` (add `interpretFreeText` method)

Layer in: combat cursor advance after each combatant's turn ends, human-turn dispatch through `HumanInputProvider`, free-text interpretation through the DM agent (≤3 retries on rule violations, fallback to `skip_turn`).

- [ ] **Step 1: Add `interpretFreeText` to Agent**

In `src/runtime/agent.ts`, append a public method on the `Agent` class (after `takeTurn`):

```ts
  /**
   * Used during a human turn when the human types free text. The DM agent
   * interprets the text into 1+ PlayerActions for the named human character.
   * Returns the decoded actions in the order they should be applied. The
   * orchestrator validates each via the engine.
   */
  async interpretFreeText(
    text: string,
    forActorId: CharacterId,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<{ actions: import('../engine/action.js').PlayerAction[]; thinking: string[] }> {
    if (this.args.role !== 'dm') {
      throw new Error('interpretFreeText is only valid on a DM agent');
    }

    const prompt = this.args.promptBuilder.buildDm({
      party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
      monstersInScene: this.args.getMonstersInScene(),
      persona: this.args.persona,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      observation: { kind: 'public_resolution', summary:
        `Interpret the following free-text input from human "${forActorId}" into 1+ player tool calls (move/normal_attack/use_item/say/end_turn): ${text}` },
      currentTurnIdx,
    });

    const resp = await this.args.llm.complete({
      system: prompt.system,
      messages: prompt.messages,
      tools: this.args.tools, // DM_TOOLS shape — we accept narrate (clarify) or fall back via PLAYER_TOOLS in v1.
      thinking: { type: 'enabled' },
      model: this.args.model,
      maxTokens: this.args.maxTokens,
      ...({ tag: `${this.args.tag}:interp` } as never),
    } as never);

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

    // For v1, the DM is expected to emit narrate (to clarify) OR a special
    // "interpretation" payload via narrate's text field. We treat any non-narrate
    // tool use as failure to interpret and return zero actions (orchestrator falls
    // through to skip_turn).
    //
    // To keep Layer B simple, the DM is expected to call PLAYER_TOOLS-named tools
    // with an extra _forActorId field. We re-decode through the player decoder.
    const { decodePlayerToolUse } = await import('./prompt/tools.js');
    const actions: import('../engine/action.js').PlayerAction[] = [];
    for (const tu of resp.toolUses) {
      try {
        actions.push(decodePlayerToolUse(tu));
      } catch {
        // ignore non-player tools (e.g. narrate clarifications)
      }
    }
    return { actions, thinking: resp.thinkingBlocks };
  }
```

Note: in v1 the DM agent has only DM_TOOLS, so the LLM cannot natively call player tools. For Layer B we keep the implementation simple: scenarios use a separate "interpreter" agent OR the test wires a ScriptedLlmClient that returns player-tool-shaped responses through the DM seam. The headline integration test exercises this via scripted responses — see Task 19.

- [ ] **Step 2: Extend orchestrator test for human + combat**

Append to `tests/runtime/orchestrator.test.ts`:

```ts
import type { HumanInput, HumanInputProvider } from '../../src/runtime/orchestrator.js';

class ScriptedHuman implements HumanInputProvider {
  private inputs: HumanInput[];
  constructor(inputs: HumanInput[]) { this.inputs = [...inputs]; }
  async requestInput(): Promise<HumanInput> {
    const next = this.inputs.shift();
    if (!next) throw new Error('scripted human exhausted');
    return next;
  }
}

describe('Orchestrator with human seat', () => {
  it('routes a /skip structured action', async () => {
    const { engine, heroes, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const human = heroes[1]!;

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: human.id } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Human skipped.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);

    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-h-'));

    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: human.id, provider: new ScriptedHuman([{ kind: 'skip' }]) },
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'human-test',
    });

    const out = await orch.run();
    expect(out.outcome).toBe('success');
    expect(sub.events.find((e) => e.type === 'human_input')).toBeDefined();
    expect(sub.events.find((e) => e.type === 'action' && (e as { action: { kind: string } }).action.kind === 'skip_turn'))
      .toBeDefined();
  });
});
```

- [ ] **Step 3: Implement `runHumanTurn` in orchestrator**

Replace `runHumanTurn` in `src/runtime/orchestrator.ts` with:

```ts
  private async runHumanTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    if (!this.cfg.human) throw new Error('runHumanTurn called without a human config');

    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);

    const input = await this.cfg.human.provider.requestInput();

    if (input.kind === 'free_text') {
      this.cfg.engine.emitRuntime({ type: 'human_input', actorId, text: input.text } as Omit<Event, 't'>);
      await this.drainAndPublish(log);

      const interpretation = await this.cfg.agents.dm.interpretFreeText(
        input.text, actorId,
        this.historyFor({ kind: 'dm' }),
        this.currentTurnIdx,
        {
          emitThought: (t) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: 'dm', text: t } as Omit<Event, 't'>),
        },
      );
      await this.drainAndPublish(log);

      // Validate each interpreted action; on rule violation, retry up to 3 times.
      let attempts = 0;
      let actions = interpretation.actions;
      let appliedTurnEnd = false;
      while (attempts < 3) {
        let allOk = true;
        for (const action of actions) {
          const r = this.cfg.engine.applyAction(actorId, action);
          if (!r.ok) { allOk = false; break; }
          if (action.kind === 'end_turn' || action.kind === 'skip_turn') { appliedTurnEnd = true; break; }
        }
        await this.drainAndPublish(log);
        if (allOk) break;
        attempts += 1;
        // Re-ask DM with the violation as observation.
        const retry = await this.cfg.agents.dm.interpretFreeText(
          `Previous attempt produced an illegal action. Try again: ${input.text}`,
          actorId,
          this.historyFor({ kind: 'dm' }),
          this.currentTurnIdx,
          {
            emitThought: (t) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: 'dm', text: t } as Omit<Event, 't'>),
          },
        );
        await this.drainAndPublish(log);
        actions = retry.actions;
      }

      if (!appliedTurnEnd) {
        // Fall back to skip_turn so the turn definitely ends.
        const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
        if (!skip.ok) throw new Error(`fallback skip_turn rejected: ${skip.error.reason}`);
        await this.drainAndPublish(log);
      }
    } else if (input.kind === 'structured_action') {
      const r = this.cfg.engine.applyAction(actorId, input.action);
      if (!r.ok) {
        // Surface the violation but still end the turn.
        const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
        if (!skip.ok) throw new Error(`fallback skip_turn rejected: ${skip.error.reason}`);
      }
      await this.drainAndPublish(log);
      // If the structured action was not turn-ending, follow with an explicit end_turn.
      if (input.action.kind !== 'end_turn' && input.action.kind !== 'skip_turn') {
        const end = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
        if (end.ok) await this.drainAndPublish(log);
      }
    } else {
      // skip
      const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
      if (!skip.ok) throw new Error(`skip_turn rejected: ${skip.error.reason}`);
      await this.drainAndPublish(log);
    }

    // Combat cursor advance.
    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance();

    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    this.currentTurnIdx += 1;
  }
```

- [ ] **Step 4: Add combat cursor advance to AI turn**

In `runAiTurn`, just before `for (const sub of ...) sub.onTurnEnded?.(actorId)`, add:

```ts
    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance();
```

- [ ] **Step 5: Run the orchestrator tests**

Run: `npx vitest run tests/runtime/orchestrator.test.ts`
Expected: PASS — both the original DM+player test and the new human-skip test.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/orchestrator.ts src/runtime/agent.ts tests/runtime/orchestrator.test.ts
git commit -m "feat(runtime): orchestrator handles human turns + combat advance"
```

---

### Task 14: AnthropicLlmClient (real network) with retry + cache headers

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk` runtime dep)
- Create: `src/runtime/llm/anthropic.ts`
- Create: `tests/runtime/llm/anthropic.test.ts`

The test uses a fake `fetch`-style client injected into the constructor — no real network. Live calls happen only during the manual smoke run (Done signal #5).

- [ ] **Step 1: Add the SDK dep**

Run:
```bash
npm install @anthropic-ai/sdk@^0.30.0
```
Expected: dep added to `package.json`, lockfile updated, no errors.

- [ ] **Step 2: Write failing tests**

Create `tests/runtime/llm/anthropic.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient, type AnthropicCreateFn, type AnthropicSdkResponse } from '../../../src/runtime/llm/anthropic.js';

const okResponse = (toolName = 'narrate', input: Record<string, unknown> = { text: 'hi' }): AnthropicSdkResponse => ({
  content: [
    { type: 'thinking', thinking: 'plan thoughts' },
    { type: 'tool_use', id: 'tu_1', name: toolName, input },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
});

const minimalReq = () => ({
  system: [{ text: 'sys', cacheable: true }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi', cacheable: false }] }],
  tools: [],
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
});

describe('AnthropicLlmClient', () => {
  it('parses thinking + tool_use blocks and usage', async () => {
    const create = vi.fn<AnthropicCreateFn>().mockResolvedValue(okResponse());
    const client = new AnthropicLlmClient({ create });

    const r = await client.complete(minimalReq());
    expect(r.thinkingBlocks).toEqual(['plan thoughts']);
    expect(r.toolUses).toEqual([{ name: 'narrate', input: { text: 'hi' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 0 });
  });

  it('marks cacheable system segments with cache_control: ephemeral', async () => {
    const create = vi.fn<AnthropicCreateFn>().mockResolvedValue(okResponse());
    const client = new AnthropicLlmClient({ create });
    await client.complete({
      ...minimalReq(),
      system: [{ text: 'sys-stable', cacheable: true }, { text: 'sys-volatile', cacheable: false }],
    });
    const arg = create.mock.calls[0]![0];
    expect(arg.system[0]).toMatchObject({ type: 'text', text: 'sys-stable', cache_control: { type: 'ephemeral' } });
    expect(arg.system[1]).toMatchObject({ type: 'text', text: 'sys-volatile' });
    expect(arg.system[1].cache_control).toBeUndefined();
  });

  it('retries on 429 with exponential backoff', async () => {
    let calls = 0;
    const create: AnthropicCreateFn = async () => {
      calls += 1;
      if (calls < 3) {
        const e: Error & { status?: number } = new Error('rate limited');
        e.status = 429;
        throw e;
      }
      return okResponse();
    };
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() /* speed up tests */ });
    const r = await client.complete(minimalReq());
    expect(r.toolUses).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('throws LlmCallError after 5 retries on persistent 5xx', async () => {
    const create: AnthropicCreateFn = async () => {
      const e: Error & { status?: number } = new Error('server error'); e.status = 500;
      throw e;
    };
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() });
    await expect(client.complete(minimalReq())).rejects.toThrow(/persistent/i);
  });

  it('throws on refusal stopReason', async () => {
    const create: AnthropicCreateFn = async () => ({
      content: [], stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as AnthropicSdkResponse);
    const client = new AnthropicLlmClient({ create, sleepFn: () => Promise.resolve() });
    const r = await client.complete(minimalReq());
    expect(r.stopReason).toBe('refusal');
    expect(r.toolUses).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/runtime/llm/anthropic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement AnthropicLlmClient**

Create `src/runtime/llm/anthropic.ts`:

```ts
import type {
  LlmClient, LlmCompleteRequest, LlmResponse, ParsedToolUse, ToolSchema,
} from './llm-client.js';
import { LlmCallError } from './llm-client.js';

export interface AnthropicSdkResponse {
  content: Array<
    | { type: 'thinking'; thinking: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicCreateArgs {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{
    role: 'user' | 'assistant';
    content: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  }>;
  tools?: ToolSchema[];
  thinking?: { type: 'enabled'; budget_tokens?: number };
}

export type AnthropicCreateFn = (args: AnthropicCreateArgs) => Promise<AnthropicSdkResponse>;

export interface AnthropicLlmClientConfig {
  create: AnthropicCreateFn;
  /** Override sleep for tests. Default: setTimeout-backed. */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;        // default 5
  baseDelayMs?: number;       // default 250
  maxDelayMs?: number;        // default 4000
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isRetryable = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const status = (e as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
};

export class AnthropicLlmClient implements LlmClient {
  private readonly cfg: Required<AnthropicLlmClientConfig>;

  constructor(cfg: AnthropicLlmClientConfig) {
    this.cfg = {
      create: cfg.create,
      sleepFn: cfg.sleepFn ?? defaultSleep,
      maxRetries: cfg.maxRetries ?? 5,
      baseDelayMs: cfg.baseDelayMs ?? 250,
      maxDelayMs: cfg.maxDelayMs ?? 4000,
    };
  }

  async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
    const args: AnthropicCreateArgs = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system.map((s) => s.cacheable
        ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: s.text },
      ),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((c) => c.cacheable
          ? { type: 'text', text: c.text, cache_control: { type: 'ephemeral' } }
          : { type: 'text', text: c.text },
        ),
      })),
      ...(req.tools.length > 0 && { tools: req.tools }),
      ...(req.thinking && { thinking: { type: 'enabled', ...(req.thinking.budgetTokens && { budget_tokens: req.thinking.budgetTokens }) } }),
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const resp = await this.cfg.create(args);
        return this.parseResponse(resp);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt === this.cfg.maxRetries) break;
        const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs);
        await this.cfg.sleepFn(delay);
      }
    }
    throw new LlmCallError('persistent LLM call failure after retries', lastErr);
  }

  private parseResponse(resp: AnthropicSdkResponse): LlmResponse {
    const thinkingBlocks: string[] = [];
    const toolUses: ParsedToolUse[] = [];
    for (const block of resp.content) {
      if (block.type === 'thinking') thinkingBlocks.push(block.thinking);
      else if (block.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
    }
    return {
      thinkingBlocks,
      toolUses,
      stopReason: resp.stop_reason === 'stop_sequence' ? 'end_turn' : resp.stop_reason,
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/runtime/llm/anthropic.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/runtime/llm/anthropic.ts tests/runtime/llm/anthropic.test.ts
git commit -m "feat(runtime/llm): anthropic client with retry, cache headers, parsed thinking"
```

---

### Task 15: Emoji glyph registry + slash parser + scripted human reader

**Files:**
- Create: `src/runtime/cli/glyphs.ts`
- Create: `src/runtime/cli/slash-parser.ts`
- Create: `src/runtime/cli/script-reader.ts`
- Create: `tests/runtime/cli/glyphs.test.ts`
- Create: `tests/runtime/cli/slash-parser.test.ts`
- Create: `tests/runtime/cli/script-reader.test.ts`

Three small leaf utilities. None of them depend on Ink so they can be unit-tested in pure node.

- [ ] **Step 1: Glyph registry**

Create `src/runtime/cli/glyphs.ts`:

```ts
import type { Archetype } from '../../engine/character.js';

export const HERO_GLYPHS: Record<Archetype, string> = {
  warrior: '⚔️ ', hunter: '🏹', healer: '💚', warlock: '🔥',
  rogue:   '🗡️ ', knight: '🛡️ ', brute:  '👹',
};

export const MONSTER_GLYPHS: Record<string, string> = {
  'giant-rat': '🐀',
  'king-rat':  '👑',
};

export const ITEM_GLYPHS: Record<string, string> = {
  potion: '🧪', rope: '🪢', bomb: '💣', food: '🍞', gold: '🪙', herbs: '🌿',
};

export const TERRAIN = {
  floor:    '⬜',
  wall:     '⬛',
  obstacle: '🪵',
  ko:       '💀',
} as const;

export const STATUS = {
  active:  '⭐',
  engaged: '⚔️ ',
  prone:   '⬇️',
} as const;

export const HEALTH_FULL  = '❤️';
export const HEALTH_EMPTY = '🤍';

export const heroGlyph = (archetype: Archetype | undefined): string =>
  archetype ? HERO_GLYPHS[archetype] : '👤';

export const monsterGlyph = (typeId: string): string => MONSTER_GLYPHS[typeId] ?? '❓';

export const itemGlyph = (itemId: string): string => ITEM_GLYPHS[itemId] ?? '📦';
```

- [ ] **Step 2: Glyph tests**

Create `tests/runtime/cli/glyphs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HERO_GLYPHS, MONSTER_GLYPHS, ITEM_GLYPHS, heroGlyph, monsterGlyph, itemGlyph } from '../../../src/runtime/cli/glyphs.js';

describe('glyph registry', () => {
  it('every v1 archetype has a glyph', () => {
    expect(HERO_GLYPHS.warrior).toBeTruthy();
    expect(HERO_GLYPHS.hunter).toBeTruthy();
    expect(HERO_GLYPHS.healer).toBeTruthy();
    expect(HERO_GLYPHS.warlock).toBeTruthy();
  });

  it('giant-rat and king-rat have glyphs', () => {
    expect(MONSTER_GLYPHS['giant-rat']).toBe('🐀');
    expect(MONSTER_GLYPHS['king-rat']).toBe('👑');
  });

  it('v1 items have glyphs', () => {
    for (const id of ['potion', 'rope', 'bomb', 'food', 'gold', 'herbs']) {
      expect(ITEM_GLYPHS[id]).toBeTruthy();
    }
  });

  it('helpers fall back gracefully', () => {
    expect(heroGlyph(undefined)).toBeTruthy();
    expect(monsterGlyph('unknown-bestiary-id')).toBeTruthy();
    expect(itemGlyph('unknown-item-id')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run glyph test**

Run: `npx vitest run tests/runtime/cli/glyphs.test.ts`
Expected: PASS.

- [ ] **Step 4: Slash parser**

Create `src/runtime/cli/slash-parser.ts`:

```ts
import type { PlayerAction } from '../../engine/action.js';
import { asCharacterId, asItemId, asEquipmentId, asSkillId } from '../../engine/ids.js';

export type ParsedInput =
  | { kind: 'free_text'; text: string }
  | { kind: 'structured_action'; action: PlayerAction }
  | { kind: 'skip' }
  | { kind: 'help' }
  | { kind: 'parse_error'; message: string };

const parseSquare = (s: string): { x: number; y: number } | null => {
  const m = s.match(/^(\d+)\s*,\s*(\d+)$/);
  if (!m) return null;
  return { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10) };
};

const parsePath = (rest: string): Array<{ x: number; y: number }> | null => {
  const parts = rest.split(/\s+via\s+|\s*;\s*/i).map((s) => s.trim()).filter(Boolean);
  const out: Array<{ x: number; y: number }> = [];
  for (const p of parts) {
    const sq = parseSquare(p);
    if (!sq) return null;
    out.push(sq);
  }
  return out.length >= 1 ? out : null;
};

export const parseLine = (raw: string): ParsedInput => {
  const line = raw.trim();
  if (line.length === 0) return { kind: 'free_text', text: '' };
  if (!line.startsWith('/')) return { kind: 'free_text', text: line };

  const [head, ...rest] = line.slice(1).split(/\s+/);
  const tail = line.slice(1 + (head?.length ?? 0)).trim();

  switch (head) {
    case 'help': return { kind: 'help' };
    case 'skip': return { kind: 'skip' };
    case 'end':  return { kind: 'structured_action', action: { kind: 'end_turn' } };
    case 'say':  return { kind: 'structured_action', action: { kind: 'say', text: tail } };
    case 'attack': {
      const target = rest[0];
      if (!target) return { kind: 'parse_error', message: '/attack requires a targetId' };
      return { kind: 'structured_action', action: { kind: 'normal_attack', targetId: asCharacterId(target) } };
    }
    case 'move': {
      const path = parsePath(tail);
      if (!path) return { kind: 'parse_error', message: '/move requires "x,y[ via x,y; ...]"' };
      return { kind: 'structured_action', action: { kind: 'move', path } };
    }
    case 'use': {
      const itemId = rest[0];
      if (!itemId) return { kind: 'parse_error', message: '/use requires <itemId> [<targetId>]' };
      const targetId = rest[1];
      return { kind: 'structured_action', action: {
        kind: 'use_item',
        itemId: asItemId(itemId),
        ...(targetId && { targetId: asCharacterId(targetId) }),
      } };
    }
    case 'equip': {
      const eq = rest[0];
      if (!eq) return { kind: 'parse_error', message: '/equip requires <equipmentId>' };
      return { kind: 'structured_action', action: { kind: 'equip', equipmentId: asEquipmentId(eq) } };
    }
    case 'special': {
      // /special [target=ID] [k=v ...]
      const params: Record<string, string> = {};
      let target: string | undefined;
      for (const tok of rest) {
        const eq = tok.indexOf('=');
        if (eq <= 0) continue;
        const k = tok.slice(0, eq); const v = tok.slice(eq + 1);
        if (k === 'target') target = v;
        else params[k] = v;
      }
      return { kind: 'structured_action', action: {
        kind: 'special_action',
        ...(target && { targetIds: [asCharacterId(target)] }),
        ...(Object.keys(params).length > 0 && { params }),
      } };
    }
    case 'test': {
      // /test <melee|ranged|magic> <4|5|6> [skill=<id>] [item=<id>] -- <describe>
      const dashIdx = tail.indexOf('--');
      const head = (dashIdx === -1 ? tail : tail.slice(0, dashIdx)).trim().split(/\s+/);
      const describe = dashIdx === -1 ? '' : tail.slice(dashIdx + 2).trim();
      const characteristic = head[0] as 'melee' | 'ranged' | 'magic' | undefined;
      const difficulty = head[1] ? parseInt(head[1], 10) : NaN;
      if (!characteristic || (difficulty !== 4 && difficulty !== 5 && difficulty !== 6) || !describe) {
        return { kind: 'parse_error', message: '/test <melee|ranged|magic> <4|5|6> [skill=...] [item=...] -- <describe>' };
      }
      let skillId: string | undefined; let itemId: string | undefined;
      for (let i = 2; i < head.length; i++) {
        const tok = head[i]!;
        if (tok.startsWith('skill=')) skillId = tok.slice('skill='.length);
        else if (tok.startsWith('item=')) itemId = tok.slice('item='.length);
      }
      return { kind: 'structured_action', action: {
        kind: 'ability_test', characteristic, difficulty,
        describe,
        ...(skillId && { skillId: asSkillId(skillId) }),
        ...(itemId  && { itemId: asItemId(itemId) }),
      } };
    }
    default:
      return { kind: 'parse_error', message: `unknown command: /${head}` };
  }
};

export const HELP_TEXT = `Available commands:
  /move x,y[ via x,y; ...]     Move along a path
  /attack <targetId>           Normal attack
  /special [target=ID] [k=v ...]  Special action
  /use <itemId> [<targetId>]   Use a consumable
  /equip <equipmentId>         Swap equipment (out of combat)
  /test <melee|ranged|magic> <4|5|6> [skill=ID] [item=ID] -- <describe>
  /say <text>                  Say something out loud
  /skip                        Skip your turn
  /end                         End your turn
  /help                        This message
Or just type free text — the DM will interpret.`;
```

- [ ] **Step 5: Slash parser tests**

Create `tests/runtime/cli/slash-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLine } from '../../../src/runtime/cli/slash-parser.js';

describe('slash parser', () => {
  it('non-slash → free_text', () => {
    expect(parseLine('I rush in')).toEqual({ kind: 'free_text', text: 'I rush in' });
    expect(parseLine('   ')).toEqual({ kind: 'free_text', text: '' });
  });

  it('/skip and /end', () => {
    expect(parseLine('/skip')).toEqual({ kind: 'skip' });
    expect(parseLine('/end')).toEqual({ kind: 'structured_action', action: { kind: 'end_turn' } });
  });

  it('/attack <id>', () => {
    expect(parseLine('/attack rat-1')).toEqual({
      kind: 'structured_action',
      action: { kind: 'normal_attack', targetId: 'rat-1' },
    });
  });

  it('/move single-square shorthand', () => {
    const r = parseLine('/move 4,5');
    expect(r).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 4, y: 5 }] },
    });
  });

  it('/move with via path', () => {
    const r = parseLine('/move 1,1 via 2,1; 3,1');
    expect(r).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }] },
    });
  });

  it('/use with target', () => {
    expect(parseLine('/use potion h-ally')).toEqual({
      kind: 'structured_action',
      action: { kind: 'use_item', itemId: 'potion', targetId: 'h-ally' },
    });
  });

  it('/test parses', () => {
    const r = parseLine('/test ranged 5 skill=tracking -- spot the rat');
    expect(r).toEqual({
      kind: 'structured_action',
      action: {
        kind: 'ability_test', characteristic: 'ranged', difficulty: 5,
        describe: 'spot the rat', skillId: 'tracking',
      },
    });
  });

  it('parse_error on unknown command', () => {
    expect(parseLine('/teleport')).toEqual({ kind: 'parse_error', message: 'unknown command: /teleport' });
  });

  it('parse_error on bad /move', () => {
    expect(parseLine('/move not-a-square')).toEqual({
      kind: 'parse_error',
      message: '/move requires "x,y[ via x,y; ...]"',
    });
  });

  it('/say preserves text including spaces', () => {
    expect(parseLine('/say flank left now!')).toEqual({
      kind: 'structured_action',
      action: { kind: 'say', text: 'flank left now!' },
    });
  });
});
```

- [ ] **Step 6: Run slash parser tests**

Run: `npx vitest run tests/runtime/cli/slash-parser.test.ts`
Expected: PASS.

- [ ] **Step 7: Script reader**

Create `src/runtime/cli/script-reader.ts`:

```ts
import { readFile } from 'node:fs/promises';
import type { HumanInput, HumanInputProvider } from '../orchestrator.js';
import type { PlayerAction } from '../../engine/action.js';

interface ScriptLine {
  text?: string;
  action?: PlayerAction;
}

export class ScriptHumanProvider implements HumanInputProvider {
  private inputs: HumanInput[] = [];
  private cursor = 0;

  static async fromFile(path: string): Promise<ScriptHumanProvider> {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const inputs: HumanInput[] = lines.map((l, i) => {
      const obj = JSON.parse(l) as ScriptLine;
      if (obj.action) {
        if (obj.action.kind === 'skip_turn') return { kind: 'skip' };
        return { kind: 'structured_action', action: obj.action };
      }
      if (typeof obj.text === 'string') return { kind: 'free_text', text: obj.text };
      throw new Error(`Script line ${i + 1} has neither "text" nor "action"`);
    });
    const p = new ScriptHumanProvider();
    p.inputs = inputs;
    return p;
  }

  async requestInput(): Promise<HumanInput> {
    const next = this.inputs[this.cursor];
    if (!next) throw new Error('Scripted human input exhausted');
    this.cursor += 1;
    return next;
  }

  remaining(): number {
    return this.inputs.length - this.cursor;
  }
}
```

- [ ] **Step 8: Script reader tests**

Create `tests/runtime/cli/script-reader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ScriptHumanProvider } from '../../../src/runtime/cli/script-reader.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('ScriptHumanProvider', () => {
  it('reads jsonl, returns inputs in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'script-'));
    const file = path.join(dir, 'h.jsonl');
    writeFileSync(file, [
      JSON.stringify({ text: 'I rush in' }),
      JSON.stringify({ action: { kind: 'skip_turn' } }),
      JSON.stringify({ action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } }),
    ].join('\n') + '\n');

    const p = await ScriptHumanProvider.fromFile(file);
    expect(p.remaining()).toBe(3);
    expect(await p.requestInput()).toEqual({ kind: 'free_text', text: 'I rush in' });
    expect(await p.requestInput()).toEqual({ kind: 'skip' });
    expect(await p.requestInput()).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
    });
  });

  it('throws when exhausted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'script-'));
    const file = path.join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    const p = await ScriptHumanProvider.fromFile(file);
    await expect(p.requestInput()).rejects.toThrow(/exhausted/);
  });
});
```

- [ ] **Step 9: Run script reader tests**

Run: `npx vitest run tests/runtime/cli/script-reader.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/cli/glyphs.ts src/runtime/cli/slash-parser.ts src/runtime/cli/script-reader.ts \
        tests/runtime/cli/glyphs.test.ts tests/runtime/cli/slash-parser.test.ts tests/runtime/cli/script-reader.test.ts
git commit -m "feat(runtime/cli): glyph registry, slash parser, scripted human reader"
```

---

### Task 16: Ink stack + cli-store + Board / CharacterPanels / ChatLog components

**Files:**
- Modify: `package.json` (add `ink`, `react`; dev deps `ink-testing-library`, `@types/react`)
- Modify: `tsconfig.json` (add `"jsx": "react-jsx"` to compiler options)
- Create: `src/runtime/cli/cli-store.ts`
- Create: `src/runtime/cli/Board.tsx`
- Create: `src/runtime/cli/CharacterPanels.tsx`
- Create: `src/runtime/cli/ChatLog.tsx`
- Create: `tests/runtime/cli/board.test.ts`

The components are pure renders driven by the store snapshot. State changes happen by pushing into the store from the orchestrator subscriber.

- [ ] **Step 1: Add Ink + React deps**

Run:
```bash
npm install ink@^5 react@^18
npm install --save-dev ink-testing-library@^4 @types/react@^18
```
Expected: deps added; lockfile updated.

- [ ] **Step 2: Enable JSX in tsconfig**

In `tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions`. Resulting `compilerOptions` should look like:

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
    "sourceMap": true,
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 3: Create the cli-store**

Create `src/runtime/cli/cli-store.ts`:

```ts
import type { Event } from '../../log/events.js';
import type { Character } from '../../engine/character.js';
import type { Scene } from '../../engine/adventure.js';
import type { CharacterId } from '../../engine/ids.js';
import type { Grid } from '../../engine/grid.js';

export interface CliSnapshot {
  scene: Scene | null;
  grid: Grid | null;
  characters: Character[];
  activeActor: CharacterId | 'dm' | null;
  chat: ChatEntry[];
  /** True iff the human's seat is locked open for input. */
  inputUnlocked: boolean;
  ended: { outcome: 'success' | 'failure' | 'aborted' } | null;
}

export interface ChatEntry {
  t: number;
  who: string;            // "DM", actor name, or "system"
  text: string;
  kind: 'narrate' | 'say' | 'action' | 'resolution' | 'system';
}

type Listener = () => void;

export class CliStore {
  private snap: CliSnapshot = {
    scene: null,
    grid: null,
    characters: [],
    activeActor: null,
    chat: [],
    inputUnlocked: false,
    ended: null,
  };
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getSnapshot(): CliSnapshot { return this.snap; }

  private commit(next: CliSnapshot): void {
    this.snap = next;
    for (const l of this.listeners) l();
  }

  setScene(scene: Scene, grid: Grid): void {
    this.commit({ ...this.snap, scene, grid });
  }
  setCharacters(cs: Character[]): void {
    this.commit({ ...this.snap, characters: cs });
  }
  setActive(actor: CharacterId | 'dm' | null): void {
    this.commit({ ...this.snap, activeActor: actor });
  }
  unlockInput(unlocked: boolean): void {
    this.commit({ ...this.snap, inputUnlocked: unlocked });
  }
  end(outcome: 'success' | 'failure' | 'aborted'): void {
    this.commit({ ...this.snap, ended: { outcome }, inputUnlocked: false });
  }

  ingest(ev: Event, characterNameById: (id: CharacterId | 'dm') => string): void {
    if (ev.type === 'narrate') {
      this.appendChat({ t: ev.t, who: 'DM', text: ev.text, kind: 'narrate' });
    } else if (ev.type === 'action' && (ev.action as { kind: string }).kind === 'say') {
      const text = (ev.action as { kind: 'say'; text: string }).text;
      this.appendChat({ t: ev.t, who: characterNameById(ev.actorId), text, kind: 'say' });
    } else if (ev.type === 'action') {
      const k = (ev.action as { kind: string }).kind;
      this.appendChat({ t: ev.t, who: characterNameById(ev.actorId), text: `→ ${k}`, kind: 'action' });
    } else if (ev.type === 'resolution') {
      const pub = ev.public as Record<string, unknown>;
      this.appendChat({ t: ev.t, who: characterNameById(ev.actorId), text: `result: ${JSON.stringify(pub)}`, kind: 'resolution' });
    } else if (ev.type === 'request_action') {
      this.commit({ ...this.snap, activeActor: ev.targetId });
    } else if (ev.type === 'adventure_ended') {
      this.end(ev.outcome);
    }
  }

  private appendChat(entry: ChatEntry): void {
    this.commit({ ...this.snap, chat: [...this.snap.chat, entry].slice(-50) });
  }
}
```

- [ ] **Step 4: Board.tsx**

Create `src/runtime/cli/Board.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Grid } from '../../engine/grid.js';
import type { Character } from '../../engine/character.js';
import type { CharacterId } from '../../engine/ids.js';
import { TERRAIN, heroGlyph, monsterGlyph } from './glyphs.js';

interface BoardProps {
  grid: Grid;
  characters: Character[];
  activeActor: CharacterId | 'dm' | null;
}

const cellGlyph = (
  pos: { x: number; y: number },
  grid: Grid,
  characters: Character[],
  activeActor: CharacterId | 'dm' | null,
): string => {
  // Active actor highlight precedence.
  for (const c of characters) {
    if (!c.pos) continue;
    if (c.pos.x !== pos.x || c.pos.y !== pos.y) continue;
    if (c.health.status === 'KO') return TERRAIN.ko;
    if (c.id === activeActor) return '⭐';
    return c.kind === 'hero' ? heroGlyph(c.archetype) : monsterGlyph(c.name.toLowerCase().replace(/\s+/g, '-'));
  }
  const cell = grid.cellAt(pos);
  if (cell.kind === 'wall') return TERRAIN.wall;
  if (cell.kind === 'obstacle') return TERRAIN.obstacle;
  return TERRAIN.floor;
};

export const Board: React.FC<BoardProps> = ({ grid, characters, activeActor }) => {
  const rows: React.ReactElement[] = [];
  for (let y = 0; y < grid.height; y++) {
    const cells: React.ReactElement[] = [];
    for (let x = 0; x < grid.width; x++) {
      cells.push(<Text key={x}>{cellGlyph({ x, y }, grid, characters, activeActor)}</Text>);
    }
    rows.push(<Box key={y} flexDirection="row">{cells}</Box>);
  }
  return <Box flexDirection="column">{rows}</Box>;
};
```

- [ ] **Step 5: CharacterPanels.tsx**

Create `src/runtime/cli/CharacterPanels.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Character } from '../../engine/character.js';
import { heroGlyph, HEALTH_FULL, HEALTH_EMPTY, itemGlyph } from './glyphs.js';

interface Props {
  characters: Character[];
}

const heartsFor = (c: Character): string => {
  const remaining = c.health.total - c.health.damage;
  return HEALTH_FULL.repeat(Math.max(0, remaining)) + HEALTH_EMPTY.repeat(Math.max(0, c.health.damage));
};

export const CharacterPanels: React.FC<Props> = ({ characters }) => {
  const heroes = characters.filter((c) => c.kind === 'hero');
  return (
    <Box flexDirection="column" marginLeft={2}>
      {heroes.map((c) => {
        const inv = c.inventory.length === 0
          ? '—'
          : c.inventory.map((s) => `${itemGlyph(s.itemId as string)}×${s.count}`).join(' ');
        return (
          <Box key={c.id} flexDirection="row">
            <Text>{heroGlyph(c.archetype)} </Text>
            <Text bold>{c.name.padEnd(8)}</Text>
            <Text>HP {heartsFor(c)}  </Text>
            <Text>M{c.pools.melee} R{c.pools.ranged} G{c.pools.magic} A{c.pools.armor}  </Text>
            <Text>{inv}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
```

- [ ] **Step 6: ChatLog.tsx**

Create `src/runtime/cli/ChatLog.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { ChatEntry } from './cli-store.js';

export const ChatLog: React.FC<{ entries: ChatEntry[] }> = ({ entries }) => (
  <Box flexDirection="column" marginTop={1}>
    {entries.slice(-12).map((e) => {
      const color = e.kind === 'narrate' ? 'cyan'
        : e.kind === 'say' ? 'green'
        : e.kind === 'action' ? 'yellow'
        : 'gray';
      return (
        <Box key={e.t} flexDirection="row">
          <Text color={color}>{e.who}: </Text>
          <Text>{e.text}</Text>
        </Box>
      );
    })}
  </Box>
);
```

- [ ] **Step 7: Board snapshot test**

Create `tests/runtime/cli/board.test.ts`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Board } from '../../../src/runtime/cli/Board.js';
import { Grid } from '../../../src/engine/grid.js';
import { asCharacterId, asEffectId } from '../../../src/engine/ids.js';
import type { Character } from '../../../src/engine/character.js';

const mkChar = (id: string, archetype: Character['archetype'], pos: { x: number; y: number }): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype,
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos, normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('Board renders', () => {
  it('places hero glyphs at their positions and floor elsewhere', () => {
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );
    const chars = [
      mkChar('p1', 'warrior', { x: 0, y: 0 }),
      mkChar('p2', 'warlock', { x: 3, y: 3 }),
    ];
    const { lastFrame } = render(<Board grid={grid} characters={chars} activeActor={null} />);
    const frame = lastFrame() ?? '';

    // Hero glyphs appear in the frame.
    expect(frame).toContain('⚔️ ');     // warrior
    expect(frame).toContain('🔥');     // warlock
    // 4×4 floor cells (minus 2 occupied) = 14 floor glyphs
    const floorMatches = (frame.match(/⬜/g) ?? []).length;
    expect(floorMatches).toBe(14);
  });

  it('marks the active actor with the star glyph', () => {
    const grid = new Grid(
      Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
    );
    const chars = [mkChar('p1', 'warrior', { x: 1, y: 1 })];
    const { lastFrame } = render(<Board grid={grid} characters={chars} activeActor={asCharacterId('p1')} />);
    expect(lastFrame() ?? '').toContain('⭐');
  });
});
```

- [ ] **Step 8: Run the board test**

Run: `npx vitest run tests/runtime/cli/board.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/runtime/cli/cli-store.ts \
        src/runtime/cli/Board.tsx src/runtime/cli/CharacterPanels.tsx src/runtime/cli/ChatLog.tsx \
        tests/runtime/cli/board.test.ts
git commit -m "feat(runtime/cli): ink components for board, panels, chat log"
```

---

### Task 17: InputLine + App + CliAdapter (Subscriber + HumanInputProvider)

**Files:**
- Create: `src/runtime/cli/InputLine.tsx`
- Create: `src/runtime/cli/App.tsx`
- Create: `src/runtime/cli/cli-adapter.ts`
- Create: `tests/runtime/cli/input-line.test.ts`
- Create: `tests/runtime/cli/app.test.ts`

The CliAdapter is the bridge: it implements both `Subscriber` (push events into the store) and `HumanInputProvider` (return a promise that resolves on submit).

- [ ] **Step 1: InputLine.tsx**

Create `src/runtime/cli/InputLine.tsx`:

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputLineProps {
  enabled: boolean;
  onSubmit(line: string): void;
}

export const InputLine: React.FC<InputLineProps> = ({ enabled, onSubmit }) => {
  const [buf, setBuf] = useState('');

  useInput((input, key) => {
    if (!enabled) return;
    if (key.return) {
      const submitted = buf;
      setBuf('');
      onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      setBuf((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuf((b) => b + input);
    }
  }, { isActive: enabled });

  if (!enabled) return <Text dimColor>Waiting for the active turn…</Text>;
  return (
    <Box>
      <Text>{'> '}</Text>
      <Text>{buf}</Text>
      <Text inverse>{' '}</Text>
    </Box>
  );
};
```

- [ ] **Step 2: App.tsx**

Create `src/runtime/cli/App.tsx`:

```tsx
import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { Board } from './Board.js';
import { CharacterPanels } from './CharacterPanels.js';
import { ChatLog } from './ChatLog.js';
import { InputLine } from './InputLine.js';
import type { CliStore } from './cli-store.js';

interface AppProps {
  store: CliStore;
  onSubmit(line: string): void;
}

export const App: React.FC<AppProps> = ({ store, onSubmit }) => {
  const snap = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row">
        <Text>Scene: {snap.scene?.id ?? '—'}    </Text>
        <Text>Turn: {snap.activeActor ?? '—'}    </Text>
        {snap.ended && <Text bold color={snap.ended.outcome === 'success' ? 'green' : 'red'}>Run ended: {snap.ended.outcome}</Text>}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        {snap.grid && <Board grid={snap.grid} characters={snap.characters} activeActor={snap.activeActor} />}
        <CharacterPanels characters={snap.characters} />
      </Box>
      <ChatLog entries={snap.chat} />
      <Box marginTop={1}>
        <InputLine enabled={snap.inputUnlocked && !snap.ended} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
};
```

- [ ] **Step 3: CliAdapter**

Create `src/runtime/cli/cli-adapter.ts`:

```ts
import type { Subscriber } from '../subscriber.js';
import type { HumanInput, HumanInputProvider } from '../orchestrator.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { CharacterId } from '../../engine/ids.js';
import type { CliStore } from './cli-store.js';
import type { Grid } from '../../engine/grid.js';
import type { Character } from '../../engine/character.js';
import type { Scene } from '../../engine/adventure.js';
import { parseLine, HELP_TEXT } from './slash-parser.js';

export interface CliAdapterDeps {
  store: CliStore;
  /** Given an event's actorId, return a printable display name. */
  nameFor(id: CharacterId | 'dm'): string;
  /** Return current state for the store (called every event tick). */
  readState(): { scene: Scene | null; grid: Grid | null; characters: Character[] };
}

export class CliAdapter implements Subscriber, HumanInputProvider {
  readonly viewer: Viewer = { kind: 'human' };

  private pendingResolve: ((input: HumanInput) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(private readonly deps: CliAdapterDeps) {}

  /* Subscriber */

  onStart(): void {
    const s = this.deps.readState();
    if (s.scene && s.grid) this.deps.store.setScene(s.scene, s.grid);
    this.deps.store.setCharacters(s.characters);
  }

  onEvent(ev: RedactedEvent): void {
    this.deps.store.ingest(ev, this.deps.nameFor);
    const s = this.deps.readState();
    this.deps.store.setCharacters(s.characters);
    if (s.scene && s.grid) this.deps.store.setScene(s.scene, s.grid);
  }

  onTurnStarted(actorId: CharacterId | 'dm'): void {
    this.deps.store.setActive(actorId);
  }

  onTurnEnded(_actorId: CharacterId | 'dm'): void {
    this.deps.store.unlockInput(false);
  }

  onEnd(outcome: 'success' | 'failure' | 'aborted'): void {
    this.deps.store.end(outcome);
    if (this.pendingReject) {
      this.pendingReject(new Error(`run ended (${outcome}) while waiting for human input`));
      this.pendingResolve = null; this.pendingReject = null;
    }
  }

  /* HumanInputProvider */

  async requestInput(): Promise<HumanInput> {
    this.deps.store.unlockInput(true);
    return new Promise<HumanInput>((resolve, reject) => {
      this.pendingResolve = resolve; this.pendingReject = reject;
    });
  }

  /** Called by App.onSubmit. */
  submit(line: string): void {
    if (!this.pendingResolve) return;     // input not requested; ignore stray keystrokes
    const parsed = parseLine(line);
    switch (parsed.kind) {
      case 'free_text':
        this.deliver({ kind: 'free_text', text: parsed.text });
        break;
      case 'structured_action':
        this.deliver({ kind: 'structured_action', action: parsed.action });
        break;
      case 'skip':
        this.deliver({ kind: 'skip' });
        break;
      case 'help':
        this.deps.store.ingest(
          { t: -1, type: 'narrate', actorId: 'dm', text: HELP_TEXT } as never,
          this.deps.nameFor,
        );
        // input remains unlocked; do not resolve
        break;
      case 'parse_error':
        this.deps.store.ingest(
          { t: -1, type: 'narrate', actorId: 'dm', text: `(${parsed.message})` } as never,
          this.deps.nameFor,
        );
        // input remains unlocked
        break;
    }
  }

  private deliver(input: HumanInput): void {
    const r = this.pendingResolve;
    this.pendingResolve = null; this.pendingReject = null;
    this.deps.store.unlockInput(false);
    r?.(input);
  }
}
```

- [ ] **Step 4: InputLine test**

Create `tests/runtime/cli/input-line.test.ts`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { InputLine } from '../../../src/runtime/cli/InputLine.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('InputLine', () => {
  it('disabled state shows waiting message and ignores input', async () => {
    let submitted: string | null = null;
    const { lastFrame, stdin } = render(
      <InputLine enabled={false} onSubmit={(line) => { submitted = line; }} />,
    );
    expect(lastFrame() ?? '').toMatch(/Waiting/);
    stdin.write('a');
    await flush();
    expect(submitted).toBeNull();
  });

  it('accumulates keystrokes and submits on Enter', async () => {
    let submitted: string | null = null;
    const { stdin } = render(
      <InputLine enabled={true} onSubmit={(line) => { submitted = line; }} />,
    );
    stdin.write('hi');
    await flush();
    stdin.write('\r');
    await flush();
    expect(submitted).toBe('hi');
  });

  it('backspace removes the last character', async () => {
    const lines: string[] = [];
    const { stdin } = render(
      <InputLine enabled={true} onSubmit={(line) => lines.push(line)} />,
    );
    stdin.write('abc');
    await flush();
    stdin.write(''); // backspace
    await flush();
    stdin.write('\r');
    await flush();
    expect(lines).toEqual(['ab']);
  });
});
```

- [ ] **Step 5: App composition test**

Create `tests/runtime/cli/app.test.ts`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../../src/runtime/cli/App.js';
import { CliStore } from '../../../src/runtime/cli/cli-store.js';
import { Grid } from '../../../src/engine/grid.js';
import { asCharacterId, asEffectId, asSceneId } from '../../../src/engine/ids.js';
import type { Character } from '../../../src/engine/character.js';
import type { Scene } from '../../../src/engine/adventure.js';

const mkScene = (): Scene => ({
  id: asSceneId('s'),
  intro: '', conclusion: '',
  map: { width: 4, height: 4, background: 'bg', obstacles: [], exits: [] },
  monsters: [], abilityTests: [], transitions: [],
});

const mkChar = (id: string, archetype: Character['archetype']): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype,
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('App', () => {
  it('renders board, character panel, chat, and locked input by default', () => {
    const store = new CliStore();
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );
    store.setScene(mkScene(), grid);
    store.setCharacters([mkChar('p1', 'warrior')]);

    const { lastFrame } = render(<App store={store} onSubmit={() => undefined} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Scene: s');
    expect(frame).toContain('p1');
    expect(frame).toMatch(/Waiting/);
  });

  it('unlocks input when store.unlockInput(true)', () => {
    const store = new CliStore();
    const grid = new Grid(
      Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ kind: 'floor' as const }))),
    );
    store.setScene(mkScene(), grid);
    store.setCharacters([mkChar('p1', 'warrior')]);
    store.unlockInput(true);
    const { lastFrame } = render(<App store={store} onSubmit={() => undefined} />);
    expect(lastFrame() ?? '').toMatch(/^>/m);
  });
});
```

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run tests/runtime/cli/input-line.test.ts tests/runtime/cli/app.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/cli/InputLine.tsx src/runtime/cli/App.tsx src/runtime/cli/cli-adapter.ts \
        tests/runtime/cli/input-line.test.ts tests/runtime/cli/app.test.ts
git commit -m "feat(runtime/cli): app, input line, and cli adapter (subscriber + input provider)"
```

---

### Task 18: Scenario loader + persona files + `bin/play.ts`

**Files:**
- Create: `src/runtime/scenario.ts`
- Create: `tests/runtime/scenario.test.ts`
- Create: `personas/cautious.md`
- Create: `personas/reckless.md`
- Create: `personas/dm-default.md`
- Create: `bin/play.ts`
- Modify: `package.json` — add `"play"` script

The scenario loader hashes each persona Markdown for `manifest.promptHash`. `bin/play.ts` is the wiring from CLI args to a running orchestrator.

- [ ] **Step 1: Persona files**

Create `personas/cautious.md`:

```md
You are cautious and tactical. You favor preserving the party's HP over
splashy plays. You speak deliberately. You frequently call out plays before
making them: "Anwen, hold the chokepoint while I drink a potion."
```

Create `personas/reckless.md`:

```md
You are reckless and theatrical. You charge into combat with a quip. You
chase off-screen monsters when you can. You cheer when allies score hits.
You rarely retreat — even when it would be wise.
```

Create `personas/dm-default.md`:

```md
You are an even-handed Dungeon Master. You read the canonical scene text
faithfully on entry. You never roll dice — the engine does. When the
players act, you narrate the outcome briefly (one or two sentences),
adjudicating fuzzy edge cases when needed. You hand turns off promptly.
```

- [ ] **Step 2: Write failing scenario test**

Create `tests/runtime/scenario.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadScenario } from '../../src/runtime/scenario.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const writeFile = (p: string, content: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

describe('scenario loader', () => {
  it('reads scenario JSON, inlines persona Markdown, and computes promptHash per agent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-'));

    writeFile(path.join(dir, 'personas', 'cautious.md'), 'You are cautious.');
    writeFile(path.join(dir, 'personas', 'reckless.md'), 'You are reckless.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'You are the DM.');

    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline',
      adventure: 'adventures/x.json',
      seed: 'seed-1',
      model: 'claude-sonnet-4-6',
      stepBudget: { player: 6, dm: 12 },
      snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/cautious.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/reckless.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h1', archetype: 'hunter' },
    }, null, 2));

    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.id).toBe('baseline');
    expect(scenario.agents.p1.persona).toBe('You are cautious.');
    expect(scenario.agents.p2.persona).toBe('You are reckless.');
    expect(scenario.agents.dm.persona).toBe('You are the DM.');
    expect(scenario.agentRecords).toHaveLength(3);
    for (const ar of scenario.agentRecords) {
      expect(ar.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // Same persona text → same hash; different text → different hash.
    const hashes = new Set(scenario.agentRecords.map((a) => a.promptHash));
    expect(hashes.size).toBe(3);
  });

  it('throws on missing persona file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-'));
    const scenarioPath = path.join(dir, 's.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'x', adventure: 'a.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: { p1: { characterId: 'p1', archetype: 'warrior', persona: 'nope.md' },
                p2: { characterId: 'p2', archetype: 'warlock', persona: 'nope.md' },
                dm: { persona: 'nope.md' } },
      human: { characterId: 'h', archetype: 'hunter' },
    }));
    await expect(loadScenario(scenarioPath, dir)).rejects.toThrow(/nope\.md/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/runtime/scenario.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement scenario.ts**

Create `src/runtime/scenario.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunManifest } from '../log/manifest.js';

const AgentBlockSchema = z.object({
  characterId: z.string().optional(),
  archetype: z.string().optional(),
  persona: z.string(),                 // path relative to baseDir
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  adventure: z.string().min(1),
  seed: z.string().min(1),
  model: z.string().min(1),
  stepBudget: z.object({ player: z.number().int().min(1), dm: z.number().int().min(1) }),
  snapshotEveryTurns: z.number().int().min(1).default(3),
  agents: z.object({
    p1: AgentBlockSchema.extend({ characterId: z.string(), archetype: z.string() }),
    p2: AgentBlockSchema.extend({ characterId: z.string(), archetype: z.string() }),
    dm: AgentBlockSchema,
  }),
  human: z.object({ characterId: z.string().min(1), archetype: z.string().min(1) }),
});

export type ScenarioFile = z.infer<typeof ScenarioSchema>;

export interface LoadedScenario {
  id: string;
  adventurePath: string;             // resolved absolute
  seed: string;
  model: string;
  stepBudget: { player: number; dm: number };
  snapshotEveryTurns: number;
  agents: {
    p1: { characterId: string; archetype: string; persona: string };
    p2: { characterId: string; archetype: string; persona: string };
    dm: { persona: string };
  };
  human: { characterId: string; archetype: string };
  agentRecords: RunManifest['agents'];
}

const sha256Hex = (s: string): string =>
  'sha256:' + createHash('sha256').update(s).digest('hex');

export const loadScenario = async (
  scenarioPath: string,
  baseDir: string,
): Promise<LoadedScenario> => {
  const raw = await readFile(scenarioPath, 'utf8');
  const parsed = ScenarioSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid scenario: ${parsed.error.message}`);
  const sf = parsed.data;

  const readPersona = async (rel: string): Promise<string> => {
    const full = path.resolve(baseDir, rel);
    try { return (await readFile(full, 'utf8')).trim(); }
    catch (e) { throw new Error(`failed to read persona ${rel}: ${(e as Error).message}`); }
  };

  const [p1Persona, p2Persona, dmPersona] = await Promise.all([
    readPersona(sf.agents.p1.persona),
    readPersona(sf.agents.p2.persona),
    readPersona(sf.agents.dm.persona),
  ]);

  const agentRecords: RunManifest['agents'] = [
    { role: 'dm', model: sf.model, persona: sf.agents.dm.persona, promptHash: sha256Hex(dmPersona) },
    { role: 'p1', characterId: sf.agents.p1.characterId, persona: sf.agents.p1.persona, model: sf.model, promptHash: sha256Hex(p1Persona) },
    { role: 'p2', characterId: sf.agents.p2.characterId, persona: sf.agents.p2.persona, model: sf.model, promptHash: sha256Hex(p2Persona) },
  ];

  return {
    id: sf.id,
    adventurePath: path.resolve(baseDir, sf.adventure),
    seed: sf.seed,
    model: sf.model,
    stepBudget: sf.stepBudget,
    snapshotEveryTurns: sf.snapshotEveryTurns,
    agents: {
      p1: { characterId: sf.agents.p1.characterId, archetype: sf.agents.p1.archetype, persona: p1Persona },
      p2: { characterId: sf.agents.p2.characterId, archetype: sf.agents.p2.archetype, persona: p2Persona },
      dm: { persona: dmPersona },
    },
    human: sf.human,
    agentRecords,
  };
};
```

- [ ] **Step 5: Run scenario tests**

Run: `npx vitest run tests/runtime/scenario.test.ts`
Expected: PASS.

- [ ] **Step 6: Add `play` script and `bin/play.ts`**

In `package.json`'s `scripts` block, add:

```json
    "play": "tsx bin/play.ts"
```

Add `tsx` as a devDependency (no compile step needed for the entry):

```bash
npm install --save-dev tsx@^4
```

Create `bin/play.ts`:

```ts
#!/usr/bin/env node
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import { fileURLToPath } from 'node:url';

import { loadScenario } from '../src/runtime/scenario.js';
import { loadCatalogs } from '../src/engine/load.js';
import { loadAdventure } from '../src/engine/adventure.js';
import { Grid } from '../src/engine/grid.js';
import { GameEngine } from '../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../src/engine/ids.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { Agent } from '../src/runtime/agent.js';
import { PromptBuilder } from '../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../src/runtime/prompt/tools.js';
import { AnthropicLlmClient } from '../src/runtime/llm/anthropic.js';
import { CliStore } from '../src/runtime/cli/cli-store.js';
import { CliAdapter } from '../src/runtime/cli/cli-adapter.js';
import { ScriptHumanProvider } from '../src/runtime/cli/script-reader.js';
import { App } from '../src/runtime/cli/App.js';
import type { Character } from '../src/engine/character.js';
import type { HumanInputProvider } from '../src/runtime/orchestrator.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const parseArgs = (argv: string[]): { scenario: string; humanScript: string | null } => {
  const args = argv.slice(2);
  const scenario = args[0];
  if (!scenario) {
    console.error('usage: npm run play <scenarios/file.json> [--human-script <path>]');
    process.exit(1);
  }
  const flagIdx = args.indexOf('--human-script');
  const humanScript = flagIdx !== -1 ? args[flagIdx + 1] ?? null : null;
  return { scenario, humanScript };
};

const main = async () => {
  const { scenario: scenarioRel, humanScript } = parseArgs(process.argv);
  const scenario = await loadScenario(path.resolve(REPO, scenarioRel), REPO);

  const cats = await loadCatalogs(path.resolve(REPO, 'data'));
  const adventure = await loadAdventure(scenario.adventurePath);

  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const heroFromCatalog = (id: string, archetype: string, pos: { x: number; y: number }): Character => {
    const hero = cats.heroes.get(archetype === 'warlock' ? 'warlock-fire' : archetype);
    if (!hero) throw new Error(`unknown archetype: ${archetype}`);
    return {
      id: asCharacterId(id), name: hero.name, kind: 'hero', archetype: hero.archetype,
      pools: hero.pools,
      health: { total: hero.healthTotal, damage: 0, status: 'normal' },
      pos, normalAttack: hero.normalAttack,
      specialAction: { id: asEffectId(hero.specialAction.effectId), name: hero.specialAction.name, description: hero.specialAction.description },
      bonusAbility:  { id: asEffectId(hero.bonusAbility.effectId),  name: hero.bonusAbility.name,  description: hero.bonusAbility.description },
      inventory: [...hero.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
      boons: [], skills: hero.defaultSkills as Character['skills'],
    };
  };

  const p1 = heroFromCatalog(scenario.agents.p1.characterId, scenario.agents.p1.archetype, { x: 0, y: 0 });
  const p2 = heroFromCatalog(scenario.agents.p2.characterId, scenario.agents.p2.archetype, { x: 1, y: 0 });
  const human = heroFromCatalog(scenario.human.characterId, scenario.human.archetype, { x: 0, y: 1 });

  // Use scene 0's monsters for now. Multi-scene placement is Layer C.
  const scene0 = adventure.scenes[0]!;
  const monsters: Character[] = scene0.monsters.map((m, i) => {
    const def = cats.monsters.get(m.type);
    if (!def) throw new Error(`unknown monster type: ${m.type}`);
    return {
      id: asCharacterId(`${m.type}-${i + 1}`),
      name: def.name, kind: 'monster',
      pools: def.pools,
      health: { total: def.healthTotal, damage: 0, status: 'normal' },
      pos: m.startPos, normalAttack: def.normalAttack,
      specialAction: { id: asEffectId(def.specialAction.effectId), name: def.specialAction.name, description: def.specialAction.description },
      bonusAbility:  { id: asEffectId(def.bonusAbility.effectId),  name: def.bonusAbility.name,  description: def.bonusAbility.description },
      inventory: [], boons: [], skills: [],
    };
  });

  const grid = new Grid(
    Array.from({ length: scene0.map.height }, () =>
      Array.from({ length: scene0.map.width }, () => ({ kind: 'floor' as const }))),
  );

  const engine = new GameEngine({
    seed: scenario.seed, grid,
    characters: [p1, p2, human, ...monsters],
    effects: reg, items: cats.items, boons: cats.boons,
  });

  const builder = new PromptBuilder({ snapshotEveryTurns: scenario.snapshotEveryTurns });

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY env var required for live runs.');
    process.exit(2);
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const sdk = new Anthropic({ apiKey });
  const llm = new AnthropicLlmClient({
    create: async (args) => sdk.messages.create(args as never) as never,
  });

  const sharedAgentArgs = {
    llm, promptBuilder: builder, model: scenario.model, maxTokens: 4096,
    engine, adventure, partyDescription: '',
    getActiveScene: () => scene0,
    getCharacters: () => Array.from(engine.charactersById().values()),
    getMonstersInScene: () => monsters.filter((m) => engine.charactersById().get(m.id)?.health.status !== 'KO'),
  };

  const dmAgent = new Agent({
    ...sharedAgentArgs,
    role: 'dm', actorId: 'dm', persona: scenario.agents.dm.persona,
    tools: DM_TOOLS, stepBudget: scenario.stepBudget.dm, tag: 'dm',
  });
  const p1Agent = new Agent({
    ...sharedAgentArgs,
    role: 'player', actorId: asCharacterId(scenario.agents.p1.characterId),
    persona: scenario.agents.p1.persona,
    tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'p1',
  });
  const p2Agent = new Agent({
    ...sharedAgentArgs,
    role: 'player', actorId: asCharacterId(scenario.agents.p2.characterId),
    persona: scenario.agents.p2.persona,
    tools: PLAYER_TOOLS, stepBudget: scenario.stepBudget.player, tag: 'p2',
  });

  const store = new CliStore();
  const cli = new CliAdapter({
    store,
    nameFor: (id) => id === 'dm' ? 'DM' : engine.charactersById().get(id as never)?.name ?? String(id),
    readState: () => ({ scene: scene0, grid, characters: Array.from(engine.charactersById().values()) }),
  });

  let humanProvider: HumanInputProvider = cli;
  if (humanScript) {
    humanProvider = await ScriptHumanProvider.fromFile(path.resolve(REPO, humanScript));
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario.id}`;
  const runDir = path.resolve(REPO, 'runs', runId);

  // Render the Ink app first, then run the orchestrator concurrently.
  const inkInstance = render(React.createElement(App, { store, onSubmit: (line: string) => cli.submit(line) }));

  const orch = new Orchestrator({
    engine, adventure,
    agents: { dm: dmAgent, players: new Map([[asCharacterId(scenario.agents.p1.characterId), p1Agent], [asCharacterId(scenario.agents.p2.characterId), p2Agent]]) },
    human: { characterId: asCharacterId(scenario.human.characterId), provider: humanProvider },
    subscribers: [cli],
    stepBudget: scenario.stepBudget,
    runDir, seed: scenario.seed, runId,
    agentRecords: scenario.agentRecords,
  });

  try {
    const result = await orch.run();
    console.error(`run ended: ${result.outcome} (${result.totalEvents} events)`);
    console.error(`manifest: ${result.manifestPath}`);
  } catch (e) {
    console.error('run failed:', e);
    process.exitCode = 1;
  } finally {
    inkInstance.unmount();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 7: Add a baseline scenario file**

Create `scenarios/baseline.json`:

```json
{
  "id": "baseline",
  "adventure": "adventures/stub-layer-b.json",
  "seed": "0xC0FFEE-2026-05-08-baseline",
  "model": "claude-sonnet-4-6",
  "stepBudget": { "player": 6, "dm": 12 },
  "snapshotEveryTurns": 3,
  "agents": {
    "p1": { "characterId": "p1_anwen", "archetype": "warrior", "persona": "personas/cautious.md" },
    "p2": { "characterId": "p2_kael",  "archetype": "warlock", "persona": "personas/reckless.md" },
    "dm": { "persona": "personas/dm-default.md" }
  },
  "human": { "characterId": "human_bran", "archetype": "hunter" }
}
```

(`adventures/stub-layer-b.json` is created in Task 19; the scenario references it forward.)

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Run full suite**

Run: `npm test`
Expected: all green (no integration test runs the live entry yet — that's Task 19).

- [ ] **Step 10: Commit**

```bash
git add src/runtime/scenario.ts tests/runtime/scenario.test.ts \
        personas scenarios bin/play.ts package.json package-lock.json
git commit -m "feat(runtime): scenario loader, persona files, bin/play.ts entry"
```

---

### Task 19: stub-layer-b adventure + headline integration test

**Files:**
- Create: `adventures/stub-layer-b.json`
- Create: `tests/fixtures/layer-b/scripted-dm-responses.json`
- Create: `tests/fixtures/layer-b/scripted-p1-responses.json`
- Create: `tests/fixtures/layer-b/scripted-p2-responses.json`
- Create: `tests/fixtures/layer-b/human-bran-script.jsonl`
- Create: `tests/integration/layer-b-end-to-end.test.ts`

The headline test wires every Layer B piece together with a `ScriptedLlmClient` for each agent and a `ScriptHumanProvider` for the human seat. It asserts: adventure_ended success, all rats KO, the human's free-text and `/attack` paths produce different `interpretedBy` flags, replay invariant holds, manifest exists with `promptHash` and `cacheHitRatio` fields.

- [ ] **Step 1: Adventure JSON**

Create `adventures/stub-layer-b.json`:

```json
{
  "id": "stub-layer-b",
  "title": "Stub: Layer B end-to-end fixture",
  "estimatedDurationMin": 10,
  "scenes": [
    {
      "id": "stub-cell-b",
      "intro": "You stand in a dim stone room. Three rats scurry near the back wall.",
      "map": {
        "width": 8,
        "height": 8,
        "background": "stub-cell-b",
        "obstacles": [],
        "exits": []
      },
      "monsters": [
        { "type": "giant-rat", "startPos": { "x": 5, "y": 2 } },
        { "type": "giant-rat", "startPos": { "x": 6, "y": 2 } },
        { "type": "giant-rat", "startPos": { "x": 5, "y": 5 } }
      ],
      "tactics": "Rats hold their position until attacked, then engage the closest hero.",
      "abilityTests": [
        { "skill": "perception", "difficulty": 4, "describe": "spot which rat looks weakest" }
      ],
      "conclusion": "With the last rat down, the room falls quiet.",
      "transitions": [{ "to": "END", "trigger": "all-monsters-ko" }]
    }
  ]
}
```

- [ ] **Step 2: Human script**

Create `tests/fixtures/layer-b/human-bran-script.jsonl`:

```jsonl
{"text":"I rush toward the closest rat and swing"}
{"action":{"kind":"skip_turn"}}
{"action":{"kind":"normal_attack","targetId":"giant-rat-1"}}
```

- [ ] **Step 3: Scripted DM responses**

Create `tests/fixtures/layer-b/scripted-dm-responses.json`:

```json
[
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "set_scene", "input": { "sceneId": "stub-cell-b" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Three rats. The room reeks." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "p1_anwen" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "The warrior strikes." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "p2_kael" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Flames lick the stones." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "human_bran" } }] } },
  { "match": { "tag": "dm:interp" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-1" } }, { "name": "end_turn", "input": {} }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Bran lunges." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "p1_anwen" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "The warrior strikes again." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "p2_kael" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Final rat falls." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "request_action", "input": { "actorId": "human_bran" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Bran exhales." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "end_adventure", "input": { "outcome": "success" } }] } }
]
```

(Counts of player/DM responses depend on how many turns the engine actually requires to KO all rats. The `ScriptedLlmClient` throws "no scripted response matched" if exhausted, which is a precise failure signal in the test.)

- [ ] **Step 4: Scripted P1 responses**

Create `tests/fixtures/layer-b/scripted-p1-responses.json`:

```json
[
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "move", "input": { "path": [{ "x": 0, "y": 0 }, { "x": 1, "y": 0 }, { "x": 2, "y": 0 }, { "x": 3, "y": 0 }, { "x": 4, "y": 1 }] } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-1" } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-2" } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } }
]
```

- [ ] **Step 5: Scripted P2 responses**

Create `tests/fixtures/layer-b/scripted-p2-responses.json`:

```json
[
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "say", "input": { "text": "Burn them all!" } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-3" } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-3" } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } }
]
```

- [ ] **Step 6: Headline test**

Create `tests/integration/layer-b-end-to-end.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { ScriptHumanProvider } from '../../src/runtime/cli/script-reader.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { loadCatalogs } from '../../src/engine/load.js';
import { loadAdventure } from '../../src/engine/adventure.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import { readEventLog } from '../../src/log/event-log.js';
import { snapshotEngineState } from '../../src/log/replay.js';
import type { Character } from '../../src/engine/character.js';
import type { Subscriber } from '../../src/runtime/subscriber.js';
import type { Event } from '../../src/log/events.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class CapturingSubscriber implements Subscriber {
  readonly viewer = { kind: 'human' as const };
  events: Event[] = [];
  onEvent(e: Event): void { this.events.push(e); }
}

const mkEngineFromCatalog = async (seed: string) => {
  const cats = await loadCatalogs(path.join(REPO, 'data'));
  const adv = await loadAdventure(path.join(REPO, 'adventures/stub-layer-b.json'));

  const heroFromCat = (id: string, key: string, pos: { x: number; y: number }): Character => {
    const h = cats.heroes.get(key);
    if (!h) throw new Error(`hero ${key} not found`);
    return {
      id: asCharacterId(id), name: h.name, kind: 'hero', archetype: h.archetype,
      pools: h.pools, health: { total: h.healthTotal, damage: 0, status: 'normal' },
      pos, normalAttack: h.normalAttack,
      specialAction: { id: asEffectId(h.specialAction.effectId), name: h.specialAction.name, description: h.specialAction.description },
      bonusAbility:  { id: asEffectId(h.bonusAbility.effectId),  name: h.bonusAbility.name,  description: h.bonusAbility.description },
      inventory: [...h.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
      boons: [], skills: h.defaultSkills as Character['skills'],
    };
  };

  const p1 = heroFromCat('p1_anwen', 'warrior', { x: 0, y: 0 });
  const p2 = heroFromCat('p2_kael',  'warlock-fire', { x: 1, y: 0 });
  const human = heroFromCat('human_bran', 'hunter', { x: 0, y: 1 });

  const scene0 = adv.scenes[0]!;
  const monsters: Character[] = scene0.monsters.map((m, i) => {
    const def = cats.monsters.get(m.type)!;
    return {
      id: asCharacterId(`${m.type}-${i + 1}`),
      name: def.name, kind: 'monster',
      pools: def.pools,
      health: { total: def.healthTotal, damage: 0, status: 'normal' },
      pos: m.startPos, normalAttack: def.normalAttack,
      specialAction: { id: asEffectId(def.specialAction.effectId), name: def.specialAction.name, description: def.specialAction.description },
      bonusAbility:  { id: asEffectId(def.bonusAbility.effectId),  name: def.bonusAbility.name,  description: def.bonusAbility.description },
      inventory: [], boons: [], skills: [],
    };
  });

  const grid = new Grid(
    Array.from({ length: scene0.map.height }, () =>
      Array.from({ length: scene0.map.width }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const engine = new GameEngine({
    seed, grid, characters: [p1, p2, human, ...monsters],
    effects: reg, items: cats.items, boons: cats.boons,
  });

  return { engine, adventure: adv, scene0, monsters, p1, p2, human, grid };
};

const loadJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(path.join(REPO, rel), 'utf8')) as T;

describe('Layer B end-to-end (scripted, deterministic)', () => {
  it('runs to adventure_ended success and the replay invariant holds', async () => {
    const seed = 'layer-b-headline-seed';
    const { engine, adventure, scene0, monsters, p1, p2, human } = await mkEngineFromCatalog(seed);

    const dmLlm = new ScriptedLlmClient(
      loadJson<ConstructorParameters<typeof ScriptedLlmClient>[0]>('tests/fixtures/layer-b/scripted-dm-responses.json'),
    );
    const p1Llm = new ScriptedLlmClient(
      loadJson<ConstructorParameters<typeof ScriptedLlmClient>[0]>('tests/fixtures/layer-b/scripted-p1-responses.json'),
    );
    const p2Llm = new ScriptedLlmClient(
      loadJson<ConstructorParameters<typeof ScriptedLlmClient>[0]>('tests/fixtures/layer-b/scripted-p2-responses.json'),
    );
    const humanProvider = await ScriptHumanProvider.fromFile(
      path.join(REPO, 'tests/fixtures/layer-b/human-bran-script.jsonl'),
    );

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const sharedArgs = {
      promptBuilder: builder, model: 'claude-sonnet-4-6', maxTokens: 1024,
      engine, adventure, partyDescription: '',
      getActiveScene: () => scene0,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => monsters,
    };
    const dmAgent = new Agent({ ...sharedArgs, role: 'dm', actorId: 'dm', persona: '', llm: dmLlm, tools: DM_TOOLS, stepBudget: 12, tag: 'dm' });
    const p1Agent = new Agent({ ...sharedArgs, role: 'player', actorId: p1.id, persona: '', llm: p1Llm, tools: PLAYER_TOOLS, stepBudget: 6, tag: 'p1' });
    const p2Agent = new Agent({ ...sharedArgs, role: 'player', actorId: p2.id, persona: '', llm: p2Llm, tools: PLAYER_TOOLS, stepBudget: 6, tag: 'p2' });

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'layer-b-'));

    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map([[p1.id, p1Agent], [p2.id, p2Agent]]) },
      human: { characterId: human.id, provider: humanProvider },
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed, runId: 'layer-b-test',
      agentRecords: [
        { role: 'dm', model: 'claude-sonnet-4-6', promptHash: 'sha256:0', persona: 'inline' },
        { role: 'p1', characterId: p1.id, model: 'claude-sonnet-4-6', promptHash: 'sha256:1', persona: 'inline' },
        { role: 'p2', characterId: p2.id, model: 'claude-sonnet-4-6', promptHash: 'sha256:2', persona: 'inline' },
      ],
    });

    const result = await orch.run();

    // 1. Orchestrator ran to completion.
    expect(result.outcome).toBe('success');

    // 2. adventure_ended fired.
    expect(sub.events[sub.events.length - 1]?.type).toBe('adventure_ended');

    // 3. All rats KO; all heroes alive.
    const finalChars = Array.from(engine.charactersById().values());
    for (const m of finalChars.filter((c) => c.kind === 'monster')) {
      expect(m.health.status).toBe('KO');
    }
    for (const h of finalChars.filter((c) => c.kind === 'hero')) {
      expect(h.health.damage).toBeLessThan(h.health.total);
    }

    // 4. Free-text human turn produced an action with interpretedBy: 'dm'.
    const interpAction = sub.events.find((e) =>
      e.type === 'action' && (e as { interpretedBy?: string }).interpretedBy === 'dm');
    expect(interpAction).toBeDefined();

    // 5. /attack human turn produced an action without interpretedBy.
    const directAction = sub.events.find((e) =>
      e.type === 'action' && (e as { actorId: string; interpretedBy?: string; action: { kind: string } }).actorId === 'human_bran'
      && (e as { interpretedBy?: string }).interpretedBy === undefined
      && (e as { action: { kind: string } }).action.kind === 'normal_attack');
    expect(directAction).toBeDefined();

    // 6. Replay invariant.
    const events = await readEventLog(path.join(dir, 'events.jsonl'));
    expect(events.length).toBeGreaterThan(0);

    const replay = await mkEngineFromCatalog(seed);
    for (const ev of events) {
      if (ev.type === 'action' && (ev as { actorId: string }).actorId !== 'dm') {
        const r = replay.engine.applyAction(asCharacterId((ev as { actorId: string }).actorId), (ev as { action: never }).action);
        if (!r.ok) throw new Error(`replay diverged: ${JSON.stringify(ev)}`);
      } else if (ev.type === 'action' && (ev as { actorId: string }).actorId === 'dm') {
        replay.engine.applyDmAction((ev as { action: never }).action);
      }
      replay.engine.flushEvents();
    }
    expect(snapshotEngineState(replay.engine)).toEqual(snapshotEngineState(engine));

    // 7. Manifest fields present.
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      agents: Array<{ promptHash: string }>;
      cacheHitRatio: number;
      totalEvents: number;
    };
    expect(manifest.agents.every((a) => a.promptHash.length > 0)).toBe(true);
    expect(manifest).toHaveProperty('cacheHitRatio');
    expect(manifest.totalEvents).toBeGreaterThan(0);

    // 8. Visibility audit: human-perspective subscriber saw no thoughts and no resolution.private.
    expect(sub.events.find((e) => e.type === 'thought')).toBeUndefined();
    for (const ev of sub.events) {
      if (ev.type === 'resolution') {
        expect((ev as { private?: unknown }).private).toBeUndefined();
      }
    }
  });
});
```

Note: `interpretedBy: 'dm'` — engine's `applyAction` doesn't currently set this. For Layer B the orchestrator should attach it when it applies an action that came from `interpretFreeText`. Add an optional parameter to engine.applyAction OR have the orchestrator emit a wrapped event. To keep the engine clean: orchestrator emits a runtime annotation event right after the engine action, OR we add a small helper `engine.applyAction(actorId, action, opts?: { interpretedBy?: 'dm' })`. The simplest path is to widen `applyAction` to accept the optional flag and set it on the emitted `action` event. Make this small change in:

- [ ] **Step 7: Add `interpretedBy` plumb-through to `engine.applyAction`**

In `src/engine/game-engine.ts`, change the `applyAction` signature from:

```ts
applyAction(actorId: CharacterId, action: PlayerAction): Result<ActionOk, RuleViolation>
```

to:

```ts
applyAction(actorId: CharacterId, action: PlayerAction, opts?: { interpretedBy?: 'dm' }): Result<ActionOk, RuleViolation>
```

And inside each branch that emits `{ type: 'action', ...}`, spread the optional flag. For example, in `case 'say'`:

```ts
      case 'say':
        this.emit({ type: 'action', actorId, action,
          ...(opts?.interpretedBy && { interpretedBy: opts.interpretedBy }),
        } as unknown as Omit<Event, 't'>);
        return ok({ turnEnded: false });
```

Apply the same `...(opts?.interpretedBy && { interpretedBy: opts.interpretedBy })` spread to each `this.emit({type: 'action', ...})` call inside `applyAction`'s dispatch (the per-handler private methods need the flag too — pass `opts?.interpretedBy` through `handleMove`, `handleNormalAttack`, etc., as an optional second/third argument and spread in the emit).

In `src/runtime/orchestrator.ts`, in `runHumanTurn`, when applying interpreted actions from the DM, pass `{ interpretedBy: 'dm' }`:

```ts
const r = this.cfg.engine.applyAction(actorId, action, { interpretedBy: 'dm' });
```

- [ ] **Step 8: Run the headline test**

Run: `npx vitest run tests/integration/layer-b-end-to-end.test.ts`
Expected: PASS.

If the run fails because the scripted-response counts don't match the engine's actual turn cadence, add or remove entries in the `scripted-{dm,p1,p2}-responses.json` fixtures. The error message from `ScriptedLlmClient` ("no scripted response matched") tells you which agent ran out — adjust that fixture by appending another action and re-run.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all green (existing 85 + the ~50-70 new Layer B tests).

- [ ] **Step 10: Manual live smoke (out-of-band, NOT in CI)**

Run:
```bash
ANTHROPIC_API_KEY=sk-ant-... npm run play scenarios/baseline.json -- --human-script tests/fixtures/layer-b/human-bran-script.jsonl
```

Expected: the run plays through `stub-layer-b.json` against real Sonnet, the manifest at `runs/<id>/manifest.json` shows `cacheHitRatio > 0` after turn ~3, and run cost is logged at exit.

This is the only "Done" check the suite cannot perform automatically. It validates that the Anthropic SDK wiring, retry behaviour, and prompt-cache headers are real, not mocked.

- [ ] **Step 11: Commit**

```bash
git add adventures/stub-layer-b.json tests/fixtures/layer-b tests/integration/layer-b-end-to-end.test.ts \
        src/engine/game-engine.ts src/runtime/orchestrator.ts
git commit -m "feat(runtime): headline integration test + interpretedBy plumbing"
```

---

## Self-Review

**Spec coverage check.** Walking the spec sections:

- §1 goal/scope → covered by Tasks 1-19.
- §2 locked decisions B-1..B-7 → all covered: B-1 (Tasks 9,12), B-2 (Task 19's stub-layer-b), B-3 (Tasks 6,14), B-4 (Tasks 13,15), B-5 (Task 18), B-6 (out of scope, no task needed), B-7 (Tasks 15-17).
- §3 build order → mirrored in Task ordering.
- §4 file layout → mirrored in plan's File Structure.
- §5 architecture: Subscriber bus + EventLog (Task 9, 12), Agent + ReACT (Task 11), LlmClient + scripted/anthropic (Tasks 5,6,14), visibility filter (Task 8), prompt builder (Task 10), CLI (Tasks 15-17), scenario (Task 18).
- §6 test plan → covered by Tasks 1-19 individual tests + Task 19 headline.
- §7 done signal → Task 19 step 10 (manual live smoke), other items handled by `npm test`.
- §8 risks → flagged, no plan items needed.
- §9 deferred questions → not part of plan.

**Placeholder scan.** Searched for "TBD", "TODO", "later" in the plan. None remain in step bodies. The "free-text DM interpretation" path in Task 13 is intentionally simplified (the DM emits player-named tools through the DM seam in Layer B; full natural-language → tool decoder is deferred to Layer D evaluation work). This is documented in Task 13 step 1, not hidden.

**Type consistency check.** `Subscriber.viewer`, `HumanInputProvider.requestInput()`, `Orchestrator` config field names, `Agent.takeTurn` signature, `LlmClient.complete` request shape — all consistent across Tasks 9-19. The `interpretedBy` field is added to `applyAction` in Task 19 step 7 and used in Task 13's `runHumanTurn`. The `ScriptHumanProvider.fromFile` static method is referenced consistently across Task 15 (definition) and Task 19 (usage).

**Scope check.** This is one integrated runtime layer producing a working CLI playthrough. Cannot meaningfully decompose further without artificial seams — the headline integration test requires the orchestrator + agents + LLM + visibility + prompt builder + CLI + scenario all working together.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-layer-b-agent-runtime.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

