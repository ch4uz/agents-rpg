# Layer B — Agent Runtime Design Spec

**Date:** 2026-05-08
**Status:** Approved (brainstorm)
**Owner:** Arthur Chau (Mestrado)
**Layer:** B — Agent runtime (per project layering in `CLAUDE.md` and parent spec §10)
**Parent spec:** `docs/superpowers/specs/2026-05-08-agents-rpg-design.md`
**Predecessor plan:** `docs/superpowers/plans/2026-05-08-engine-foundation.md` (Layer A — completed, 85 tests passing)

## 1. Goal and scope

Build the agent runtime that drives the Layer A engine: a deterministic orchestrator, ReACT-style AI agents with private extended thinking, a one-method `LlmClient` seam with both a real Anthropic-backed implementation and a scripted test double, the visibility filter that enforces "public actions and dialogue only," and an Ink-rendered CLI view adapter that lets a human play alongside two AI players and an AI DM.

**End state:** running `npm run play scenarios/baseline.json` plays through a richer single-scene fixture (`adventures/stub-layer-b.json` — 2-3 rats, one suggested ability test) end-to-end with a DM agent, two AI players, and one human via CLI. A `ScriptedLlmClient`-driven integration test asserts the same path runs deterministically with a scripted human input file.

**In scope.**
- The 3 hardening items the Layer A final review surfaced (engine touch-ups; see §3).
- `LlmClient` interface; `AnthropicLlmClient` (real network) and `ScriptedLlmClient` (test double).
- `Agent` class with ReACT inner loop, role-configured for DM and Players.
- `Orchestrator` driving the turn cycle, owning a `Subscriber` event bus.
- Visibility filter as a pure function, encoding the parent spec §5 matrix.
- `PromptBuilder` with three-band cache-aware prompt assembly.
- Ink-based CLI view adapter with emoji glyphs, slash-command shorthand, and a scripted-human file mode for unattended runs.
- Scenario JSON loader + persona Markdown files; per-agent `promptHash` in the manifest.
- Tool-use schemas derived from the existing `PlayerAction` / `DmAction` unions.
- Full test coverage (~50-70 new tests) plus a headline integration test.

**Out of scope (explicit).**
- WebSocket server (Layer C, alongside the Pixi browser).
- Pixi.js / browser rendering (Layer C).
- Asset extraction from PDFs (Layer C task 7 of parent spec §10).
- Encoding the canonical Basement O' Rats adventure (Layer C task 9).
- Eval metrics, LLM-as-judge, experiment matrix scripts (Layer D).
- Resume-from-log after a crashed run (deferred — runs are short).
- Multi-scene transitions (stub-layer-b is one scene).
- Off-turn boon plays at the orchestrator level — the v1 boon catalog is empty so this can be exercised purely via fixture tests; full off-turn dispatch lands when an adventure actually grants a boon.
- Mid-run hot-reload of agent prompts.
- Adventure authoring UI.

## 2. Locked decisions from this brainstorm

| # | Decision | Why |
|---|---|---|
| B-1 | **Process model = `EventLog` direct sink + `Subscriber` fan-out, CLI in-process.** Every event lands in `runs/<id>/events.jsonl` unredacted, and is also fanned out to perspective-keyed `Subscriber`s with the visibility filter applied. Layer B ships one subscriber: `CliAdapter` (`viewer = {kind: 'human'}`), in the same Node process. | Small abstraction, defers WebSocket complexity to Layer C, and matches parent spec decision 14 ("the view adapter is the only piece that differs"). The log/subscriber split keeps the source-of-truth log untouched by perspective filtering. |
| B-2 | **Demo target = richer single-scene fixture (`adventures/stub-layer-b.json`).** 2-3 rats, one suggested ability test, all 4 archetypes available. | Proves the runtime end-to-end (loop, visibility, DM/player coordination, CLI) without bleeding Layer C's adventure-encoding work. The existing one-rat stub doesn't exercise coordination. |
| B-3 | **LlmClient testability = real + scripted mock.** Two implementations behind one interface. | Orchestrator/visibility/agent tests run in milliseconds with zero tokens. Real client used only for live smoke runs. Recording mocks rejected as too brittle to prompt churn. |
| B-4 | **Human input = free-text + slash-shorthand + scripted file.** Three sources, same pipeline. | Free text routes through DM for interpretation (authentic). Slash commands hit the engine directly (cheap during dev, useful for thesis variants). `--human-script` enables unattended integration tests. |
| B-5 | **Run config = scenario JSON + persona Markdown files.** `scenarios/baseline.json` references `personas/cautious.md` etc. | Personas commit cleanly, diff cleanly, and re-running with the same scenario reproduces the same `promptHash`. Experiment matrix becomes N scenario files (Layer D). |
| B-6 | **Resume out of scope for Layer B.** | Runs are 30-45 minutes; rebuilding state from log + re-priming agent context is real complexity for low payoff at this scale. |
| B-7 | **CLI rendering = Ink + emojis.** `vadimdemedes/ink` (React for terminals) plus a single emoji-glyph registry. | Component layout, redraws, and stdin handling without manual cursor work. Emojis are scannable and match HeroKids' tone. (Saved as a project-level feedback note.) |

## 3. Build order

The first three steps fix Layer A debt. They land before any new runtime code.

1. **Hardening — `snapshotEngineState` captures inventory/boons/equipped.** `src/log/replay.ts:snapshotEngineState` currently leaves item state out of the snapshot, so replay can silently diverge once items move. Extend the snapshot shape and add fixtures that exercise potion drinks and (synthetic) boon usage.
2. **Hardening — `handleSpecialAction` dispatches `EffectChange`.** `src/engine/game-engine.ts:handleSpecialAction` only emits narration; the healer's Healing Touch and similar special actions are silent no-ops. Mirror `handleUseItem`'s change-application loop (apply heal/damage, emit `state_change`).
3. **Hardening — `handleUseBoon` dispatches the boon effect.** Currently only removes the boon from inventory. Invoke the boon's effect through the `EffectRegistry` before the inventory mutation. The v1 catalog has no boons, so this is exercised by a new fixture-only test.
4. `LlmClient` interface + `ScriptedLlmClient` (no Anthropic SDK yet).
5. `Agent` + ReACT inner loop, driven entirely by the scripted client.
6. Visibility filter (pure function + table-driven tests).
7. `Orchestrator` + `Subscriber` interface + direct `EventLog` write path.
8. `PromptBuilder` (still feeding the scripted client).
9. `AnthropicLlmClient` (real network impl) + retry/backoff.
10. Ink CLI: `App` tree, `Board`, `CharacterPanels`, `ChatLog`, `InputLine`; slash parser; `--human-script` reader.
11. Scenario loader + persona files + `bin/play.ts` entry point.
12. `adventures/stub-layer-b.json` + the headline integration test (`tests/integration/layer-b-end-to-end.test.ts`).

Each step compiles and tests pass before the next starts.

## 4. File layout

```
src/
  engine/                            (existing — items 1-3 above touch this)
  log/                               (existing — item 1 extends snapshotEngineState)
  runtime/                           NEW
    orchestrator.ts                  # turn loop, owns Subscriber bus
    agent.ts                         # role-configured ReACT loop
    subscriber.ts                    # Subscriber interface + bus
    visibility/
      filter.ts                      # pure function: filter(event, viewer) → RedactedEvent | null
    prompt/
      builder.ts                     # three-band cache-aware prompt assembly
      tools.ts                       # PlayerAction/DmAction → Anthropic tool schemas
      templates/
        player.system.ts             # template strings (port of parent spec §5)
        dm.system.ts
    llm/
      llm-client.ts                  # interface
      anthropic.ts                   # real impl with retry/backoff/cache headers
      scripted.ts                    # canned-response impl for tests
    cli/
      App.tsx                        # root Ink component
      cli-adapter.ts                 # Subscriber + HumanInputProvider
      cli-store.ts                   # external store for useSyncExternalStore
      Board.tsx                      # emoji grid renderer
      CharacterPanels.tsx            # HP / pools / inventory per hero
      ChatLog.tsx
      InputLine.tsx
      slash-parser.ts                # /move /attack /skip /say /test /equip /use /end
      glyphs.ts                      # emoji registry (single source of truth)
      script-reader.ts               # --human-script JSONL reader
    scenario.ts                      # load scenario JSON + persona files; compute promptHash
  bin/
    play.ts                          # entry: load scenario, wire orchestrator + cli, render Ink

adventures/
  stub-one-scene.json                (existing)
  stub-layer-b.json                  NEW: 2-3 rats + ability test

scenarios/                           NEW
  baseline.json
  cautious-vs-cautious.json          (sample second condition for the matrix)

personas/                            NEW
  cautious.md
  reckless.md
  neutral.md
  dm-default.md

tests/
  engine/
    game-engine.test.ts              + special-action dispatch + use_boon dispatch
  log/
    replay.test.ts                   + snapshot inventory/boons/equipped roundtrip
  runtime/                           NEW
    visibility.test.ts
    tools.test.ts
    scripted-llm.test.ts
    anthropic-llm.test.ts            mocked fetch
    prompt/builder.test.ts
    agent.test.ts
    orchestrator.test.ts
    scenario.test.ts
    cli/
      slash-parser.test.ts
      glyphs.test.ts
      board.test.ts                  ink-testing-library snapshots
      input-line.test.ts             ink-testing-library
  integration/
    stub-adventure.test.ts           (existing)
    layer-b-end-to-end.test.ts       NEW: the headline test
  fixtures/
    layer-b/
      scripted-dm-responses.json
      scripted-p1-responses.json
      scripted-p2-responses.json
      human-bran-script.jsonl
```

**Why this layout.** `runtime/` is the new top-level concern. Tests mirror source paths. Each cluster (`prompt/`, `llm/`, `cli/`, `visibility/`) is small enough to fit in your head as a single conceptual unit — when one grows past a few hundred lines, that's a signal to split, not an invitation to keep piling on.

## 5. Architecture

### 5.1 Event log, subscriber bus, and orchestrator

The orchestrator splits event delivery into two paths:

- **`EventLog` (direct sink).** Every emitted event is appended to `runs/<id>/events.jsonl` unredacted, source-of-truth. Not a subscriber — the log is the system's authoritative record, not a perspective.
- **`Subscriber[]` (filtered fan-out).** Each subscriber declares the perspective it represents (its `Viewer`, defined in §5.4). The orchestrator runs the visibility filter once per (event × subscriber) and delivers the redacted result, skipping when the filter returns `null`.

```ts
// src/runtime/subscriber.ts
import type { Viewer } from './visibility/filter.js';

export interface Subscriber {
  readonly viewer: Viewer;                          // perspective this subscriber represents
  onEvent(event: RedactedEvent): void;
  onTurnStarted?(actorId: CharacterId | 'dm'): void;
  onTurnEnded?(actorId: CharacterId | 'dm'): void;
}
```

Layer B wires one subscriber: `CliAdapter` with `viewer = {kind: 'human'}`. The `EventLog` is held directly by the orchestrator. Layer C will add a `WsServerSubscriber` (browser perspective) and a `ResearcherOverlaySubscriber` (`viewer = {kind: 'researcher', revealThoughts: true}`).

There is no second filtering step downstream of `Subscriber.onEvent` — the orchestrator is the only place the visibility filter runs.

```ts
// src/runtime/orchestrator.ts (control flow)
class Orchestrator {
  constructor(opts: {
    engine: GameEngine;
    agents: { dm: Agent; players: Map<CharacterId, Agent>; };
    human: { characterId: CharacterId; provider: HumanInputProvider } | null;
    eventLog: EventLog;                           // direct sink — receives all events unredacted
    subscribers: Subscriber[];                    // fan-out — receive filtered events
    stepBudget: { player: number; dm: number };  // defaults: 6 / 12
    runDir: string;                               // for manifest + events.jsonl
  }) { ... }

  async run(): Promise<{ outcome: 'success' | 'failure'; manifestPath: string }>;
}
```

After every action goes through the engine, the orchestrator calls `engine.flushEvents()` once, then for each event: `eventLog.append(event)` (always) and `for sub of subscribers: const r = filter(event, sub.viewer); if r !== null: sub.onEvent(r)`. This is the only place engine state and observer state stay in lockstep.

The main loop:

```
loop:
  drain engine.flushEvents() → publish to all subscribers (with visibility filter)
  if final 'adventure_ended' event seen: write manifest, return outcome

  actor = engine.turn.activeActorId
  if actor is 'dm':           runDmTurn()
  else if actor is human:     runHumanTurn()
  else:                       runAiTurn(actor)
```

Three control-flow seams:

1. **`runAiTurn(actorId)`** delegates to `agent.takeTurn(observation, history)`. The agent runs the ReACT inner loop (§5.2). The orchestrator drains and publishes events after every step, so subscribers see the same ordering the engine produced.
2. **`runHumanTurn()`** awaits `human.provider.requestInput()`. The provider returns one of:
   - `{kind: 'free_text', text}` — orchestrator routes to `agents.dm.interpretFreeText(text, characterId, history)`, gets back 1-N `PlayerAction`s, validates each via the engine; on `rule_violation` retries the DM ≤3 times, then defaults to `skip_turn`.
   - `{kind: 'structured_action', action}` — engine receives directly. Rule violations show in chat and the input is re-shown.
   - `{kind: 'skip'}` — engine receives `skip_turn`.
3. **`runDmTurn()`** is a ReACT loop with a different "is this turn done?" predicate: ends on `request_action`, `start_combat`, `end_combat`, or `end_adventure`. Step budget `dm: 12` (configurable per scenario).

### 5.2 Agent and ReACT inner loop

```ts
// src/runtime/agent.ts
class Agent {
  constructor(opts: {
    role: 'dm' | 'player';
    actorId: CharacterId | 'dm';
    persona?: string;            // markdown text
    llm: LlmClient;
    promptBuilder: PromptBuilder;
    tools: ToolSchema[];
    stepBudget: number;
  });

  async takeTurn(observation: Observation, history: RedactedEvent[]): Promise<{
    steps: AgentStep[];
    reason: 'end_turn' | 'budget_exhausted' | 'turn-control-yielded';
  }>;

  async interpretFreeText(text: string, actorId: CharacterId, history: RedactedEvent[]):
    Promise<PlayerAction[]>;
}
```

`takeTurn` runs the inner loop:

```
step = 0
while step < stepBudget:
  step += 1
  prompt = promptBuilder.build({role, actorId, persona, history, observation, scene, characters})
  resp   = await llm.complete({system: prompt.system, messages: prompt.messages, tools, thinking: {type: 'enabled'}})
  emit ThoughtEvent(resp.thinkingBlocks)            # always private
  action = parseSingleToolUse(resp)                  # exactly one
  result = engine.applyAction(actorId, action)       # OR engine.applyDmAction for DM
  if result.isErr():
    observation = {kind: 'rule_violation', reason: result.err.reason}
    continue                                          # retry within budget
  observation = {kind: 'public_resolution', publicResult: result.ok}
  if isTurnEndingAction(action, role): break

if step == stepBudget and not turnEnded:
  emit StepBudgetExhausted(actorId, forced: 'end_turn')
  force end_turn through engine
```

**Turn-ending predicate.**
- Player role: `action.kind === 'end_turn'` (the agent's only way to yield voluntarily).
- DM role: `action.kind ∈ {'request_action', 'start_combat', 'end_combat', 'end_adventure'}` — each transfers control out of the DM (to a player, to combat, or to run-end).

Three load-bearing properties (mirroring parent spec §5):

- **Extended thinking is the Thought channel.** The Anthropic SDK call passes `thinking: { type: 'enabled' }`. Thinking blocks are extracted and logged as `thought` events. They are never re-included in any other agent's prompt.
- **Tool use, not free-form JSON.** Anthropic tool calling enforces the action schema at the model level. `parseSingleToolUse` asserts exactly one tool call per step; zero or two-plus → orchestrator force-ends the turn with a `rule_violation` observation.
- **Rule violations are private.** Orchestrator emits `rule_violation` events for the audit log, but the visibility filter hides them from non-offenders.

`interpretFreeText` is the same shape but constrained: it receives the human's text + visibility-filtered history, returns 1-N `PlayerAction`s. Used during the human's turn when input arrives as free text. Validation and retry logic live in the orchestrator, not the agent.

### 5.3 LlmClient and tool schemas

```ts
// src/runtime/llm/llm-client.ts
export interface LlmClient {
  complete(req: {
    system: PromptSegment[];           // ordered; each segment can be cacheable
    messages: AnthropicMessage[];      // ordered; each can be cacheable
    tools: ToolSchema[];
    thinking?: { type: 'enabled'; budgetTokens?: number };
    model: string;
    maxTokens: number;
  }): Promise<LlmResponse>;
}

export interface PromptSegment { text: string; cacheable: boolean; }

export interface LlmResponse {
  thinkingBlocks: string[];
  toolUses: ParsedToolUse[];           // expect exactly 1; parser handles 0/N as error
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
```

**`AnthropicLlmClient`** wraps `@anthropic-ai/sdk`. It sets `cache_control: { type: 'ephemeral' }` on every segment marked `cacheable: true`. Retries 429 and 5xx with exponential backoff (250ms → 4s, max 5 attempts). On `refusal` or persistent 4xx → throws `LlmCallError`; the orchestrator catches and surfaces as a `rule_violation`-shaped observation so the agent can retry within budget or fall through.

**`ScriptedLlmClient`** is a deterministic test double:

```ts
new ScriptedLlmClient([
  { match: { role: 'dm' },                    response: { toolUses: [{ name: 'narrate', input: { text: '...' } }] } },
  { match: { role: 'dm' },                    response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1_anwen' } }] } },
  { match: { role: 'player', actorId: 'p1_anwen' }, response: { toolUses: [{ name: 'move', input: { path: [...] } }] } },
  // ...
]);
```

It pops the next matching response per call, asserts schema, fails loudly when no match. Used by every runtime test except the live-API smoke.

**Tool schemas** (`src/runtime/prompt/tools.ts`) derive from the existing `PlayerAction` and `DmAction` unions in `src/engine/action.ts`:

- `PLAYER_TOOLS` — one tool per kind: `move`, `normal_attack`, `special_action`, `use_item`, `use_boon`, `equip`, `ability_test`, `say`, `end_turn`. (`skip_turn` is intentionally omitted from the AI tool list — humans only.)
- `DM_TOOLS` — one per kind: `narrate`, `set_scene`, `start_combat`, `end_combat`, `request_action`, `reveal_monster`, `environmental`, `offer_rest`, `end_adventure`.

Each tool's JSON schema is hand-written and small. A roundtrip unit test constructs each `PlayerAction` / `DmAction` variant, encodes it via the schema, parses it back, and asserts deep equality. This catches drift between the TS unions and the tool definitions.

### 5.4 Visibility filter

```ts
// src/runtime/visibility/filter.ts
export type Viewer =
  | { kind: 'self'; actorId: CharacterId }       // the event's own author
  | { kind: 'other_player'; actorId: CharacterId }
  | { kind: 'dm' }
  | { kind: 'human' }
  | { kind: 'researcher'; revealThoughts: boolean };

export function filter(event: Event, viewer: Viewer): RedactedEvent | null;
```

Single `switch` over `event.type`, encoding the parent spec §5 matrix line by line. Two events redact (return a partial) instead of dropping or passing through whole:

- **`resolution`**: own actor sees `public + private`; everyone else sees `public` only (dice rolls hidden).
- **`thought`**: only `viewer.kind === 'self' && viewer.actorId === event.actorId` sees the text. Researchers with `revealThoughts: true` also see them. Everyone else: `null` (dropped).

Tests are pure data: a fixture file of `[event, viewer, expected]` triples. Adding an event type means adding rows + a switch case. If they don't match, the test fails. The matrix is defined exactly once, in code, and the test guarantees the implementation matches it.

### 5.5 PromptBuilder

One builder, role-aware. Both DM and Player produce `{system, messages}` using a fixed three-band layout designed for prompt-cache hits:

```
Band 1 — cacheable, stable for the whole run
  • system prompt template (filled with character sheet for player; scene template for DM)
  • adventure metadata (scene list, monster catalog excerpts relevant to the active scene)

Band 2 — cacheable, stable across many turns; rebuilt at "snapshot points"
  • full event history through the last snapshot point, visibility-filtered for this viewer
  • current scene state snapshot (positions, HP, conditions, inventory) at the snapshot tick

Band 3 — uncacheable, current step
  • events since the last snapshot point
  • current observation (rule_violation / public_resolution / fresh turn-start)
  • "what action will you take this step?" prompt
```

A snapshot point fires every K turns (default `K=3`, configurable per scenario). Bands 1 and 2 carry `cache_control: ephemeral`; band 3 does not. This matches parent spec §5's "older history prefixes can also be cached at periodic snapshot points."

The system templates start as ports of parent spec §5's text into TS template strings — same prompt content, parameterized on character sheet and scene data.

`cacheHitRatio` for the manifest = `sum(cacheReadTokens) / sum(inputTokens)` across all calls.

### 5.6 CLI view adapter (Ink + emojis)

**Stack additions.** Two runtime deps:
- `ink ^5.x` — React renderer for terminals
- `react ^18.x` — peer of Ink

Plus dev deps `ink-testing-library` and `@types/react`.

**Component tree.**

```
<App>                                        # root; subscribes via useSyncExternalStore
  <Header sceneId roundN activeActor />
  <Box flexDirection="row">
    <Board grid characters />                # the emoji grid
    <CharacterPanels heroes />               # HP, pools, inventory per hero
  </Box>
  <ChatLog entries />
  <InputLine enabled placeholder onSubmit />
</App>
```

`useWindowSize` lets the chat region grow/shrink with terminal height. Re-renders are driven by the external store (`cli-store.ts`) the orchestrator pushes events into; Ink diffs the frame.

**Glyph registry** (`src/runtime/cli/glyphs.ts`):

```ts
export const HERO_GLYPHS    = { warrior: '⚔️ ', hunter: '🏹', healer: '💚', warlock: '🔥' };
export const MONSTER_GLYPHS = { 'giant-rat': '🐀', 'king-rat': '👑' };
export const ITEM_GLYPHS    = { potion: '🧪', rope: '🪢', bomb: '💣', food: '🍞', gold: '🪙', herbs: '🌿' };
export const TERRAIN        = { floor: '⬜', wall: '⬛', obstacle: '🪵', ko: '💀' };
export const STATUS         = { active: '⭐', engaged: '⚔️ ', prone: '⬇️' };
```

Adding a new entity = one map entry. Most emojis are East Asian Width "W" / 2 cells in monospace terminals; Ink measures via `string-width` so layout works without manual width math.

**Board rendering.** `Board.tsx` is a pure render of grid + character positions, no input logic. `glyphFor` precedence: active actor highlight > KO marker > monster > hero > obstacle > wall > floor.

Visual sketch (fixture: stub-layer-b, mid-combat, p1_anwen active):

```
┌─ Scene: stub-cell ─────────────── Round 3 / Turn: ⚔️  Anwen ───────┐
│ ⬜⬜⬜⬜⬜⬜⬜⬜    ⚔️  Anwen   HP ❤️❤️❤️  M3 R0 G0 A2  🧪 ×1   │
│ ⬜⬜⬜⬜⬜⬜⬜⬜    🔥 Kael    HP ❤️❤️❤️  M0 R0 G3 A2  —        │
│ ⬜⬜⬜⬜⬜⬜⬜⬜    🏹 Bran    HP ❤️❤️🤍  M0 R3 G0 A2  🪢 ×1   │
│ ⬜⬜⬜⬜🐀⬜⬜⬜                                                  │
│ ⬜⬜⬜⬜⬜⬜⬜⬜    🐀 ×1    HP ❤️                              │
│ ⬜⬜⚔️ ⬜⬜⬜⬜⬜    💀 ×1                                        │
│ ⬜⬜⬜⬜⬜⬜⬜⬜                                                  │
│ ⬜⬜⬜🔥🏹⬜⬜⬜                                                  │
└─────────────────────────────────────────────────────────────────────┘
[chat]
DM: A rat scurries from the shadows...
⚔️  Anwen: "Bran, flank left — I'll take the closest!"
⚔️  Anwen → move (1,7)→(2,6)→(3,5)→(4,4)
> _   (your turn — type freely or /help)
```

**Input handling.** `InputLine.tsx` uses `useInput((input, key) => ...)` to accumulate keystrokes in local state, submit on Enter, edit on Backspace. The slash parser (`slash-parser.ts`) parses one submitted line into `{kind: 'free_text'}`, `{kind: 'structured_action', action: PlayerAction}`, or `{kind: 'skip'}`.

**Slash command vocabulary:**

```
/move <x>,<y>[ via <x>,<y>; ...]      → {kind: 'move', path}
/attack <targetId>                     → {kind: 'normal_attack', targetId}
/special [<targetId>] [k=v ...]        → {kind: 'special_action', targetIds, params}
/use <itemId> [<targetId>]             → {kind: 'use_item', itemId, targetId}
/equip <equipmentId>                   → {kind: 'equip', equipmentId}
/test <melee|ranged|magic> <4|5|6> [skill=<id>] [item=<id>] -- <describe>
/say <text>                            → {kind: 'say', text}
/skip                                  → {kind: 'skip'}
/end                                   → {kind: 'end_turn'}
/help                                  → prints command list, doesn't return input
```

Anything not starting with `/` becomes `{kind: 'free_text', text}`.

**Raw mode and scripted input.** `useStdin().isRawModeSupported` is checked at boot. Falsy (e.g., piped stdin from `--human-script`) → `InputLine` is mounted as a no-op and input is fed from `script-reader.ts` instead. Same component tree, different input source.

**Scripted human file format** (`--human-script <path>`):

```jsonl
{"text": "I rush the wounded one and finish it off"}
{"action": {"kind": "skip"}}
{"action": {"kind": "move", "path": [[8,7],[7,6],[6,5]]}}
```

One input per line, consumed in order on the human's turn. EOF before run completion → orchestrator emits a fatal-error event and shuts down cleanly.

### 5.7 Scenario config and persona files

`scenarios/baseline.json`:

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

`personas/*.md` are plain Markdown. The scenario loader reads them at boot, hashes each (sha256), and the manifest stores the hash per agent. Renaming or rewording a persona file changes the hash → makes the experimental condition explicit.

CLI uses the scenario's `id` plus a timestamp for the run directory: `runs/2026-05-08T14-22-baseline/`.

`bin/play.ts` is a small entry point: parse args, load scenario + personas, build engine + agents + orchestrator + subscribers, mount the Ink `<App>`, await `orchestrator.run()`.

## 6. Test plan

### 6.1 Unit and integration tests

```
tests/engine/game-engine.test.ts          + special-action EffectChange dispatch
                                          + use_boon effect-via-registry dispatch
tests/log/replay.test.ts                  + snapshotEngineState round-trips inventory/boons/equipped

tests/runtime/visibility.test.ts          table-driven: (event, viewer) → expected redaction
tests/runtime/tools.test.ts               PlayerAction/DmAction ↔ tool schema roundtrip per kind
tests/runtime/scripted-llm.test.ts        pops responses, schema asserts, clear errors on misuse
tests/runtime/anthropic-llm.test.ts       mocked fetch: retry on 429/5xx, parses thinking + tool blocks
tests/runtime/prompt/builder.test.ts      band segmentation; snapshot-point advance; cache-control flags
tests/runtime/agent.test.ts               ReACT loop over ScriptedLlmClient; emits thought; retries on rule_violation
tests/runtime/orchestrator.test.ts        DM→player→human dispatch; step budget; subscriber filtering
tests/runtime/scenario.test.ts            loads scenario JSON + persona files; promptHash stable

tests/runtime/cli/slash-parser.test.ts    each command → expected action; malformed handled
tests/runtime/cli/glyphs.test.ts          registry shape; precedence rules
tests/runtime/cli/board.test.ts           ink-testing-library: lastFrame() snapshots per fixture
tests/runtime/cli/input-line.test.ts      ink-testing-library: keystroke accumulation, Enter to submit
```

### 6.2 Headline integration test

`tests/integration/layer-b-end-to-end.test.ts` — one vitest test, no network, deterministic.

**Setup.**
- Adventure: `adventures/stub-layer-b.json` (3 rats, one suggested ability test, transitions to END on all-monsters-KO).
- Scenario: synthesized in-test, all-scripted agents.
- DM agent: `ScriptedLlmClient` with ~12 canned responses (set_scene, narrate intro, request_action P1, narrate hits between turns, start_combat after first attack, end_combat on all-KO, end_adventure success).
- P1 / P2: `ScriptedLlmClient` with ~6 canned responses each.
- Human seat: `--human-script` JSONL with 2-3 lines (one free-text turn that exercises DM interpretation, one `/skip`, one `/attack`).
- CLI: rendered headlessly via `ink-testing-library`; `lastFrame()` snapshotted at three checkpoints.

**Assertions.**
1. Orchestrator runs to completion without throwing.
2. Final event is `adventure_ended` with `outcome: 'success'`.
3. All 3 rats end with `status: 'KO'`; all 3 heroes with `damage < 3`.
4. The human's free-text turn produced an `action` event with `interpretedBy: 'dm'`.
5. The human's `/attack` turn produced an `action` event without `interpretedBy`.
6. **Replay invariant** — feed the produced `events.jsonl` through `replayActions` from a fresh engine with the same seed; final state matches the live-run final state byte-for-byte.
7. Manifest exists at `runs/<id>/manifest.json` with non-null `promptHash` per agent and a `cacheHitRatio` field present (value irrelevant under scripted client; field shape is what we test).
8. **Visibility audit** — for the "human" viewer's filtered event stream, no `thought` events appear and `resolution.private` is absent on every entry.
9. Ink snapshot at the "right after first KO" checkpoint matches the committed snapshot file.

### 6.3 What's explicitly NOT tested in Layer B

- Multi-scene transitions (stub is one scene).
- Pixi/browser rendering (Layer C).
- Combat with `reveal_monster` / `environmental` effects beyond engine logging (DM emits the events; engine just records them in v1).
- Eval metrics calculation (Layer D).
- Cost/token throughput at experiment-matrix scale (Layer D).

## 7. "Done" signal for Layer B

Layer B is complete when all of the following hold:

1. `npm test` is green (existing 85 + ~50-70 new ≈ 150 tests).
2. `npm run typecheck` is clean.
3. `npm run lint` is clean.
4. The headline integration test in §6.2 passes.
5. **Manual live smoke** (not in CI): `ANTHROPIC_API_KEY=… npm run play scenarios/baseline.json --human-script tests/fixtures/layer-b/human-bran-script.jsonl` plays through `stub-layer-b.json` end-to-end against real Sonnet, the manifest shows `cacheHitRatio > 0` after turn ~3, and total cost is logged at exit.
6. The 3 hardening items (§3 steps 1-3) have unit tests and no regression in existing tests.

Item 5 is the only check the suite can't perform automatically. It proves the Anthropic SDK wiring, retry behaviour, and prompt-cache headers are real, not mocked. Run it manually before declaring Layer B done.

## 8. Risks and tradeoffs worth flagging

- **Live-call latency.** Six steps × 3 agents × ~3-10 s per Sonnet call with extended thinking = a 1-3 minute round of combat. Acceptable for a research tool; flag in writeup if a real-time demo is ever needed (would push toward smaller models or shrunk step budget).
- **Tool-schema drift.** TS `PlayerAction` / `DmAction` unions and the hand-written tool schemas are kept in sync only by `tools.test.ts`. If someone adds an action variant without updating the tool schema, the test fails — but only if it's in the roundtrip table. Convention: editing `src/engine/action.ts` requires editing `src/runtime/prompt/tools.ts` in the same commit.
- **Prompt-cache assumptions.** Cache hit ratio depends on the prompt prefix being byte-identical across calls. Nondeterministic ordering (e.g., `Object.keys`) anywhere in the prompt assembly path silently destroys the cache. Builder tests pin a stable serialization.
- **Scripted human ≠ real human.** The integration test exercises the orchestrator's human-input plumbing but cannot validate that real free text is interpreted reasonably by the DM. Layer D's matrix is where qualitative human-in-the-loop testing happens.
- **Off-turn boon plays.** Parent spec §4 specifies boons can be played mid-other-turn. The v1 catalog has no boons, so the orchestrator queue + dispatch for off-turn actions is deferred to whenever an adventure first grants a boon — likely Layer C if the adventure encoding adds them, otherwise Layer D.

## 9. Open questions deferred to plan phase

- **`bin/play.ts` argument shape.** Whether `--human-script` is a top-level flag or a property in the scenario JSON. Probably top-level for ergonomics; plan-phase decides.
- **Persona prompt placement.** Whether persona Markdown is appended to the system prompt as a single block or interpolated into a `{{persona}}` slot in the role template. Both work; plan-phase picks based on the template structure.
- **Snapshot-point trigger.** Default `K=3` turns is a starting point; tuning happens at Layer D when cost data exists. The scenario JSON exposes `snapshotEveryTurns` so tuning is data, not code.
- **Anthropic SDK version pinning.** Use the latest stable at plan-phase time; pin precisely in `package.json`.
- **Where `step_budget_exhausted` lives for DM turns.** The current event type in `src/log/events.ts` types `actorId` as `CharacterId`; the DM force-end path needs widening to `CharacterId | 'dm'`. This is a tiny Layer B engine-side touch noted alongside the 3 hardening items.

## 10. What to do next

The natural follow-up is `superpowers:writing-plans`, referencing this spec to produce `docs/superpowers/plans/2026-05-08-layer-b-agent-runtime.md`. The build order in §3 already maps cleanly to plan tasks. Each step there should become one task with its own files-to-create / files-to-edit list, test-first checklist, and verification step.
