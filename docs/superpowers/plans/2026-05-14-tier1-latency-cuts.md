# Tier 1 Latency Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut six browser-side timing constants so a full combat round visibly progresses ~40% faster, with no LLM/protocol changes.

**Architecture:** Pure constant edits in six files plus two CSS keyframe-duration tweaks plus one hardcoded test-advance update. No code refactors, no new abstractions. All timing knobs live in named exports already; downstream consumers (Board, Layout, ws-deferred, tests) import the constants so they auto-track. The only follow-on edits are: (a) the CSS `roll-show` and `.roll-panel--initiative` animation durations, which mirror the JS constants but live in a CSS file so they don't auto-track; (b) `bin/play.ts`'s `initiativeRevealDelayMs`, which mirrors `INITIATIVE_PANEL_MS` so the orchestrator sleep stays in lockstep with the panel hold; (c) two hardcoded `advance(7500)` calls in `tests/web/layout-action-buttons.test.ts` that don't use the constants.

**Tech Stack:** TypeScript, Vitest, plain CSS. No new dependencies.

**Constant changes (the entire surface area):**

| File | Constant | Old | New | Saves |
|---|---|---:|---:|---|
| `web/components/RollPanel.ts:41` | `DICE_PANEL_LIFESPAN_MS` | 5000 | **3500** | 1.5s × every roll |
| `web/styles/main.css:1426` | `roll-show` animation duration | 5000ms | **3500ms** | (mirror) |
| `web/components/InitiativePanel.ts:17` | `INITIATIVE_PANEL_MS` | 7000 | **4500** | 2.5s × once per combat |
| `web/styles/main.css:2176` | `.roll-panel--initiative` animation duration | 7000ms | **4500ms** | (mirror) |
| `bin/play.ts:239` | `initiativeRevealDelayMs` | 7000 | **4500** | (mirror — orchestrator hold) |
| `web/components/Layout.ts:67` | `POST_REVEAL_HOLD_MS` | 4000 | **2000** | 2.0s × every narration/speech |
| `web/components/NarratorWindow.ts:166` | `TYPEWRITER_CHAR_MS` | 18 | **10** | ~45% on text reveal |
| `bin/play.ts:234` | `monsterActionDelayMs` | 500 | **250** | 0.25s × monster sub-action |
| `bin/play.ts:235` | `monsterTurnDelayMs` | 900 | **500** | 0.4s × monster turn |
| `web/components/EmojiBalloon.ts:46` | `EMOTE_BALLOON_HOLD_MS` | 3000 | **1800** | (visual de-clutter, non-blocking) |

**Why these numbers:**
- `DICE_PANEL_LIFESPAN_MS = 3500`: verdict still pops at 2400ms (CSS `roll-result-reveal` keyframe is hardcoded — unchanged), giving ~750ms verdict read time before the panel fades. The fade itself is the last 10% of the animation = 350ms. Below 3500ms the verdict is illegible.
- `INITIATIVE_PANEL_MS = 4500`: initiative has more dice (one per character) but the verdict is the turn order, which the turn-bar shows right after. 2.1s post-verdict read time.
- `POST_REVEAL_HOLD_MS = 2000`: combined with new `TYPEWRITER_CHAR_MS=10`, a 150-char line gets `1500ms reveal + 2000ms hold = 3.5s` total visibility (down from 6.7s).
- `monster*DelayMs` halved: the 4-step move tween takes ~480ms; new 500ms inter-turn delay still gives that breathing room without dead air.

**Risk + rollback:** Each constant is one numeric literal. `git diff` shows the entire change in <30 lines. If the dice feel rushed in the live smoke, bump `DICE_PANEL_LIFESPAN_MS` and the CSS to 4000ms (single revert per constant).

---

### Task 1: Cut `DICE_PANEL_LIFESPAN_MS` from 5000 → 3500

**Files:**
- Modify: `web/components/RollPanel.ts:41`
- Modify: `web/styles/main.css:1426`

- [ ] **Step 1: Update the JS constant**

In `web/components/RollPanel.ts:41`, change:

```ts
export const DICE_PANEL_LIFESPAN_MS = 5000;
```

to:

```ts
export const DICE_PANEL_LIFESPAN_MS = 3500;
```

- [ ] **Step 2: Update the mirroring CSS animation duration**

In `web/styles/main.css:1426`, change:

```css
animation: roll-show 5000ms ease-out forwards;
```

to:

```css
animation: roll-show 3500ms ease-out forwards;
```

(The `@keyframes roll-show` block at line 1455 uses percentages, so it auto-scales. Verdict pop at 2400ms is driven by `roll-result-reveal` with an absolute `2400ms` delay (line 1679) and stays unchanged.)

- [ ] **Step 3: Run the timing-sensitive tests**

```bash
npx vitest run tests/web/ws-deferred.test.ts tests/web/layout-action-buttons.test.ts tests/web/layout-initiative-clears.test.ts tests/web/layout-turn-order-sticky.test.ts
```

Expected: all pass. `ws-deferred.test.ts` imports `DICE_PANEL_LIFESPAN_MS` and uses it symbolically (`advanceTimersByTime(DICE_PANEL_LIFESPAN_MS + N)`), so the math auto-tracks.

---

### Task 2: Cut `INITIATIVE_PANEL_MS` from 7000 → 4500

**Files:**
- Modify: `web/components/InitiativePanel.ts:17`
- Modify: `web/styles/main.css:2176`
- Modify: `bin/play.ts:239`

- [ ] **Step 1: Update the JS constant**

In `web/components/InitiativePanel.ts:17`, change:

```ts
export const INITIATIVE_PANEL_MS = 7000;
```

to:

```ts
export const INITIATIVE_PANEL_MS = 4500;
```

- [ ] **Step 2: Update the mirroring CSS animation duration**

In `web/styles/main.css:2176`, change:

```css
.roll-panel--initiative {
  animation-duration: 7000ms;
}
```

to:

```css
.roll-panel--initiative {
  animation-duration: 4500ms;
}
```

- [ ] **Step 3: Update the orchestrator hold so it stays in lockstep with the panel**

In `bin/play.ts:239`, change:

```ts
initiativeRevealDelayMs: 7000,
```

to:

```ts
initiativeRevealDelayMs: 4500,
```

Also update the surrounding comment at `bin/play.ts:236-238`:

```ts
    // Initiative panel plays for 7000ms (web/components/InitiativePanel.ts —
    // INITIATIVE_PANEL_MS). Hold the orchestrator at the same duration so the
    // first combatant's turn doesn't begin until the reveal has finished.
```

to:

```ts
    // Initiative panel plays for 4500ms (web/components/InitiativePanel.ts —
    // INITIATIVE_PANEL_MS). Hold the orchestrator at the same duration so the
    // first combatant's turn doesn't begin until the reveal has finished.
```

- [ ] **Step 4: Run the initiative tests**

```bash
npx vitest run tests/web/layout-initiative-clears.test.ts tests/web/layout-turn-order-sticky.test.ts tests/web/layout-action-buttons.test.ts
```

Expected: all pass. Both test files import `INITIATIVE_PANEL_MS` and use it symbolically. `layout-action-buttons.test.ts` has a hardcoded `7500` that is still > new total — fixed cleanly in Task 7.

---

### Task 3: Cut `POST_REVEAL_HOLD_MS` from 4000 → 2000

**Files:**
- Modify: `web/components/Layout.ts:67`

- [ ] **Step 1: Update the constant**

In `web/components/Layout.ts:67`, change:

```ts
const POST_REVEAL_HOLD_MS = 4000;
```

to:

```ts
const POST_REVEAL_HOLD_MS = 2000;
```

- [ ] **Step 2: Run the layout/narrator tests**

```bash
npx vitest run tests/web/narrator.test.ts tests/web/layout-action-buttons.test.ts tests/web/layout-initiative-clears.test.ts tests/web/layout-turn-order-sticky.test.ts
```

Expected: all pass. `POST_REVEAL_HOLD_MS` is module-private; the queue-hold math (`text.length * TYPEWRITER_CHAR_MS + POST_REVEAL_HOLD_MS`) is consumed only inside Layout.ts.

---

### Task 4: Cut `TYPEWRITER_CHAR_MS` from 18 → 10

**Files:**
- Modify: `web/components/NarratorWindow.ts:166`

- [ ] **Step 1: Update the constant**

In `web/components/NarratorWindow.ts:166`, change:

```ts
export const TYPEWRITER_CHAR_MS = 18;
```

to:

```ts
export const TYPEWRITER_CHAR_MS = 10;
```

- [ ] **Step 2: Run the narrator tests**

```bash
npx vitest run tests/web/narrator.test.ts
```

Expected: all pass. `narrator.test.ts` lines 196 and 284 read `TYPEWRITER_CHAR_MS` from the import (`const CHAR_MS = TYPEWRITER_CHAR_MS`), so any `advanceTimersByTime(N * CHAR_MS)` math auto-tracks the new value.

---

### Task 5: Cut monster pacing delays in `bin/play.ts`

**Files:**
- Modify: `bin/play.ts:234-235`

- [ ] **Step 1: Update both monster delays**

In `bin/play.ts:234-235`, change:

```ts
    monsterActionDelayMs: 500,
    monsterTurnDelayMs:   900,
```

to:

```ts
    monsterActionDelayMs: 250,
    monsterTurnDelayMs:   500,
```

Also update the surrounding comment at `bin/play.ts:229-233` to reflect the new values:

```ts
    // Live pacing for the browser viewer: ~500ms between move and follow-up
    // attack inside one monster's turn (matches the 4-step move tween at
    // 120ms/step + a beat), and ~900ms between consecutive monster turns so
    // the user sees the previous attack's HIT/MISS flash settle before the
    // next monster begins. Tests leave both at 0.
```

to:

```ts
    // Live pacing for the browser viewer: ~250ms between move and follow-up
    // attack inside one monster's turn (the 4-step move tween at 120ms/step
    // covers most of it), and ~500ms between consecutive monster turns so
    // the user sees the previous attack's HIT/MISS flash settle before the
    // next monster begins. Tests leave both at 0.
```

- [ ] **Step 2: Verify orchestrator tests still pass**

```bash
npx vitest run tests/runtime/orchestrator.test.ts
```

Expected: all pass. The orchestrator tests pass `DELAY_MS` as a test-local constant; they do not import the values from `bin/play.ts`.

---

### Task 6: Cut `EMOTE_BALLOON_HOLD_MS` from 3000 → 1800

**Files:**
- Modify: `web/components/EmojiBalloon.ts:46`

- [ ] **Step 1: Update the constant**

In `web/components/EmojiBalloon.ts:46`, change:

```ts
export const EMOTE_BALLOON_HOLD_MS = 3000;
```

to:

```ts
export const EMOTE_BALLOON_HOLD_MS = 1800;
```

`EMOTE_BALLOON_FADE_MS = 500` is unchanged, so the new lifetime is 2300ms.

- [ ] **Step 2: Run the balloon tests**

```bash
npx vitest run tests/web/emoji-balloon.test.ts
```

Expected: all pass. The test imports both constants and uses `advanceTimersByTime(EMOTE_BALLOON_HOLD_MS)` and `advanceTimersByTime(EMOTE_BALLOON_LIFETIME_MS - EMOTE_BALLOON_HOLD_MS)`, so the assertion math auto-tracks.

---

### Task 7: Fix the hardcoded `advance(7500)` in `layout-action-buttons.test.ts`

**Files:**
- Modify: `tests/web/layout-action-buttons.test.ts:104-112`

This is the one test that hardcodes a delay value rather than importing the constant. The current `advance(7500); advance(7500)` was sized for the old `INITIATIVE_PANEL_MS=7000`. With the new value (4500ms initiative + ~2300ms narration hold for a 27-char line = ~6800ms total), `advance(7500)` once would suffice, but to stay defensively past the queue drain we use two steps as before.

- [ ] **Step 1: Update the hardcoded advances and the surrounding comment**

In `tests/web/layout-action-buttons.test.ts:104-112`, change:

```ts
    // Advance past the initiative panel hold, then the narration hold. The
    // combat_started event ingests an `initiative` queue beat
    // (INITIATIVE_PANEL_MS = 7000) ahead of the narration beat (~5000ms).
    // We advance in two steps because the queue promotion logic compares
    // `performance.now()` to the item's `shownAt`, and we drive both timers
    // and the clock together each step. No server events fire in this
    // window — the human hasn't done anything.
    advance(7500);
    advance(7500);
```

to:

```ts
    // Advance past the initiative panel hold, then the narration hold. The
    // combat_started event ingests an `initiative` queue beat
    // (INITIATIVE_PANEL_MS = 4500) ahead of the narration beat (~2300ms for
    // a ~27-char line under TYPEWRITER_CHAR_MS=10 + POST_REVEAL_HOLD_MS=2000).
    // We advance in two steps because the queue promotion logic compares
    // `performance.now()` to the item's `shownAt`, and we drive both timers
    // and the clock together each step. No server events fire in this
    // window — the human hasn't done anything.
    advance(5000);
    advance(5000);
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run tests/web/layout-action-buttons.test.ts
```

Expected: all pass. The two `advance(5000)` calls cover the new 4500ms initiative + ~2300ms narration with comfortable margin.

---

### Task 8: Run the full suite + typecheck + lint

**Files:** none (verification only)

- [ ] **Step 1: Full vitest run**

```bash
npm test
```

Expected: all 438 tests pass. If any timing-dependent test that this plan did not flag fails, capture the file and line and STOP — return to systematic-debugging.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: zero errors.

---

### Task 9: Manual browser smoke

**Files:** none (live verification)

- [ ] **Step 1: Start the dev server in one terminal**

```bash
npm run dev:web
```

Wait for "Local: http://localhost:5174/" before continuing.

- [ ] **Step 2: Start a scripted play session in a second terminal**

```bash
npm run play -- --browser scenarios/basement-o-rats.json --human-script tests/fixtures/layer-c/human-bran-script.jsonl
```

(Requires `ANTHROPIC_API_KEY` set. If you don't want to spend a live call, the stub adventure works too: `npm run play -- --browser adventures/stub-layer-b.json`.)

- [ ] **Step 3: Watch the first combat round in the browser**

Open `http://localhost:5174/`. Verify visually:

1. The initiative panel shows for ~4.5s (down from ~7s) — count "one mississippi, two mississippi, three mississippi, four" and the panel should be fading.
2. A dice roll shows the verdict ("HIT" / "MISS") for clearly readable time before the panel fades. If the verdict feels rushed and unreadable, that's a sign `DICE_PANEL_LIFESPAN_MS=3500` is too low — bump to 4000 in `RollPanel.ts:41` AND `main.css:1426`.
3. Narration types onto screen visibly (not instant) but feels brisk — about half-second to two seconds per typical line.
4. The full first round (initiative + 3-4 actions) completes in noticeably less time than before. Compare against your memory of the prior pacing.

- [ ] **Step 4: Stop both processes**

`Ctrl-C` in both terminals.

---

### Task 10: Commit

**Files:** none (commit only)

- [ ] **Step 1: Stage all the constant-change files**

```bash
git add web/components/RollPanel.ts web/components/InitiativePanel.ts web/components/Layout.ts web/components/NarratorWindow.ts web/components/EmojiBalloon.ts web/styles/main.css bin/play.ts tests/web/layout-action-buttons.test.ts
```

- [ ] **Step 2: Verify the diff is small and constant-only**

```bash
git diff --cached --stat
```

Expected: ~8 files changed, ~20-30 lines total. If any file is significantly larger than that, you accidentally swept in unrelated changes — STOP and reset.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
perf(ui): cut Tier 1 latency constants

Six browser-side timing knobs cut to make a full combat round visibly
progress ~40% faster. No protocol or LLM changes.

- DICE_PANEL_LIFESPAN_MS: 5000 → 3500 (and CSS roll-show)
- INITIATIVE_PANEL_MS:    7000 → 4500 (and CSS + bin/play orch hold)
- POST_REVEAL_HOLD_MS:    4000 → 2000
- TYPEWRITER_CHAR_MS:       18 →   10
- monsterActionDelayMs:    500 →  250
- monsterTurnDelayMs:      900 →  500
- EMOTE_BALLOON_HOLD_MS:  3000 → 1800

Tests using these constants symbolically auto-track; one hardcoded
advance() in layout-action-buttons.test.ts updated.
EOF
)"
```

---

## Verification at the end

After Task 10, run one final sanity pass:

```bash
git log -1 --stat
npm test
```

Expected: the commit shows the eight files above changed; all 438 tests pass.

If a future round of tuning is needed, the constants are all named and indexed in this plan — bump them in place and re-run Task 9.
