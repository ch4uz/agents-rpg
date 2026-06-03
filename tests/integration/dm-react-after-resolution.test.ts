/**
 * After any `resolution` event (i.e. any dice roll), the next thing logged
 * to the event stream should be a DM narrate. This means in-turn dice rolls
 * during a player's normal_attack (or the human's interpreted attack) get
 * an immediate DM narration BEFORE the player's next ReACT step or before
 * the next interpreted action runs.
 *
 * Previously runDmReact only fired after the *whole* turn ended, so a
 * "Kael shoots → miss" resolution sat alone in the chat until end_turn.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator, type HumanInput } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import type { LlmClient, LlmCompleteRequest, LlmResponse } from '../../src/runtime/llm/llm-client.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import type { Adventure, Scene } from '../../src/engine/adventure.js';
import type { Character } from '../../src/engine/character.js';
import type { Event } from '../../src/log/events.js';
import type { Subscriber } from '../../src/runtime/subscriber.js';

class ResearcherCapturer implements Subscriber {
  readonly viewer = { kind: 'researcher' as const, revealThoughts: true };
  events: Event[] = [];
  onEvent(e: Event): void { this.events.push(e); }
}

/**
 * Wraps an inner LlmClient and records the (tag, concatenated message text) of
 * every complete() call, so a test can inspect what the DM react prompt
 * actually contained.
 */
class CapturingLlmClient implements LlmClient {
  calls: Array<{ tag: string; text: string }> = [];
  constructor(private readonly inner: LlmClient) {}
  async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
    const tag = (req as { tag?: string }).tag ?? '';
    const text = req.messages
      .map((m) => m.content.map((c) => c.text).join('\n'))
      .join('\n');
    this.calls.push({ tag, text });
    return this.inner.complete(req);
  }
}

const hero = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'hunter',
  pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
  health: { total: 3, damage: 0, status: 'normal' }, pos: { x, y },
  normalAttack: { kind: 'ranged', name: 'Quick Shot', range: 6, damageMod: 0 },
  specialAction: { id: asEffectId('split-shot'), name: 'Split Shot', description: '' },
  bonusAbility: { id: asEffectId('keen-eye'), name: 'Keen Eye', description: '' },
  inventory: [], boons: [], skills: [],
});

const monster = (id: string, x: number, y: number): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster', archetype: 'brute',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  health: { total: 1, damage: 0, status: 'normal' }, pos: { x, y },
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: 'Pack Attack', description: '' },
  bonusAbility: { id: asEffectId('vermin'), name: 'Vermin', description: '' },
  inventory: [], boons: [], skills: [],
});

const buildScene = (): Scene => ({
  id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
  map: { width: 8, height: 8, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
  monsters: [], tactics: '', abilityTests: [], transitions: [],
});

describe('DM reacts after every dice roll (resolution event)', () => {
  it('AI player attack produces resolution → DM narrate before any further player action', async () => {
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30, scenes: [buildScene()],
    };
    const grid = new Grid(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const p1 = hero('p1_warrior', 0, 0);
    const m1 = monster('giant-rat-1', 1, 0); // adjacent so the shot is in range immediately
    const engine = new GameEngine({
      seed: 's', grid, characters: [p1, m1], effects: reg, adventure,
    });
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    // p1 takes one normal_attack then end_turn.
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'giant-rat-1' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);

    // DM react fires AT LEAST twice: once after the resolution (within the turn),
    // once after end_turn (post-turn). Provide 4 entries so both kinds match.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'set_scene', input: { sceneId: 's' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'start_combat', input: { heroSide: ['p1_warrior'], monsterSide: ['giant-rat-1'] } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'AFTER_RESOLUTION_NARRATE' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'POST_TURN_NARRATE' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'POST_MONSTER_NARRATE' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);

    const sharedAgentArgs = {
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
    };
    const dm = new Agent({
      ...sharedAgentArgs, role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });
    const p1Agent = new Agent({
      ...sharedAgentArgs, role: 'player', actorId: asCharacterId('p1_warrior'),
      persona: '', llm: p1Llm, tools: PLAYER_TOOLS, stepBudget: 6, tag: 'p1',
    });

    const capture = new ResearcherCapturer();
    const runDir = mkdtempSync(path.join(tmpdir(), 'react-after-res-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map([[asCharacterId('p1_warrior'), p1Agent]]) },
      human: null,
      subscribers: [capture],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'react-after-res',
    });
    await orch.run();

    // The first resolution event: scan forward and assert the next narrate
    // appears before the next 'action' event from the same actor.
    const idxResolution = capture.events.findIndex((e) => e.type === 'resolution');
    expect(idxResolution).toBeGreaterThanOrEqual(0);

    // Find the next narrate AND the next action after the resolution.
    const after = capture.events.slice(idxResolution + 1);
    const nextNarrateOffset = after.findIndex((e) => e.type === 'narrate');
    const nextActionByP1Offset = after.findIndex((e) =>
      e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('p1_warrior'),
    );
    expect(nextNarrateOffset, 'a narrate should appear after the resolution').toBeGreaterThanOrEqual(0);
    expect(
      nextActionByP1Offset === -1 || nextNarrateOffset < nextActionByP1Offset,
      'narrate should come BEFORE the next p1 action (dice-roll narration must precede further play)',
    ).toBe(true);

    // The narrate text from the dm:react script — confirms it's the in-turn
    // react, not the post-turn one.
    const firstNarrateAfter = after[nextNarrateOffset] as Event & { type: 'narrate' };
    expect(firstNarrateAfter.text).toBe('AFTER_RESOLUTION_NARRATE');
  });

  it('human structured_action attack triggers DM react after resolution', async () => {
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30, scenes: [buildScene()],
    };
    const grid = new Grid(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const human = hero('human_hunter', 0, 0);
    const m1 = monster('giant-rat-1', 1, 0);
    const engine = new GameEngine({
      seed: 's', grid, characters: [human, m1], effects: reg, adventure,
    });
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'AFTER_HUMAN_ATTACK' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'POST_HUMAN_TURN' } }] } },
    ]);

    const dm = new Agent({
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });

    // After the engine fix, a structured action no longer auto-ends the turn —
    // the human now sends [attack, end_turn] explicitly (matching the UI flow
    // where the End Turn button is a separate click).
    const humanInputs: HumanInput[] = [
      { kind: 'structured_action', action: { kind: 'normal_attack', targetId: asCharacterId('giant-rat-1') } },
      { kind: 'structured_action', action: { kind: 'end_turn' } },
    ];
    let humanCursor = 0;
    const humanProvider = {
      requestInput: async () => humanInputs[humanCursor++]!,
    };

    const capture = new ResearcherCapturer();
    const runDir = mkdtempSync(path.join(tmpdir(), 'react-human-res-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map() },
      human: { characterId: asCharacterId('human_hunter'), provider: humanProvider },
      subscribers: [capture],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'react-human-res',
    });
    engine.turn.setNarrativeActor(asCharacterId('human_hunter'));
    await orch.runOneHumanTurn(asCharacterId('human_hunter'));

    // Find the indices of resolution, end_turn, and the first narrate after resolution.
    const idxResolution = capture.events.findIndex((e) => e.type === 'resolution');
    expect(idxResolution).toBeGreaterThanOrEqual(0);
    const idxEndTurn = capture.events.findIndex((e, i) =>
      i > idxResolution && e.type === 'action'
      && (e as Event & { type: 'action' }).action.kind === 'end_turn',
    );
    expect(idxEndTurn).toBeGreaterThan(idxResolution);

    // A narrate must appear strictly between the resolution and the end_turn.
    const narrateBetween = capture.events.slice(idxResolution + 1, idxEndTurn)
      .find((e) => e.type === 'narrate') as (Event & { type: 'narrate' }) | undefined;
    expect(narrateBetween, 'a narrate should fire between resolution and end_turn').toBeDefined();
    expect(narrateBetween!.text).toBe('AFTER_HUMAN_ATTACK');
  });

  // Regression for the King Rat "1 HP narrated while 2 hearts shown" bug
  // (run 2026-05-31T13-32-44 t=319): the DM reacted after a hit with only the
  // generic observation + the (already-post-hit) state block, recomputed HP and
  // double-subtracted. The fix feeds the engine-truth resulting HP into the
  // react observation via summarizeHpOutcome. A single human turn isolates the
  // first hit so the surviving monster never triggers a second combat round.
  it('DM react prompt after a hit carries the AUTHORITATIVE post-hit HP, not a recomputable delta', async () => {
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30, scenes: [buildScene()],
    };
    const grid = new Grid(
      Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const human = hero('human_hunter', 0, 0);
    // 3 HP + 0 armor: a normal hit always lands (defenderTop 0) for 1 damage, so
    // the monster survives at 2/3 — exactly the King Rat case (3 HP, hit once).
    const king = monster('king-rat-1', 1, 0);
    king.health = { total: 3, damage: 0, status: 'normal' };
    const engine = new GameEngine({
      seed: 's', grid, characters: [human, king], effects: reg, adventure,
    });
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    const dmScript = new ScriptedLlmClient([
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'R1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'R2' } }] } },
    ]);
    const dmLlm = new CapturingLlmClient(dmScript);

    const dm = new Agent({
      promptBuilder: builder, model: 'test', maxTokens: 256,
      engine, adventure, partyDescription: '',
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      role: 'dm', actorId: 'dm', persona: '', llm: dmLlm,
      tools: DM_TOOLS, stepBudget: 12, tag: 'dm',
    });

    const humanInputs: HumanInput[] = [
      { kind: 'structured_action', action: { kind: 'normal_attack', targetId: asCharacterId('king-rat-1') } },
      { kind: 'structured_action', action: { kind: 'end_turn' } },
    ];
    let humanCursor = 0;
    const humanProvider = { requestInput: async () => humanInputs[humanCursor++]! };

    const capture = new ResearcherCapturer();
    const runDir = mkdtempSync(path.join(tmpdir(), 'react-hp-truth-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map() },
      human: { characterId: asCharacterId('human_hunter'), provider: humanProvider },
      subscribers: [capture],
      stepBudget: { player: 6, dm: 12 },
      runDir, seed: 's', runId: 'react-hp-truth',
    });
    engine.turn.setNarrativeActor(asCharacterId('human_hunter'));
    await orch.runOneHumanTurn(asCharacterId('human_hunter'));

    // Sanity: the engine resolved the hit and the king is at 2/3 (not KO, not 1).
    const kingFinal = engine.charactersById().get(asCharacterId('king-rat-1'))!;
    expect(kingFinal.health.total - kingFinal.health.damage).toBe(2);

    // The dm:react call fired on the resolution must contain the engine-truth
    // post-hit HP — "now 2/3 HP" — so the DM quotes 2, not 1.
    const reactCall = dmLlm.calls.find((c) => c.tag === 'dm:react');
    expect(reactCall, 'a dm:react call should have been captured').toBeDefined();
    expect(reactCall!.text).toContain('Just resolved');
    expect(reactCall!.text).toContain('king-rat-1 now 2/3 HP');
    expect(reactCall!.text).toContain('AUTHORITATIVE');
  });
});
