# Layer B Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 18 actionable findings from the 2026-05-08 baseline-run audit so a Layer B playthrough produces a clean, faithful, lossless audit log: rule violations are observable, the engine is idempotent and skips KO'd actors, the human teammate's input actually executes, the system prompt caches effectively, and the DM advances the scene with real mid-combat reactions. Layer C work (multi-target special-action dispatch) remains explicitly out of scope.

**Architecture:** Surgical changes across three subsystems. (1) `src/engine/` gets phase-gating, KO-aware turn rotation, and engine-side monster instantiation on `set_scene` / `reveal_monster`. (2) `src/runtime/` gets a `rule_violation` event emitter in the agent loop, a corrected `interpretFreeText` that exposes `PLAYER_TOOLS` to the DM, a between-turns DM-react hook in the orchestrator, and a clarifying-narrate fallback for rejected structured human actions. (3) `src/runtime/prompt/` splits the system text into a cacheable static head plus a dynamic state block delivered as a user-message segment, surfaces special-action descriptions, and tightens DM/human-input documentation. A pinned scripted-LLM regression test replays the failing baseline scenario and asserts the new invariants.

**Tech Stack:** TypeScript 5.x, Node 20+, vitest, `@anthropic-ai/sdk` (already wired). No new dependencies.

**Reference:** Findings list captured during the 2026-05-09 audit conversation. Source-of-truth specs: `docs/superpowers/specs/2026-05-08-agents-rpg-design.md`, `docs/superpowers/specs/2026-05-08-layer-b-agent-runtime-design.md`.

---

## File Structure

```
src/
  engine/
    game-engine.ts                 MODIFY: phase-gate end_combat (F18), instantiate scene + revealed monsters (F19),
                                           validate id uniqueness on reveal_monster (F9), auto-reveal on set_scene (F3)
    turn-tracker.ts                MODIFY: skip KO'd actors in advance() / sequence() (F17)
    adventure.ts                   (no change — Scene.monsters already declared)

  log/
    events.ts                      (no change — rule_violation event already typed)

  runtime/
    agent.ts                       MODIFY: emit rule_violation events on engine err (F16);
                                           interpretFreeText uses PLAYER_TOOLS + decoder fallback (F6, F13);
                                           DM observation summary reflects engine state after end_combat (F2 via F18 cascade)
    orchestrator.ts                MODIFY: surface narrate on rejected structured human action (F7);
                                           between-turns DM-react hook (F8);
                                           drop redundant auto end_combat now that engine gates phase (F18)
    prompt/
      builder.ts                   MODIFY: split system into static+dynamic; dynamic state block goes into messages (F12)
      templates/
        player-system.ts           MODIFY: surface specialAction description/kind/range (F11);
                                           remove HP/pos/inventory from cacheable system text (F12);
                                           add closing-step rule (F1);
                                           document step_budget_exhausted (F15)
        dm-system.ts               MODIFY: tighten start_combat example (F14);
                                           document PLAYER_TOOLS access during human-input interpretation (F13);
                                           require canonical conclusion-text reading on combat end (F10);
                                           remove monster/party HP from cacheable header (F12)
        state-block.ts             NEW: render the dynamic state block (HP, pos, inventory, monsters) for both player + DM
    cli/
      slash-parser.ts              (no change)

  personas/
    dm-default.md                  MODIFY: explicit "read scene.conclusion text on combat end" rule (F10)

tests/
  engine/
    game-engine.test.ts            EXTEND: end_combat returns rule_violation when not in combat (F18);
                                           reveal_monster rejects duplicate id (F9);
                                           set_scene auto-reveals scene-declared monsters (F3, F19)
    turn-tracker.test.ts           EXTEND: advance() skips KO'd actors (F17)
  runtime/
    agent.test.ts                  EXTEND: rule_violation event emitted when engine rejects player action (F16);
                                           interpretFreeText returns PlayerActions when DM responds with PLAYER_TOOLS (F6)
    orchestrator.test.ts           EXTEND: rejected structured human action triggers DM narrate (F7);
                                           DM is invoked between turns when configured (F8)
    prompt/
      builder.test.ts              NEW or EXTEND: cacheable system text is invariant across position/HP changes (F12);
                                                   dynamic state block reflects current state (F12)
  integration/
    audit-baseline-replay.test.ts  NEW: pinned scripted-LLM regression replay of the 2026-05-08 baseline, asserting:
                                          - exactly one combat_ended in the log
                                          - no KO'd actor receives a turn slot
                                          - rule_violation events present where the engine rejected a tool use
                                          - human "I rush and swing" produces a normal_attack action, not skip_turn

  fixtures/
    audit-baseline-replay/
      scripted-dm.json             NEW: canned DM responses keyed by tag for the replay
      scripted-p1.json             NEW
      scripted-p2.json             NEW
      human-script.jsonl           NEW: free-text + structured-action lines mirroring the baseline run
```

---

## Task 0: Pin a regression-replay scaffold (no fixes yet — failing skeleton)

**Files:**
- Create: `tests/integration/audit-baseline-replay.test.ts`
- Create: `tests/fixtures/audit-baseline-replay/scripted-dm.json`
- Create: `tests/fixtures/audit-baseline-replay/scripted-p1.json`
- Create: `tests/fixtures/audit-baseline-replay/scripted-p2.json`
- Create: `tests/fixtures/audit-baseline-replay/human-script.jsonl`

**Why first:** every later task asserts against this replay. We write the test now so each fix has a concrete acceptance signal. The test will fail on every assertion until its corresponding task lands; that's expected.

- [ ] **Step 0.1: Write the failing replay test**

```ts
// tests/integration/audit-baseline-replay.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient, type ScriptedEntry } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { EventLog } from '../../src/log/event-log.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asAdventureId, asSceneId, asEffectId } from '../../src/engine/ids.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Character } from '../../src/engine/character.js';
import type { Event } from '../../src/log/events.js';
import type { HumanInput, HumanInputProvider } from '../../src/runtime/orchestrator.js';

const FIX_DIR = path.join(__dirname, '../fixtures/audit-baseline-replay');

const loadScripted = (file: string): ScriptedEntry[] =>
  JSON.parse(readFileSync(path.join(FIX_DIR, file), 'utf8')) as ScriptedEntry[];

class JsonlHumanProvider implements HumanInputProvider {
  private idx = 0;
  constructor(private readonly lines: HumanInput[]) {}
  async requestInput(): Promise<HumanInput> {
    const line = this.lines[this.idx++];
    if (!line) throw new Error('human-script exhausted');
    return line;
  }
}

const buildBaseline = () => {
  const grid = new Grid(
    Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const heroes: Character[] = [
    { id: asCharacterId('p1_anwen'), name: 'Anwen', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'Slashing Strike', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: 'Whirlwind Attack', description: 'hit all adjacent enemies' },
      bonusAbility: { id: asEffectId('teamwork'), name: 'Teamwork', description: '' },
      inventory: [], boons: [], skills: [] },
    { id: asCharacterId('p2_kael'), name: 'Kael', kind: 'hero', archetype: 'warlock',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 1, y: 0 },
      normalAttack: { kind: 'magic', name: 'Flaming Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Flame Burst', description: 'AoE burst, 2 squares around target' },
      bonusAbility: { id: asEffectId('arcane-mind'), name: 'Arcane Mind', description: '' },
      inventory: [], boons: [], skills: [] },
    { id: asCharacterId('human_bran'), name: 'Bran', kind: 'hero', archetype: 'hunter',
      pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 0, y: 1 },
      normalAttack: { kind: 'ranged', name: 'Quick Shot', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split Shot', description: '' },
      bonusAbility: { id: asEffectId('keen-eye'), name: 'Keen Eye', description: '' },
      inventory: [], boons: [], skills: [] },
  ];
  const adventure: Adventure = {
    id: asAdventureId('stub-layer-b'), title: 'Audit Replay', estimatedDurationMin: 10,
    scenes: [{
      id: asSceneId('stub-cell-b'),
      intro: 'You stand in a dim stone room. Three rats scurry near the back wall.',
      conclusion: 'With the last rat down, the room falls quiet.',
      map: { width: 8, height: 8, background: 'stub-cell-b', obstacles: [], exits: [] },
      monsters: [
        { type: 'giant-rat', startPos: { x: 5, y: 2 } },
        { type: 'giant-rat', startPos: { x: 6, y: 2 } },
        { type: 'giant-rat', startPos: { x: 5, y: 5 } },
      ],
      tactics: 'Rats hold their position until attacked.',
      abilityTests: [], transitions: [{ to: 'END' as const, trigger: 'all-monsters-ko' as const }],
    }],
  };
  const engine = new GameEngine({ seed: '0xC0FFEE', grid, characters: heroes, effects: reg });
  return { engine, adventure, heroes };
};

const readEvents = async (runDir: string): Promise<Event[]> => {
  const txt = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  return txt.trim().split('\n').map((l) => JSON.parse(l) as Event);
};

describe('audit-baseline-replay (regression)', () => {
  it('produces a clean log with no audit findings present', async () => {
    const { engine, adventure, heroes } = buildBaseline();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient(loadScripted('scripted-dm.json'));
    const p1Llm = new ScriptedLlmClient(loadScripted('scripted-p1.json'));
    const p2Llm = new ScriptedLlmClient(loadScripted('scripted-p2.json'));

    const humanLines = readFileSync(path.join(FIX_DIR, 'human-script.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as HumanInput);
    const human: HumanInputProvider = new JsonlHumanProvider(humanLines);

    const dm = new Agent({ role: 'dm', actorId: 'dm', llm: dmLlm, tools: DM_TOOLS,
      promptBuilder: builder, persona: 'You are even-handed.', model: 'test', maxTokens: 512,
      tag: 'dm', adventure,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      stepBudget: 12, engine });

    const players = new Map(heroes.filter((h) => h.id !== asCharacterId('human_bran')).map((h, i) => [
      h.id,
      new Agent({ role: 'player', actorId: h.id, llm: i === 0 ? p1Llm : p2Llm, tools: PLAYER_TOOLS,
        promptBuilder: builder, persona: 'p', model: 'test', maxTokens: 512, tag: i === 0 ? 'p1' : 'p2',
        adventure, getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
        stepBudget: 6, engine }),
    ]));

    const runDir = mkdtempSync(path.join(tmpdir(), 'replay-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players },
      human: { characterId: asCharacterId('human_bran'), provider: human },
      subscribers: [], stepBudget: { player: 6, dm: 12 },
      runDir, seed: '0xC0FFEE', runId: 'replay',
    });
    const result = await orch.run();
    const events = await readEvents(runDir);

    // F18/F2: no duplicate combat_ended
    const combatEnds = events.filter((e) => e.type === 'combat_ended');
    expect(combatEnds.length).toBe(1);

    // F17: KO'd actors do not appear as turn-takers after KO
    const koEvents = events.filter((e) => e.type === 'state_change'
      && (e as Event & { type: 'state_change' }).changes.some((c) => c.status === 'KO'));
    for (const ko of koEvents) {
      const koId = (ko as Event & { type: 'state_change' }).changes.find((c) => c.status === 'KO')!.id;
      const actionsAfter = events.filter((e) => e.t > ko.t && e.type === 'action'
        && (e as Event & { type: 'action' }).actorId === koId);
      expect(actionsAfter, `KO'd ${koId} should not act after t=${ko.t}`).toHaveLength(0);
    }

    // F16: rule_violation events are emitted (presence proves the channel works)
    expect(events.some((e) => e.type === 'rule_violation')).toBe(true);

    // F6: human's "rush and swing" must execute a normal_attack, not skip_turn
    const humanFreeTextIdx = events.findIndex((e) => e.type === 'human_input'
      && (e as Event & { type: 'human_input' }).text.startsWith('I rush'));
    expect(humanFreeTextIdx).toBeGreaterThanOrEqual(0);
    const followUp = events.slice(humanFreeTextIdx + 1, humanFreeTextIdx + 6)
      .find((e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('human_bran'));
    expect(followUp).toBeDefined();
    expect((followUp as Event & { type: 'action' }).action.kind).toBe('normal_attack');

    expect(result.outcome).toBe('success');
  });
});
```

- [ ] **Step 0.2: Write the four fixture files (minimal seeds; expand as later tasks need)**

```json
// tests/fixtures/audit-baseline-replay/scripted-dm.json
[
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "set_scene", "input": { "sceneId": "stub-cell-b" } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "You stand in a dim stone room." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "start_combat", "input": { "heroSide": ["p1_anwen", "p2_kael", "human_bran"], "monsterSide": ["giant-rat-1", "giant-rat-2", "giant-rat-3"] } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "narrate", "input": { "text": "Rats fall, chamber stills." } }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "offer_rest", "input": {} }] } },
  { "match": { "tag": "dm" }, "response": { "toolUses": [{ "name": "end_adventure", "input": { "outcome": "success" } }] } }
]
```

```json
// tests/fixtures/audit-baseline-replay/scripted-p1.json
[
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "move", "input": { "path": [{ "x": 0, "y": 0 }, { "x": 1, "y": 1 }, { "x": 2, "y": 2 }, { "x": 3, "y": 2 }, { "x": 4, "y": 2 }] } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-1" } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "move", "input": { "path": [{ "x": 4, "y": 2 }, { "x": 5, "y": 3 }] } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-2" } }] } },
  { "match": { "tag": "p1" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } }
]
```

```json
// tests/fixtures/audit-baseline-replay/scripted-p2.json
[
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "move", "input": { "path": [{ "x": 1, "y": 0 }, { "x": 2, "y": 1 }, { "x": 3, "y": 1 }] } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-2" } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-3" } }] } },
  { "match": { "tag": "p2" }, "response": { "toolUses": [{ "name": "end_turn", "input": {} }] } }
]
```

```jsonl
// tests/fixtures/audit-baseline-replay/human-script.jsonl
{"kind":"free_text","text":"I rush toward the closest rat and swing"}
{"kind":"structured_action","action":{"kind":"end_turn"}}
```

- [ ] **Step 0.3: Run the test to verify it fails**

Run: `npx vitest run tests/integration/audit-baseline-replay.test.ts`
Expected: FAIL — at minimum on `expect(events.some((e) => e.type === 'rule_violation')).toBe(true)` and on the human normal_attack assertion. The test stays red until later tasks land.

- [ ] **Step 0.4: Commit**

```bash
git add tests/integration/audit-baseline-replay.test.ts tests/fixtures/audit-baseline-replay/
git commit -m "test: add pinned baseline-replay regression test (currently red)"
```

---

## Task 1: Emit `rule_violation` events from the agent loop (F16)

**Files:**
- Modify: `src/runtime/agent.ts:140-145, 153-158, 128-132`
- Test: `tests/runtime/agent.test.ts` (extend)

**Why first among fixes:** every later assertion ("the engine rejected this — was it logged?") depends on this channel working.

- [ ] **Step 1.1: Write the failing test**

Append to `tests/runtime/agent.test.ts`:

```ts
import type { Event } from '../../src/log/events.js';
// ...

describe('Agent emits rule_violation events on engine rejection', () => {
  it('appends a rule_violation event when the engine returns err', async () => {
    const { engine, hero } = makeAgentTestEngine(); // existing helper
    const llm = new ScriptedLlmClient([
      // First step: try to attack a non-existent target → invalid-target
      { match: { tag: 'p' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'ghost' } }] } },
      // Second step: end turn after retry
      { match: { tag: 'p' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const captured: Event[] = [];
    const agent = new Agent({
      role: 'player', actorId: hero.id, llm, tools: PLAYER_TOOLS,
      promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      persona: 'p', model: 'test', maxTokens: 256, tag: 'p',
      adventure: stubAdventure(), getActiveScene: () => stubAdventure().scenes[0]!,
      getCharacters: () => [hero], getMonstersInScene: () => [],
      stepBudget: 6, engine,
    });
    engine.beginNarrativeTurn(hero.id);
    await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {
      emitThought: () => {},
      emitBudgetExhausted: () => {},
      onEngineActed: async () => { captured.push(...engine.flushEvents()); },
      onLlmResponse: () => {},
    });
    captured.push(...engine.flushEvents());
    const violations = captured.filter((e) => e.type === 'rule_violation');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect((violations[0] as Event & { type: 'rule_violation' }).violation.reason).toBe('invalid-target');
    expect((violations[0] as Event & { type: 'rule_violation' }).actorId).toBe(hero.id);
  });
});
```

- [ ] **Step 1.2: Run the test, verify it fails**

Run: `npx vitest run tests/runtime/agent.test.ts -t "rule_violation"`
Expected: FAIL — `violations.length` is 0.

- [ ] **Step 1.3: Implement the emission in `src/runtime/agent.ts`**

Replace the player-rejection branch around line 140:

```ts
// src/runtime/agent.ts (player branch, was lines 140-145)
if (!result.ok) {
  this.args.engine.emitRuntime({
    type: 'rule_violation',
    actorId: this.args.actorId as CharacterId,
    violation: result.error,
  } as Omit<Event, 't'>);
  observation = { kind: 'rule_violation', reason: result.error.reason };
  steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
  await drainAndAppend();
  continue;
}
```

Apply the same pattern in the DM branch around line 153:

```ts
// src/runtime/agent.ts (dm branch, was lines 153-158)
if (!result.ok) {
  this.args.engine.emitRuntime({
    type: 'rule_violation',
    actorId: 'dm',
    violation: result.error,
  } as Omit<Event, 't'>);
  observation = { kind: 'rule_violation', reason: result.error.reason };
  steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: tu.name, toolInput: tu.input, observation });
  await drainAndAppend();
  continue;
}
```

And the "expected exactly 1 tool call" branch around line 128:

```ts
// src/runtime/agent.ts (was lines 128-133)
if (resp.toolUses.length !== 1) {
  this.args.engine.emitRuntime({
    type: 'rule_violation',
    actorId: this.args.role === 'dm' ? 'dm' : (this.args.actorId as CharacterId),
    violation: { reason: 'invalid-action-shape', details: `expected exactly 1 tool call, got ${resp.toolUses.length}` },
  } as Omit<Event, 't'>);
  observation = { kind: 'rule_violation', reason: `expected exactly 1 tool call, got ${resp.toolUses.length}` };
  steps.push({ thought: resp.thinkingBlocks.join('\n'), toolName: '(none)', toolInput: {}, observation });
  await drainAndAppend();
  continue;
}
```

- [ ] **Step 1.4: Run the test, verify it passes**

Run: `npx vitest run tests/runtime/agent.test.ts -t "rule_violation"`
Expected: PASS.

- [ ] **Step 1.5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: 148 prior tests still pass; one new test added.

- [ ] **Step 1.6: Commit**

```bash
git add src/runtime/agent.ts tests/runtime/agent.test.ts
git commit -m "feat(runtime): emit rule_violation events on engine rejection (F16)"
```

---

## Task 2: Phase-gate `end_combat` so it returns a rule_violation when not in combat (F18, cascades F2)

**Files:**
- Modify: `src/engine/game-engine.ts:130-133`
- Test: `tests/engine/game-engine.test.ts` (extend)

- [ ] **Step 2.1: Write the failing test**

Append to `tests/engine/game-engine.test.ts`:

```ts
describe('end_combat phase gate', () => {
  it('returns wrong-phase rule violation when not in combat', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    const r = e.applyDmAction({ kind: 'end_combat' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('wrong-phase');
  });

  it('emits exactly one combat_ended when called twice in a row', () => {
    const e = makeEngine([hero('h1', 0, 0)]);
    e.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('h1')], monsterSide: [] });
    e.flushEvents();
    const r1 = e.applyDmAction({ kind: 'end_combat' });
    expect(r1.ok).toBe(true);
    const r2 = e.applyDmAction({ kind: 'end_combat' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('wrong-phase');
    const events = e.flushEvents();
    expect(events.filter((ev) => ev.type === 'combat_ended').length).toBe(1);
  });
});
```

- [ ] **Step 2.2: Run, verify fails**

Run: `npx vitest run tests/engine/game-engine.test.ts -t "end_combat phase gate"`
Expected: FAIL — current code accepts and re-emits.

- [ ] **Step 2.3: Implement the gate**

Replace `src/engine/game-engine.ts:130-133`:

```ts
case 'end_combat':
  if (this.turn.phase !== 'combat') {
    return err({ reason: 'wrong-phase' });
  }
  this.turn.endCombat();
  this.emit({ type: 'combat_ended' } as unknown as Event);
  return ok({ turnEnded: false });
```

- [ ] **Step 2.4: Drop the orchestrator's redundant auto end_combat now that the engine self-protects**

In `src/runtime/orchestrator.ts:133-142`, the existing block calls `applyDmAction({ kind: 'end_combat' })` after every monster turn when all monsters are KO. Keep the *call* — it still serves as auto-resolution — but ignore the rule_violation when the phase has already transitioned. Replace the block with:

```ts
// orchestrator.ts (was lines 133-142)
const allMonstersKo = Array.from(this.cfg.engine.charactersById().values())
  .filter((c) => c.kind === 'monster')
  .every((c) => c.health.status === 'KO');
if (allMonstersKo && this.cfg.engine.turn.phase === 'combat') {
  const r = this.cfg.engine.applyDmAction({ kind: 'end_combat' });
  // wrong-phase here would only happen if a concurrent path already ended combat;
  // it's a benign no-op, but other reasons should surface.
  if (!r.ok && r.error.reason !== 'wrong-phase') {
    throw new Error(`auto end_combat rejected: ${r.error.reason}`);
  }
  await this.drainAndPublish(log);
}
```

- [ ] **Step 2.5: Run engine tests, verify pass**

Run: `npx vitest run tests/engine/game-engine.test.ts -t "end_combat phase gate"`
Expected: PASS.

- [ ] **Step 2.6: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2.7: Commit**

```bash
git add src/engine/game-engine.ts src/runtime/orchestrator.ts tests/engine/game-engine.test.ts
git commit -m "fix(engine): phase-gate end_combat to prevent duplicate combat_ended events (F18, F2)"
```

---

## Task 3: Skip KO'd actors in `TurnTracker.advance()` (F17)

**Files:**
- Modify: `src/engine/turn-tracker.ts:60-70`
- Modify: `src/engine/game-engine.ts` (pass character liveness map into advance)
- Test: `tests/engine/turn-tracker.test.ts` (extend)

- [ ] **Step 3.1: Write the failing test**

Append to `tests/engine/turn-tracker.test.ts`:

```ts
describe('advance skips KO actors', () => {
  it('skips a KO actor and lands on the next live actor', () => {
    const tt = new TurnTracker();
    const dice = new Dice('seed');
    tt.startCombat(dice,
      [asCharacterId('h1'), asCharacterId('h2')],
      [asCharacterId('m1'), asCharacterId('m2')]);
    const isAlive = (id: CharacterId): boolean =>
      id !== asCharacterId('m1'); // m1 is KO
    // Walk the cursor until we'd otherwise land on m1.
    while (tt.activeActorId !== asCharacterId('m1')) tt.advance(isAlive);
    // Now advance: tracker should skip m1 since !isAlive('m1') and land on the next live actor.
    tt.advance(isAlive);
    expect(tt.activeActorId).not.toBe(asCharacterId('m1'));
    expect(isAlive(tt.activeActorId!)).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run, verify fails**

Run: `npx vitest run tests/engine/turn-tracker.test.ts -t "skips KO"`
Expected: FAIL — `advance` takes no `isAlive` arg yet.

- [ ] **Step 3.3: Update `advance` to accept a liveness predicate and rotate past dead actors**

Replace `src/engine/turn-tracker.ts:60-63`:

```ts
advance(isAlive?: (id: CharacterId) => boolean): void {
  if (this.phase !== 'combat' || !this.combatOrder) return;
  const seq = this.sequence();
  if (seq.length === 0) return;
  for (let i = 0; i < seq.length; i++) {
    this.combatOrder.cursor = (this.combatOrder.cursor + 1) % seq.length;
    const next = seq[this.combatOrder.cursor]!;
    if (!isAlive || isAlive(next)) return;
  }
  // All actors dead — leave the cursor where it is; phase change is the caller's responsibility.
}
```

- [ ] **Step 3.4: Wire the predicate from the orchestrator**

In `src/runtime/orchestrator.ts`, replace each bare `this.cfg.engine.turn.advance()` with:

```ts
this.cfg.engine.turn.advance((id) => {
  const c = this.cfg.engine.charactersById().get(id);
  return c?.health.status !== 'KO';
});
```

There are at least two call sites: `runMonsterTurnPassive` (around line 130) and `runAiTurn` (around line 204).

- [ ] **Step 3.5: Run, verify pass**

Run: `npx vitest run tests/engine/turn-tracker.test.ts -t "skips KO"`
Expected: PASS.

- [ ] **Step 3.6: Run the full suite**

Run: `npm test`
Expected: all green. (Existing tests that called `advance()` with zero args still work via the optional predicate.)

- [ ] **Step 3.7: Commit**

```bash
git add src/engine/turn-tracker.ts src/runtime/orchestrator.ts tests/engine/turn-tracker.test.ts
git commit -m "fix(engine): skip KO'd actors in turn rotation (F17)"
```

---

## Task 4: Engine instantiates monsters on `set_scene` and on `reveal_monster`; reject duplicate IDs (F19, F9, F3)

**Files:**
- Modify: `src/engine/game-engine.ts:115-117` (`set_scene` auto-reveals scene-declared monsters)
- Modify: `src/engine/game-engine.ts:151-155` (`reveal_monster` actually adds to `characters`, validates id uniqueness)
- Modify: `src/runtime/orchestrator.ts` — drop any out-of-engine monster injection, since the engine now owns this.
- Test: `tests/engine/game-engine.test.ts` (extend)

- [ ] **Step 4.1: Write the failing tests**

Append to `tests/engine/game-engine.test.ts`:

```ts
describe('set_scene auto-reveals declared monsters', () => {
  it('adds monsters with deterministic IDs to engine.characters when set_scene is called', () => {
    const e = makeEngineWithCatalog(); // helper that loads the giant-rat catalog
    e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    e.flushEvents();
    const ids = Array.from(e.charactersById().keys());
    expect(ids).toContain(asCharacterId('giant-rat-1'));
    expect(ids).toContain(asCharacterId('giant-rat-2'));
    expect(ids).toContain(asCharacterId('giant-rat-3'));
  });
});

describe('reveal_monster id uniqueness', () => {
  it('rejects a reveal that collides with an existing character id', () => {
    const e = makeEngineWithCatalog();
    e.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('stub-cell-b') });
    e.flushEvents();
    const r = e.applyDmAction({
      kind: 'reveal_monster',
      monsterTypeId: 'giant-rat',
      characterId: asCharacterId('giant-rat-1'),
      pos: { x: 0, y: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid-action-shape');
  });
});
```

- [ ] **Step 4.2: Run, verify fails**

Run: `npx vitest run tests/engine/game-engine.test.ts -t "set_scene auto-reveals|reveal_monster id"`
Expected: FAIL — engine doesn't yet add monsters on set_scene; reveal_monster doesn't check uniqueness.

- [ ] **Step 4.3: Implement scene auto-reveal**

In `src/engine/game-engine.ts`, replace the `set_scene` branch (lines 115-117):

```ts
case 'set_scene': {
  const scene = this.adventure.scenes.find((s) => s.id === action.sceneId);
  if (!scene) return err({ reason: 'unknown-id', what: 'scene', id: String(action.sceneId) });
  this.emit({ type: 'scene_enter', sceneId: action.sceneId } as unknown as Event);
  // Auto-reveal scene-declared monsters with deterministic IDs.
  const counters: Record<string, number> = {};
  for (const m of scene.monsters) {
    counters[m.type] = (counters[m.type] ?? 0) + 1;
    const id = asCharacterId(`${m.type}-${counters[m.type]}`);
    if (this.characters.has(id)) {
      return err({ reason: 'invalid-action-shape', details: `auto-reveal id collision: ${id}` });
    }
    const monster = this.materializeMonster(m.type, id, m.startPos);
    this.characters.set(id, monster);
    this.emit({ type: 'action', actorId: 'dm',
      action: { kind: 'reveal_monster', monsterTypeId: m.type, characterId: id, pos: m.startPos } } as unknown as Event);
  }
  return ok({ turnEnded: false });
}
```

This requires:
1. `this.adventure` field on `GameEngine` — wire it through the constructor config (mirror existing `effects`/`grid` injection).
2. A `materializeMonster(typeId, id, pos)` helper that reads the monster catalog and produces a `Character`. The Layer A code already has the catalog loader in `src/engine/catalogs.ts`; reuse it.

- [ ] **Step 4.4: Implement reveal_monster id-uniqueness + instantiation**

Replace the `reveal_monster` branch (lines 151-155):

```ts
case 'reveal_monster': {
  if (this.characters.has(action.characterId)) {
    return err({ reason: 'invalid-action-shape', details: `id already in use: ${action.characterId}` });
  }
  const monster = this.materializeMonster(action.monsterTypeId, action.characterId, action.pos);
  this.characters.set(action.characterId, monster);
  this.emit({ type: 'action', actorId: 'dm', action } as unknown as Event);
  return ok({ turnEnded: false });
}
```

- [ ] **Step 4.5: Drop any out-of-engine monster injection in the orchestrator**

Search `src/runtime/orchestrator.ts` for code that inserts monsters into `engine.characters` directly (the existing `reveal_monster` branch's previous implementation deferred this to the orchestrator per the engine comment at line 152 in the audit bundle). Remove it; the engine now owns instantiation.

```bash
grep -n "characters\|reveal_monster" src/runtime/orchestrator.ts
```

Delete any block that mutates `engine.characters` outside the engine.

- [ ] **Step 4.6: Run, verify the new tests pass**

Run: `npx vitest run tests/engine/game-engine.test.ts -t "set_scene|reveal_monster id"`
Expected: PASS.

- [ ] **Step 4.7: Run the full suite**

Run: `npm test`
Expected: all green. The integration test from Task 0 should now pass an additional assertion (set_scene seeds giant-rats automatically), but the test as a whole still fails on later checks.

- [ ] **Step 4.8: Commit**

```bash
git add src/engine/game-engine.ts src/runtime/orchestrator.ts tests/engine/game-engine.test.ts
git commit -m "fix(engine): auto-reveal scene monsters and reject duplicate IDs (F19, F9, F3)"
```

---

## Task 5: `interpretFreeText` exposes `PLAYER_TOOLS` to the DM and decodes them (F6)

**Files:**
- Modify: `src/runtime/agent.ts:215-243`
- Modify: `src/runtime/prompt/templates/dm-system.ts:326-330` (covered in Task 7)
- Test: `tests/runtime/agent.test.ts` (extend)

- [ ] **Step 5.1: Write the failing test**

Append to `tests/runtime/agent.test.ts`:

```ts
describe('Agent.interpretFreeText (DM role)', () => {
  it('returns PlayerActions when the DM responds with PLAYER_TOOLS', async () => {
    const { engine, hero } = makeAgentTestEngine();
    const llm = new ScriptedLlmClient([
      { match: { tag: 'dm:interp' }, response: { toolUses: [
        { name: 'normal_attack', input: { targetId: hero.id } },
      ] } },
    ]);
    const dm = new Agent({
      role: 'dm', actorId: 'dm', llm, tools: DM_TOOLS,
      promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      persona: 'p', model: 'test', maxTokens: 256, tag: 'dm',
      adventure: stubAdventure(), getActiveScene: () => stubAdventure().scenes[0]!,
      getCharacters: () => [hero], getMonstersInScene: () => [],
      stepBudget: 12, engine,
    });
    const out = await dm.interpretFreeText('Attack the rat!', hero.id, [], 0, { emitThought: () => {} });
    expect(out.actions.length).toBe(1);
    expect(out.actions[0]!.kind).toBe('normal_attack');
  });
});
```

- [ ] **Step 5.2: Run, verify fails**

Run: `npx vitest run tests/runtime/agent.test.ts -t "interpretFreeText"`
Expected: FAIL — current code throws on decode and silently returns 0 actions.

- [ ] **Step 5.3: Update `interpretFreeText` to send PLAYER_TOOLS instead of DM tools**

Replace the body of `interpretFreeText` in `src/runtime/agent.ts` (lines 215-243):

```ts
const interpReq = {
  system: prompt.system,
  messages: prompt.messages,
  // The DM is interpreting human input on the human's behalf, so it must call
  // PLAYER_TOOLS, not its own DM toolset.
  tools: PLAYER_TOOLS,
  thinking: { type: 'enabled' as const },
  model: this.args.model,
  maxTokens: this.args.maxTokens,
  tag: `${this.args.tag}:interp`,
};
const resp = await this.args.llm.complete(interpReq as never);

for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

const actions: PlayerAction[] = [];
for (const tu of resp.toolUses) {
  try {
    actions.push(decodePlayerToolUse(tu));
  } catch (e) {
    // A failed decode here is informative — surface it as a rule_violation event
    // so the audit log records the DM's bad interpretation.
    this.args.engine.emitRuntime({
      type: 'rule_violation',
      actorId: 'dm',
      violation: { reason: 'invalid-action-shape', details: `interp decode failed for ${tu.name}: ${(e as Error).message}` },
    } as Omit<Event, 't'>);
  }
}
return { actions, thinking: resp.thinkingBlocks };
```

Add the import if missing:

```ts
import { PLAYER_TOOLS, decodePlayerToolUse } from './prompt/tools.js';
```

- [ ] **Step 5.4: Run the new test, verify pass**

Run: `npx vitest run tests/runtime/agent.test.ts -t "interpretFreeText"`
Expected: PASS.

- [ ] **Step 5.5: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 5.6: Commit**

```bash
git add src/runtime/agent.ts tests/runtime/agent.test.ts
git commit -m "fix(runtime): interpretFreeText exposes PLAYER_TOOLS to DM (F6)"
```

---

## Task 6: Surface a DM `narrate` when a structured human action is rejected (F7)

**Files:**
- Modify: `src/runtime/orchestrator.ts:272-284`
- Test: `tests/runtime/orchestrator.test.ts` (extend)

- [ ] **Step 6.1: Write the failing test**

Append to `tests/runtime/orchestrator.test.ts`:

```ts
describe('rejected structured human action surfaces a narrate', () => {
  it('emits a DM narrate explaining the rejection instead of silently skipping', async () => {
    const { engine, adventure, heroes } = buildSceneWithKoMonster(); // helper: rat starts KO'd
    // Human attacks the KO'd rat — engine must reject invalid-target.
    const human: HumanInputProvider = {
      requestInput: async () => ({ kind: 'structured_action',
        action: { kind: 'normal_attack', targetId: asCharacterId('giant-rat-1') } }),
    };
    const captured = new CapturingSubscriber();
    const orch = makeOrchestrator({ engine, adventure, heroes, human, subscribers: [captured] });
    await orch.runOneHumanTurn(asCharacterId('human_bran')); // testing seam, see step 6.3
    const narrates = captured.events.filter((e) => e.type === 'narrate');
    expect(narrates.length).toBeGreaterThanOrEqual(1);
    expect((narrates[0] as Event & { type: 'narrate' }).text.toLowerCase()).toMatch(/(invalid|rejected|cannot)/);
  });
});
```

- [ ] **Step 6.2: Run, verify fails**

Run: `npx vitest run tests/runtime/orchestrator.test.ts -t "rejected structured"`
Expected: FAIL — orchestrator currently falls through to skip_turn silently.

- [ ] **Step 6.3: If `runHumanTurn` is private, expose a thin testing seam**

In `src/runtime/orchestrator.ts`, change `private async runHumanTurn` to a package-level method that the test can call directly. Either:
1. Make `runHumanTurn` non-private and rename the test invocation to call it; or
2. Expose `runOneHumanTurn(actorId)` as a public method that calls `runHumanTurn`.

Pick option 2 to avoid widening the API surface unintentionally:

```ts
async runOneHumanTurn(actorId: CharacterId): Promise<void> {
  const log = await EventLog.create(path.join(this.cfg.runDir, 'events.jsonl'));
  try { await this.runHumanTurn(actorId, log); } finally { await log.close(); }
}
```

- [ ] **Step 6.4: Implement the narrate-on-rejection branch**

Replace the structured-action branch in `src/runtime/orchestrator.ts:272-284`:

```ts
} else if (input.kind === 'structured_action') {
  const r = this.cfg.engine.applyAction(actorId, input.action);
  if (!r.ok) {
    // Surface the rejection through DM narrate so the player sees feedback,
    // and emit the rule_violation event for the audit log.
    this.cfg.engine.emitRuntime({
      type: 'rule_violation', actorId, violation: r.error,
    } as Omit<Event, 't'>);
    this.cfg.engine.emitRuntime({
      type: 'narrate', actorId: 'dm',
      text: `That action can't be taken: ${r.error.reason}.`,
    } as Omit<Event, 't'>);
    const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
    if (!skip.ok) throw new Error(`fallback skip_turn rejected: ${skip.error.reason}`);
  }
  await this.drainAndPublish(log);
  if (input.action.kind !== 'end_turn' && input.action.kind !== 'skip_turn' && r.ok) {
    const end = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
    if (end.ok) await this.drainAndPublish(log);
  }
}
```

- [ ] **Step 6.5: Run, verify pass**

Run: `npx vitest run tests/runtime/orchestrator.test.ts -t "rejected structured"`
Expected: PASS.

- [ ] **Step 6.6: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6.7: Commit**

```bash
git add src/runtime/orchestrator.ts tests/runtime/orchestrator.test.ts
git commit -m "fix(runtime): surface DM narrate when human structured action is rejected (F7)"
```

---

## Task 7: DM template documents PLAYER_TOOLS access during human-input interpretation; tighten start_combat example (F13, F14)

**Files:**
- Modify: `src/runtime/prompt/templates/dm-system.ts:316-330`
- Test: `tests/runtime/prompt/builder.test.ts` (extend; create file if missing)

- [ ] **Step 7.1: Write the failing test**

In `tests/runtime/prompt/builder.test.ts`, append (or create the file if missing):

```ts
import { describe, it, expect } from 'vitest';
import { renderDmSystem } from '../../../src/runtime/prompt/templates/dm-system.js';
// ...build minimal ctx with one party + one monster...

describe('DM system prompt — human-input section', () => {
  it('mentions PLAYER_TOOLS when documenting human-input interpretation', () => {
    const text = renderDmSystem({
      adventure: stubAdventure(),
      activeScene: stubAdventure().scenes[0]!,
      party: [stubHero()],
      monstersInScene: [],
      persona: 'persona',
    });
    expect(text).toMatch(/move|normal_attack|use_item|say/);
    expect(text).toMatch(/PLAYER_TOOLS|player tool/i);
  });

  it('does not include literal `…` placeholder in start_combat example', () => {
    const text = renderDmSystem({ /* same ctx */ });
    expect(text).not.toMatch(/heroSide=\["[^"]+", \.\.\./);
  });
});
```

- [ ] **Step 7.2: Run, verify fails**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "human-input"`
Expected: FAIL.

- [ ] **Step 7.3: Edit `src/runtime/prompt/templates/dm-system.ts`**

Replace the YOUR TURN STRUCTURE block (around lines 313-330):

```ts
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
CONCLUSION (read faithfully on combat end, before offer_rest):
"""
${ctx.activeScene.conclusion}
"""

PARTY: ${partyIds}
MONSTERS PRESENT: ${monsterIds}

PERSONA
${ctx.persona}

YOUR TURN STRUCTURE
  Out of combat: narrate → call request_action(actorId) to hand off.
  Combat: call start_combat({heroSide, monsterSide}) ONCE — both lists must
  contain id= values from PARTY/MONSTERS PRESENT (full list, not abbreviated).
  Example: heroSide=[${ctx.party.map((c) => `"${c.id}"`).join(', ')}]
           monsterSide=[${ctx.monstersInScene.map((m) => `"${m.id}"`).join(', ') || '<no monsters yet>'}]
  Engine drives initiative; you only narrate outcomes between turns. Combat
  auto-ends when one side is fully KO'd — do NOT call end_combat after that;
  the engine will reject it as wrong-phase. After auto-end, read the scene
  CONCLUSION text faithfully, then offer_rest.

ID DISCIPLINE
  Every tool parameter that takes an actor id (request_action.actorId,
  start_combat.heroSide/monsterSide, reveal_monster.characterId) MUST be
  one of the id= values in PARTY/MONSTERS PRESENT. Names, positions, or
  descriptions will be rejected.

INTERPRETING THE HUMAN
  When the human types free text, the runtime asks YOU to translate it
  into player tool calls on their behalf. During that interpretation step,
  your tool vocabulary switches to PLAYER_TOOLS: move, normal_attack,
  special_action, use_item, use_boon, equip, ability_test, say, end_turn.
  Call exactly the tool the human meant. If their intent is ambiguous,
  call narrate instead with a clarifying question (the runtime will ask
  the human again next turn).`;
```

Move the dynamic `partyIds` / `monsterIds` lines to come from a static helper that lists IDs only (no HP/pos — those move into Task 9's dynamic state block). For now, keep them inline:

```ts
const partyIds = ctx.party.map((c) => c.id).join(', ');
const monsterIds = ctx.monstersInScene.map((m) => m.id).join(', ') || '(none placed yet)';
```

- [ ] **Step 7.4: Run, verify pass**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "human-input"`
Expected: PASS.

- [ ] **Step 7.5: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7.6: Commit**

```bash
git add src/runtime/prompt/templates/dm-system.ts tests/runtime/prompt/builder.test.ts
git commit -m "fix(prompt): DM template documents PLAYER_TOOLS for human-input interpretation (F13, F14)"
```

---

## Task 8: Surface `specialAction` description, kind, range in player template (F11, F4)

**Files:**
- Modify: `src/runtime/prompt/templates/player-system.ts:217-228`
- Test: `tests/runtime/prompt/builder.test.ts` (extend)

- [ ] **Step 8.1: Write the failing test**

```ts
describe('player system prompt — specialAction description', () => {
  it('includes specialAction.description in the rendered text', () => {
    const c = makeWarriorWithSpecial({
      id: 'whirlwind-attack',
      name: 'Whirlwind Attack',
      description: 'Strike all adjacent enemies (1 melee die per target).',
    });
    const text = renderPlayerSystem({ character: c, persona: '', partyDescription: '' });
    expect(text).toMatch(/Whirlwind Attack/);
    expect(text).toMatch(/Strike all adjacent enemies/);
  });
});
```

- [ ] **Step 8.2: Run, verify fails**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "specialAction description"`
Expected: FAIL — current template only emits `c.specialAction.name`.

- [ ] **Step 8.3: Edit `src/runtime/prompt/templates/player-system.ts:24`**

Replace the special-action line:

```ts
Special action: ${c.specialAction.name} — ${c.specialAction.description || '(no description)'}
```

- [ ] **Step 8.4: Run, verify pass**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "specialAction description"`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add src/runtime/prompt/templates/player-system.ts tests/runtime/prompt/builder.test.ts
git commit -m "fix(prompt): surface specialAction description in player system prompt (F11, F4)"
```

---

## Task 9: Split system prompt into static head + dynamic state block (F12)

**Files:**
- Create: `src/runtime/prompt/templates/state-block.ts`
- Modify: `src/runtime/prompt/templates/player-system.ts:217-228`
- Modify: `src/runtime/prompt/templates/dm-system.ts:276-281`
- Modify: `src/runtime/prompt/builder.ts:78-79, 108-140`
- Test: `tests/runtime/prompt/builder.test.ts` (extend)

**Why:** the live baseline run got `cacheHitRatio: 0.083`. Per-step changes to `Position`, `Health`, and `partyLines` invalidate the entire cacheable system block on every action. Solution: keep `system` as character/role-static text (cacheable across all turns) and emit a fresh dynamic state block as a non-cached user-message segment.

- [ ] **Step 9.1: Write the failing test**

```ts
describe('PromptBuilder — system text is invariant under state changes', () => {
  it('produces identical system text before and after a position change', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const c = makeWarriorAt(0, 0);
    const before = builder.buildPlayer({
      character: c, persona: 'p', partyDescription: 'allies',
      adventure: stubAdventure(), activeScene: stubAdventure().scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const cMoved = { ...c, pos: { x: 5, y: 5 } };
    const after = builder.buildPlayer({
      character: cMoved, persona: 'p', partyDescription: 'allies',
      adventure: stubAdventure(), activeScene: stubAdventure().scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    expect(after.system.map((s) => s.text)).toEqual(before.system.map((s) => s.text));
  });

  it('emits a dynamic state-block message segment that DOES change with state', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const c = makeWarriorAt(0, 0);
    const before = builder.buildPlayer({ /* same as above with pos (0,0) */ });
    const cMoved = { ...c, pos: { x: 5, y: 5 } };
    const after = builder.buildPlayer({ /* same as above with pos (5,5) */ });
    const stateBlockBefore = before.messages.find((m) =>
      m.content.some((c) => c.text.startsWith('CURRENT STATE')));
    const stateBlockAfter = after.messages.find((m) =>
      m.content.some((c) => c.text.startsWith('CURRENT STATE')));
    expect(stateBlockBefore).toBeDefined();
    expect(stateBlockAfter).toBeDefined();
    expect(stateBlockBefore!.content[0]!.text).not.toEqual(stateBlockAfter!.content[0]!.text);
  });
});
```

- [ ] **Step 9.2: Run, verify fails**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "system text is invariant"`
Expected: FAIL.

- [ ] **Step 9.3: Create `state-block.ts`**

```ts
// src/runtime/prompt/templates/state-block.ts
import type { Character } from '../../../engine/character.js';

export interface PlayerStateBlockCtx {
  character: Character;
}

export interface DmStateBlockCtx {
  party: Character[];
  monstersInScene: Character[];
}

export const renderPlayerStateBlock = (ctx: PlayerStateBlockCtx): string => {
  const c = ctx.character;
  const inv = c.inventory.length === 0
    ? '(empty)'
    : c.inventory.map((s) => `${s.itemId}×${s.count}`).join(', ');
  const posStr = c.pos ? `(${c.pos.x}, ${c.pos.y})` : 'unplaced';
  return `CURRENT STATE
  Position: ${posStr}     Health: ${c.health.total - c.health.damage}/${c.health.total} (${c.health.status})
  Inventory: ${inv}`;
};

export const renderDmStateBlock = (ctx: DmStateBlockCtx): string => {
  const partyLines = ctx.party.map(
    (c) => `  - ${c.id} HP ${c.health.total - c.health.damage}/${c.health.total} pos=(${c.pos?.x},${c.pos?.y})`,
  ).join('\n');
  const monsterLines = ctx.monstersInScene.map(
    (m) => `  - ${m.id} HP ${m.health.total - m.health.damage}/${m.health.total} pos=(${m.pos?.x},${m.pos?.y})`,
  ).join('\n') || '  (none placed yet)';
  return `CURRENT STATE
PARTY:
${partyLines}
MONSTERS PRESENT:
${monsterLines}`;
};
```

- [ ] **Step 9.4: Strip dynamic state out of `player-system.ts`**

Replace the `YOUR CHARACTER SHEET` block in `src/runtime/prompt/templates/player-system.ts:217-228` to keep only static fields:

```ts
return `You are ${c.name}, a ${c.archetype ?? 'hero'} in a HeroKids adventure played around a virtual table.

YOUR CHARACTER SHEET
  id=${c.id}
  Max HP: ${c.health.total}
  Melee ${c.pools.melee}d6  Ranged ${c.pools.ranged}d6
  Magic ${c.pools.magic}d6  Armor  ${c.pools.armor}d6
  Normal attack: ${c.normalAttack.name} (kind: ${c.normalAttack.kind}, range ${c.normalAttack.range})
  Special action: ${c.specialAction.name} — ${c.specialAction.description || '(no description)'}
  Bonus (passive): ${c.bonusAbility.name}
  Skills:    ${skills}
(Live HP, position, and inventory appear in the CURRENT STATE block below each turn.)

MOVEMENT RULES
  When you call move({path}), path[0] MUST be your current position from
  CURRENT STATE. Each subsequent entry must be a square adjacent to the
  previous one (8-directional). Movement budget is 4 squares per turn
  (5 with rogue's Nimble). You cannot end your turn on an enemy or ally
  square.

PERSONA
${ctx.persona}

YOUR PARTY
${ctx.partyDescription}

HOW YOU ACT
  Each turn, you may take SEVERAL reasoning steps. On each step, think
  privately, then call EXACTLY ONE tool from the action vocabulary. Your
  reasoning is PRIVATE — only your tool calls and say() are seen by others.
  End your turn with end_turn. Step budget: 6 per turn.
  CLOSING-STEP RULE: when your final action of the turn is end_turn, call
  end_turn directly with no narration thought — don't burn a step restating
  that you're done.

WHAT YOU SEE
  - DM narration & scene description
  - Every character's public actions and effects
  - Everything any character says aloud
  - The CURRENT STATE block at the head of each step
  You do NOT see anyone else's private thoughts.
  If you receive a step_budget_exhausted observation, the runtime will
  force end_turn for you on the next step — wrap up if you can.

GOAL
  Help the party complete the adventure. Behave consistently with your
  persona. Coordinate through dialogue and visible action — your teammates
  literally cannot read your mind.`;
```

(`skills` is already defined in this template; keep that line.)

- [ ] **Step 9.5: Strip dynamic state out of `dm-system.ts`**

Remove the `partyLines`/`monsterLines` blocks and replace the `PARTY:` / `MONSTERS PRESENT:` sections with a static reference:

```ts
PARTY: ${partyIds}
MONSTERS PRESENT: ${monsterIds}
(Live HP, positions appear in the CURRENT STATE block below each step.)
```

- [ ] **Step 9.6: Wire dynamic state-block into `builder.ts`**

In `src/runtime/prompt/builder.ts`:

```ts
import { renderPlayerStateBlock, renderDmStateBlock } from './templates/state-block.js';

// in buildPlayer, after computing systemText:
const stateBlock = renderPlayerStateBlock({ character: args.character });
return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx, stateBlock);

// in buildDm:
const stateBlock = renderDmStateBlock({
  party: args.party,
  monstersInScene: args.monstersInScene,
});
return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx, stateBlock);
```

Update `assemble`'s signature to accept `stateBlock: string` and prepend it (uncached) to band 3:

```ts
private assemble(
  systemText: string,
  history: Event[],
  observation: Observation,
  currentTurnIdx: number,
  stateBlock: string,
): BuiltPrompt {
  // ... unchanged through line 121 ...
  const tailLines = tail.map(formatEventLine).join('\n');
  const obsLine = (() => {
    switch (observation.kind) {
      case 'fresh_turn':         return 'It is your turn. Take your first reasoning step.';
      case 'rule_violation':     return `Rule violation: ${observation.reason}. Choose another action.`;
      case 'public_resolution':  return `Result of your last action: ${observation.summary}. Continue your turn.`;
    }
  })();
  const tailText = `${stateBlock}\n\n` +
    (tail.length > 0 ? `Recent events:\n${tailLines}\n\n` : '') +
    obsLine;
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: tailText, cacheable: false }],
  });
  return { system, messages };
}
```

- [ ] **Step 9.7: Run, verify pass**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "system text is invariant"`
Expected: PASS.

- [ ] **Step 9.8: Run the full suite**

Run: `npm test`
Expected: all green. Existing prompt-builder tests may need updates if they grep system text for HP/pos — fix them to grep the dynamic state block instead.

- [ ] **Step 9.9: Commit**

```bash
git add src/runtime/prompt/templates/ src/runtime/prompt/builder.ts tests/runtime/prompt/builder.test.ts
git commit -m "fix(prompt): split system into cacheable head + dynamic state block (F12)"
```

---

## Task 10: DM persona reads the canonical scene `conclusion` text on combat end (F10)

**Files:**
- Modify: `personas/dm-default.md`
- (Already covered partially in Task 7's CONCLUSION block; this task ensures the persona reinforces it.)

- [ ] **Step 10.1: Write the failing test**

In `tests/runtime/prompt/builder.test.ts`:

```ts
describe('DM persona — conclusion text rule', () => {
  it('mentions reading the conclusion faithfully on combat end', () => {
    const persona = readFileSync(path.join(__dirname, '../../../personas/dm-default.md'), 'utf8');
    expect(persona.toLowerCase()).toMatch(/conclusion/);
    expect(persona.toLowerCase()).toMatch(/combat end|combat ends|when combat ends/);
  });
});
```

- [ ] **Step 10.2: Run, verify fails**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "conclusion text"`
Expected: FAIL.

- [ ] **Step 10.3: Edit `personas/dm-default.md`**

Append to the existing persona:

```md
You are an even-handed Dungeon Master. You read the canonical scene text
faithfully on entry. You never roll dice — the engine does. When the
players act, you narrate the outcome briefly (one or two sentences),
adjudicating fuzzy edge cases when needed. You hand turns off promptly.

When combat ends (the engine emits combat_ended automatically when one
side is fully KO'd), you read the active scene's CONCLUSION text
faithfully — verbatim or lightly paraphrased — before offering rest.
Do not call end_combat yourself; the engine has already done so.
```

- [ ] **Step 10.4: Run, verify pass**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "conclusion text"`
Expected: PASS.

- [ ] **Step 10.5: Commit**

```bash
git add personas/dm-default.md tests/runtime/prompt/builder.test.ts
git commit -m "fix(persona): DM reads scene conclusion text on combat end (F10)"
```

---

## Task 11: Add a between-turns DM-react hook in the orchestrator (F8)

**Files:**
- Modify: `src/runtime/orchestrator.ts:200-211` and `:127-145`
- Modify: `src/runtime/agent.ts` (add a one-shot `react` method on the DM agent)
- Test: `tests/runtime/orchestrator.test.ts` (extend)

**Why:** in the audit run, the DM was inert during 54 events of combat. The system prompt promises mid-turn narration; nothing in the runtime actually invokes it.

- [ ] **Step 11.1: Write the failing test**

```ts
describe('DM reacts between player turns', () => {
  it('invokes the DM with a "react" tag after each player turn ends', async () => {
    const dmLlm = new ScriptedLlmClient([
      // initial DM turn ...
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'set_scene', input: { sceneId: 's' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'start_combat', input: { heroSide: ['p1'], monsterSide: [] } }] } },
      // react after each player turn:
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Anwen presses forward.' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    // ... build orchestrator with a single AI player who attacks then ends ...
    const result = await orch.run();
    const events = await readEvents(orch.runDir);
    const reactNarrates = events.filter((e) => e.type === 'narrate'
      && (e as Event & { type: 'narrate' }).text === 'Anwen presses forward.');
    expect(reactNarrates).toHaveLength(1);
    expect(result.outcome).toBe('success');
  });
});
```

- [ ] **Step 11.2: Run, verify fails**

Run: `npx vitest run tests/runtime/orchestrator.test.ts -t "DM reacts between"`
Expected: FAIL — no `dm:react` LLM call ever happens.

- [ ] **Step 11.3: Add a one-shot `react` method to `Agent`**

In `src/runtime/agent.ts`, after `interpretFreeText`:

```ts
/**
 * Single-step DM reaction between player turns. The DM gets one tool call
 * and is expected to either narrate, call request_action, or end_adventure.
 */
async react(history: Event[], currentTurnIdx: number, hooks: AgentRunHooks): Promise<void> {
  if (this.args.role !== 'dm') {
    throw new Error('react is only valid on a DM agent');
  }
  const prompt = this.args.promptBuilder.buildDm({
    party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
    monstersInScene: this.args.getMonstersInScene(),
    persona: this.args.persona,
    adventure: this.args.adventure,
    activeScene: this.args.getActiveScene(),
    history,
    observation: { kind: 'public_resolution', summary:
      'A player turn just ended. React with one tool call (narrate/request_action/end_adventure) — or skip by calling narrate with empty text.' },
    currentTurnIdx,
  });
  const resp = await this.args.llm.complete({
    system: prompt.system, messages: prompt.messages,
    tools: this.args.tools, thinking: { type: 'enabled' as const },
    model: this.args.model, maxTokens: this.args.maxTokens, tag: `${this.args.tag}:react`,
  } as never);
  for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');
  hooks.onLlmResponse?.(`${this.args.tag}:react`, resp.usage);
  if (resp.toolUses.length === 1) {
    const action = decodeDmToolUse(resp.toolUses[0]!);
    const r = this.args.engine.applyDmAction(action);
    if (!r.ok) {
      this.args.engine.emitRuntime({
        type: 'rule_violation', actorId: 'dm', violation: r.error,
      } as Omit<Event, 't'>);
    }
  }
}
```

- [ ] **Step 11.4: Invoke the react hook from the orchestrator**

In `src/runtime/orchestrator.ts`, at the end of `runAiTurn`, `runHumanTurn`, and `runMonsterTurnPassive` (just before `this.currentTurnIdx += 1`), add:

```ts
// DM reacts between turns. Skipped if combat has just ended (DM will get
// a full turn next iteration) or if the adventure is done.
const last = this.allEvents[this.allEvents.length - 1];
const adventureDone = last?.type === 'adventure_ended';
if (!adventureDone) {
  await this.cfg.agents.dm.react(
    this.historyFor({ kind: 'self', actorId: 'dm' }),
    this.currentTurnIdx,
    {
      emitThought: (text) => this.cfg.engine.emitRuntime({
        type: 'thought', actorId: 'dm', text,
      } as Omit<Event, 't'>),
      emitBudgetExhausted: () => {},
      onEngineActed: async () => this.drainAndReturn(log),
      onLlmResponse: (role, usage) => this.recordUsage(role, usage),
    },
  );
  await this.drainAndPublish(log);
}
```

- [ ] **Step 11.5: Run, verify pass**

Run: `npx vitest run tests/runtime/orchestrator.test.ts -t "DM reacts between"`
Expected: PASS.

- [ ] **Step 11.6: Run the full suite**

Run: `npm test`
Expected: all green. The existing orchestrator tests now require an extra DM scripted entry per player turn — extend their fixtures with `tag: 'dm:react'` responses (use `narrate` with empty text for "no comment").

- [ ] **Step 11.7: Commit**

```bash
git add src/runtime/orchestrator.ts src/runtime/agent.ts tests/runtime/orchestrator.test.ts
git commit -m "feat(runtime): DM reacts between turns via single-step react hook (F8)"
```

---

## Task 12: Allow combining the closing reasoning step with `end_turn` (F1)

**Files:**
- Modify: `src/runtime/prompt/templates/player-system.ts` HOW YOU ACT block (already partially done in Task 9 — verify)

This is documentation-only; the system prompt now contains the CLOSING-STEP RULE from Task 9.4. No code change needed.

- [ ] **Step 12.1: Write the test**

```ts
describe('player system prompt — closing-step rule', () => {
  it('tells agents to call end_turn directly without a redundant thought', () => {
    const text = renderPlayerSystem({ character: stubHero(), persona: '', partyDescription: '' });
    expect(text).toMatch(/CLOSING-STEP RULE/);
    expect(text).toMatch(/end_turn directly/);
  });
});
```

- [ ] **Step 12.2: Run, verify pass (Task 9 already added the rule)**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "closing-step"`
Expected: PASS.

- [ ] **Step 12.3: Commit (no source change beyond Task 9)**

```bash
git add tests/runtime/prompt/builder.test.ts
git commit -m "test(prompt): pin closing-step rule (F1)"
```

---

## Task 13: Document `step_budget_exhausted` consequences in player template (F15)

**Files:**
- (Already added in Task 9.4 system prompt update; verify with a test.)

- [ ] **Step 13.1: Write the test**

```ts
describe('player system prompt — step_budget_exhausted', () => {
  it('explains what happens when the step budget runs out', () => {
    const text = renderPlayerSystem({ character: stubHero(), persona: '', partyDescription: '' });
    expect(text).toMatch(/step_budget_exhausted/);
    expect(text).toMatch(/force end_turn/);
  });
});
```

- [ ] **Step 13.2: Run, verify pass**

Run: `npx vitest run tests/runtime/prompt/builder.test.ts -t "step_budget_exhausted"`
Expected: PASS.

- [ ] **Step 13.3: Commit**

```bash
git add tests/runtime/prompt/builder.test.ts
git commit -m "test(prompt): pin step_budget_exhausted documentation (F15)"
```

---

## Task 14: Drop redundant DM `reveal_monster` calls from the baseline replay fixture and verify F3 effect

**Files:**
- Modify: `tests/fixtures/audit-baseline-replay/scripted-dm.json` (already minimal post-Task 0; verify no `reveal_monster` entries)
- Modify: `tests/runtime/orchestrator.test.ts` and other tests that scripted `reveal_monster` responses — those entries should now be unnecessary because Task 4 made the engine auto-reveal on `set_scene`.

- [ ] **Step 14.1: Search for tests that script `reveal_monster`**

Run: `grep -rn '"reveal_monster"' tests/`
Expected output: list of fixture entries.

- [ ] **Step 14.2: Remove the now-redundant entries from each fixture**

For each match, delete the `reveal_monster` scripted response. Confirm the test still passes (or update the surrounding fixture so the engine's auto-revealed monsters carry the same IDs the test expects).

- [ ] **Step 14.3: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 14.4: Commit**

```bash
git add tests/
git commit -m "refactor(tests): drop redundant reveal_monster scripted responses now that set_scene auto-reveals (F3)"
```

---

## Task 15: Make the pinned baseline-replay test green (closes the loop)

**Files:**
- Modify: `tests/fixtures/audit-baseline-replay/*` (extend if needed)
- Modify: `tests/integration/audit-baseline-replay.test.ts` (assertions only)

- [ ] **Step 15.1: Run the replay test**

Run: `npx vitest run tests/integration/audit-baseline-replay.test.ts`
Expected: depending on prior tasks, the test should now pass all assertions. If a fixture entry is missing because the orchestrator now invokes `dm:react` more often than the original fixture anticipated, extend `scripted-dm.json` with `dm:react` entries that respond with empty `narrate` calls.

- [ ] **Step 15.2: If the test fails, diagnose**

If `combatEnds.length` ≠ 1, audit which Task missed:
- 0 ends → Task 4's auto-reveal might have broken the orchestrator's auto-end check; verify line 136-142.
- 2+ ends → Task 2's phase-gate didn't land or there's a redundant call.

If `rule_violation.length` is 0, Task 1's emission isn't reaching the log — check `emitRuntime` is called inside `agent.ts:140`.

If the human's normal_attack isn't recorded, Task 5's PLAYER_TOOLS swap isn't applied OR the fixture's `scripted-dm.json` has no `dm:interp` response. Add one:

```json
{ "match": { "tag": "dm:interp" },
  "response": { "toolUses": [{ "name": "normal_attack", "input": { "targetId": "giant-rat-1" } }] } }
```

- [ ] **Step 15.3: Run the full suite**

Run: `npm test`
Expected: 148 + ~10 new tests, all green.

- [ ] **Step 15.4: Commit**

```bash
git add tests/
git commit -m "test(integration): green baseline-replay regression (closes audit findings)"
```

---

## Task 16: Verify cache hit ratio improvement against real Sonnet (manual + scripted)

**Files:**
- (No source change — verification only. Skip if `ANTHROPIC_API_KEY` isn't available.)

- [ ] **Step 16.1: Run the live smoke against real Sonnet**

```bash
npm run play scenarios/baseline.json -- --human-script tests/fixtures/layer-b/human-bran-script.jsonl
```

- [ ] **Step 16.2: Inspect the new run's manifest**

```bash
ls runs/ | tail -1 | xargs -I {} cat runs/{}/manifest.json | jq .cacheHitRatio
```

Expected: `cacheHitRatio` ≥ 0.30. Pre-fix baseline was 0.083. Post-Task-9 split should produce a ratio that rises with each agent step, since the system block is now invariant across an entire run.

If the ratio is still below 0.30, inspect the prompt: print the `system` text for two consecutive steps and `diff` them — they should be byte-identical.

- [ ] **Step 16.3: Document the new baseline ratio**

Update `CLAUDE.md` "Current state — Layer B complete" line:

```md
**B** | … | **✅ Done** (148 tests; live smoke against real Sonnet ran successfully on 2026-05-09 with cacheHitRatio ≥ 0.30 after audit fixes)
```

- [ ] **Step 16.4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record post-fix cache hit ratio in CLAUDE.md"
```

---

## Self-review checklist

**Coverage** — every audit finding has a task that addresses it:

| Finding | Task | Severity |
|---------|------|----------|
| F1 closing-step waste | T9, T12 | MED |
| F2 DM redundant combat_ended | T2 (cascades) | HIGH |
| F3 batched setup actions | T4 (auto-reveal) | MED |
| F4 special-action description hidden | T8 | LOW |
| F5 coordination via dialogue | (no fix — pass) | — |
| F6 human free text dropped | T5 | HIGH |
| F7 silent skip on rejected structured action | T6 | HIGH |
| F8 DM inert during combat | T11 | MED |
| F9 DM picks colliding monster IDs | T4 | LOW |
| F10 conclusion text not read | T7, T10 | LOW |
| F11 specialAction.description not surfaced | T8 | HIGH |
| F12 system prompt invalidates cache every step | T9 | HIGH |
| F13 DM template promises unfulfillable contract | T7 | MED |
| F14 DM template literal `…` placeholder | T7 | LOW |
| F15 step_budget_exhausted unexplained | T9, T13 | LOW |
| F16 rule_violation events not emitted | T1 | HIGH |
| F17 KO'd actors get turn slots | T3 | MED |
| F18 end_combat not idempotent | T2 | MED |
| F19 reveal_monster doesn't instantiate | T4 | MED |
| F20 thought leakage | (no fix — pass) | — |

**Placeholders** — no `TODO`/`TBD`/"similar to Task N"/abstract test stubs remain. Every step has runnable code or shell commands.

**Type consistency** — `Agent` constructor args match across tasks (Task 5 uses `engine` field for `emitRuntime`; Task 11 reuses the same field). `materializeMonster` is referenced in Task 4 only (helper internal to `GameEngine`). `runOneHumanTurn` is consistently named in Task 6 (no rename across tasks). `react` method on `Agent` is added in Task 11 and called in Task 11 only.

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-layer-b-audit-fixes.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
