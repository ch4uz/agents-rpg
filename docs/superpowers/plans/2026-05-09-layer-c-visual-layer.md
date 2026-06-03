# Layer C — Visual Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Pixi.js + WebSocket browser view to the Layer B runtime, close the multi-target special-action dispatch gap, and encode Basement O' Rats encounter 1 so a real adventure plays through the new visual stack against real Sonnet.

**Architecture:** A new `WsAdapter` Subscriber (server-side) JSON-encodes Subscriber callbacks and ships them over WS to a Vite-built browser bundle. The browser uses `lit-html` for DOM panels and Pixi.js for the board. The Layer B Subscriber bus is unchanged; the Ink CLI `CliAdapter` keeps working as a parallel subscriber selectable via `--cli`. Engine-side, `handleSpecialAction` gets per-effect dispatch, a new `isEngaged` helper, and a redacted snapshot serializer reused for browser reconnect.

**Tech Stack:** TypeScript (server + browser), Vite, Pixi.js, `lit-html`, `ws`, vitest, jsdom.

**Spec:** `docs/superpowers/specs/2026-05-09-layer-c-visual-design.md`
**Parent spec:** `docs/superpowers/specs/2026-05-08-agents-rpg-design.md`
**Predecessor plans:** `docs/superpowers/plans/2026-05-08-layer-b-agent-runtime.md`, `docs/superpowers/plans/2026-05-09-layer-b-audit-fixes.md`

---

## File Structure

```
src/engine/
  game-engine.ts            (modify — Tasks 3-6, 8)
  effects.ts                (modify — Tasks 3-6)
  action.ts                 (modify — Task 1; add new RuleViolation reasons)
  engaged.ts                (NEW — Task 1; isEngaged helper)
  resolution.ts             (modify — Task 2; consume targetEngaged)
  snapshot.ts               (NEW — Task 8; getRedactedSnapshot)

src/runtime/prompt/
  tools.ts                  (modify — Task 7; special_action.params.diceSplit)

src/runtime/ws/             (NEW)
  protocol.ts               (Task 11; envelope types + codecs)
  adapter.ts                (Tasks 12-13)
  manifest.ts               (Task 10; validator)
  server.ts                 (Task 14)

assets/                     (extended in Task 9)
  manifest.json             (NEW)
  heroes/{warrior,hunter,healer,warlock}.png  (moved/renamed)
  monsters/{giant-rat,king-rat}.png           (NEW — from PDFs)
  maps/{tavern-basement,...}.png              (NEW — at minimum tavern-basement)

web/                        (NEW — Vite root)
  index.html                (Task 16)
  main.ts                   (Task 16)
  store.ts                  (Task 17)
  ws-client.ts              (Task 18)
  components/{Layout,HeroCard,ChatLog,InputBox}.ts  (Task 19)
  components/{Board,RollOverlay}.ts                 (Tasks 20-21)
  styles/main.css           (Task 16)

vite.config.ts              (NEW — Task 16)
package.json                (modify — Task 16)
bin/play.ts                 (modify — Task 22)
adventures/basement-o-rats.json  (NEW — Task 23)
scenarios/basement-o-rats.json   (NEW — Task 23)

tests/engine/
  engaged.test.ts                          (NEW — Task 1)
  special-actions.test.ts                  (NEW — Tasks 3-6)
  special-actions-validation.test.ts       (NEW — Tasks 3-6)
  snapshot-redacted.test.ts                (NEW — Task 8)
tests/runtime/ws/
  protocol.test.ts                         (NEW — Task 11)
  ws-adapter.test.ts                       (NEW — Tasks 12-13)
  manifest.test.ts                         (NEW — Task 10)
  reconnect.test.ts                        (NEW — Task 15)
tests/web/
  store.test.ts                            (NEW — Task 17)
  cards.test.ts                            (NEW — Task 19)
  board.test.ts                            (NEW — Task 20)
tests/integration/
  ws-stub-adventure.test.ts                (NEW — Task 24)
  basement-o-rats-encounter-1.test.ts      (NEW — Task 25)
tests/fixtures/layer-c/
  human-bran-script.jsonl                  (NEW — Task 26 / live smoke)
```

---

## Test helpers used throughout

These helpers (already used in Layer B tests) are reused. Don't redefine them per task — import from existing test files where they live, or copy the small ones into a new test file as needed.

```ts
// Already present in tests/engine/game-engine.test.ts — duplicate with the
// shape you need; a couple of multi-character variants are introduced below.
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
```

`grid8x8()` (a `Grid` of 8×8 floor cells) and `hero(id, x, y, overrides?)` / `monster(id, x, y, overrides?)` factories are reproduced inline in each new test file rather than centralized — Layer A/B avoided a shared test helper module on purpose.

---

## Task 1: New RuleViolation reasons + `isEngaged` helper

**Files:**
- Modify: `src/engine/action.ts:55-73`
- Create: `src/engine/engaged.ts`
- Create: `tests/engine/engaged.test.ts`

- [ ] **Step 1: Write the failing test for `isEngaged`**

Create `tests/engine/engaged.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isEngaged } from '../../src/engine/engaged.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const ch = (id: string, x: number, y: number, kind: 'hero' | 'monster' = 'hero'): Character => ({
  id: asCharacterId(id),
  name: id,
  kind,
  archetype: kind === 'hero' ? 'warrior' : undefined,
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('noop'), name: 'noop', description: '' },
  bonusAbility:  { id: asEffectId('noop'), name: 'noop', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('isEngaged', () => {
  it('returns false when only the attacker is adjacent to the target', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const target   = ch('m1', 1, 0, 'monster');
    const others: Character[] = [];
    expect(isEngaged(target, [attacker, ...others], 'hero')).toBe(false);
  });

  it('returns true when target is adjacent to ≥2 attacker-team members (incl. attacker)', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const ally     = ch('h2', 1, 1, 'hero');
    const target   = ch('m1', 1, 0, 'monster');
    expect(isEngaged(target, [attacker, ally], 'hero')).toBe(true);
  });

  it('does not count KO\'d teammates as engaging', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const ally     = { ...ch('h2', 1, 1, 'hero'), health: { total: 3, damage: 3, status: 'KO' as const } };
    const target   = ch('m1', 1, 0, 'monster');
    expect(isEngaged(target, [attacker, ally], 'hero')).toBe(false);
  });

  it('counts at least 2 monsters when the attacker team is monsters', () => {
    const attacker = ch('m1', 0, 0, 'monster');
    const ally     = ch('m2', 1, 1, 'monster');
    const target   = ch('h1', 1, 0, 'hero');
    expect(isEngaged(target, [attacker, ally], 'monster')).toBe(true);
  });

  it('returns false when target has no position', () => {
    const attacker = ch('h1', 0, 0, 'hero');
    const target   = { ...ch('m1', 1, 0, 'monster'), pos: null };
    expect(isEngaged(target, [attacker], 'hero')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/engine/engaged.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/engaged.js'`.

- [ ] **Step 3: Implement `isEngaged`**

Create `src/engine/engaged.ts`:

```ts
import type { Character } from './character.js';
import { chebyshevDistance } from './primitives.js';

/**
 * A target is "engaged" by `team` iff at least two non-KO'd members of
 * `team` (including the attacker, if they're on `team`) are adjacent to
 * the target. HeroKids manual p.12 references "engaged target" as the
 * trigger for Teamwork (+1 hero attack die) and Pack Attack (+1 monster
 * attack die).
 *
 * Symmetric: works the same way for the monster team.
 */
export const isEngaged = (
  target: Character,
  team: readonly Character[],
  attackerKind: 'hero' | 'monster',
): boolean => {
  if (!target.pos) return false;
  let adjacent = 0;
  for (const c of team) {
    if (c.kind !== attackerKind) continue;
    if (c.health.status === 'KO') continue;
    if (!c.pos) continue;
    if (chebyshevDistance(c.pos, target.pos) === 1) adjacent += 1;
    if (adjacent >= 2) return true;
  }
  return false;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/engine/engaged.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add new `RuleViolation` reasons**

Modify `src/engine/action.ts` — extend the `RuleViolation` union after line 73:

```ts
export type RuleViolation =
  | { reason: 'out-of-range' }
  | { reason: 'no-line-of-sight' }
  | { reason: 'invalid-target' }
  | { reason: 'not-actors-turn' }
  | {
      reason: 'unknown-id';
      what: 'item' | 'equipment' | 'boon' | 'character' | 'scene';
      id: string;
    }
  | { reason: 'wrong-phase' }
  | { reason: 'insufficient-movement' }
  | { reason: 'blocked-by-wall' }
  | { reason: 'no-such-effect' }
  | { reason: 'already-moved' }
  | { reason: 'action-already-used' }
  | { reason: 'invalid-action-shape'; details: string }
  // Layer C — multi-target special-action dispatch
  | { reason: 'targets-required' }
  | { reason: 'target-not-adjacent'; targetId: string }
  | { reason: 'target-out-of-range'; targetId: string }
  | { reason: 'invalid-split-sum'; expected: number; actual: number }
  | { reason: 'invalid-split-shape'; details: string };
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: clean — the new variants are additions; no existing code matches them yet.

- [ ] **Step 7: Commit**

```bash
git add src/engine/engaged.ts src/engine/action.ts tests/engine/engaged.test.ts
git commit -m "feat(engine): isEngaged helper + multi-target rule-violation reasons"
```

---

## Task 2: Wire `targetEngaged` into `resolveAttack`

The existing `teamwork` bonus passive consumes a `targetEngaged` boolean from `params`, but no caller computes it. `pack-attack` will need the same value. This task threads it through the normal-attack path so `teamwork` actually fires.

**Files:**
- Modify: `src/engine/game-engine.ts:331-399` (`handleNormalAttack`)
- Modify: `tests/engine/game-engine.test.ts` (extend the existing attack test)

- [ ] **Step 1: Write the failing test**

Add to `tests/engine/game-engine.test.ts` after the existing attack tests:

```ts
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
    const resolution = events.find((e) => e.type === 'resolution') as { private: { attackRoll: number[] } };
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
    const resolution = events.find((e) => e.type === 'resolution') as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `npm test -- tests/engine/game-engine.test.ts`
Expected: the engaged test FAILS with `expect(3).toBe(...)` — currently both attacks roll 2 dice.

- [ ] **Step 3: Modify `handleNormalAttack` to compute and apply `targetEngaged`**

In `src/engine/game-engine.ts`, replace the body of `handleNormalAttack` (around line 331-399) with code that calls `isEngaged` and runs the actor's bonus-passive effect to get `extraAttackDice`. Add at the top of the file:

```ts
import { isEngaged } from './engaged.js';
```

Then inside `handleNormalAttack`, between the line-of-sight check and the `resolveAttack` call:

```ts
// Compute teamwork / pack-attack-style bonus dice from the actor's bonus
// passive. The passive consumes `targetEngaged` from params; engaged is
// defined as ≥ 2 non-KO'd attacker-team members adjacent to the target.
const allChars = Array.from(this.characters.values());
const engaged = isEngaged(target, allChars, actor.kind);
let extraAttackDice = 0;
const bonusEffectId = actor.bonusAbility.id;
if (this.effects.has(bonusEffectId)) {
  const bonusResult = this.effects.get(bonusEffectId).apply({
    actor, target, params: { targetEngaged: engaged },
  });
  for (const change of bonusResult.changes) {
    if (change.kind === 'attack-mod') extraAttackDice += change.extraDice;
  }
}

const pool = actor.pools[attackKind];
const result = resolveAttack(this.dice, {
  attackerPool: pool,
  defenderArmor: target.pools.armor,
  attackKind,
  modifiers: {
    extraAttackDice,
    extraArmorDice: extraArmor,
    damageMod: actor.normalAttack.damageMod,
  },
});
```

- [ ] **Step 4: Run the test, expect pass**

Run: `npm test -- tests/engine/game-engine.test.ts`
Expected: PASS — both teamwork tests green; existing attack tests still green.

- [ ] **Step 5: Run the full suite to make sure nothing else regressed**

Run: `npm test`
Expected: all tests pass (note: counts will diverge from CLAUDE.md once Layer C lands; ~240 expected after this task).

- [ ] **Step 6: Commit**

```bash
git add src/engine/game-engine.ts tests/engine/game-engine.test.ts
git commit -m "feat(engine): wire isEngaged + bonus-passive into normal attack resolution"
```

---

## Task 3: Multi-target dispatch — `whirlwind-attack`

Layer C goal #1: warrior's whirlwind splits the melee dice pool across multiple adjacent targets.

**Files:**
- Modify: `src/engine/effects.ts:101-107` (drop the noop placeholder)
- Modify: `src/engine/game-engine.ts:521-569` (replace `handleSpecialAction`)
- Create: `tests/engine/special-actions.test.ts`
- Create: `tests/engine/special-actions-validation.test.ts`

- [ ] **Step 1: Write the failing happy-path test**

Create `tests/engine/special-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const grid8x8 = (): Grid =>
  new Grid(Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));

const hero = (id: string, x: number, y: number, overrides: Partial<Character> = {}): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: 'Whirlwind', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [], boons: [], skills: [],
  ...overrides,
});

const monster = (id: string, x: number, y: number, overrides: Partial<Character> = {}): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
  health: { total: 1, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: 'Pack', description: '' },
  bonusAbility:  { id: asEffectId('coward'), name: 'Cow', description: '' },
  inventory: [], boons: [], skills: [],
  ...overrides,
});

const makeEngine = (chars: Character[], seed = 'wirl'): GameEngine => {
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({ seed, grid: grid8x8(), characters: chars, effects: reg });
};

describe('special_action: whirlwind-attack', () => {
  it('splits melee dice across two adjacent targets and resolves each separately', () => {
    const w  = hero('w', 1, 1);                         // melee 2
    const r1 = monster('r1', 1, 0);                     // adjacent N
    const r2 = monster('r2', 2, 1);                     // adjacent E
    const engine = makeEngine([w, r1, r2], 'whirl-pass');
    engine.beginNarrativeTurn(asCharacterId('w'));

    const r = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    expect(r.ok).toBe(true);

    const events = engine.flushEvents();
    const resolutions = events.filter((e) => e.type === 'resolution');
    expect(resolutions).toHaveLength(2);
    // each resolution exposes the attackerTop result; we only assert structure here
    for (const res of resolutions) {
      expect((res as { public: { attackerTop: number } }).public.attackerTop).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies damage independently to each target on hit', () => {
    // Force a hit by giving rats armor 0 and warrior melee 2 split 1/1.
    const w  = hero('w', 1, 1);
    const r1 = monster('r1', 1, 0, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const r2 = monster('r2', 2, 1, { pools: { melee: 1, ranged: 0, magic: 0, armor: 0 } });
    const engine = makeEngine([w, r1, r2], 'whirl-hit');
    engine.beginNarrativeTurn(asCharacterId('w'));

    engine.applyAction(asCharacterId('w'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    const events = engine.flushEvents();
    const stateChanges = events.filter((e) => e.type === 'state_change');
    // each rat should have a damage state_change with damage > 0
    expect(stateChanges.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Write the failing validation test**

Create `tests/engine/special-actions-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

// Reuse the same hero/monster/makeEngine factories (paste from above) — keep
// the tests self-contained per the project convention.
// ... [identical hero/monster/makeEngine helpers as in special-actions.test.ts]

describe('special_action: whirlwind validation', () => {
  it('targets-required when targetIds is empty', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val1');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [], params: { diceSplit: {} },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('targets-required');
  });

  it('target-not-adjacent when target is two squares away', () => {
    const w = hero('w', 1, 1); const r = monster('r', 4, 4);
    const engine = makeEngine([w, r], 'val2');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('target-not-adjacent');
  });

  it('invalid-split-sum when split does not sum to actor.pools.melee', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val3');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 5 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok && out.error.reason === 'invalid-split-sum') {
      expect(out.error.expected).toBe(2);
      expect(out.error.actual).toBe(5);
    } else {
      throw new Error(`expected invalid-split-sum, got ${JSON.stringify(out.error)}`);
    }
  });

  it('invalid-split-shape when diceSplit keys mismatch targetIds', () => {
    const w = hero('w', 1, 1); const r = monster('r', 1, 0);
    const engine = makeEngine([w, r], 'val4');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { wrong: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('invalid-split-shape');
  });
});
```

(Copy the same `hero`/`monster`/`makeEngine` factories from Step 1 into this file's top — see project convention note.)

- [ ] **Step 3: Run tests, expect failure**

Run: `npm test -- tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts`
Expected: all FAIL — current dispatch returns `noop` and ignores split.

- [ ] **Step 4: Drop the placeholder whirlwind effect**

In `src/engine/effects.ts`, replace lines 98-107:

```ts
  // Multi-target specials are dispatched directly by GameEngine.handleSpecialAction
  // (see src/engine/game-engine.ts). Their effect-registry entries return only
  // a narration so the registry's surface stays uniform; damage and resolution
  // are produced by the engine.
  reg.register('whirlwind-attack', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} sweeps a whirlwind of steel.`,
    }),
  });
```

- [ ] **Step 5: Replace `handleSpecialAction` with per-effect dispatch (whirlwind path only for now)**

In `src/engine/game-engine.ts`, replace `handleSpecialAction` (around lines 521-569) and remove the `LAYER C TODO` block:

```ts
private handleSpecialAction(
  actorId: CharacterId,
  action: Extract<PlayerAction, { kind: 'special_action' }>,
  opts?: { interpretedBy?: 'dm' },
): Result<ActionOk, RuleViolation> {
  if (this.turn.hasActed()) return err({ reason: 'action-already-used' });
  const actor = this.characters.get(actorId)!;
  const effectId = actor.specialAction.id;

  switch (effectId) {
    case asEffectId('whirlwind-attack'):
      return this.dispatchSplitAttack(actor, action, 'melee', 1, opts);
    default:
      return this.dispatchSingleEffect(actorId, action, opts);
  }
}

/**
 * Whirlwind / split-shot path. Validates the targets list and the diceSplit,
 * then runs one resolveAttack per target with the per-target dice override.
 *
 * `kind` selects the actor pool (`melee` for whirlwind, `ranged` for split-shot)
 * and the range check (1 for melee, the actor.normalAttack.range for ranged).
 */
private dispatchSplitAttack(
  actor: Character,
  action: Extract<PlayerAction, { kind: 'special_action' }>,
  kind: 'melee' | 'ranged',
  meleeRange: number,
  opts?: { interpretedBy?: 'dm' },
): Result<ActionOk, RuleViolation> {
  const targetIds = action.targetIds ?? [];
  if (targetIds.length === 0) return err({ reason: 'targets-required' });

  const split = (action.params?.['diceSplit'] ?? {}) as Record<string, number>;
  // Shape: every targetId has an entry, no extras.
  const splitKeys = Object.keys(split);
  if (splitKeys.length !== targetIds.length || !targetIds.every((id) => Object.prototype.hasOwnProperty.call(split, String(id)))) {
    return err({ reason: 'invalid-split-shape', details: 'diceSplit keys must match targetIds exactly' });
  }
  // Each value is a positive integer.
  for (const v of Object.values(split)) {
    if (!Number.isInteger(v) || v < 1) {
      return err({ reason: 'invalid-split-shape', details: 'each diceSplit value must be a positive integer' });
    }
  }
  // Sum equals actor pool.
  const expected = actor.pools[kind];
  const actual = Object.values(split).reduce((s, n) => s + n, 0);
  if (actual !== expected) {
    return err({ reason: 'invalid-split-sum', expected, actual });
  }

  // Resolve targets and check adjacency / range.
  const resolved: Character[] = [];
  for (const id of targetIds) {
    const t = this.characters.get(id);
    if (!t) return err({ reason: 'unknown-id', what: 'character', id: String(id) });
    if (t.health.status === 'KO') return err({ reason: 'invalid-target' });
    if (!actor.pos || !t.pos) return err({ reason: 'invalid-target' });
    const dist = chebyshevDistance(actor.pos, t.pos);
    if (kind === 'melee' && dist !== meleeRange) {
      return err({ reason: 'target-not-adjacent', targetId: String(id) });
    }
    if (kind === 'ranged') {
      if (dist > actor.normalAttack.range) {
        return err({ reason: 'target-out-of-range', targetId: String(id) });
      }
      const sight = this.grid.lineOfSight(actor.pos, t.pos);
      if (sight.blocked) return err({ reason: 'no-line-of-sight' });
    }
    resolved.push(t);
  }

  // Emit one action event for the whole special_action call.
  const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
  this.emit({ type: 'action', actorId: actor.id, action, ...interp } as unknown as Event);

  // One resolveAttack per target, using the split as the per-target pool.
  const allChars = Array.from(this.characters.values());
  for (const t of resolved) {
    const perTargetPool = split[String(t.id)] ?? 0;
    const result = resolveAttack(this.dice, {
      attackerPool: perTargetPool,
      defenderArmor: t.pools.armor,
      attackKind: kind,
      modifiers: { extraAttackDice: 0, extraArmorDice: 0, damageMod: 0 },
    });
    this.emit({
      type: 'resolution',
      actorId: actor.id,
      public: { hit: result.hit, damage: result.damage, attackerTop: result.attackerTop, defenderTop: result.defenderTop, targetId: t.id },
      private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
    } as unknown as Event);
    if (result.hit && result.damage > 0) {
      const damaged = applyDamage(t, result.damage);
      this.characters.set(t.id, damaged);
      this.emit({
        type: 'state_change',
        changes: [{ id: t.id, damage: damaged.health.damage, status: damaged.health.status }],
      } as unknown as Event);
    }
  }

  this.turn.markActed();
  return ok({ turnEnded: false });
}

/** Single-target effect path: keeps Layer A's healing-touch behavior intact. */
private dispatchSingleEffect(
  actorId: CharacterId,
  action: Extract<PlayerAction, { kind: 'special_action' }>,
  opts?: { interpretedBy?: 'dm' },
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

  const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
  this.emit({ type: 'action', actorId, action, ...interp } as unknown as Event);
  if (result.narration) {
    this.emit({
      type: 'resolution',
      actorId,
      public: { narration: result.narration, changes: result.changes },
    } as unknown as Event);
  }
  this.applyEffectChanges(actorId, result.changes);
  this.turn.markActed();
  return ok({ turnEnded: false });
}
```

`allChars` declaration in the new method is unused at this stage — it'll be used in Tasks 4-6. It's fine to leave or remove; lint won't allow unused. Remove the unused declaration:

```ts
// remove this line:
const allChars = Array.from(this.characters.values());
```

(The unused-vars warning would block the build; reintroduce when the engaged check lands in Task 6.)

- [ ] **Step 6: Run tests, expect pass**

Run: `npm test -- tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts`
Expected: PASS — 6 tests in the two files (2 happy + 4 validation).

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: all tests pass; existing `tests/engine/effects.test.ts` still asserts `whirlwind-attack` is registered (just with a different shape now).

- [ ] **Step 8: Commit**

```bash
git add src/engine/effects.ts src/engine/game-engine.ts \
  tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts
git commit -m "feat(engine): whirlwind-attack multi-target dispatch"
```

---

## Task 4: Multi-target dispatch — `split-shot`

Same shape as whirlwind, but ranged with line-of-sight.

**Files:**
- Modify: `src/engine/effects.ts:154-160` (drop placeholder)
- Modify: `src/engine/game-engine.ts` (extend `handleSpecialAction` switch)
- Extend: `tests/engine/special-actions.test.ts`, `tests/engine/special-actions-validation.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/engine/special-actions.test.ts`:

```ts
describe('special_action: split-shot', () => {
  it('splits ranged dice across two in-range targets with LOS', () => {
    const h  = hero('h', 0, 0, {
      pools: { melee: 0, ranged: 2, magic: 0, armor: 2 },
      normalAttack: { kind: 'ranged', name: 'Bow', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split', description: '' },
    });
    const r1 = monster('r1', 5, 0);
    const r2 = monster('r2', 0, 5);
    const engine = makeEngine([h, r1, r2], 'split-pass');
    engine.beginNarrativeTurn(asCharacterId('h'));
    const r = engine.applyAction(asCharacterId('h'), {
      kind: 'special_action',
      targetIds: [asCharacterId('r1'), asCharacterId('r2')],
      params: { diceSplit: { r1: 1, r2: 1 } },
    });
    expect(r.ok).toBe(true);
    const events = engine.flushEvents();
    expect(events.filter((e) => e.type === 'resolution')).toHaveLength(2);
  });
});
```

Append to `tests/engine/special-actions-validation.test.ts`:

```ts
describe('special_action: split-shot validation', () => {
  it('target-out-of-range when target is past range 6', () => {
    const h = hero('h', 0, 0, {
      pools: { melee: 0, ranged: 2, magic: 0, armor: 2 },
      normalAttack: { kind: 'ranged', name: 'Bow', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split', description: '' },
    });
    const r = monster('r', 7, 0);
    const engine = makeEngine([h, r], 'split-fail');
    engine.beginNarrativeTurn(asCharacterId('h'));
    const out = engine.applyAction(asCharacterId('h'), {
      kind: 'special_action', targetIds: [asCharacterId('r')], params: { diceSplit: { r: 2 } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe('target-out-of-range');
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npm test -- tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts`
Expected: the two new tests FAIL (split-shot still routes through `dispatchSingleEffect`).

- [ ] **Step 3: Drop the split-shot placeholder**

Replace `src/engine/effects.ts` lines 154-160:

```ts
  reg.register('split-shot', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} loses a fanned volley of arrows.`,
    }),
  });
```

- [ ] **Step 4: Add split-shot to the dispatch switch**

In `src/engine/game-engine.ts`, extend the `switch` in `handleSpecialAction`:

```ts
  switch (effectId) {
    case asEffectId('whirlwind-attack'):
      return this.dispatchSplitAttack(actor, action, 'melee', 1, opts);
    case asEffectId('split-shot'):
      return this.dispatchSplitAttack(actor, action, 'ranged', actor.normalAttack.range, opts);
    default:
      return this.dispatchSingleEffect(actorId, action, opts);
  }
```

- [ ] **Step 5: Run tests, expect pass**

Run: `npm test -- tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/effects.ts src/engine/game-engine.ts \
  tests/engine/special-actions.test.ts tests/engine/special-actions-validation.test.ts
git commit -m "feat(engine): split-shot multi-target dispatch"
```

---

## Task 5: Multi-target dispatch — `flame-burst`

Auto-targets all adjacent characters (allies + enemies, excluding self and KO'd). Agent does not supply `targetIds` for flame-burst.

**Files:**
- Modify: `src/engine/effects.ts:162-168`
- Modify: `src/engine/game-engine.ts`
- Extend: `tests/engine/special-actions.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/engine/special-actions.test.ts`:

```ts
describe('special_action: flame-burst', () => {
  it('hits every adjacent character (allies and enemies), 1 magic die each', () => {
    const w  = hero('w', 1, 1, {
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Burst', description: '' },
    });
    const ally = hero('a', 2, 1);
    const r1 = monster('r1', 1, 0);
    const r2 = monster('r2', 1, 2);
    const farRat = monster('r3', 5, 5);  // not adjacent — should NOT be hit
    const engine = makeEngine([w, ally, r1, r2, farRat], 'flame-pass');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), { kind: 'special_action' });
    expect(out.ok).toBe(true);

    const events = engine.flushEvents();
    const resolutions = events.filter((e) => e.type === 'resolution');
    // ally + r1 + r2 = 3 adjacent characters
    expect(resolutions).toHaveLength(3);
  });

  it('skips KO\'d adjacent characters', () => {
    const w  = hero('w', 1, 1, {
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Burst', description: '' },
    });
    const dead = monster('d', 1, 0, { health: { total: 1, damage: 1, status: 'KO' as const } });
    const r1 = monster('r1', 2, 1);
    const engine = makeEngine([w, dead, r1], 'flame-skip');
    engine.beginNarrativeTurn(asCharacterId('w'));
    const out = engine.applyAction(asCharacterId('w'), { kind: 'special_action' });
    expect(out.ok).toBe(true);
    const resolutions = engine.flushEvents().filter((e) => e.type === 'resolution');
    expect(resolutions).toHaveLength(1);  // only r1
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/engine/special-actions.test.ts`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Drop the flame-burst placeholder**

Replace `src/engine/effects.ts` lines 162-168:

```ts
  reg.register('flame-burst', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} explodes outward in a wave of flame.`,
    }),
  });
```

- [ ] **Step 4: Add flame-burst handler**

In `src/engine/game-engine.ts`, extend the switch and add `dispatchFlameBurst`:

```ts
  switch (effectId) {
    case asEffectId('whirlwind-attack'):
      return this.dispatchSplitAttack(actor, action, 'melee', 1, opts);
    case asEffectId('split-shot'):
      return this.dispatchSplitAttack(actor, action, 'ranged', actor.normalAttack.range, opts);
    case asEffectId('flame-burst'):
      return this.dispatchFlameBurst(actor, action, opts);
    default:
      return this.dispatchSingleEffect(actorId, action, opts);
  }
```

```ts
private dispatchFlameBurst(
  actor: Character,
  action: Extract<PlayerAction, { kind: 'special_action' }>,
  opts?: { interpretedBy?: 'dm' },
): Result<ActionOk, RuleViolation> {
  if (!actor.pos) return err({ reason: 'invalid-target' });
  const targets: Character[] = [];
  for (const c of this.characters.values()) {
    if (c.id === actor.id) continue;
    if (c.health.status === 'KO') continue;
    if (!c.pos) continue;
    if (chebyshevDistance(actor.pos, c.pos) === 1) targets.push(c);
  }

  const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
  this.emit({ type: 'action', actorId: actor.id, action, ...interp } as unknown as Event);

  for (const t of targets) {
    const result = resolveAttack(this.dice, {
      attackerPool: 1,
      defenderArmor: t.pools.armor,
      attackKind: 'magic',
      modifiers: { extraAttackDice: 0, extraArmorDice: 0, damageMod: 0 },
    });
    this.emit({
      type: 'resolution',
      actorId: actor.id,
      public: { hit: result.hit, damage: result.damage, attackerTop: result.attackerTop, defenderTop: result.defenderTop, targetId: t.id },
      private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
    } as unknown as Event);
    if (result.hit && result.damage > 0) {
      const damaged = applyDamage(t, result.damage);
      this.characters.set(t.id, damaged);
      this.emit({
        type: 'state_change',
        changes: [{ id: t.id, damage: damaged.health.damage, status: damaged.health.status }],
      } as unknown as Event);
    }
  }

  this.turn.markActed();
  return ok({ turnEnded: false });
}
```

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- tests/engine/special-actions.test.ts`
Expected: PASS — 5 tests now (3 whirlwind + 2 flame-burst — split-shot test is in the same file, total 4? double-check Step 1 of Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/engine/effects.ts src/engine/game-engine.ts tests/engine/special-actions.test.ts
git commit -m "feat(engine): flame-burst multi-target dispatch"
```

---

## Task 6: Multi-target dispatch — `pack-attack`

Single-target with `+1` die when the target is engaged.

**Files:**
- Modify: `src/engine/effects.ts:146-152`
- Modify: `src/engine/game-engine.ts`
- Extend: `tests/engine/special-actions.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/engine/special-actions.test.ts`:

```ts
describe('special_action: pack-attack', () => {
  it('rolls actor.pools.melee + 1 dice when target is engaged by ≥ 2 monsters', () => {
    const r1 = monster('r1', 0, 0);
    const r2 = monster('r2', 0, 1);
    const h  = hero('h', 1, 0);   // adjacent to r1 and r2
    const engine = makeEngine([r1, r2, h], 'pack-engaged');
    engine.beginNarrativeTurn(asCharacterId('r1'));
    const out = engine.applyAction(asCharacterId('r1'), {
      kind: 'special_action', targetIds: [asCharacterId('h')],
    });
    expect(out.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as { private: { attackRoll: number[] } };
    // r1 melee 1 + engaged +1 = 2 dice
    expect(resolution.private.attackRoll.length).toBe(2);
  });

  it('rolls only actor.pools.melee dice when target is not engaged', () => {
    const r1 = monster('r1', 0, 0);
    const h  = hero('h', 1, 0);
    const engine = makeEngine([r1, h], 'pack-alone');
    engine.beginNarrativeTurn(asCharacterId('r1'));
    const out = engine.applyAction(asCharacterId('r1'), {
      kind: 'special_action', targetIds: [asCharacterId('h')],
    });
    expect(out.ok).toBe(true);
    const events = engine.flushEvents();
    const resolution = events.find((e) => e.type === 'resolution') as { private: { attackRoll: number[] } };
    expect(resolution.private.attackRoll.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/engine/special-actions.test.ts`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Drop the pack-attack placeholder**

Replace `src/engine/effects.ts` lines 145-152 (drop the LAYER C TODO comment too):

```ts
  reg.register('pack-attack', {
    kind: 'special-action',
    apply: ({ actor }) => ({
      changes: [],
      narration: `${actor.name} closes in with the pack.`,
    }),
  });
```

- [ ] **Step 4: Add pack-attack handler**

In `src/engine/game-engine.ts`, extend the switch and add `dispatchPackAttack`. Also re-import `isEngaged` if not already imported (Task 2 added it).

```ts
  switch (effectId) {
    case asEffectId('whirlwind-attack'):
      return this.dispatchSplitAttack(actor, action, 'melee', 1, opts);
    case asEffectId('split-shot'):
      return this.dispatchSplitAttack(actor, action, 'ranged', actor.normalAttack.range, opts);
    case asEffectId('flame-burst'):
      return this.dispatchFlameBurst(actor, action, opts);
    case asEffectId('pack-attack'):
      return this.dispatchPackAttack(actor, action, opts);
    default:
      return this.dispatchSingleEffect(actorId, action, opts);
  }
```

```ts
private dispatchPackAttack(
  actor: Character,
  action: Extract<PlayerAction, { kind: 'special_action' }>,
  opts?: { interpretedBy?: 'dm' },
): Result<ActionOk, RuleViolation> {
  const targetIds = action.targetIds ?? [];
  if (targetIds.length === 0) return err({ reason: 'targets-required' });
  const targetId = targetIds[0]!;
  const target = this.characters.get(targetId);
  if (!target) return err({ reason: 'unknown-id', what: 'character', id: String(targetId) });
  if (target.health.status === 'KO') return err({ reason: 'invalid-target' });
  if (!actor.pos || !target.pos) return err({ reason: 'invalid-target' });
  if (chebyshevDistance(actor.pos, target.pos) !== 1) {
    return err({ reason: 'target-not-adjacent', targetId: String(targetId) });
  }

  const allChars = Array.from(this.characters.values());
  const engaged = isEngaged(target, allChars, actor.kind);
  const extraAttackDice = engaged ? 1 : 0;

  const interp = opts?.interpretedBy ? { interpretedBy: opts.interpretedBy } : {};
  this.emit({ type: 'action', actorId: actor.id, action, ...interp } as unknown as Event);

  const result = resolveAttack(this.dice, {
    attackerPool: actor.pools.melee,
    defenderArmor: target.pools.armor,
    attackKind: 'melee',
    modifiers: { extraAttackDice, extraArmorDice: 0, damageMod: 0 },
  });
  this.emit({
    type: 'resolution',
    actorId: actor.id,
    public: { hit: result.hit, damage: result.damage, attackerTop: result.attackerTop, defenderTop: result.defenderTop, targetId: target.id },
    private: { attackRoll: result.attackRoll, armorRoll: result.armorRoll },
  } as unknown as Event);
  if (result.hit && result.damage > 0) {
    const damaged = applyDamage(target, result.damage);
    this.characters.set(target.id, damaged);
    this.emit({
      type: 'state_change',
      changes: [{ id: target.id, damage: damaged.health.damage, status: damaged.health.status }],
    } as unknown as Event);
  }

  this.turn.markActed();
  return ok({ turnEnded: false });
}
```

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- tests/engine/special-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite — verify the three `LAYER C TODO` markers are gone**

Run: `npm test && grep -rn "LAYER C TODO" src/`
Expected: tests green; grep output empty.

- [ ] **Step 7: Commit**

```bash
git add src/engine/effects.ts src/engine/game-engine.ts tests/engine/special-actions.test.ts
git commit -m "feat(engine): pack-attack engaged-bonus dispatch; closes layer C engine TODOs"
```

---

## Task 7: Tool schema — `params.diceSplit` for `special_action`

The agent's tool schema for `special_action` needs to include the `diceSplit` param so AI players can produce valid splits without trial-and-error rule violations.

**Files:**
- Modify: `src/runtime/prompt/tools.ts` (find the `special_action` schema)
- Modify: `tests/runtime/prompt/tools.test.ts`

- [ ] **Step 1: Inspect the current schema**

Run: `grep -n "special_action" src/runtime/prompt/tools.ts`

Locate the `special_action` schema. Note its current shape — `targetIds` is already optional with `string[]`.

- [ ] **Step 2: Write failing test**

Add to `tests/runtime/prompt/tools.test.ts`:

```ts
it('special_action schema accepts a diceSplit object in params', () => {
  const schema = TOOLS.special_action.input_schema as { properties: { params: { properties: Record<string, unknown> } } };
  expect(schema.properties.params.properties).toHaveProperty('diceSplit');
});

it('round-trips a special_action with diceSplit through fromTool', () => {
  const action = fromTool('special_action', {
    targetIds: ['rat-1', 'rat-2'],
    params: { diceSplit: { 'rat-1': 1, 'rat-2': 1 } },
  });
  expect(action.kind).toBe('special_action');
  if (action.kind === 'special_action') {
    expect(action.targetIds).toEqual(['rat-1', 'rat-2']);
    expect(action.params).toEqual({ diceSplit: { 'rat-1': 1, 'rat-2': 1 } });
  }
});
```

- [ ] **Step 3: Run, expect failure**

Run: `npm test -- tests/runtime/prompt/tools.test.ts`

- [ ] **Step 4: Add `diceSplit` to the schema**

In `src/runtime/prompt/tools.ts`, locate the `special_action` schema's `input_schema.properties.params` block and add (preserving the existing structure — read the current file first):

```ts
params: {
  type: 'object',
  description: 'Optional structured parameters. For whirlwind / split-shot, supply diceSplit; for healing-touch and other single-target effects, this can be omitted.',
  properties: {
    diceSplit: {
      type: 'object',
      description: 'For whirlwind-attack and split-shot: maps each targetId to the number of dice (positive integer) used against that target. The values must sum to the actor\'s relevant dice pool (melee for whirlwind, ranged for split-shot).',
      additionalProperties: { type: 'integer', minimum: 1 },
    },
  },
  additionalProperties: true,
},
```

If `fromTool` does explicit shape coercion, ensure it passes `params` through unchanged when present.

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- tests/runtime/prompt/tools.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/runtime/prompt/tools.ts tests/runtime/prompt/tools.test.ts
git commit -m "feat(prompt): special_action.params.diceSplit on agent tool schema"
```

---

## Task 8: `getRedactedSnapshot(viewer)` on `GameEngine`

**Files:**
- Create: `src/engine/snapshot.ts`
- Modify: `src/engine/game-engine.ts` (add `getRedactedSnapshot`)
- Create: `tests/engine/snapshot-redacted.test.ts`

- [ ] **Step 1: Inspect the existing visibility filter**

Run: `grep -n "Viewer\b\|RedactedEvent" src/runtime/visibility/types.ts src/runtime/visibility/*.ts`

Note the `Viewer` type and the predicate used to filter events. The snapshot reuses the same predicate to filter characters.

- [ ] **Step 2: Write the failing test**

Create `tests/engine/snapshot-redacted.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';

const grid = (): Grid => new Grid(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))));
const reg = (): EffectRegistry => { const r = new EffectRegistry(); registerCoreEffects(r); return r; };

const hero = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x, y },
  normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('noop'), name: 'noop', description: '' },
  bonusAbility:  { id: asEffectId('noop'), name: 'noop', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('getRedactedSnapshot', () => {
  it('includes all heroes for the human viewer', () => {
    const engine = new GameEngine({
      seed: 's', grid: grid(), characters: [hero('h1', 0, 0), hero('h2', 1, 1)], effects: reg(),
    });
    const snap = engine.getRedactedSnapshot({ kind: 'character', characterId: asCharacterId('h1') });
    expect(snap.characters.map((c) => c.id)).toEqual(expect.arrayContaining([asCharacterId('h1'), asCharacterId('h2')]));
  });

  it('captures activeActor and ended fields when set', () => {
    const engine = new GameEngine({ seed: 's', grid: grid(), characters: [hero('h1', 0, 0)], effects: reg() });
    engine.beginNarrativeTurn(asCharacterId('h1'));
    const snap = engine.getRedactedSnapshot({ kind: 'character', characterId: asCharacterId('h1') });
    expect(snap.activeActor).toBe(asCharacterId('h1'));
  });

  it('exposes pools, health, inventory, equipped, boons, specialAction.name on each character', () => {
    const engine = new GameEngine({ seed: 's', grid: grid(), characters: [hero('h1', 0, 0)], effects: reg() });
    const snap = engine.getRedactedSnapshot({ kind: 'character', characterId: asCharacterId('h1') });
    const h1 = snap.characters.find((c) => c.id === asCharacterId('h1'))!;
    expect(h1.pools.melee).toBe(2);
    expect(h1.health.total).toBe(3);
    expect(h1.inventory).toEqual([]);
    expect(h1.specialAction.name).toBe('noop');
  });
});
```

The full visibility / redaction tests (e.g., unrevealed monster filtering) require the orchestrator's reveal-tracking state. We add an integration-flavoured assertion in Task 24.

- [ ] **Step 3: Run, expect failure**

Run: `npm test -- tests/engine/snapshot-redacted.test.ts`
Expected: FAIL — `getRedactedSnapshot` undefined.

- [ ] **Step 4: Implement the snapshot type and method**

Create `src/engine/snapshot.ts`:

```ts
import type { CharacterId, ItemId, BoonId, EquipmentId } from './ids.js';
import type { Viewer } from '../runtime/visibility/types.js';
import type { Square } from './primitives.js';

export interface RedactedCharacter {
  id: CharacterId;
  name: string;
  kind: 'hero' | 'monster';
  archetype?: string;
  sprite?: string;
  pos: Square | null;
  health: { total: number; damage: number; status: 'normal' | 'prone' | 'KO' };
  pools: { melee: number; ranged: number; magic: number; armor: number };
  equipped?: EquipmentId;
  inventory: { itemId: ItemId; count: number }[];
  boons: BoonId[];
  specialAction: { name: string; description: string };
  bonusAbility:  { name: string; description: string };
}

export interface RedactedSnapshot {
  runId?: string;
  viewer: Viewer;
  scene: { id: string; assetId: string; gridW: number; gridH: number } | null;
  characters: RedactedCharacter[];
  activeActor: CharacterId | 'dm' | null;
  recentChat: unknown[];                  // actually RedactedEvent[], but kept as opaque to avoid an import cycle
  ended?: { outcome: 'success' | 'failure' | 'aborted' };
}
```

In `src/engine/game-engine.ts`, add the method:

```ts
import type { RedactedSnapshot, RedactedCharacter } from './snapshot.js';
import type { Viewer } from '../runtime/visibility/types.js';

// ... inside class GameEngine:

getRedactedSnapshot(viewer: Viewer): RedactedSnapshot {
  const sceneId = this.adventure?.scenes?.[0]?.id;            // current scene tracking lives in the orchestrator;
                                                              // engine-side, the snapshot exposes the loaded scene if any.
  const scene = sceneId
    ? {
        id: sceneId,
        assetId: this.adventure?.scenes?.[0]?.background ?? sceneId,
        gridW: this.grid.cols(),
        gridH: this.grid.rows(),
      }
    : null;

  const characters: RedactedCharacter[] = [];
  for (const c of this.characters.values()) {
    // Layer C scope: heroes are always visible to the human viewer; monsters
    // are visible if not in the orchestrator's "unrevealed" set. The engine
    // does not track reveal state — the orchestrator filters monsters before
    // calling getRedactedSnapshot when applicable. For unit tests with no
    // orchestrator, all characters round-trip.
    characters.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      ...(c.archetype !== undefined && { archetype: c.archetype }),
      pos: c.pos,
      health: { ...c.health },
      pools: { ...c.pools },
      ...(c.equipped !== undefined && { equipped: c.equipped }),
      inventory: c.inventory.map((s) => ({ itemId: s.itemId, count: s.count })),
      boons: [...c.boons],
      specialAction: { name: c.specialAction.name, description: c.specialAction.description },
      bonusAbility:  { name: c.bonusAbility.name,  description: c.bonusAbility.description  },
    });
  }

  return {
    viewer,
    scene,
    characters,
    activeActor: this.turn.activeActorId ?? null,
    recentChat: [],   // populated by the orchestrator/Subscriber bus when sending a snapshot envelope
  };
}
```

(Adjust `cols()` / `rows()` to whatever the existing `Grid` API exposes — check `src/engine/grid.ts`.)

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- tests/engine/snapshot-redacted.test.ts`

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/engine/snapshot.ts src/engine/game-engine.ts tests/engine/snapshot-redacted.test.ts
git commit -m "feat(engine): getRedactedSnapshot for browser reconnect"
```

---

## Task 9: Asset extraction + manifest authoring

This is one-time grunt work, but it has to be done before any browser code can render real art. Treat it as a single committed unit: cropped PNGs + `assets/manifest.json`.

**Files:**
- Move/rename existing assets (`archer.png` → `heroes/hunter.png`; move warrior/healer/warlock into `heroes/`).
- Create: `assets/heroes/hunter.png` (renamed from `assets/archer.png`)
- Create: `assets/monsters/giant-rat.png` (extracted from PDF)
- Create: `assets/monsters/king-rat.png` (extracted; needed for encounters 4-5 but cropped now)
- Create: `assets/maps/tavern-basement.png` (required for done signal)
- Create: `assets/manifest.json`

- [ ] **Step 1: Reorganize existing hero PNGs into `heroes/`**

```bash
cd /Users/arthurchau/Cofre/Mestrado/agents/agents-rpg
mkdir -p assets/heroes assets/monsters assets/maps
git mv assets/warrior.png  assets/heroes/warrior.png
git mv assets/archer.png   assets/heroes/hunter.png
git mv assets/healer.png   assets/heroes/healer.png
git mv assets/warlock.png  assets/heroes/warlock.png
```

- [ ] **Step 2: Extract pages from the HeroKids PDFs as PNGs**

Use `pdftoppm` (Poppler) — install via `brew install poppler` if missing.

```bash
mkdir -p /tmp/herokids-pages
pdftoppm -r 200 -png \
  herokids/Hero_Kids_-_Fantasy_Adventure_-_Basement_O_Rats.pdf \
  /tmp/herokids-pages/basement
pdftoppm -r 200 -png -f 41 -l 41 \
  herokids/Hero_Kids_-_Fantasy_RPG.pdf \
  /tmp/herokids-pages/manual
ls /tmp/herokids-pages/
```

- [ ] **Step 3: Crop the giant-rat sprite from the manual page 41**

Open `/tmp/herokids-pages/manual-41.png` in Preview. The giant-rat illustration is on the bestiary card. Crop a tight bounding box (~200×400 px-ish for a portrait token), Save As `assets/monsters/giant-rat.png` with transparency (use Preview's Instant Alpha or any quick background-removal step).

- [ ] **Step 4: Crop the king-rat sprite from adventure page 18**

Open `/tmp/herokids-pages/basement-18.png`. King-rat is on the encounter-5 page. Same procedure → `assets/monsters/king-rat.png`.

- [ ] **Step 5: Crop the tavern-basement map from adventure page 13**

Open `/tmp/herokids-pages/basement-13.png`. The map fills most of the page; crop to the grid area (5×8 cells). Aim for a final size where 1 grid square ≈ 64 px (so a 5×8 grid = 320×512). Save as `assets/maps/tavern-basement.png` (no transparency; backgrounds are opaque).

- [ ] **Step 6: (Optional but recommended) Crop the remaining four maps**

Pages 14-17 of the basement adventure: rat-tunnel, underground-choices, momentary-detour, rat-den. Save under `assets/maps/{name}.png`. If time-constrained, omit these — only `tavern-basement.png` is required for the done signal. Update the manifest in Step 7 accordingly.

- [ ] **Step 7: Write `assets/manifest.json`**

Create `assets/manifest.json` (only include lines for assets that actually exist):

```json
{
  "heroes": {
    "warrior":  "heroes/warrior.png",
    "hunter":   "heroes/hunter.png",
    "healer":   "heroes/healer.png",
    "warlock":  "heroes/warlock.png"
  },
  "monsters": {
    "giant-rat": "monsters/giant-rat.png",
    "king-rat":  "monsters/king-rat.png"
  },
  "maps": {
    "tavern-basement": "maps/tavern-basement.png"
  },
  "items": {},
  "equipment": {},
  "boons": {}
}
```

If you cropped any of the optional encounter-2-5 maps, add their lines under `maps`.

- [ ] **Step 8: Verify the existing `data/heroes.json` `sprite` field still resolves**

Run: `grep '"sprite"' data/heroes.json data/monsters.json`

Each `"sprite"` value (e.g. `"warrior"`, `"giant-rat"`) must be a key in the manifest under the appropriate category. If the existing `data/heroes.json` references `"sprite": "archer"` anywhere, change it to `"hunter"`.

- [ ] **Step 9: Commit assets**

```bash
git add assets/
git commit -m "feat(assets): hunter rename + monster + map sprites + manifest.json"
```

---

## Task 10: Manifest validator

**Files:**
- Create: `src/runtime/ws/manifest.ts`
- Create: `tests/runtime/ws/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/ws/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest, loadManifest } from '../../../src/runtime/ws/manifest.js';

const fixture = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe('manifest validator', () => {
  it('passes when every referenced file exists', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes'));
      writeFileSync(join(root, 'heroes', 'warrior.png'), 'png-bytes');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally { cleanup(); }
  });

  it('throws with the missing path on a missing file', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/heroes\/warrior\.png/);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/runtime/ws/manifest.test.ts`

- [ ] **Step 3: Implement the validator**

Create `src/runtime/ws/manifest.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AssetManifest {
  heroes:    Record<string, string>;
  monsters:  Record<string, string>;
  maps:      Record<string, string>;
  items:     Record<string, string>;
  equipment: Record<string, string>;
  boons:     Record<string, string>;
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
  };
};

export const validateManifest = (m: AssetManifest, assetsRoot: string): void => {
  const groups: Array<keyof AssetManifest> = ['heroes', 'monsters', 'maps', 'items', 'equipment', 'boons'];
  for (const g of groups) {
    for (const [id, rel] of Object.entries(m[g])) {
      const full = join(assetsRoot, rel);
      try {
        const s = statSync(full);
        if (!s.isFile()) throw new Error(`Manifest asset is not a file: ${rel}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Missing manifest asset ${g}.${id}: ${rel} (${msg})`);
      }
    }
  }
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/runtime/ws/manifest.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ws/manifest.ts tests/runtime/ws/manifest.test.ts
git commit -m "feat(ws): manifest validator (boot-time fatal-on-missing)"
```

---

## Task 11: WS protocol envelope types and codecs

**Files:**
- Create: `src/runtime/ws/protocol.ts`
- Create: `tests/runtime/ws/protocol.test.ts`

- [ ] **Step 1: Write failing roundtrip test**

Create `tests/runtime/ws/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeServerEnvelope, parseClientEnvelope, parseServerEnvelope } from '../../../src/runtime/ws/protocol.js';
import { asCharacterId } from '../../../src/engine/ids.js';

describe('WS protocol', () => {
  it('encodes and decodes a snapshot envelope', () => {
    const env = encodeServerEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} },
      state: {
        viewer: { kind: 'character', characterId: asCharacterId('h1') },
        scene: null, characters: [], activeActor: null, recentChat: [],
      },
    });
    expect(typeof env).toBe('string');
    const back = parseServerEnvelope(env);
    expect(back?.kind).toBe('snapshot');
  });

  it('encodes and decodes turn_started / turn_ended', () => {
    for (const k of ['turn_started', 'turn_ended'] as const) {
      const e = encodeServerEnvelope({ kind: k, actorId: asCharacterId('h1') });
      expect(parseServerEnvelope(e)?.kind).toBe(k);
    }
  });

  it('parseClientEnvelope accepts human_input and skip_turn', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'hi' }))?.kind).toBe('human_input');
    expect(parseClientEnvelope(JSON.stringify({ kind: 'skip_turn' }))?.kind).toBe('skip_turn');
  });

  it('parseClientEnvelope returns null on malformed JSON', () => {
    expect(parseClientEnvelope('{not json')).toBeNull();
  });

  it('parseClientEnvelope returns null on unknown kinds', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'launch_missiles' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/runtime/ws/protocol.test.ts`

- [ ] **Step 3: Implement the protocol**

Create `src/runtime/ws/protocol.ts`:

```ts
import type { CharacterId } from '../../engine/ids.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { RedactedSnapshot } from '../../engine/snapshot.js';
import type { AssetManifest } from './manifest.js';

export type ServerEnvelope =
  | { kind: 'snapshot'; viewer: Viewer; manifest: AssetManifest; state: RedactedSnapshot }
  | { kind: 'event'; event: RedactedEvent }
  | { kind: 'turn_started'; actorId: CharacterId | 'dm' }
  | { kind: 'turn_ended';   actorId: CharacterId | 'dm' }
  | { kind: 'thinking';      actorId: CharacterId | 'dm' }
  | { kind: 'thinking_done'; actorId: CharacterId | 'dm' }
  | { kind: 'end'; outcome: 'success' | 'failure' | 'aborted' }
  | { kind: 'rejected'; reason: 'not_your_turn' | 'session_in_use' | 'invalid_envelope' };

export type ClientEnvelope =
  | { kind: 'human_input'; text: string }
  | { kind: 'skip_turn' };

export const encodeServerEnvelope = (env: ServerEnvelope): string => JSON.stringify(env);

const SERVER_KINDS = new Set<ServerEnvelope['kind']>([
  'snapshot', 'event', 'turn_started', 'turn_ended', 'thinking', 'thinking_done', 'end', 'rejected',
]);
const CLIENT_KINDS = new Set<ClientEnvelope['kind']>(['human_input', 'skip_turn']);

export const parseServerEnvelope = (raw: string): ServerEnvelope | null => {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && SERVER_KINDS.has(v.kind)) return v as ServerEnvelope;
    return null;
  } catch { return null; }
};

export const parseClientEnvelope = (raw: string): ClientEnvelope | null => {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    if (v.kind === 'human_input' && typeof v.text === 'string') return v as ClientEnvelope;
    if (v.kind === 'skip_turn') return v as ClientEnvelope;
    return null;
  } catch { return null; }
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/runtime/ws/protocol.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ws/protocol.ts tests/runtime/ws/protocol.test.ts
git commit -m "feat(ws): server/client envelope types and codecs"
```

---

## Task 12: `WsAdapter` — Subscriber half

**Files:**
- Create: `src/runtime/ws/adapter.ts`
- Create: `tests/runtime/ws/ws-adapter.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/runtime/ws/ws-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WsAdapter } from '../../../src/runtime/ws/adapter.js';
import { asCharacterId } from '../../../src/engine/ids.js';

class FakeWs {
  readyState = 1;
  static OPEN = 1;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  on(_event: string, _handler: unknown) {}
}

const fakeManifest = { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} };

describe('WsAdapter — Subscriber', () => {
  it('emits an event envelope per onEvent', () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    a.onEvent({ type: 'action', actorId: asCharacterId('h1'), action: { kind: 'say', text: 'hi' } } as never);
    const sent = (ws as unknown as FakeWs).sent.map((s) => JSON.parse(s));
    // first envelope is the snapshot
    expect(sent[0].kind).toBe('snapshot');
    expect(sent[1].kind).toBe('event');
  });

  it('emits turn_started / turn_ended on lifecycle hooks', () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    a.onTurnStarted?.(asCharacterId('h1'));
    a.onTurnEnded?.(asCharacterId('h1'));
    const kinds = (ws as unknown as FakeWs).sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('turn_started');
    expect(kinds).toContain('turn_ended');
  });

  it('detach causes subsequent emits to no-op (no throw)', () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    a.detach();
    expect(() => a.onEvent({ type: 'action', actorId: asCharacterId('h1'), action: { kind: 'say', text: 'x' } } as never)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/runtime/ws/ws-adapter.test.ts`

- [ ] **Step 3: Implement the Subscriber half**

Create `src/runtime/ws/adapter.ts`:

```ts
import type { Subscriber } from '../subscriber.js';
import type { CharacterId } from '../../engine/ids.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { RedactedSnapshot } from '../../engine/snapshot.js';
import type { HumanInputProvider } from '../human-input.js';
import { encodeServerEnvelope, parseClientEnvelope, type ServerEnvelope } from './protocol.js';
import type { AssetManifest } from './manifest.js';
import type { WebSocket } from 'ws';

export class WsAdapter implements Subscriber, HumanInputProvider {
  readonly viewer: Viewer;
  private ws: WebSocket | null = null;
  private manifest: AssetManifest;
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;

  constructor(viewer: Viewer, manifest: AssetManifest) {
    this.viewer = viewer;
    this.manifest = manifest;
  }

  /** Bind this adapter to a live socket and immediately send the snapshot. */
  attach(ws: WebSocket, state: RedactedSnapshot): void {
    this.ws = ws;
    ws.on('message', (raw: Buffer | string) => this.onClientMessage(raw.toString()));
    ws.on('close', () => this.detach());
    this.send({ kind: 'snapshot', viewer: this.viewer, manifest: this.manifest, state });
  }

  detach(): void {
    if (this.pending) {
      this.pending.reject(new Error('client disconnected before input'));
      this.pending = null;
    }
    this.ws = null;
  }

  /* Subscriber */
  onStart(): void { /* attach() does the work */ }
  onEvent(event: RedactedEvent): void          { this.send({ kind: 'event', event }); }
  onTurnStarted(actorId: CharacterId | 'dm') { this.send({ kind: 'turn_started', actorId }); }
  onTurnEnded(actorId: CharacterId | 'dm')   { this.send({ kind: 'turn_ended',   actorId }); }
  onEnd(outcome: 'success' | 'failure' | 'aborted'): void { this.send({ kind: 'end', outcome }); }

  /* HumanInputProvider — implemented in Task 13 */
  requestInput(): Promise<string> {
    throw new Error('Task 13 wires this');
  }

  /* internal */
  private send(env: ServerEnvelope): void {
    if (!this.ws) return;
    const OPEN = 1;
    if ((this.ws as unknown as { readyState: number }).readyState !== OPEN) return;
    this.ws.send(encodeServerEnvelope(env));
  }

  private onClientMessage(raw: string): void {
    const env = parseClientEnvelope(raw);
    if (!env) { this.send({ kind: 'rejected', reason: 'invalid_envelope' }); return; }
    if (!this.pending) { this.send({ kind: 'rejected', reason: 'not_your_turn' }); return; }
    const text = env.kind === 'skip_turn' ? '/skip' : env.text;
    const p = this.pending; this.pending = null; p.resolve(text);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/runtime/ws/ws-adapter.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ws/adapter.ts tests/runtime/ws/ws-adapter.test.ts
git commit -m "feat(ws): WsAdapter Subscriber half (snapshot + event tail)"
```

---

## Task 13: `WsAdapter` — `HumanInputProvider` half

**Files:**
- Modify: `src/runtime/ws/adapter.ts` (replace stub `requestInput`)
- Modify: `tests/runtime/ws/ws-adapter.test.ts` (add input tests)

- [ ] **Step 1: Write failing tests**

Append to `tests/runtime/ws/ws-adapter.test.ts`:

```ts
describe('WsAdapter — HumanInputProvider', () => {
  it('requestInput resolves on a human_input envelope', async () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    let messageHandler: (raw: string) => void = () => {};
    (ws as unknown as { on: (e: string, h: unknown) => void }).on = (event, h) => {
      if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
    };
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'I draw my sword' }));
    await expect(promise).resolves.toBe('I draw my sword');
  });

  it('requestInput resolves to "/skip" on a skip_turn envelope', async () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    let messageHandler: (raw: string) => void = () => {};
    (ws as unknown as { on: (e: string, h: unknown) => void }).on = (event, h) => {
      if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
    };
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'skip_turn' }));
    await expect(promise).resolves.toBe('/skip');
  });

  it('throws when called twice without resolution', async () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs() as unknown as import('ws').WebSocket;
    a.attach(ws, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    void a.requestInput();
    expect(() => a.requestInput()).toThrow(/one pending request/);
  });

  it('client message before requestInput is rejected with not_your_turn', () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws = new FakeWs();
    let messageHandler: (raw: string) => void = () => {};
    (ws as unknown as { on: (e: string, h: unknown) => void }).on = (event, h) => {
      if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
    };
    a.attach(ws as unknown as import('ws').WebSocket, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'pre-emptive' }));
    const kinds = ws.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('rejected');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/runtime/ws/ws-adapter.test.ts`
Expected: the new HumanInputProvider tests FAIL (`Task 13 wires this`).

- [ ] **Step 3: Replace `requestInput` stub**

In `src/runtime/ws/adapter.ts`, replace the stub:

```ts
requestInput(): Promise<string> {
  if (this.pending) throw new Error('one pending request at a time');
  return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/runtime/ws/ws-adapter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ws/adapter.ts tests/runtime/ws/ws-adapter.test.ts
git commit -m "feat(ws): WsAdapter HumanInputProvider — pending-promise input"
```

---

## Task 14: WS server — HTTP static + WS upgrade + single-client

**Files:**
- Create: `src/runtime/ws/server.ts`
- Modify: `package.json` (add `ws` dependency if not present)

- [ ] **Step 1: Add `ws` dependency**

```bash
npm install --save ws
npm install --save-dev @types/ws
```

- [ ] **Step 2: Implement the server**

Create `src/runtime/ws/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeServerEnvelope, type ServerEnvelope } from './protocol.js';
import { loadManifest, validateManifest, type AssetManifest } from './manifest.js';

export interface BootedServer {
  port: number;
  server: Server;
  wss: WebSocketServer;
  manifest: AssetManifest;
  /** Called when a fresh WS client connects (after rejecting a duplicate). */
  onConnect: (handler: (ws: WebSocket) => void) => void;
  shutdown: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const safeJoin = (root: string, relUrl: string): string | null => {
  const normalized = normalize(relUrl).replace(/^\/+/, '');
  const full = resolvePath(join(root, normalized));
  if (!full.startsWith(resolvePath(root))) return null;
  return full;
};

export const bootWsServer = async (opts: {
  webRoot: string;     // e.g. dist/web
  assetsRoot: string;  // e.g. assets
  port?: number;       // 0 = auto-pick
}): Promise<BootedServer> => {
  const manifestPath = join(opts.assetsRoot, 'manifest.json');
  const manifest = loadManifest(manifestPath);
  validateManifest(manifest, opts.assetsRoot);

  let connectHandler: ((ws: WebSocket) => void) | null = null;
  let activeClient: WebSocket | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    // Asset paths → assets/
    if (url.startsWith('/assets/')) {
      const full = safeJoin(opts.assetsRoot, url.slice('/assets/'.length));
      if (!full || !existsSync(full) || !statSync(full).isFile()) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', MIME[extname(full)] ?? 'application/octet-stream');
      res.end(readFileSync(full));
      return;
    }
    // Web bundle → webRoot. SPA fallback to index.html for non-asset paths.
    const reqPath = url === '/' ? '/index.html' : url;
    const full = safeJoin(opts.webRoot, reqPath);
    if (full && existsSync(full) && statSync(full).isFile()) {
      res.setHeader('Content-Type', MIME[extname(full)] ?? 'application/octet-stream');
      res.end(readFileSync(full));
      return;
    }
    const indexFull = safeJoin(opts.webRoot, '/index.html');
    if (indexFull && existsSync(indexFull)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(indexFull));
      return;
    }
    res.statusCode = 404; res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws: WebSocket) => {
    if (activeClient && (activeClient as unknown as { readyState: number }).readyState === 1) {
      ws.send(encodeServerEnvelope({ kind: 'rejected', reason: 'session_in_use' } as ServerEnvelope));
      ws.close();
      return;
    }
    activeClient = ws;
    ws.on('close', () => { if (activeClient === ws) activeClient = null; });
    if (connectHandler) connectHandler(ws);
  });

  await new Promise<void>((resolveListen) => server.listen(opts.port ?? 0, resolveListen));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);

  return {
    port, server, wss, manifest,
    onConnect: (h) => { connectHandler = h; },
    shutdown: async () => {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
};
```

- [ ] **Step 3: Smoke test it**

Add a smoke-only test (not strict) at `tests/runtime/ws/server-boot.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { bootWsServer } from '../../../src/runtime/ws/server.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ws-boot-'));
mkdirSync(join(tmp, 'assets'));
writeFileSync(join(tmp, 'assets', 'manifest.json'), JSON.stringify({
  heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
}));
mkdirSync(join(tmp, 'web'));
writeFileSync(join(tmp, 'web', 'index.html'), '<html><body>hi</body></html>');

describe('bootWsServer', () => {
  it('binds to a random port and serves index.html on /', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('hi');
    await s.shutdown();
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/runtime/ws/server-boot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ws/server.ts tests/runtime/ws/server-boot.test.ts package.json package-lock.json
git commit -m "feat(ws): boot HTTP+WS server with manifest validation and single-client guard"
```

---

## Task 15: Reconnect snapshot test

End-to-end check that mid-run reconnects work — captures a current state and re-sends it on a fresh socket.

**Files:**
- Create: `tests/runtime/ws/reconnect.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { WsAdapter } from '../../../src/runtime/ws/adapter.js';
import { asCharacterId } from '../../../src/engine/ids.js';

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  on(_e: string, _h: unknown) {}
}

const fakeManifest = { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} };

describe('reconnect (snapshot+tail)', () => {
  it('a fresh attach sends a snapshot envelope reflecting the supplied state', () => {
    const a = new WsAdapter({ kind: 'character', characterId: asCharacterId('h1') }, fakeManifest);
    const ws1 = new FakeWs();
    a.attach(ws1 as unknown as import('ws').WebSocket, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 },
      characters: [], activeActor: asCharacterId('h1'), recentChat: [],
    });
    a.detach();
    const ws2 = new FakeWs();
    a.attach(ws2 as unknown as import('ws').WebSocket, {
      viewer: { kind: 'character', characterId: asCharacterId('h1') },
      scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 },
      characters: [],
      activeActor: asCharacterId('h1'),
      recentChat: [{ type: 'narration', actorId: 'dm', text: 'A door creaks.' } as never],
    });
    const second = ws2.sent.map((s) => JSON.parse(s));
    expect(second[0].kind).toBe('snapshot');
    expect(second[0].state.recentChat).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect pass**

Run: `npm test -- tests/runtime/ws/reconnect.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/runtime/ws/reconnect.test.ts
git commit -m "test(ws): reconnect re-sends snapshot reflecting current state"
```

---

## Task 16: Vite + browser scaffolding (no Pixi yet)

**Files:**
- Modify: `package.json`
- Create: `vite.config.ts`
- Create: `web/index.html`
- Create: `web/main.ts`
- Create: `web/styles/main.css`

- [ ] **Step 1: Add browser deps**

```bash
npm install --save pixi.js lit-html
npm install --save-dev vite jsdom @vitest/web-worker
```

- [ ] **Step 2: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/ws': { target: 'ws://localhost:5175', ws: true },
      '/assets': { target: 'http://localhost:5175' },
    },
  },
});
```

- [ ] **Step 3: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Hero Kids — Layer C</title>
  <link rel="stylesheet" href="./styles/main.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 4: Create `web/styles/main.css`**

Boring v4 CSS matching the locked layout (1024 px max-width container, board-left + cards-right + chat below + input below):

```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #e8e3d3; color: #2a2a2a; }
.container { max-width: 1024px; margin: 0 auto; background: #f8f4e7; border: 1px solid #c9bfa3; border-radius: 6px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-top: 24px; }
.header { background: #444; color: #ddd; padding: 8px 12px; font-size: 13px; font-family: monospace; margin-bottom: 12px; border-radius: 4px; text-align: center; }
.row { display: flex; gap: 12px; margin-bottom: 12px; align-items: stretch; }
.board { flex: 0 0 600px; background: #5a4a35; border: 1px solid #2a2a2a; border-radius: 4px; min-height: 340px; }
.cards { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.card { background: #fff; border: 1px solid #aaa; padding: 8px 10px; font-size: 11px; border-radius: 4px; flex: 1; }
.card.active { border: 2px solid #ffd966; }
.card h4 { margin: 0 0 2px 0; }
.card .stats { font-family: monospace; font-size: 10px; color: #555; }
.card .meta  { font-size: 10px; color: #555; }
.card .abilities { font-size: 10px; color: #7a4a1c; }
.chat { background: #fff; border: 1px solid #aaa; padding: 10px; font-size: 12px; height: 130px; overflow-y: auto; border-radius: 4px; margin-bottom: 10px; line-height: 1.6; }
.input-row { display: flex; gap: 8px; }
.input { flex: 1; background: #fff; border: 1px solid #aaa; padding: 8px; font-size: 12px; border-radius: 3px; }
.input:disabled { background: #eee; color: #999; }
.skip-btn { padding: 8px 14px; font-size: 12px; background: #9c5b1c; color: #fff; border: none; border-radius: 3px; cursor: pointer; }
.skip-btn:disabled { background: #aaa; cursor: not-allowed; }
.thinking-banner { background: #fffce0; border: 1px solid #ddc266; padding: 4px 8px; font-size: 11px; margin-bottom: 8px; border-radius: 3px; }
```

- [ ] **Step 5: Create `web/main.ts` skeleton**

```ts
// Wires the store + ws-client + components. Each is added in subsequent tasks;
// at this point we just confirm Vite builds and the page loads.
const root = document.getElementById('app')!;
root.innerHTML = `<div class="container"><div class="header">Hero Kids — Layer C (boot)</div></div>`;
```

- [ ] **Step 6: Add npm scripts**

In `package.json`, add:

```json
"scripts": {
  "dev:web": "vite",
  "build:web": "vite build",
  "preview:web": "vite preview"
}
```

(merge with existing `scripts` block; do not clobber).

- [ ] **Step 7: Build smoke**

```bash
npm run build:web
ls dist/web/
```

Expected: `index.html`, an `assets/*.js` bundle.

- [ ] **Step 8: Commit**

```bash
git add web/ vite.config.ts package.json package-lock.json
git commit -m "feat(web): vite + index.html + main.ts skeleton (no game logic yet)"
```

---

## Task 17: Browser store

A single mutable object plus a tiny pub-sub. Mirror `src/runtime/cli/cli-store.ts` shape so future code that reads either store looks similar.

**Files:**
- Create: `web/store.ts`
- Create: `tests/web/store.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/web/store.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createStore } from '../../web/store.js';

describe('browser store', () => {
  it('applies a snapshot envelope', () => {
    const s = createStore();
    s.applySnapshot({
      viewer: { kind: 'character', characterId: 'h1' as unknown as never },
      scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 },
      characters: [
        { id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
          pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
          pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, inventory: [], boons: [],
          specialAction: { name: 'Whirlwind', description: '' },
          bonusAbility:  { name: 'Teamwork',  description: '' } } as never,
      ],
      activeActor: 'h1' as never,
      recentChat: [],
    });
    const snap = s.getSnapshot();
    expect(snap.scene?.id).toBe('tavern-basement');
    expect(snap.characters).toHaveLength(1);
    expect(snap.activeActor).toBe('h1');
  });

  it('appends an event to chat on event envelope', () => {
    const s = createStore();
    s.applySnapshot({
      viewer: { kind: 'character', characterId: 'h1' as never },
      scene: null, characters: [], activeActor: null, recentChat: [],
    });
    s.applyEvent({ type: 'narration', actorId: 'dm', text: 'Hello' } as never);
    expect(s.getSnapshot().chat).toHaveLength(1);
  });

  it('subscribers fire on every mutation', () => {
    const s = createStore();
    let fires = 0;
    s.subscribe(() => { fires += 1; });
    s.applyEvent({ type: 'narration', actorId: 'dm', text: 'Hello' } as never);
    s.applyEvent({ type: 'narration', actorId: 'dm', text: 'World' } as never);
    expect(fires).toBe(2);
  });
});
```

Configure vitest to enable jsdom for the `tests/web/` path. Add to `vitest.config.ts` (read it first):

```ts
test: {
  // existing settings
  environmentMatchGlobs: [
    ['tests/web/**', 'jsdom'],
  ],
}
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/web/store.test.ts`

- [ ] **Step 3: Implement the store**

Create `web/store.ts`:

```ts
import type { ServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { RedactedSnapshot } from '../src/engine/snapshot.js';
import type { CharacterId } from '../src/engine/ids.js';

export interface ChatEntry { event: unknown; }

export interface StoreState {
  scene: RedactedSnapshot['scene'];
  characters: RedactedSnapshot['characters'];
  activeActor: CharacterId | 'dm' | null;
  chat: ChatEntry[];
  thinking: Set<CharacterId | 'dm'>;
  inputUnlocked: boolean;
  ended?: { outcome: 'success' | 'failure' | 'aborted' };
}

export interface Store {
  getSnapshot(): StoreState;
  subscribe(listener: () => void): () => void;
  applySnapshot(snap: RedactedSnapshot): void;
  applyEvent(event: unknown): void;
  applyEnvelope(env: ServerEnvelope): void;
  setInputUnlocked(unlocked: boolean): void;
}

export const createStore = (): Store => {
  let state: StoreState = {
    scene: null, characters: [], activeActor: null,
    chat: [], thinking: new Set(), inputUnlocked: false,
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    getSnapshot: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    applySnapshot: (snap) => {
      state = { ...state, scene: snap.scene, characters: snap.characters, activeActor: snap.activeActor,
        chat: (snap.recentChat as ChatEntry[]) ?? [], thinking: new Set(), inputUnlocked: false };
      notify();
    },
    applyEvent: (event) => {
      state = { ...state, chat: [...state.chat, { event }] };
      notify();
    },
    applyEnvelope: (env) => {
      switch (env.kind) {
        case 'snapshot': return state = (() => { const s = env.state;
          return { scene: s.scene, characters: s.characters, activeActor: s.activeActor,
            chat: (s.recentChat as ChatEntry[]) ?? [], thinking: new Set(), inputUnlocked: false };
        })(), notify();
        case 'event':
          state = { ...state, chat: [...state.chat, { event: env.event }] }; notify(); return;
        case 'turn_started':
          state = { ...state, activeActor: env.actorId }; notify(); return;
        case 'turn_ended':
          state = { ...state, activeActor: null }; notify(); return;
        case 'thinking':
          { const next = new Set(state.thinking); next.add(env.actorId);
            state = { ...state, thinking: next }; notify(); return; }
        case 'thinking_done':
          { const next = new Set(state.thinking); next.delete(env.actorId);
            state = { ...state, thinking: next }; notify(); return; }
        case 'end':
          state = { ...state, ended: { outcome: env.outcome }, inputUnlocked: false }; notify(); return;
        case 'rejected':
          // toast/ignore for now; UI components may add a banner later
          return;
      }
    },
    setInputUnlocked: (unlocked) => { state = { ...state, inputUnlocked: unlocked }; notify(); },
  };
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/web/store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add web/store.ts tests/web/store.test.ts vitest.config.ts
git commit -m "feat(web): browser store mirroring CLI store shape"
```

---

## Task 18: WS client

**Files:**
- Create: `web/ws-client.ts`

- [ ] **Step 1: Implement the client**

```ts
import { parseServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { Store } from './store.js';

export interface WsClient {
  send(msg: { kind: 'human_input'; text: string } | { kind: 'skip_turn' }): void;
}

export const connectWs = (url: string, store: Store): WsClient => {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev) => {
    const env = parseServerEnvelope(typeof ev.data === 'string' ? ev.data : '');
    if (env) store.applyEnvelope(env);
  });
  ws.addEventListener('close', () => {
    setTimeout(() => connectWs(url, store), 1000);
  });
  return {
    send: (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
  };
};
```

- [ ] **Step 2: Commit**

```bash
git add web/ws-client.ts
git commit -m "feat(web): ws client with auto-reconnect"
```

---

## Task 19: lit-html components — `Layout`, `HeroCard`, `ChatLog`, `InputBox`

**Files:**
- Create: `web/components/Layout.ts`
- Create: `web/components/HeroCard.ts`
- Create: `web/components/ChatLog.ts`
- Create: `web/components/InputBox.ts`
- Create: `tests/web/cards.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/web/cards.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import { heroCard } from '../../web/components/HeroCard.js';

describe('HeroCard', () => {
  it('renders pools, equipment, inventory, special-action name, bonus-ability name', () => {
    const root = document.createElement('div');
    render(heroCard({
      id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      equipped: 'raiders-battleaxe' as never,
      inventory: [{ itemId: 'potion' as never, count: 2 }],
      boons: [],
      specialAction: { name: 'Whirlwind', description: '' },
      bonusAbility:  { name: 'Teamwork',  description: '' },
    }, false), root);
    const html = root.innerHTML;
    expect(html).toContain('Bran');
    expect(html).toContain('Whirlwind');
    expect(html).toContain('Teamwork');
    expect(html).toContain('potion');
  });

  it('marks active card with class .active', () => {
    const root = document.createElement('div');
    render(heroCard({
      id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: null, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      inventory: [], boons: [],
      specialAction: { name: 'X', description: '' },
      bonusAbility:  { name: 'Y', description: '' },
    }, true), root);
    expect(root.querySelector('.card')?.className).toContain('active');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/web/cards.test.ts`

- [ ] **Step 3: Implement `HeroCard`**

Create `web/components/HeroCard.ts`:

```ts
import { html, type TemplateResult } from 'lit-html';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const heart = (full: boolean) => (full ? '♥' : '♡');

export const heroCard = (c: RedactedCharacter, active: boolean): TemplateResult => {
  const remaining = c.health.total - c.health.damage;
  const hearts = Array.from({ length: c.health.total }, (_, i) => heart(i < remaining)).join('');
  const inv = c.inventory.length === 0
    ? '—'
    : c.inventory.map((s) => `${String(s.itemId)}×${s.count}`).join(' ');
  return html`
    <div class="card ${active ? 'active' : ''}">
      <h4>${c.name} <span style="font-weight:normal;color:#888">(${c.archetype ?? c.kind})</span></h4>
      <div class="stats">⚔ ${c.pools.melee} · 🏹 ${c.pools.ranged} · ✦ ${c.pools.magic} · ⛨ ${c.pools.armor} · HP ${hearts}</div>
      <div class="meta">Equip: ${c.equipped ?? '—'}</div>
      <div class="meta">Bag: ${inv}</div>
      <div class="meta">Boons: ${c.boons.length ? c.boons.join(' ') : '—'}</div>
      <div class="abilities"><b>Special:</b> ${c.specialAction.name} · <b>Bonus:</b> ${c.bonusAbility.name}</div>
    </div>
  `;
};
```

- [ ] **Step 4: Implement `ChatLog`, `InputBox`, `Layout`**

`web/components/ChatLog.ts`:

```ts
import { html, type TemplateResult } from 'lit-html';
import type { ChatEntry } from '../store.js';

export const chatLog = (chat: ChatEntry[]): TemplateResult => html`
  <div class="chat">
    ${chat.map((c) => html`<div>${formatEntry(c)}</div>`)}
  </div>
`;

const formatEntry = (c: ChatEntry): string => {
  const e = c.event as { type?: string; actorId?: string; text?: string; action?: { kind?: string; text?: string } };
  if (e.type === 'narration')   return `📖 ${e.text ?? ''}`;
  if (e.type === 'action' && e.action?.kind === 'say') return `💬 ${e.actorId}: ${e.action.text ?? ''}`;
  if (e.type === 'resolution')  return `🎲 ${e.actorId}`;
  return JSON.stringify(e);
};
```

`web/components/InputBox.ts`:

```ts
import { html, type TemplateResult } from 'lit-html';

export interface InputBoxProps {
  enabled: boolean;
  placeholder: string;
  onSubmit(text: string): void;
  onSkip(): void;
}

export const inputBox = (p: InputBoxProps): TemplateResult => html`
  <div class="input-row">
    <input class="input" type="text" placeholder="${p.placeholder}" ?disabled="${!p.enabled}"
      @keydown="${(e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          const t = (e.target as HTMLInputElement).value;
          if (t.length > 0) { p.onSubmit(t); (e.target as HTMLInputElement).value = ''; }
        }
      }}" />
    <button class="skip-btn" ?disabled="${!p.enabled}" @click="${p.onSkip}">Skip turn</button>
  </div>
`;
```

`web/components/Layout.ts`:

```ts
import { html, render, type TemplateResult } from 'lit-html';
import type { Store } from '../store.js';
import { heroCard } from './HeroCard.js';
import { chatLog } from './ChatLog.js';
import { inputBox } from './InputBox.js';

export const mountLayout = (root: HTMLElement, store: Store, onSubmit: (t: string) => void, onSkip: () => void): void => {
  const renderOnce = () => {
    const s = store.getSnapshot();
    const heroes = s.characters.filter((c) => c.kind === 'hero');
    const dmThinking = s.thinking.has('dm');
    const tpl: TemplateResult = html`
      <div class="container">
        <div class="header">Scene: ${s.scene?.id ?? '—'} · Turn: ${String(s.activeActor ?? '—')}</div>
        ${dmThinking ? html`<div class="thinking-banner">📖 DM is thinking…</div>` : ''}
        <div class="row">
          <div id="board" class="board"></div>
          <div class="cards">
            ${heroes.map((c) => heroCard(c, s.activeActor === c.id))}
          </div>
        </div>
        ${chatLog(s.chat)}
        ${inputBox({
          enabled: s.inputUnlocked && !s.ended,
          placeholder: s.inputUnlocked ? 'Describe your action, or press Skip turn' : 'Waiting for the DM…',
          onSubmit, onSkip,
        })}
      </div>
    `;
    render(tpl, root);
  };
  store.subscribe(renderOnce);
  renderOnce();
};
```

- [ ] **Step 5: Wire it up in `web/main.ts`**

Replace `web/main.ts`:

```ts
import { createStore } from './store.js';
import { connectWs } from './ws-client.js';
import { mountLayout } from './components/Layout.js';

const root = document.getElementById('app')!;
const store = createStore();
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
const ws = connectWs(wsUrl, store);

mountLayout(root, store, (text) => ws.send({ kind: 'human_input', text }), () => ws.send({ kind: 'skip_turn' }));

// On turn_started events for the human, unlock the input.
store.subscribe(() => {
  const s = store.getSnapshot();
  // The viewer's character id is delivered on the snapshot envelope; for now
  // we infer it from the first hero whose name matches the scenario "human"
  // entry (resolved at runtime via the snapshot's viewer field).
});
```

(Polish: the snapshot envelope carries the viewer; track which character the human controls and only unlock the input when `activeActor === humanId`. Add this in Task 20 once the Pixi board lands and we have a known seam to attach it to.)

- [ ] **Step 6: Run, expect pass**

Run: `npm test -- tests/web/cards.test.ts`

- [ ] **Step 7: Build smoke**

Run: `npm run build:web`
Expected: builds without errors.

- [ ] **Step 8: Commit**

```bash
git add web/components/ web/main.ts tests/web/cards.test.ts
git commit -m "feat(web): lit-html Layout, HeroCard, ChatLog, InputBox"
```

---

## Task 20: Pixi `Board`

**Files:**
- Create: `web/components/Board.ts`
- Create: `tests/web/board.test.ts`

- [ ] **Step 1: Write the failing test (data layer only)**

Create `tests/web/board.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeTokenPositions } from '../../web/components/Board.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const CELL = 64;

describe('Board.computeTokenPositions', () => {
  it('places a token at (x*64, y*64) bottom-anchored', () => {
    const c: RedactedCharacter = {
      id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: { x: 2, y: 3 }, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      inventory: [], boons: [],
      specialAction: { name: 'X', description: '' },
      bonusAbility:  { name: 'Y', description: '' },
    };
    const positions = computeTokenPositions([c], CELL);
    expect(positions.get('h1')).toEqual({ x: 2 * CELL, y: 3 * CELL });
  });

  it('omits a character with null pos', () => {
    const c: RedactedCharacter = {
      id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: null, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [], boons: [],
      specialAction: { name: 'X', description: '' },
      bonusAbility:  { name: 'Y', description: '' },
    };
    expect(computeTokenPositions([c], CELL).has('h1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/web/board.test.ts`

- [ ] **Step 3: Implement `Board`**

Create `web/components/Board.ts`. Keep `computeTokenPositions` as a pure function exported alongside the Pixi-bound class so tests can run under jsdom without WebGL.

```ts
import { Application, Assets, Sprite, Container } from 'pixi.js';
import type { RedactedCharacter, RedactedSnapshot } from '../../src/engine/snapshot.js';
import type { CharacterId } from '../../src/engine/ids.js';
import type { AssetManifest } from '../../src/runtime/ws/manifest.js';
import type { Store } from '../store.js';

export const CELL_PX = 64;

/** Pure: given a character list and cell size, return id→pixel position. */
export const computeTokenPositions = (
  chars: readonly RedactedCharacter[],
  cell: number,
): Map<string, { x: number; y: number }> => {
  const out = new Map<string, { x: number; y: number }>();
  for (const c of chars) {
    if (c.pos) out.set(String(c.id), { x: c.pos.x * cell, y: c.pos.y * cell });
  }
  return out;
};

export const mountBoard = async (
  el: HTMLElement,
  store: Store,
  manifest: AssetManifest,
  assetsBase = '/assets',
): Promise<void> => {
  const app = new Application();
  await app.init({ width: 600, height: 340, background: 0x5a4a35, antialias: false });
  el.appendChild(app.canvas);

  const tokens: Map<string, Sprite> = new Map();
  const board = new Container();
  app.stage.addChild(board);

  let bg: Sprite | null = null;

  const resolveAsset = (group: keyof AssetManifest, id: string | undefined): string | null =>
    id && manifest[group][id] ? `${assetsBase}/${manifest[group][id]}` : null;

  const update = async (snap: ReturnType<Store['getSnapshot']>) => {
    // background
    const sceneAsset = resolveAsset('maps', snap.scene?.assetId);
    if (sceneAsset && (!bg || (bg as Sprite & { __id?: string }).__id !== sceneAsset)) {
      if (bg) board.removeChild(bg);
      const tex = await Assets.load(sceneAsset);
      bg = new Sprite(tex);
      bg.x = 0; bg.y = 0;
      (bg as Sprite & { __id?: string }).__id = sceneAsset;
      board.addChildAt(bg, 0);
    }
    // tokens
    const positions = computeTokenPositions(snap.characters as RedactedCharacter[], CELL_PX);
    for (const c of snap.characters) {
      const id = String(c.id);
      const pos = positions.get(id);
      if (!pos) {
        const existing = tokens.get(id);
        if (existing) { board.removeChild(existing); tokens.delete(id); }
        continue;
      }
      const spriteAsset = resolveAsset(c.kind === 'hero' ? 'heroes' : 'monsters', (c as RedactedCharacter).sprite ?? c.archetype ?? c.kind);
      let token = tokens.get(id);
      if (!token && spriteAsset) {
        const tex = await Assets.load(spriteAsset);
        token = new Sprite(tex);
        token.anchor.set(0.5, 1.0);
        tokens.set(id, token);
        board.addChild(token);
      }
      if (token) { token.x = pos.x + CELL_PX / 2; token.y = pos.y + CELL_PX; }
    }
  };

  store.subscribe(() => { void update(store.getSnapshot()); });
  await update(store.getSnapshot());
};
```

- [ ] **Step 4: Mount the board from `Layout`**

Modify `web/components/Layout.ts` to expose the `#board` mount node — it already does, since the template renders `<div id="board" class="board"></div>`. In `web/main.ts`, after `mountLayout`, mount Pixi:

```ts
import { mountBoard } from './components/Board.js';

// after mountLayout(...):
const boardEl = document.getElementById('board')!;
// The manifest comes in on the first snapshot envelope; queue mountBoard until then.
store.subscribe(() => {
  const s = store.getSnapshot();
  if (!boardEl.dataset.mounted && s.scene) {
    boardEl.dataset.mounted = '1';
    void mountBoard(boardEl, store, (s as unknown as { manifest: AssetManifest }).manifest);
  }
});
```

The store doesn't currently keep the manifest. Patch `Store` (in `web/store.ts`) to remember it:

```ts
// add to StoreState:
manifest?: AssetManifest;

// in applyEnvelope's 'snapshot' case:
state = { ...state, manifest: env.manifest, /* ... existing fields */ };
```

(Re-run the store test from Task 17 after this patch — adjust expectations only if the test fails on the new field.)

- [ ] **Step 5: Run, expect pass (data-layer test)**

Run: `npm test -- tests/web/board.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/Board.ts web/main.ts web/store.ts tests/web/board.test.ts
git commit -m "feat(web): Pixi Board with token-position math + sprite preload"
```

---

## Task 21: Roll overlay + active-actor highlight

**Files:**
- Create: `web/components/RollOverlay.ts`
- Modify: `web/components/Board.ts` (subscribe to resolution events for the flash)

The active-actor highlight is already wired through `HeroCard.active` — Task 19 covered it. This task only adds the Pixi flash on resolution events.

- [ ] **Step 1: Implement the overlay (no test — visual)**

`web/components/RollOverlay.ts`:

```ts
import { Text, type Container } from 'pixi.js';

export const flashRoll = (
  parent: Container,
  x: number,
  y: number,
  hit: boolean,
  attackerTop: number,
  defenderTop: number,
  durationMs = 1500,
): void => {
  const label = new Text({
    text: `${hit ? 'HIT' : 'MISS'} ${attackerTop} vs ${defenderTop}`,
    style: { fill: hit ? 0x33aa33 : 0xaa3333, fontFamily: 'monospace', fontSize: 14, fontWeight: '700' },
  });
  label.anchor.set(0.5, 1.0);
  label.x = x; label.y = y;
  parent.addChild(label);
  const t0 = performance.now();
  const tick = () => {
    const elapsed = performance.now() - t0;
    label.alpha = Math.max(0, 1 - elapsed / durationMs);
    if (elapsed > durationMs) { parent.removeChild(label); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
```

- [ ] **Step 2: Hook flashRoll into Board on resolution events**

In `web/components/Board.ts`, subscribe to chat additions whose underlying event is a `resolution`. Replace the `store.subscribe(...)` line with:

```ts
let lastChatLen = 0;
store.subscribe(() => {
  void update(store.getSnapshot());
  const snap = store.getSnapshot();
  for (let i = lastChatLen; i < snap.chat.length; i += 1) {
    const e = (snap.chat[i].event as { type?: string; actorId?: string; public?: { hit?: boolean; attackerTop?: number; defenderTop?: number; targetId?: string } });
    if (e.type === 'resolution' && e.actorId && e.public) {
      const targetId = e.public.targetId ?? '';
      const positions = computeTokenPositions(snap.characters, CELL_PX);
      const pos = positions.get(targetId) ?? positions.get(e.actorId);
      if (pos && typeof e.public.hit === 'boolean' && typeof e.public.attackerTop === 'number' && typeof e.public.defenderTop === 'number') {
        flashRoll(board, pos.x + CELL_PX / 2, pos.y, e.public.hit, e.public.attackerTop, e.public.defenderTop);
      }
    }
  }
  lastChatLen = snap.chat.length;
});
```

(Add the import: `import { flashRoll } from './RollOverlay.js';` near the top of `Board.ts`.)

- [ ] **Step 3: Build smoke**

Run: `npm run build:web`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add web/components/RollOverlay.ts web/components/Board.ts
git commit -m "feat(web): roll overlay flashes HIT/MISS over the resolving token"
```

---

## Task 22: `bin/play.ts` — `--cli | --browser` flag

**Files:**
- Modify: `bin/play.ts`
- Modify: `package.json` (add `open` dep)

- [ ] **Step 1: Add `open` dependency**

```bash
npm install --save open
```

- [ ] **Step 2: Inspect current bin/play.ts**

Run: `cat bin/play.ts`

Note where the Subscriber is constructed (Layer B builds `CliAdapter` and passes it to the orchestrator).

- [ ] **Step 3: Add the flag and branch**

Refactor `bin/play.ts` so that subscriber/HumanInputProvider construction is gated on the `--cli` / `--browser` flag (default browser). Sketch:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import openBrowser from 'open';
import { bootWsServer } from '../src/runtime/ws/server.js';
import { WsAdapter } from '../src/runtime/ws/adapter.js';
import { CliAdapter } from '../src/runtime/cli/cli-adapter.js';
// ... existing scenario / orchestrator imports

const argv = process.argv.slice(2);
const isCli = argv.includes('--cli');
const isBrowser = argv.includes('--browser') || !isCli;
const scenarioPath = argv.find((a) => a.endsWith('.json'));
const humanScriptIdx = argv.indexOf('--human-script');
const humanScript = humanScriptIdx >= 0 ? argv[humanScriptIdx + 1] : undefined;
if (!scenarioPath) { console.error('usage: play [--cli|--browser] <scenario.json> [--human-script ...]'); process.exit(2); }

if (isCli) {
  // existing Layer B code path: build CliAdapter, run orchestrator
  // ...
  return;
}

// Browser path
const webRoot = join(process.cwd(), 'dist/web');
if (!existsSync(join(webRoot, 'index.html'))) {
  console.log('Building web bundle...');
  const r = spawnSync('npm', ['run', 'build:web'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const booted = await bootWsServer({ webRoot, assetsRoot: join(process.cwd(), 'assets'), port: 5175 });
console.log(`Serving on http://localhost:${booted.port}`);

// Build the orchestrator (reuse Layer B scenario load) but defer attaching
// subscribers until a WS client connects.
const { /* loadScenario, runOrchestrator, etc. */ } = await import('../src/runtime/scenario.js');
const sc = await loadScenario(scenarioPath, { humanScript });
const human = sc.players.find((p) => p.controller === 'human')!;
const adapter = new WsAdapter({ kind: 'character', characterId: human.id }, booted.manifest);

booted.onConnect((ws) => {
  // adapter.attach(ws, currentRedactedSnapshot()) — orchestrator exposes a
  // getRedactedSnapshot(viewer) wrapper around engine.getRedactedSnapshot(viewer)
  // that also fills in recentChat from the orchestrator's ring buffer.
  adapter.attach(ws, sc.orchestrator.getRedactedSnapshot(adapter.viewer));
});

await openBrowser(`http://localhost:${booted.port}`);

// Start the orchestrator with adapter as Subscriber + HumanInputProvider
sc.orchestrator.run([adapter], adapter);
```

(Adapt the exact wiring to the existing `loadScenario` / orchestrator API. The plan-phase couldn't pin every line because the Layer B scenario module's surface evolves; if names differ, follow the existing CLI path's pattern in `bin/play.ts` and substitute `WsAdapter` for `CliAdapter`.)

- [ ] **Step 4: Sanity-check the CLI path still works**

Run: `npm run play -- --cli scenarios/baseline.json --human-script tests/fixtures/layer-b/human-bran-script.jsonl`
Expected: Layer B's existing live-CLI smoke still works.

- [ ] **Step 5: Build the web bundle and try the browser path (without LLM)**

```bash
npm run build:web
npm run play -- --browser scenarios/baseline.json --human-script tests/fixtures/layer-b/human-bran-script.jsonl
```

Expected: a browser opens at `http://localhost:5175`, page shows the Layout shell, the scripted human input drives the run to completion.

(If you don't have an `ANTHROPIC_API_KEY`, the orchestrator's AI agents fail; use the scripted-LlmClient path Layer B already provides for unattended runs.)

- [ ] **Step 6: Commit**

```bash
git add bin/play.ts package.json package-lock.json
git commit -m "feat(bin): play.ts --cli|--browser flag (default browser)"
```

---

## Task 23: Encode Basement O' Rats encounter 1

**Files:**
- Create: `adventures/basement-o-rats.json`
- Create: `scenarios/basement-o-rats.json`

- [ ] **Step 1: Read the canonical adventure for encounter 1**

Read pages 12-13 of `herokids/Hero_Kids_-_Fantasy_Adventure_-_Basement_O_Rats.pdf`. Note: the basement is a 5-wide × 8-deep room; rats occupy specific tiles; heroes enter from one short edge.

- [ ] **Step 2: Write the adventure JSON**

Create `adventures/basement-o-rats.json` (encounter 1 only — sketches for 2-5 are out of scope):

```json
{
  "id": "basement-o-rats",
  "title": "Basement O' Rats",
  "scenes": [
    {
      "id": "tavern-basement",
      "background": "tavern-basement",
      "grid": { "cols": 5, "rows": 8 },
      "heroSpawns": [
        { "x": 2, "y": 7 }, { "x": 1, "y": 7 }, { "x": 3, "y": 7 }
      ],
      "monsters": [
        { "typeId": "giant-rat", "id": "rat-1", "pos": { "x": 1, "y": 2 } },
        { "typeId": "giant-rat", "id": "rat-2", "pos": { "x": 3, "y": 2 } },
        { "typeId": "giant-rat", "id": "rat-3", "pos": { "x": 0, "y": 4 } },
        { "typeId": "giant-rat", "id": "rat-4", "pos": { "x": 4, "y": 4 } }
      ],
      "intro": "The hatch creaks as you pry it open. Rotten cabbage and damp fur fill your nose. From below: the skitter of claws.",
      "conclusion": "The rats lie still. The basement is yours — for now. From the back wall, a tunnel yawns open."
    }
  ]
}
```

- [ ] **Step 3: Write the scenario JSON**

Create `scenarios/basement-o-rats.json`:

```json
{
  "id": "basement-o-rats",
  "adventure": "adventures/basement-o-rats.json",
  "seed": "boor-001",
  "players": [
    { "characterId": "bran",  "controller": "human", "heroId": "warrior", "name": "Bran",  "personaPath": null },
    { "characterId": "lia",   "controller": "ai",    "heroId": "hunter",  "name": "Lia",   "personaPath": "personas/cautious.md" },
    { "characterId": "rook",  "controller": "ai",    "heroId": "warlock-fire", "name": "Rook", "personaPath": "personas/bold.md" }
  ],
  "dm": { "personaPath": "personas/dm-default.md" }
}
```

(Match key names to the existing `scenarios/baseline.json`. Read it first via `cat scenarios/baseline.json` and conform to its shape.)

- [ ] **Step 4: Smoke-load via the existing scenario loader**

Run: `node -e "import('./dist/runtime/scenario.js').then(m => m.loadScenario('scenarios/basement-o-rats.json').then(s => console.log('ok:', s.players.length)))"`
Expected: prints `ok: 3`. (If your loader differs, run `npm test -- tests/runtime/scenario.test.ts` to confirm the schema matches.)

- [ ] **Step 5: Commit**

```bash
git add adventures/basement-o-rats.json scenarios/basement-o-rats.json
git commit -m "feat(adventure): encode Basement O' Rats encounter 1"
```

---

## Task 24: Headline integration test — `ws-stub-adventure.test.ts`

Layer C analogue of Layer B's headline integration test, exercising the orchestrator over the WS path.

**Files:**
- Create: `tests/integration/ws-stub-adventure.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { bootWsServer } from '../../src/runtime/ws/server.js';
import { WsAdapter } from '../../src/runtime/ws/adapter.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
// Reuse Layer B's scenario+orchestrator runner; if it lives elsewhere, adjust.
import { loadScenario } from '../../src/runtime/scenario.js';

describe('ws-stub-adventure end-to-end', () => {
  it('runs adventures/stub-layer-b.json over the WS subscriber to completion', async () => {
    // 1. Boot the WS server with a tmp web/asset roots — the integration test
    //    doesn't render anything, so empty index.html and an empty manifest are fine.
    const tmp = mkdtempSync(join(tmpdir(), 'wsstub-'));
    mkdirSync(join(tmp, 'web')); mkdirSync(join(tmp, 'assets'));
    writeFileSync(join(tmp, 'web', 'index.html'), '<html></html>');
    writeFileSync(join(tmp, 'assets', 'manifest.json'), JSON.stringify({
      heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
    }));
    const booted = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });

    // 2. Load the Layer B stub scenario, build a WsAdapter for the human, and
    //    arrange for connection-time attach.
    const sc = await loadScenario('scenarios/baseline.json', { humanScript: 'tests/fixtures/layer-b/human-bran-script.jsonl' });
    const human = sc.players.find((p) => p.controller === 'human')!;
    const adapter = new WsAdapter({ kind: 'character', characterId: human.id }, booted.manifest);
    booted.onConnect((ws) => adapter.attach(ws, sc.orchestrator.getRedactedSnapshot(adapter.viewer)));

    // 3. Connect a scripted client.
    const client = new WebSocket(`ws://127.0.0.1:${booted.port}`);
    const received: { kind: string }[] = [];
    await new Promise<void>((r) => client.on('open', () => r()));
    client.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      received.push(env);
      // When the orchestrator sets activeActor to the human, scripted human
      // input flows through the --human-script reader; the client only needs
      // to forward `human_input` events the script produces. For the stub
      // adventure with a script, the orchestrator drives this end-to-end.
    });

    // 4. Run the orchestrator with the adapter as both Subscriber and HumanInputProvider.
    const outcome = await sc.orchestrator.run([adapter], adapter);

    // 5. Assertions: the snapshot was sent first, the run reached an end envelope,
    //    no rule_violation events appear in the redacted stream the client received.
    expect(received[0]?.kind).toBe('snapshot');
    expect(received.find((e) => e.kind === 'end')).toBeDefined();
    expect(received.find((e) => e.kind === 'event' && (e as { event: { type: string } }).event.type === 'rule_violation')).toBeUndefined();
    expect(outcome).toBe('success');

    await booted.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
```

(The exact `loadScenario` / `orchestrator.run` signature from Layer B may differ slightly; conform to the actual API discovered in Task 22.)

- [ ] **Step 2: Run**

Run: `npm test -- tests/integration/ws-stub-adventure.test.ts`
Expected: PASS — orchestrator runs end-to-end through the WS subscriber.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/ws-stub-adventure.test.ts
git commit -m "test(integration): headline ws-stub-adventure end-to-end"
```

---

## Task 25: Integration test — `basement-o-rats-encounter-1.test.ts`

Drives encounter 1 against a `ScriptedLlmClient` recorded transcript so CI can run it without an API key.

**Files:**
- Create: `tests/fixtures/layer-c/basement-o-rats-encounter-1-transcript.jsonl`
- Create: `tests/integration/basement-o-rats-encounter-1.test.ts`

- [ ] **Step 1: Record a baseline transcript**

The existing `ScriptedLlmClient` (Layer B) consumes a JSONL file of pre-recorded model responses. Generate one by running a live smoke locally (with `ANTHROPIC_API_KEY` set) and capturing the `runs/<id>/prompts/*.json` outputs into the JSONL the scripted client expects. (Layer B's `tests/fixtures/layer-b/` already has examples; mirror their format.)

If a recording isn't immediately available, write a hand-tooled transcript that walks through encounter 1's most likely path: heroes move forward, warrior attacks rat-1, hunter shoots rat-2, warlock flame-bursts rat-3 + rat-4, DM ends combat. Save as `tests/fixtures/layer-c/basement-o-rats-encounter-1-transcript.jsonl`.

- [ ] **Step 2: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { loadScenario } from '../../src/runtime/scenario.js';

describe('basement-o-rats encounter 1', () => {
  it('plays through to combat-ended with all rats KO\'d under a scripted transcript', async () => {
    const sc = await loadScenario('scenarios/basement-o-rats.json', {
      humanScript: 'tests/fixtures/layer-c/human-bran-script.jsonl',
      llmTranscript: 'tests/fixtures/layer-c/basement-o-rats-encounter-1-transcript.jsonl',
    });
    const outcome = await sc.orchestrator.run([], sc.scriptedHumanProvider);
    expect(outcome).toBe('success');
    const finalRats = sc.engine.charactersById();
    for (const [id, c] of finalRats) {
      if (c.kind === 'monster') expect(c.health.status).toBe('KO');
    }
  }, 60_000);
});
```

(Fixtures and exact APIs depend on Task 22's scenario-loader changes. Adapt if names differ.)

- [ ] **Step 3: Run**

Run: `npm test -- tests/integration/basement-o-rats-encounter-1.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/layer-c/ tests/integration/basement-o-rats-encounter-1.test.ts
git commit -m "test(integration): basement-o-rats encounter 1 scripted transcript"
```

---

## Task 26: Manual live smoke (the done signal)

**Files:**
- Create: `tests/fixtures/layer-c/human-bran-script.jsonl`
- Touch: a runbook in CLAUDE.md (one paragraph)

The full suite is already green at this point. This task is the final manual verification.

- [ ] **Step 1: Write a minimal human script**

Create `tests/fixtures/layer-c/human-bran-script.jsonl` — one JSON object per line, mirroring the Layer B human-script shape. Each line is one human-turn input. Example minimal pacing for encounter 1:

```jsonl
{"text": "I move forward and attack the closest rat."}
{"text": "I cleave at the rat in front of me."}
{"text": "/skip"}
```

(Add as many lines as needed to cover the human's turns; orchestrator blocks on `requestInput()` for each one.)

- [ ] **Step 2: Run the full live smoke**

```bash
ANTHROPIC_API_KEY=… npm run play -- --browser scenarios/basement-o-rats.json \
  --human-script tests/fixtures/layer-c/human-bran-script.jsonl
```

The browser opens. Play through encounter 1. Watch:

- All 4 heroes + 1 giant-rat token render with cropped art.
- The `tavern-basement.png` background is centered in the board area.
- HP changes (heart loss) reflect on hero cards as combat resolves.
- Chat shows DM narration, hero dialogue, and dice roll lines.
- Combat ends with all 4 rats KO'd; conclusion narration appears.

- [ ] **Step 3: Verify done-signal criteria**

After the run exits, inspect `runs/<latest>/manifest.json`:

```bash
ls -t runs/ | head -1 | xargs -I{} cat runs/{}/manifest.json
```

Confirm:

- `outcome` is `success`.
- `cacheHitRatio` ≥ 0.30.
- `events.jsonl` has zero entries with `type: "rule_violation"`.

```bash
ls -t runs/ | head -1 | xargs -I{} grep -c '"type":"rule_violation"' runs/{}/events.jsonl
# Expected: 0
```

- [ ] **Step 4: Update CLAUDE.md**

Modify `CLAUDE.md` so the "Current state" section reflects Layer C complete, and the "Open work" section is rewritten to point at Layer D (eval / experiment matrix). Pattern after the Layer B → Layer C handoff text already in the file.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/layer-c/human-bran-script.jsonl CLAUDE.md
git commit -m "docs(claude): mark layer C complete; layer D handoff"
```

---

## Self-Review

**Spec coverage check.** Walking the spec sections:

- §1 goal/scope → covered by Tasks 1-26.
- §2 locked decisions C-1..C-11 — all covered: C-1 (Tasks 23-26 done-signal), C-2 (Tasks 1-7 hybrid dispatch), C-3 (Task 22 `--cli|--browser`), C-4 (Task 15 reconnect, Task 8 snapshot), C-5 (Task 9 manual crop), C-6 (Tasks 16, 19 layout v4), C-7 (Task 16 Vite + lit-html + Pixi), C-8 (Task 11 envelopes), C-9 (orchestrator emits thinking; Task 22 wiring), C-10 (Task 10 manifest validator), C-11 (no streaming — implicit; binary `thinking` only).
- §3 build order — mirrored in Tasks 1-26.
- §4 file layout — mirrored in plan's File Structure.
- §5 architecture: multi-target dispatch (1-7), redacted snapshot (8), wire protocol (11), WsAdapter (12-13), server packaging (14, 22), browser (16-21), asset manifest (9-10), adventure encoding (23).
- §6 test plan — covered by Tasks 1-25 individual tests + Tasks 24-25 headline integration.
- §7 done signal → Task 26 manual smoke; other items handled by `npm test`.
- §8 risks → flagged inline in spec, no plan items needed (most are mitigated by the test strategy).
- §9 deferred questions → out of plan scope.

**Placeholder scan.** Searched for "TBD", "TODO", "later". The placeholder narrations on the special-action effects entries (e.g., "(damage TBD — Layer C)") are *removed* by Tasks 3-6. Step bodies have actual code; no abstract stubs. The note in Task 22 step 3 ("Adapt the exact wiring to the existing scenario module") is a deliberate flag because the Layer B scenario API surface couldn't be pinned without a tighter Layer B reference; the engineer is told to substitute `WsAdapter` for `CliAdapter` along the existing CLI path. Same flag in Tasks 24-25 for the same reason.

**Type consistency check.**
- `RedactedSnapshot` shape: defined in Task 8, consumed by `WsAdapter` (12), `Store` (17), `Layout`/`HeroCard` (19), `Board` (20), `bootWsServer.onConnect` (14, 22).
- `RedactedCharacter` consumed by `HeroCard` (19) and `computeTokenPositions` (20).
- `ServerEnvelope` defined in Task 11; consumed by `WsAdapter` (12), `parseServerEnvelope` (11), `Store.applyEnvelope` (17), `connectWs` (18).
- `ClientEnvelope` produced by `WsClient.send` (18) and consumed by `WsAdapter.onClientMessage` (13).
- `AssetManifest` defined in Task 10; consumed by `WsAdapter` constructor (12), `bootWsServer` (14), `Board.mountBoard` (20), `Store` (Task 20 patch).
- `isEngaged` defined in Task 1; consumed by `handleNormalAttack` (2) and `dispatchPackAttack` (6). Same signature throughout.
- New `RuleViolation` reasons added in Task 1 are produced in Tasks 3, 4, 6.

**Scope check.** Layer C is one integrated layer producing the visual stack and closing engine debt. The final manual smoke (Task 26) requires all upstream tasks (engine + WS + browser + adventure) to work together; that's intentional — there's no meaningful sub-decomposition that produces shippable software earlier.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-layer-c-visual-layer.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
