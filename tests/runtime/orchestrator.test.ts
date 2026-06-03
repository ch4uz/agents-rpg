import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, isGatingBeat } from '../../src/runtime/orchestrator.js';
import type { HumanInput, HumanInputProvider } from '../../src/runtime/orchestrator.js';
import type { HeroSelectProvider, HeroSelection } from '../../src/runtime/hero-select-provider.js';
import type { GameLanguage } from '../../src/runtime/language.js';
import type { HeroChoice } from '../../src/runtime/ws/protocol.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import type { LlmClient, LlmCompleteRequest } from '../../src/runtime/llm/llm-client.js';
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
import type { PlayerAction } from '../../src/engine/action.js';

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
    id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
    scenes: [{
      id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
      monsters: [], tactics: '', abilityTests: [], transitions: [],
    }],
  };
  return { engine, heroes, adventure };
};

class CapturingSubscriber implements Subscriber {
  readonly viewer = { kind: 'human' as const };
  events: Event[] = [];
  onEvent(e: Event): void { this.events.push(e); }
}

/** Subscriber with a researcher viewer so it captures private events too (rule_violation, thought). */
class ResearcherCapturingSubscriber implements Subscriber {
  readonly viewer = { kind: 'researcher' as const, revealThoughts: true };
  events: Event[] = [];
  onEvent(e: Event): void { this.events.push(e); }
}

describe('Orchestrator (minimal: DM + AI players, no human, no combat)', () => {
  it('drives DM and players to adventure_ended', async () => {
    const { engine, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      // F8: react after p1's turn ends.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'p1 acted.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      // F8: react after p2's turn ends.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
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

/** Like buildScene but every hero starts KO'd — a party wipe. */
const buildWipedScene = () => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);
  const heroes: Character[] = ['p1', 'p2'].map((id, i) => ({
    id: asCharacterId(id), name: id, kind: 'hero' as const, archetype: 'warrior' as const,
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total: 3, damage: 3, status: 'KO' as const },
    pos: { x: 0, y: i }, normalAttack: { kind: 'melee' as const, name: 'S', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
    inventory: [], boons: [], skills: [],
  }));
  const engine = new GameEngine({ seed: 's', grid, characters: heroes, effects: reg });
  const adventure: Adventure = {
    id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
    scenes: [{
      id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
      monsters: [], tactics: '', abilityTests: [], transitions: [],
    }],
  };
  return { engine, heroes, adventure };
};

/** Captures the onEnd(outcome, reason) the orchestrator delivers. */
class EndCapturingSubscriber implements Subscriber {
  readonly viewer = { kind: 'human' as const };
  events: Event[] = [];
  end: { outcome: 'success' | 'failure' | 'aborted'; reason: 'party_wipe' | undefined } | null = null;
  onEvent(e: Event): void { this.events.push(e); }
  onEnd(outcome: 'success' | 'failure' | 'aborted', reason?: 'party_wipe'): void {
    this.end = { outcome, reason };
  }
}

describe('Orchestrator party-wipe defeat condition', () => {
  it('ends the run as failure(party_wipe) when every hero is KO — no turns taken', async () => {
    const { engine, adventure } = buildWipedScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    // Empty scripts: if any agent is invoked the ScriptedLlmClient throws, which
    // correctly fails the test — the wipe must end the run BEFORE any turn runs.
    const mkAgent = (role: 'dm' | 'player', actorId: string, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: new ScriptedLlmClient([]), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'claude-sonnet-4-6', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => [],
      });

    const sub = new EndCapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-wipe-'));

    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', 'p2')],
        ]),
      },
      human: null,
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir,
      seed: 's',
      runId: 'test-run-wipe',
    });

    const out = await orch.run();
    expect(out.outcome).toBe('failure');

    // The terminal event is adventure_ended carrying the party_wipe reason.
    const last = sub.events[sub.events.length - 1]!;
    expect(last.type).toBe('adventure_ended');
    expect((last as Extract<Event, { type: 'adventure_ended' }>).outcome).toBe('failure');
    expect((last as Extract<Event, { type: 'adventure_ended' }>).reason).toBe('party_wipe');

    // The reason is threaded to onEnd so the WS adapter can ship it to the browser.
    expect(sub.end).toEqual({ outcome: 'failure', reason: 'party_wipe' });
  });
});

/** Records every awaitBeatsDrained call. In `immediate` mode it resolves at
 *  once (so the run flows); in `manual` mode it parks the promise so a test
 *  can prove the orchestrator is blocked, then release it. */
class FakeBeatGate {
  calls: string[] = [];
  mode: 'immediate' | 'manual' = 'immediate';
  private resolvers: Array<() => void> = [];
  awaitBeatsDrained(requestId: string): Promise<void> {
    this.calls.push(requestId);
    if (this.mode === 'immediate') return Promise.resolve();
    return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
  }
  releaseAll(): void { const rs = this.resolvers; this.resolvers = []; for (const r of rs) r(); }
}

/** Build the same DM + 2-AI scripted run as the first test, parameterised by a
 *  beatGate, so the beat-pacing assertions reuse a known-good flow. */
const buildBeatGateRun = (beatGate: FakeBeatGate, sub: Subscriber) => {
  const { engine, adventure } = buildScene();
  const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
  const dmLlm = new ScriptedLlmClient([
    { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
    { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
    { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'p1 acted.' } }] } },
    { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
    { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
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
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-beat-'));
  return new Orchestrator({
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
    runDir: dir, seed: 's', runId: 'test-run',
    beatGate,
  });
};

const waitUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
};

describe('Orchestrator beat-pacing gate (BeatGate)', () => {
  it('awaits the gate after each narration/speech beat with sequential run-scoped ids', async () => {
    const gate = new FakeBeatGate();   // immediate: resolves at once
    const sub = new CapturingSubscriber();
    const out = await buildBeatGateRun(gate, sub).run();

    expect(out.outcome).toBe('success');
    // The DM's opening "Begin.", p1's "hi", and "p1 acted." each precede a
    // turn that is therefore gated; ids are run-scoped + monotonic. p2's
    // silent turn publishes no beat, and the final "p2 acted." precedes
    // adventure_ended so it isn't gated.
    expect(gate.calls).toEqual(['beat-test-run-1', 'beat-test-run-2', 'beat-test-run-3']);
  });

  it('blocks the next turn until the gate resolves', async () => {
    const gate = new FakeBeatGate();
    gate.mode = 'manual';   // park the first gate so we can observe the block
    const sub = new CapturingSubscriber();
    const runPromise = buildBeatGateRun(gate, sub).run();

    // Run reaches the first gate (after the DM's "Begin." + request_action(p1)).
    await waitUntil(() => gate.calls.length >= 1);
    expect(gate.calls.length).toBe(1);

    // Held at the gate: p1's AI turn hasn't run, so no "hi" has been published.
    const sawP1Say = () => sub.events.some(
      (e) => e.type === 'action' && e.actorId === asCharacterId('p1')
        && (e as Extract<Event, { type: 'action' }>).action.kind === 'say',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(gate.calls.length).toBe(1);   // still only the one gate; loop is parked
    expect(sawP1Say()).toBe(false);

    // Release: future gates resolve immediately and the run completes.
    gate.mode = 'immediate';
    gate.releaseAll();
    const out = await runPromise;
    expect(out.outcome).toBe('success');
    expect(sawP1Say()).toBe(true);
  });

  it('does not gate any turn when no beatGate is configured', async () => {
    // Same flow, beatGate omitted → the run completes with no pauses (the
    // FakeBeatGate is never consulted because it isn't passed in).
    const probe = new FakeBeatGate();
    const sub = new CapturingSubscriber();
    const { engine, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const mkAgent = () =>
      new Agent({
        role: 'dm', actorId: 'dm', persona: '', llm: dmLlm, promptBuilder: builder,
        tools: DM_TOOLS, stepBudget: 12, engine, adventure, partyDescription: '', tag: 'dm',
        model: 'claude-sonnet-4-6', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => [],
      });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-nobeat-'));
    const out = await new Orchestrator({
      engine, adventure,
      agents: { dm: mkAgent(), players: new Map() },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'test-run',
      // no beatGate
    }).run();
    expect(out.outcome).toBe('success');
    expect(probe.calls).toEqual([]);
  });

  it('a chained say HOLDS the next board action behind the beat gate (chainGap)', async () => {
    // p1 answers its turn with ONE reply chaining say + move + end_turn. The
    // chain must pause on the beat gate after the say — the player reads the
    // bubble BEFORE the token moves — instead of bursting all three at once.
    const { engine, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const sub = new CapturingSubscriber();
    const seenAtGate: Array<{ says: number; moves: number }> = [];
    const gate = new FakeBeatGate();
    const origAwait = gate.awaitBeatsDrained.bind(gate);
    gate.awaitBeatsDrained = (id: string) => {
      const count = (kind: string) => sub.events.filter(
        (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === kind,
      ).length;
      seenAtGate.push({ says: count('say'), moves: count('move') });
      return origAwait(id);
    };

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [
        { name: 'say', input: { text: 'Charging in!' } },
        { name: 'move', input: { path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } },
        { name: 'end_turn', input: {} },
      ] } },
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
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-chain-gap-'));
    const out = await new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')]]),
      },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'chain-gap-test',
      beatGate: gate,
    }).run();
    expect(out.outcome).toBe('success');

    // Some gate call saw the say already published but the move NOT yet — the
    // chain paused for the bubble before moving the token.
    expect(seenAtGate.some((s) => s.says >= 1 && s.moves === 0)).toBe(true);
    // And the chain then completed: the move did apply.
    expect(sub.events.some(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'move',
    )).toBe(true);
  });
});

class ScriptedHuman implements HumanInputProvider {
  private inputs: HumanInput[];
  constructor(inputs: HumanInput[]) { this.inputs = [...inputs]; }
  async requestInput(): Promise<HumanInput> {
    const next = this.inputs.shift();
    if (!next) throw new Error('scripted human exhausted');
    return next;
  }
}

/**
 * Build a scene with one hero (the human) and one KO'd monster, with the hero
 * already set as the narrative actor so the orchestrator's human-turn branch
 * fires immediately. Used by the F7 (rejected-input narrate) tests.
 */
const buildSceneWithKoMonster = () => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const hero: Character = {
    id: asCharacterId('p1'), name: 'Anwen', kind: 'hero', archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total: 3, damage: 0, status: 'normal' },
    pos: { x: 1, y: 1 }, normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
    inventory: [], boons: [], skills: [],
  };
  // Pre-KO'd rat — adjacent to the hero so range/LoS checks would otherwise pass.
  const koMonster: Character = {
    id: asCharacterId('m1'), name: 'Rat', kind: 'monster',
    pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
    health: { total: 1, damage: 1, status: 'KO' },
    pos: { x: 2, y: 1 }, normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
    bonusAbility:  { id: asEffectId('teamwork'),    name: '', description: '' },
    inventory: [], boons: [], skills: [],
  };
  const engine = new GameEngine({ seed: 's', grid, characters: [hero, koMonster], effects: reg });
  engine.beginNarrativeTurn(hero.id);
  // Drain the engine's startup events so the test only inspects the human turn.
  engine.flushEvents();

  const adventure: Adventure = {
    id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
    scenes: [{
      id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
      monsters: [], tactics: '', abilityTests: [], transitions: [],
    }],
  };
  return { engine, hero, koMonster, adventure, humanId: hero.id, koMonsterId: koMonster.id };
};

describe('Orchestrator with human seat', () => {
  it('routes a /skip structured action', async () => {
    const { engine, heroes, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const human = heroes[1]!;

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      // F8: react after the human's turn ends.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
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

/**
 * F7 — when a human submits an action that the engine rejects, the orchestrator
 * must surface the rejection to the player (via DM `narrate`) and to the audit
 * log (via `rule_violation`) before falling back to skip_turn. The test below
 * exercises both code paths in `runHumanTurn`:
 *  - the `structured_action` branch (slash-command rejection)
 *  - the `free_text` retry loop (interpreter produces an illegal action)
 */
describe('rejected human input surfaces narrate + rule_violation', () => {
  const buildOrchestrator = (
    env: ReturnType<typeof buildSceneWithKoMonster>,
    humanProvider: HumanInputProvider,
    dmLlm: ScriptedLlmClient,
    subscriber: ResearcherCapturingSubscriber,
  ) => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine: env.engine, adventure: env.adventure, partyDescription: '',
      tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => env.adventure.scenes[0]!,
      getCharacters: () => Array.from(env.engine.charactersById().values()),
      getMonstersInScene: () => [env.koMonster],
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-rej-'));
    return new Orchestrator({
      engine: env.engine, adventure: env.adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: env.humanId, provider: humanProvider },
      subscribers: [subscriber],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'rej-test',
    });
  };

  it('rejected structured human action emits rule_violation + DM narrate, then skips', async () => {
    const env = buildSceneWithKoMonster();
    // F8: runHumanTurn now invokes a single dm:react after the turn ends.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    const human: HumanInputProvider = {
      requestInput: async () => ({
        kind: 'structured_action',
        action: { kind: 'normal_attack', targetId: env.koMonsterId },
      }),
    };
    const captured = new ResearcherCapturingSubscriber();
    const orch = buildOrchestrator(env, human, dmLlm, captured);

    await orch.runOneHumanTurn(env.humanId);

    const violations = captured.events.filter((e) => e.type === 'rule_violation');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const narrates = captured.events.filter((e) => e.type === 'narrate');
    expect(narrates.length).toBeGreaterThanOrEqual(1);
    expect((narrates[0] as Event & { type: 'narrate' }).text.toLowerCase())
      .toMatch(/(invalid|cannot|reject|target)/);
    // Turn still ends — the orchestrator falls back to skip_turn so play continues.
    const skips = captured.events.filter(
      (e) => e.type === 'action' && (e as { action: { kind: string } }).action.kind === 'skip_turn',
    );
    expect(skips.length).toBeGreaterThanOrEqual(1);
  });

  it('free_text becomes a literal say AND the DM reacts to it (story mode), turn stays open', async () => {
    const env = buildSceneWithKoMonster();
    // No interp tag is ever consumed — the orchestrator no longer routes
    // free_text through interpretFreeText. In narrative phase a spoken line
    // now elicits a DM react so story mode isn't silent until the player
    // skips. Two dm:react calls fire: one in response to the say, one after
    // the /skip ends the turn. Give them distinct text so we can prove the
    // first is the response to the spoken line.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The rat hisses at your taunt.' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    // Two inputs: a literal speech line, then a /skip to end the turn. The
    // literal say MUST NOT consume the turn — that's the property under test.
    const provider = new (class implements HumanInputProvider {
      private inputs: HumanInput[] = [
        { kind: 'free_text', text: 'I stab the rat again.' },
        { kind: 'skip' },
      ];
      async requestInput(): Promise<HumanInput> {
        const next = this.inputs.shift();
        if (!next) throw new Error('input exhausted');
        return next;
      }
    })();
    const captured = new ResearcherCapturingSubscriber();
    const orch = buildOrchestrator(env, provider, dmLlm, captured);

    await orch.runOneHumanTurn(env.humanId);

    // The literal say landed with the EXACT player text — no rephrasing.
    const says = captured.events.filter(
      (e) => e.type === 'action' && (e as { action: { kind: string; text?: string } }).action.kind === 'say',
    );
    expect(says.length).toBe(1);
    expect((says[0] as Event & { type: 'action'; action: { text: string } }).action.text)
      .toBe('I stab the rat again.');

    // THE BUG FIX: the DM responded to the spoken line BEFORE the turn ended.
    // The reaction narrate must land strictly between the say and the
    // turn-ending skip — with the old behavior the only react fired AFTER
    // skip_turn (the player got silence until they happened to click Skip).
    const sayIdx = captured.events.findIndex(
      (e) => e.type === 'action' && (e as { action: { kind: string } }).action.kind === 'say',
    );
    const reactIdx = captured.events.findIndex(
      (e) => e.type === 'narrate' && (e as Event & { type: 'narrate' }).text === 'The rat hisses at your taunt.',
    );
    const skipIdx = captured.events.findIndex(
      (e) => e.type === 'action' && (e as { action: { kind: string } }).action.kind === 'skip_turn',
    );
    expect(reactIdx).toBeGreaterThan(sayIdx);
    expect(reactIdx).toBeLessThan(skipIdx);

    // No DM interpretation occurred — no rule_violation events, no narrate
    // explaining the "couldn't interpret" fallback.
    const violations = captured.events.filter((e) => e.type === 'rule_violation');
    expect(violations.length).toBe(0);
    const fallbackNarrates = captured.events.filter(
      (e) => e.type === 'narrate' && /couldn't interpret|skipped/i.test((e as Event & { type: 'narrate' }).text),
    );
    expect(fallbackNarrates.length).toBe(0);

    // No DM:interp LLM call was scripted — if the orchestrator had routed
    // through interpretFreeText, ScriptedLlmClient would have thrown.

    // Turn ended via the explicit /skip, not via the free_text submission.
    const skips = captured.events.filter(
      (e) => e.type === 'action' && (e as { action: { kind: string } }).action.kind === 'skip_turn',
    );
    expect(skips.length).toBe(1);
  });
});

/**
 * OOC (out-of-character) sidebar — the human directs a message at the DM on
 * their OWN turn. The DM interprets it (interpretHumanTurn):
 *   - a QUESTION → answer as a sidebar: emit player_ooc_query + dm_ooc_reply,
 *     do NOT consume the turn, loop back to requestInput().
 *   - an ACTION intent ("I run and jump over the barrels") → translate into the
 *     human's own player action(s), applied through the engine (tagged
 *     interpretedBy:'dm'), with the dice rolled by the engine — the DM owns
 *     intent only.
 */
describe('Orchestrator OOC sidebar', () => {
  it('round-trips a player_ooc_query → dm_ooc_reply without ending the turn', async () => {
    const env = buildSceneWithKoMonster();
    const dmLlm = new ScriptedLlmClient([
      // OOC answer for the question — single ooc_reply tool call.
      { match: { tag: 'dm:ooc' },   response: { toolUses: [{ name: 'ooc_reply', input: { text: 'Yes — three squares to the north.' } }] } },
      // After the OOC sidebar, the human submits a /skip to end the turn.
      // dm:react fires after the turn ends.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    // First call returns an OOC query; second call returns a /skip so the
    // loop terminates. ScriptedHuman pops FIFO.
    const human: HumanInputProvider = new (class {
      private inputs: HumanInput[] = [
        { kind: 'ooc_query', text: 'Can I see the door from here?' },
        { kind: 'skip' },
      ];
      async requestInput(): Promise<HumanInput> {
        const next = this.inputs.shift();
        if (!next) throw new Error('input exhausted');
        return next;
      }
    })();

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine: env.engine, adventure: env.adventure, partyDescription: '',
      tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => env.adventure.scenes[0]!,
      getCharacters: () => Array.from(env.engine.charactersById().values()),
      getMonstersInScene: () => [env.koMonster],
    });
    const captured = new ResearcherCapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-ooc-'));

    const orch = new Orchestrator({
      engine: env.engine, adventure: env.adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: env.humanId, provider: human },
      subscribers: [captured],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'ooc-test',
    });

    await orch.runOneHumanTurn(env.humanId);

    // OOC pair landed on the event log.
    const queries = captured.events.filter((e) => e.type === 'player_ooc_query');
    const replies = captured.events.filter((e) => e.type === 'dm_ooc_reply');
    expect(queries.length).toBe(1);
    expect((queries[0] as Event & { type: 'player_ooc_query' }).text).toBe('Can I see the door from here?');
    expect(replies.length).toBe(1);
    expect((replies[0] as Event & { type: 'dm_ooc_reply' }).text).toMatch(/north/i);

    // OOC events ordered correctly — query before reply.
    const queryIdx = captured.events.findIndex((e) => e.type === 'player_ooc_query');
    const replyIdx = captured.events.findIndex((e) => e.type === 'dm_ooc_reply');
    expect(queryIdx).toBeLessThan(replyIdx);

    // No engine state mutation from the OOC round-trip: the only action that
    // landed should be the final skip_turn (terminal). The OOC channel must
    // not produce an `action` event.
    const actions = captured.events.filter((e) => e.type === 'action');
    expect(actions.length).toBe(1);
    expect((actions[0] as Event & { type: 'action' }).action.kind).toBe('skip_turn');
  });

  it('interprets an on-turn "ask the DM" action intent into the human\'s own action', async () => {
    const env = buildSceneWithKoMonster();
    const dmLlm = new ScriptedLlmClient([
      // The DM reads "I run and jump over the barrels" as an ACTION and emits a
      // player tool call (ability_test) — NOT an ooc_reply.
      { match: { tag: 'dm:ooc' }, response: { toolUses: [
        { name: 'ability_test', input: { characteristic: 'melee', difficulty: 4, describe: 'Bran vaults the barrels' } },
      ] } },
      // ability_test emits a resolution → drainAndReactOnResolution fires one
      // react; the post-turn react fires after the human's skip ends the turn.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    // The action intent does NOT end the turn (ability_test is not terminal), so
    // the human then sends /skip to finish.
    const human: HumanInputProvider = new (class {
      private inputs: HumanInput[] = [
        { kind: 'ooc_query', text: 'I run and jump over the barrels' },
        { kind: 'skip' },
      ];
      async requestInput(): Promise<HumanInput> {
        const next = this.inputs.shift();
        if (!next) throw new Error('input exhausted');
        return next;
      }
    })();

    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine: env.engine, adventure: env.adventure, partyDescription: '',
      tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => env.adventure.scenes[0]!,
      getCharacters: () => Array.from(env.engine.charactersById().values()),
      getMonstersInScene: () => [env.koMonster],
    });
    const captured = new ResearcherCapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-ooc-act-'));

    const orch = new Orchestrator({
      engine: env.engine, adventure: env.adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: env.humanId, provider: human },
      subscribers: [captured],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'ooc-act-test',
    });

    await orch.runOneHumanTurn(env.humanId);

    // The human's message was recorded as a player_ooc_query…
    const queries = captured.events.filter((e) => e.type === 'player_ooc_query');
    expect(queries.length).toBe(1);
    expect((queries[0] as Event & { type: 'player_ooc_query' }).text).toBe('I run and jump over the barrels');
    // …but it was INTERPRETED, not answered — no dm_ooc_reply for an action intent.
    expect(captured.events.filter((e) => e.type === 'dm_ooc_reply').length).toBe(0);

    // The interpreted ability_test landed as the human's own action, tagged
    // interpretedBy:'dm' (the engine still rolled + resolved it).
    const acts = captured.events.filter((e) => e.type === 'action') as Array<Event & { type: 'action'; action: PlayerAction; interpretedBy?: string }>;
    const test = acts.find((a) => a.action.kind === 'ability_test');
    expect(test).toBeDefined();
    expect(test!.actorId).toBe(env.humanId);
    expect(test!.interpretedBy).toBe('dm');
    // A main action ends the turn in HeroKids, so the orchestrator auto-ended it
    // (end_turn) right after the interpreted ability_test — the human never had
    // to send a separate End Turn / skip (the scripted skip stays unused).
    expect(acts.some((a) => a.action.kind === 'end_turn')).toBe(true);
    expect(acts.some((a) => a.action.kind === 'skip_turn')).toBe(false);
    // The interpreted ability_test produced a resolution (dice were rolled).
    expect(captured.events.some((e) => e.type === 'resolution')).toBe(true);
  });
});

/**
 * HeroKids: a hero's turn is 1 move + 1 main action, and the main action is
 * terminal. The orchestrator auto-ends the human's turn once the main action is
 * spent, so the player never has to click a lone "End Turn" button (and so we
 * don't depend on the browser racing an optimistic end_turn past the physics
 * dice round-trip). A move alone leaves the turn open.
 */
describe('Orchestrator auto-ends a spent human turn', () => {
  class CountingHuman implements HumanInputProvider {
    calls = 0;
    private inputs: HumanInput[];
    constructor(inputs: HumanInput[]) { this.inputs = [...inputs]; }
    async requestInput(): Promise<HumanInput> {
      this.calls += 1;
      const next = this.inputs.shift();
      if (!next) throw new Error('requestInput called more times than expected (turn did not auto-end)');
      return next;
    }
  }

  const buildAutoEndRun = (provider: CountingHuman) => {
    const env = buildSceneWithKoMonster();  // hero p1 active (narrative), KO rat
    const dmLlm = new ScriptedLlmClient([
      // ability_test emits a resolution → one drainAndReactOnResolution react;
      // the post-turn react fires after the auto-end ends the turn.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 12,
      engine: env.engine, adventure: env.adventure, partyDescription: '',
      tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => env.adventure.scenes[0]!,
      getCharacters: () => Array.from(env.engine.charactersById().values()),
      getMonstersInScene: () => [env.koMonster],
    });
    const captured = new ResearcherCapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-autoend-'));
    const orch = new Orchestrator({
      engine: env.engine, adventure: env.adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: env.humanId, provider },
      subscribers: [captured],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'autoend-test',
    });
    return { orch, env, captured };
  };

  it('move (turn stays open) then a main action auto-ends — no End Turn input needed', async () => {
    // Exactly TWO inputs: a move (non-terminal) then a main action (terminal).
    // No skip/end_turn is supplied. If the move wrongly ended the turn, the
    // ability_test would never apply (asserted present below). If the main
    // action did NOT auto-end, requestInput would be called a 3rd time and the
    // CountingHuman would throw.
    const provider = new CountingHuman([
      { kind: 'structured_action', action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } },
      { kind: 'structured_action', action: { kind: 'ability_test', characteristic: 'melee', difficulty: 4, describe: 'leap' } },
    ]);
    const { orch, env, captured } = buildAutoEndRun(provider);

    await orch.runOneHumanTurn(env.humanId);

    // The human was asked exactly twice (move, then main action) — not a third
    // time for a manual End Turn.
    expect(provider.calls).toBe(2);
    const acts = captured.events.filter((e) => e.type === 'action') as Array<Event & { type: 'action'; action: PlayerAction }>;
    const kinds = acts.map((a) => a.action.kind);
    // The move applied (turn stayed open after it), then the main action, then
    // the orchestrator's automatic end_turn.
    expect(kinds).toContain('move');
    expect(kinds).toContain('ability_test');
    expect(kinds).toContain('end_turn');
    // The automatic end is the LAST action of the turn.
    expect(kinds[kinds.length - 1]).toBe('end_turn');
    // No skip_turn was needed.
    expect(kinds).not.toContain('skip_turn');
  });

  it('a move alone does NOT auto-end — the turn waits for the next input', async () => {
    // A move keeps the turn open: the player may still take their action. Here
    // they follow the move with an explicit /skip to end.
    const provider = new CountingHuman([
      { kind: 'structured_action', action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } },
      { kind: 'skip' },
    ]);
    const { orch, env, captured } = buildAutoEndRun(provider);

    await orch.runOneHumanTurn(env.humanId);

    expect(provider.calls).toBe(2);  // move did not end the turn; skip was asked for
    const acts = captured.events.filter((e) => e.type === 'action') as Array<Event & { type: 'action'; action: PlayerAction }>;
    const kinds = acts.map((a) => a.action.kind);
    expect(kinds).toContain('move');
    // No automatic end_turn fired after a move-only step; the human's skip ended it.
    expect(kinds).not.toContain('end_turn');
    expect(kinds[kinds.length - 1]).toBe('skip_turn');
  });
});

/**
 * Off-turn interjections — the human sends free text "to Game" / "to DM" while
 * it is NOT their turn. The provider forwards it through `onInterject`; the
 * orchestrator aborts whatever is generating (here we park it on the beat gate
 * for a deterministic pause), then processes the message:
 *   - ooc_query → DM answers (player_ooc_query + dm_ooc_reply), no turn consumed
 *   - free_text → public `say` broadcast by the human + (narrative phase) a DM react
 * After processing, the loop continues and runs the human's actual turn.
 */
describe('Orchestrator off-turn interjections', () => {
  /** Human provider that captures the orchestrator's interjection handler and
   *  returns scripted on-turn inputs (defaults to skip when exhausted). */
  class InterjectableHuman implements HumanInputProvider {
    handler: ((input: HumanInput) => void) | null = null;
    private inputs: HumanInput[];
    constructor(inputs: HumanInput[]) { this.inputs = [...inputs]; }
    async requestInput(): Promise<HumanInput> {
      return this.inputs.shift() ?? { kind: 'skip' };
    }
    onInterject(handler: (input: HumanInput) => void): void { this.handler = handler; }
  }

  const buildInterjectRun = (
    gate: FakeBeatGate,
    sub: Subscriber,
    dmEntries: ConstructorParameters<typeof ScriptedLlmClient>[0],
    provider: InterjectableHuman,
  ) => {
    const { engine, heroes, adventure } = buildScene();  // p1, p2 heroes
    const human = heroes[1]!;                              // p2 is the human seat
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '', llm: new ScriptedLlmClient(dmEntries),
      promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-interject-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: human.id, provider },
      subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'interject-test', beatGate: gate,
    });
    return { orch, human };
  };

  it('processes an off-turn OOC interjection (player_ooc_query → dm_ooc_reply) without consuming a turn', async () => {
    const gate = new FakeBeatGate(); gate.mode = 'manual';
    const sub = new CapturingSubscriber();
    const provider = new InterjectableHuman([{ kind: 'skip' }]);
    const { orch, human } = buildInterjectRun(gate, sub, [
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      { match: { tag: 'dm:ooc' },   response: { toolUses: [{ name: 'ooc_reply', input: { text: 'Two rats remain.' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ], provider);

    const runPromise = orch.run();
    // Park on the first beat gate (after the DM's "Begin." + request_action).
    await waitUntil(() => gate.calls.length >= 1 && provider.handler !== null);
    // The human fires an OFF-TURN question to the DM while parked between turns.
    provider.handler!({ kind: 'ooc_query', text: 'How many rats are left?' });
    // Release the gate so the loop wakes and processes the interjection.
    gate.mode = 'immediate'; gate.releaseAll();
    const out = await runPromise;

    expect(out.outcome).toBe('success');
    const queries = sub.events.filter((e) => e.type === 'player_ooc_query');
    const replies = sub.events.filter((e) => e.type === 'dm_ooc_reply');
    expect(queries).toHaveLength(1);
    expect((queries[0] as Event & { type: 'player_ooc_query' }).text).toBe('How many rats are left?');
    expect(replies).toHaveLength(1);
    expect((replies[0] as Event & { type: 'dm_ooc_reply' }).text).toMatch(/two rats/i);
    // No engine action was applied by the OOC sidebar — only the human's own
    // skip_turn (terminal) ends up as an action event.
    const actions = sub.events.filter((e) => e.type === 'action');
    expect(actions.every((a) => (a as Event & { type: 'action' }).action.kind === 'skip_turn')).toBe(true);
  });

  it('processes an off-turn "to Game" interjection as a public say + a narrative-phase DM react', async () => {
    const gate = new FakeBeatGate(); gate.mode = 'manual';
    const sub = new CapturingSubscriber();
    const provider = new InterjectableHuman([{ kind: 'skip' }]);
    const { orch, human } = buildInterjectRun(gate, sub, [
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      // The DM reacts to the off-turn spoken line (narrative phase), then again
      // (empty) after the human's skip ends the turn.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The rats bristle.' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ], provider);

    const runPromise = orch.run();
    await waitUntil(() => gate.calls.length >= 1 && provider.handler !== null);
    provider.handler!({ kind: 'free_text', text: 'For the kingdom!' });
    gate.mode = 'immediate'; gate.releaseAll();
    const out = await runPromise;

    expect(out.outcome).toBe('success');
    // The literal speech landed as the human's own `say` action, verbatim.
    const says = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'say',
    ) as Array<Event & { type: 'action'; action: { kind: 'say'; text: string } }>;
    expect(says).toHaveLength(1);
    expect(says[0]!.actorId).toBe(human.id);
    expect(says[0]!.action.text).toBe('For the kingdom!');
    // The DM reacted to it (narrative phase), AFTER the say.
    const sayIdx = sub.events.findIndex((e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'say');
    const reactIdx = sub.events.findIndex((e) => e.type === 'narrate' && (e as Event & { type: 'narrate' }).text === 'The rats bristle.');
    expect(reactIdx).toBeGreaterThan(sayIdx);
  });

  it('a party message lets the OTHER AI heroes react off-turn with a line and an emoji', async () => {
    const gate = new FakeBeatGate(); gate.mode = 'manual';
    const sub = new CapturingSubscriber();
    const provider = new InterjectableHuman([{ kind: 'skip' }]);

    const { engine, heroes, adventure } = buildScene();  // p1 (AI hero) + p2 (human)
    const human = heroes[1]!;                              // p2 is the human seat
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '', llm: new ScriptedLlmClient([
        { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
        { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
        // Generous dm:react pool (one after the party message, one after the
        // human's skip ends the turn; a spare so a miscount fails loud, not here).
        { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
        { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
        { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
        { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
      ]),
      promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });
    // p1 reacts to the party message with BOTH a line and an emoji.
    const p1Agent = new Agent({
      role: 'player', actorId: asCharacterId('p1'), persona: '',
      llm: new ScriptedLlmClient([
        { match: { tag: 'p1:party-react' }, response: { toolUses: [
          { name: 'say', input: { text: "I'm right behind you!" } },
          { name: 'emote', input: { emoji: '😤' } },
        ] } },
      ]),
      promptBuilder: builder, tools: PLAYER_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'p1', model: 'm', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-party-react-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map([[asCharacterId('p1'), p1Agent]]) },
      human: { characterId: human.id, provider },
      subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'party-react-test', beatGate: gate,
      partyReactions: true,  // opt in (off by default for the rest of the suite)
    });

    const runPromise = orch.run();
    await waitUntil(() => gate.calls.length >= 1 && provider.handler !== null);
    provider.handler!({ kind: 'free_text', text: 'Charge the rats!' });
    gate.mode = 'immediate'; gate.releaseAll();
    const out = await runPromise;

    expect(out.outcome).toBe('success');
    const says = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'say',
    ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'say'; text: string } }>;
    // The human's message AND p1's off-turn reaction line both landed.
    expect(says.some((e) => e.actorId === human.id && e.action.text === 'Charge the rats!')).toBe(true);
    expect(says.some((e) => e.actorId === asCharacterId('p1') && e.action.text === "I'm right behind you!")).toBe(true);
    // p1 also emoted off-turn.
    const emotes = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'emote',
    ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'emote'; emoji: string } }>;
    expect(emotes.some((e) => e.actorId === asCharacterId('p1') && e.action.emoji === '😤')).toBe(true);
    // p1's reaction came AFTER the human's message (it reacted TO it).
    const humanSayIdx = sub.events.findIndex(
      (e) => e.type === 'action'
        && (e as Event & { type: 'action' }).actorId === human.id
        && (e as Event & { type: 'action' }).action.kind === 'say',
    );
    const p1SayIdx = sub.events.findIndex(
      (e) => e.type === 'action'
        && (e as Event & { type: 'action' }).actorId === asCharacterId('p1')
        && (e as Event & { type: 'action' }).action.kind === 'say',
    );
    expect(p1SayIdx).toBeGreaterThan(humanSayIdx);
  });
});

/**
 * AI-to-AI chat: an AI hero that SPEAKS on its own turn lets the OTHER AI heroes
 * react off-turn (banter / emoji), exactly like a human party message. Bounded
 * to one round per turn-say (reaction lines are emitted directly, never through
 * a hero's takeTurn, so they don't trigger further rounds). Opt-in via
 * `partyReactions` so the rest of the suite stays deterministic.
 */
describe('Orchestrator AI-to-AI party chat', () => {
  const mkAiChatRun = (sub: Subscriber, partyReactions: boolean) => {
    const { engine, adventure } = buildScene();  // p1, p2 heroes (both AI here)
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    // p1 SPEAKS on its turn, then ends it.
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'say', input: { text: "Let's flank the big one!" } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    // p2 ONLY ever reacts — it never takes a turn (the DM doesn't request it). So
    // with partyReactions OFF this script is never consulted (proving the gate).
    const p2Llm = new ScriptedLlmClient([
      { match: { tag: 'p2:party-react' }, response: { toolUses: [
        { name: 'say', input: { text: 'Right behind you!' } },
        { name: 'emote', input: { emoji: '😎' } },
      ] } },
    ]);
    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS, stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag, model: 'm', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => [],
      });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-ai-chat-'));
    return new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', p2Llm, 'p2')],
        ]),
      },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'ai-chat-test', partyReactions,
    });
  };

  it('a hero that speaks on its turn draws an off-turn reaction (line + emoji) from another AI hero', async () => {
    const sub = new CapturingSubscriber();
    const out = await mkAiChatRun(sub, true).run();
    expect(out.outcome).toBe('success');

    const says = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'say',
    ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'say'; text: string } }>;
    // p1 spoke on its turn; p2 reacted off-turn.
    expect(says.some((e) => e.actorId === asCharacterId('p1') && e.action.text === "Let's flank the big one!")).toBe(true);
    expect(says.some((e) => e.actorId === asCharacterId('p2') && e.action.text === 'Right behind you!')).toBe(true);
    // p2 also emoted off-turn.
    const emotes = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'emote',
    ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'emote'; emoji: string } }>;
    expect(emotes.some((e) => e.actorId === asCharacterId('p2') && e.action.emoji === '😎')).toBe(true);
    // The reaction came AFTER the speaker's line.
    const p1Idx = sub.events.findIndex((e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('p1') && (e as Event & { type: 'action' }).action.kind === 'say');
    const p2Idx = sub.events.findIndex((e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('p2') && (e as Event & { type: 'action' }).action.kind === 'say');
    expect(p2Idx).toBeGreaterThan(p1Idx);
  });

  it('stays silent (no reaction LLM call) when partyReactions is OFF — the default', async () => {
    // p2's LLM has ONLY a party-react entry; if the round fired it would be
    // consulted. With the flag off it must never be called, so the run completes
    // and p2 never speaks. (A regression would throw "no scripted response".)
    const sub = new CapturingSubscriber();
    const out = await mkAiChatRun(sub, false).run();
    expect(out.outcome).toBe('success');
    const p2Said = sub.events.some(
      (e) => e.type === 'action'
        && (e as Event & { type: 'action' }).actorId === asCharacterId('p2')
        && (e as Event & { type: 'action' }).action.kind === 'say',
    );
    expect(p2Said).toBe(false);
  });
});

describe('DM-react skipped after passive monster skip_turn (F24)', () => {
  it('does not invoke dm:react for monster skip turns', async () => {
    // Build a scene with one AI hero adjacent to one monster (armor 0, hp 1)
    // so the hero's attack is a deterministic kill. Flow:
    //   - DM narrate, start_combat
    //   - p1 attacks → monster KO → maybeAutoEndCombat fires end_combat
    //   - dm:react fires after p1 turn
    //   - DM picks up combat-ended state and ends the adventure
    // The monster's turn never runs because combat ended before its cursor came up.
    // To exercise the F24 monster-skip path, we need at least one monster turn
    // to fire WITHOUT triggering react. Strategy: hero ends_turn (no kill), m1
    // passively skips (this is the F24 path under test), and we stop at a
    // bounded count of dm:react entries so a regression would over-consume.
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 4, y: 5 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    // Monster armor 0 + hp 1 → hero attack is a deterministic kill.
    const monster: Character = {
      id: asCharacterId('m1'), name: 'rat', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 5, y: 5 },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('skitter'),    name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [hero, monster], effects: reg });

    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    // To force a monster turn before combat ends, the hero first ends_turn
    // (no kill yet → m1 cursor → m1 skip_turn → advance back to p1), THEN p1
    // attacks and kills. That sequence forces the F24 monster-skip path: if
    // dm:react fires for m1, the script over-consumes its single 'r1' entry
    // and the next AI turn errors out. With the fix, only ONE dm:react fires
    // (after p1's first end_turn).
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'start_combat', input: { heroSide: ['p1'], monsterSide: ['m1'] } }] } },
      // Exactly TWO react entries. Two react sites this run: r1 = end of p1
      // turn 1 (no resolution that turn, so the post-turn react fires); r2 =
      // mid-turn after p1's attack resolution (post-resolution react). Turn 2
      // gets NO post-turn react — the DM already reacted to its resolution
      // (dmReactedThisTurn dedup). If the orchestrator regresses and fires
      // react on the monster skip_turn OR double-reacts on turn 2, a 3rd react
      // would be requested and this fixture would error — that's the F24 +
      // dedup regression guard.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'r1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'r2' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      // First turn: end_turn without attacking — m1 then skips passively.
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
      // Second turn: kill m1 → combat auto-ends → DM ends adventure.
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'm1' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);

    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-react-skip-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')]]),
      },
      human: null, subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'react-skip-test',
    });

    const out = await orch.run();
    expect(out.outcome).toBe('success');
    // Two react entries were consumed (r1 = end-of-turn-1, r2 = mid-turn-2
    // after the attack resolution). The monster turn between turn 1 and turn 2
    // did NOT consume an entry (F24), and turn 2's post-turn react was
    // deduplicated away because the DM had already reacted to its resolution.
    const reactNarrates = sub.events.filter(
      (e) => e.type === 'narrate' && ['r1', 'r2'].includes((e as Event & { type: 'narrate' }).text),
    );
    expect(reactNarrates).toHaveLength(2);
    // m1 must have ACTED on its turn — proves the monster cursor fired and the
    // orchestrator drove an action. With the Layer-D-bridge AI in monster-ai.ts,
    // m1 (melee, adjacent to p1) chooses normal_attack rather than skip_turn.
    const monsterActions = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === 'm1',
    );
    expect(monsterActions.length).toBeGreaterThanOrEqual(1);
    expect(monsterActions[0]).toMatchObject({
      type: 'action',
      actorId: 'm1',
      action: { kind: 'normal_attack', targetId: 'p1' },
    });
  });
});

describe('DM reacts between turns (F8)', () => {
  it('invokes the DM with a "dm:react" tag after each player turn ends', async () => {
    const { engine, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    // Single AI player. The DM script narrates intro, requests p1 action, then
    // ends adventure. After p1's end_turn, the orchestrator should call the DM
    // with tag 'dm:react' — that scripted entry produces a narrate so we can
    // verify it ran.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'REACT_FIRED' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
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
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-react-'));

    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
        ]),
      },
      human: null,
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir,
      seed: 's',
      runId: 'react-test',
    });

    const out = await orch.run();
    expect(out.outcome).toBe('success');

    // The dm:react entry must have been consumed.
    const reactNarrate = sub.events.find(
      (e) => e.type === 'narrate' && (e as Event & { type: 'narrate' }).text === 'REACT_FIRED',
    );
    expect(reactNarrate).toBeDefined();
  });
});

describe('Orchestrator paces monster turns (monsterTurnDelayMs)', () => {
  it('calls setTimeout with the configured delay BEFORE handing off to the next monster', async () => {
    // We don't run the full game loop — too brittle (initiative rolls,
    // multi-round combat scripting). Instead we instantiate the orchestrator,
    // spy on setTimeout, and call the inter-turn pacer directly through a
    // typed handle. The handle exists only for tests; production code uses
    // the private method through `runMonsterTurn`.
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 6 }, // armor 6 → rats can't hit
      health: { total: 5, damage: 0, status: 'normal' },
      pos: { x: 1, y: 1 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const mkRat = (id: string, x: number, y: number): Character => ({
      id: asCharacterId(id), name: id, kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x, y },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
      inventory: [], boons: [], skills: [],
    });
    const m1 = mkRat('m1', 0, 0);
    const m2 = mkRat('m2', 2, 0);
    const engine = new GameEngine({ seed: 's', grid, characters: [hero, m1, m2], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([]);
    const p1Llm = new ScriptedLlmClient([]);
    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-pace-spy-'));
    const DELAY_MS = 73;     // distinctive value so we don't catch unrelated timers
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')]]),
      },
      human: null, subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'pace-spy',
      monsterTurnDelayMs: DELAY_MS,
      monsterActionDelayMs: 0,
    });

    // Set up combat via the engine directly so we don't need to script the DM.
    engine.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('p1')], monsterSide: [asCharacterId('m1'), asCharacterId('m2')] });

    // Spy on setTimeout — the only inter-turn pacer the orchestrator uses.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // Drive a single monster turn through the (private) runMonsterTurn path
    // by reading the active actor and invoking the orchestrator's loop body
    // for one cycle. We expose this through the test seam declared below.
    const handle = orch as unknown as { runMonsterTurn(id: string, log: { close(): Promise<void> } | unknown): Promise<void> };
    // Combat now uses per-character initiative order. Force the order to
    // [m1, m2, p1] so that running m1's turn leaves m2 active next — that's
    // the scenario this test cares about (back-to-back monster turns).
    const co = engine.turn.combatOrder;
    if (co !== null) {
      co.order = [asCharacterId('m1'), asCharacterId('m2'), asCharacterId('p1')];
      co.cursor = 0;
    }
    // Stub log object — runMonsterTurn calls drainAndPublish which calls
    // log.append; subscribers are []; we only care about the setTimeout call.
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };
    await handle.runMonsterTurn('m1', stubLog);

    // m1 just ran. The cursor now points at m2 (still alive). Inter-turn
    // delay should have fired with our distinctive value.
    const matched = setTimeoutSpy.mock.calls.some(([, ms]) => ms === DELAY_MS);
    expect(matched).toBe(true);

    setTimeoutSpy.mockRestore();
  });

  it('does NOT sleep when the next actor on the cursor is a hero', async () => {
    // Single hero + single monster. After the monster's turn the cursor goes
    // back to the hero, so no inter-turn delay should fire — even though the
    // option is set.
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 6 },
      health: { total: 5, damage: 0, status: 'normal' },
      pos: { x: 1, y: 1 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const m1: Character = {
      id: asCharacterId('m1'), name: 'm1', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [hero, m1], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-no-pace-'));
    const DELAY_MS = 79;     // distinctive
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', new ScriptedLlmClient([]), 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', new ScriptedLlmClient([]), 'p1')]]),
      },
      human: null, subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'no-pace',
      monsterTurnDelayMs: DELAY_MS,
    });

    engine.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('p1')], monsterSide: [asCharacterId('m1')] });
    if (engine.turn.activeActorId !== asCharacterId('m1')) {
      for (let i = 0; i < 4 && engine.turn.activeActorId !== asCharacterId('m1'); i++) {
        engine.turn.advance(() => true);
      }
    }

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const handle = orch as unknown as { runMonsterTurn(id: string, log: unknown): Promise<void> };
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };
    await handle.runMonsterTurn('m1', stubLog);

    // No setTimeout call should match the distinctive delay value because
    // the next actor (p1) is a hero.
    const matched = setTimeoutSpy.mock.calls.some(([, ms]) => ms === DELAY_MS);
    expect(matched).toBe(false);

    setTimeoutSpy.mockRestore();
  });
});

describe('Orchestrator gates scene monster-focus on the combat round', () => {
  it('round 1 bites the normal target; from round 2 the pack fixates on the scene focus (Elara)', async () => {
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const mkHero = (id: string, x: number, y: number, status: 'normal' | 'immobilized', damage = 0): Character => ({
      id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 6 }, // armor 6 → the rat can't actually hurt them
      health: { total: 3, damage, status },
      pos: { x, y },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    });
    const m1: Character = {
      id: asCharacterId('m1'), name: 'm1', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 2, y: 2 },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    // m1 sits between two adjacent heroes: the mobile, MORE-wounded p1 (the
    // default "nearest, then most-wounded" pick) and the bound focus Elara.
    const p1 = mkHero('p1', 2, 3, 'normal', 1);             // adjacent, 2/3 HP
    const elara = mkHero('p3_healer', 2, 1, 'immobilized');  // adjacent, bound — the focus
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('cave'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: false, npcs: [] },
        monsters: [],
        monsterFocus: { characterId: 'p3_healer', fromRound: 2 },
        tactics: '', abilityTests: [], transitions: [],
      }],
    };
    // The engine needs the adventure too (set_scene resolves the focus from it).
    const engine = new GameEngine({ seed: 's', grid, characters: [m1, p1, elara], effects: reg, adventure });
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mkAgent = (role: 'dm' | 'player', actorId: string, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: new ScriptedLlmClient([]), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const captured = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-focus-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', 'p1')],
          [asCharacterId('p3_healer'), mkAgent('player', 'p3_healer', 'p3_healer')],
        ]),
      },
      human: null, subscribers: [captured],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'focus',
    });

    // Enter the scene so activeMonsterFocus() resolves, then start combat.
    expect(engine.applyDmAction({ kind: 'set_scene', sceneId: asSceneId('cave') }).ok).toBe(true);
    expect(engine.activeMonsterFocus()).toEqual({ characterId: 'p3_healer', fromRound: 2 });
    engine.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('p1'), asCharacterId('p3_healer')],
      monsterSide: [asCharacterId('m1')],
    });
    // Pin the order so m1 leads and we control which round its turn lands in.
    const co = engine.turn.combatOrder!;
    co.order = [asCharacterId('m1'), asCharacterId('p1'), asCharacterId('p3_healer')];
    co.cursor = 0;
    engine.flushEvents(); // drop setup events so `captured` only sees the monster turns
    expect(engine.turn.roundNumber).toBe(1);

    const attackTargets = (): string[] =>
      captured.events
        .filter((e) => e.type === 'action'
          && (e as unknown as { action: { kind: string } }).action.kind === 'normal_attack')
        .map((e) => (e as unknown as { action: { targetId: string } }).action.targetId);

    const handle = orch as unknown as { runMonsterTurn(id: string, log: unknown): Promise<void> };
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };

    // ROUND 1: focus not yet active → bites the normal pick (the more-wounded p1).
    await handle.runMonsterTurn('m1', stubLog);
    expect(attackTargets()).toEqual(['p1']);

    // Advance the cursor back around to m1 — crossing the wrap bumps roundNumber to 2.
    while (engine.turn.activeActorId !== asCharacterId('m1')) engine.turn.advance(() => true);
    expect(engine.turn.roundNumber).toBe(2);

    captured.events.length = 0;
    // ROUND 2: focus active → fixates on bound Elara despite p1 still adjacent + more wounded.
    await handle.runMonsterTurn('m1', stubLog);
    expect(attackTargets()).toEqual(['p3_healer']);
  });
});

describe('Orchestrator paces the initiative reveal (initiativeRevealDelayMs)', () => {
  it('sleeps for initiativeRevealDelayMs after a combat_started is published', async () => {
    // Regression: TurnTracker.startCombat sets cursor = 0 immediately, so
    // `engine.turn.activeActorId` returns order[0] the moment `start_combat`
    // resolves. Without an engine-side hold, the orchestrator would dispatch
    // the first combatant's turn before the browser's 7s initiative panel
    // had a chance to play. The fix is a sleep inside drainAndReturn keyed
    // off the presence of a combat_started in the drained batch.
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const rat: Character = {
      id: asCharacterId('m1'), name: 'm1', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 3, y: 3 },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [hero, rat], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mkAgent = (role: 'dm' | 'player', actorId: string, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: new ScriptedLlmClient([]), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-init-pace-'));
    const DELAY_MS = 137;    // distinctive
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', 'p1')]]),
      },
      human: null, subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'init-pace',
      initiativeRevealDelayMs: DELAY_MS,
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // Stage the engine to emit combat_started, then call the private drain
    // path the orchestrator uses during its main loop. The drain must observe
    // the combat_started event and schedule the sleep with the configured ms.
    engine.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('p1')],
      monsterSide: [asCharacterId('m1')],
    });
    const handle = orch as unknown as { drainAndReturn(log: unknown): Promise<Event[]> };
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };
    const drained = await handle.drainAndReturn(stubLog);

    // The drained batch must include combat_started — sanity check the test
    // is exercising the right code path before asserting on the spy.
    expect(drained.some((e) => e.type === 'combat_started')).toBe(true);
    const matched = setTimeoutSpy.mock.calls.some(([, ms]) => ms === DELAY_MS);
    expect(matched).toBe(true);

    setTimeoutSpy.mockRestore();
  });

  it('does NOT sleep when no combat_started is in the drained batch', async () => {
    // Negative case: a routine drain (e.g. of narration events) must not be
    // gated on the initiative delay — otherwise every drain would block for
    // 7 seconds in live runs.
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [hero], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mkAgent = (role: 'dm' | 'player', actorId: string, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: new ScriptedLlmClient([]), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-init-no-pace-'));
    const DELAY_MS = 149;    // distinctive
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', 'p1')]]),
      },
      human: null, subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'init-no-pace',
      initiativeRevealDelayMs: DELAY_MS,
    });

    // Emit a benign narration via the DM channel — no combat involvement.
    engine.applyDmAction({ kind: 'narrate', text: 'You stand in the hall.' });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const handle = orch as unknown as { drainAndReturn(log: unknown): Promise<Event[]> };
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };
    const drained = await handle.drainAndReturn(stubLog);

    expect(drained.some((e) => e.type === 'combat_started')).toBe(false);
    const matched = setTimeoutSpy.mock.calls.some(([, ms]) => ms === DELAY_MS);
    expect(matched).toBe(false);

    setTimeoutSpy.mockRestore();
  });
});

describe('Orchestrator gates the first turn on the reveal ack (revealProvider)', () => {
  // When a revealProvider is configured (browser attached), the first combat
  // turn must NOT start until the player dismisses the on-screen Order of
  // Battle. The orchestrator awaits revealProvider.awaitInitiativeReveal in
  // place of the fixed initiativeRevealDelayMs sleep, so drainAndReturn stays
  // pending until the ack resolves — and never schedules the wall-clock delay.
  const stageCombat = (runId: string) => {
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const hero: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const rat: Character = {
      id: asCharacterId('m1'), name: 'm1', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 3, y: 3 },
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('coward'),     name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [hero, rat], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mkAgent = (role: 'dm' | 'player', actorId: string, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: new ScriptedLlmClient([]), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 512,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });
    return { engine, adventure, mkAgent };
  };

  it('blocks drainAndReturn on awaitInitiativeReveal and skips the fixed delay', async () => {
    const { engine, adventure, mkAgent } = stageCombat('reveal-gate');

    // Controllable reveal gate: records the requestId and stays pending until
    // we release it, standing in for the browser's "player clicked Skip".
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const revealProvider = {
      awaitInitiativeReveal: (requestId: string): Promise<void> => {
        calls.push(requestId);
        return gate;
      },
    };

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-reveal-gate-'));
    const DELAY_MS = 4242;   // distinctive — must NOT be scheduled when a provider is present
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', 'dm'),
        players: new Map([[asCharacterId('p1'), mkAgent('player', 'p1', 'p1')]]),
      },
      human: null, subscribers: [],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'reveal-gate',
      initiativeRevealDelayMs: DELAY_MS,
      revealProvider,
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    engine.applyDmAction({
      kind: 'start_combat',
      heroSide: [asCharacterId('p1')],
      monsterSide: [asCharacterId('m1')],
    });
    const handle = orch as unknown as { drainAndReturn(log: unknown): Promise<Event[]> };
    const stubLog = { append: () => Promise.resolve(), close: () => Promise.resolve() };
    const drainPromise = handle.drainAndReturn(stubLog);

    // The gate was consulted with a run-scoped reveal id, and the drain is
    // still pending — the first turn has NOT been allowed to proceed.
    await new Promise<void>((r) => setImmediate(r));
    expect(calls).toEqual(['reveal-reveal-gate-1']);
    let settled = false;
    void drainPromise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    // The fixed wall-clock delay must NOT have been scheduled — the gate
    // replaced it.
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === DELAY_MS)).toBe(false);

    // Player dismisses the reveal → drain resolves, first turn may proceed.
    release();
    const drained = await drainPromise;
    expect(drained.some((e) => e.type === 'combat_started')).toBe(true);

    setTimeoutSpy.mockRestore();
  });
});

describe('Orchestrator abortSignal', () => {
  it('unwinds with outcome=aborted when the signal fires while waiting on the human', async () => {
    const { engine, heroes, adventure } = buildScene();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const human = heroes[1]!;

    // DM begins, then hands control to the human. Once the human is parked on
    // requestInput we trigger abort; the orchestrator should unwind without
    // ever resolving the human input.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
    ]);

    const dmAgent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: dmLlm, promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm', model: 'm', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });

    const ac = new AbortController();

    // Provider that resolves once the orchestrator parks on requestInput, and
    // also rejects future calls if the signal fires (mirrors WsAdapter.abort).
    let resolveParked: () => void;
    const parked = new Promise<void>((r) => { resolveParked = r; });
    const provider: HumanInputProvider = {
      requestInput: () => new Promise<HumanInput>((_, reject) => {
        resolveParked();
        ac.signal.addEventListener('abort', () => reject(new Error('session aborted')), { once: true });
      }),
    };

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-abort-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map() },
      human: { characterId: human.id, provider },
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'abort-test',
      abortSignal: ac.signal,
    });

    const runP = orch.run();
    await parked;
    ac.abort();
    const out = await runP;
    expect(out.outcome).toBe('aborted');
  });
});

describe('Orchestrator (start-scene override)', () => {
  /** Two-scene adventure (no monsters/npcs, so set_scene needs no catalogs) with
   *  the engine wired to the adventure so the initial set_scene resolves real
   *  scenes and emits the corresponding `scene_enter`. */
  const buildTwoSceneEnv = () => {
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
    const mkScene = (id: string, intro: string) => ({
      id: asSceneId(id), intro, conclusion: 'done.',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
      monsters: [], tactics: '', abilityTests: [], transitions: [],
    });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [mkScene('one', 'first.'), mkScene('two', 'second.')],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: heroes, effects: reg, adventure });
    return { engine, adventure };
  };

  /** DM that ends the adventure on its first turn — no set_scene, so the only
   *  `scene_enter` published is the orchestrator's initial auto-entry. */
  const mkEndingDm = (engine: GameEngine, adventure: Adventure, builder: PromptBuilder): Agent =>
    new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: new ScriptedLlmClient([
        { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
      ]),
      promptBuilder: builder, tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => [],
    });

  const enteredScenes = async (startSceneId: string | undefined): Promise<string[]> => {
    const { engine, adventure } = buildTwoSceneEnv();
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-startscene-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: mkEndingDm(engine, adventure, builder), players: new Map() },
      human: null,
      subscribers: [sub],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'startscene-test',
      ...(startSceneId !== undefined && { startSceneId }),
    });
    await orch.run();
    return sub.events
      .filter((e) => e.type === 'scene_enter')
      .map((e) => String((e as { sceneId: unknown }).sceneId));
  };

  it('opens on the scene named by startSceneId instead of scenes[0]', async () => {
    expect(await enteredScenes('two')).toEqual(['two']);
  });

  it('opens on scenes[0] when startSceneId is absent', async () => {
    expect(await enteredScenes(undefined)).toEqual(['one']);
  });

  it('falls back to scenes[0] when startSceneId names no scene in the adventure', async () => {
    expect(await enteredScenes('does-not-exist')).toEqual(['one']);
  });
});

describe('DM-driven monster turns (monsterControl: dm)', () => {
  // Build a combat where monster m1 sits adjacent to hero p1, with m1 already
  // on the active cursor — so runOneMonsterTurn drives m1's DM-controlled turn.
  const buildCombat = (seed = 's') => {
    const grid = new Grid(
      Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
    );
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const heroP1: Character = {
      id: asCharacterId('p1'), name: 'p1', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x: 4, y: 5 },
      normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'), name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const m1: Character = {
      id: asCharacterId('m1'), name: 'rat', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 5, y: 5 }, // Chebyshev 1 from p1
      normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('skitter'), name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed, grid, characters: [heroP1, m1], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    engine.applyDmAction({ kind: 'start_combat', heroSide: [asCharacterId('p1')], monsterSide: [asCharacterId('m1')] });
    engine.flushEvents();
    let guard = 0;
    while (engine.turn.activeActorId !== asCharacterId('m1') && guard < 16) { engine.turn.advance(() => true); guard += 1; }
    return { engine, adventure };
  };

  const mkDm = (engine: GameEngine, adventure: Adventure, llm: ScriptedLlmClient, dmStepBudget = 12) =>
    new Agent({
      role: 'dm', actorId: 'dm', persona: '', llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: dmStepBudget, engine, adventure, partyDescription: '',
      tag: 'dm', model: 'm', maxTokens: 512,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
    });

  const mkOrch = (engine: GameEngine, adventure: Adventure, dm: Agent, sub: Subscriber, dmStepBudget = 12) =>
    new Orchestrator({
      engine, adventure,
      agents: { dm, players: new Map() },
      human: null, subscribers: [sub],
      stepBudget: { player: 6, dm: dmStepBudget },
      runDir: mkdtempSync(path.join(tmpdir(), 'orch-mon-dm-')),
      seed: 's', runId: 'mon-dm-test',
      monsterControl: 'dm',
    });

  const monsterAttackEvent = (sub: ResearcherCapturingSubscriber) =>
    sub.events.find(
      (e) => e.type === 'action'
        && (e as Event & { type: 'action' }).actorId === 'm1'
        && (e as Event & { type: 'action'; action: { kind: string } }).action.kind === 'normal_attack',
    ) as (Event & { interpretedBy?: string }) | undefined;

  it('DM puppets the monster: attack tagged interpretedBy:dm, resolves, narrates inline, no react', async () => {
    const { engine, adventure } = buildCombat();
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The rat lunges!' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'monster_action', input: { monsterId: 'm1', action: { kind: 'normal_attack', targetId: 'p1' } } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'monster_action', input: { monsterId: 'm1', action: { kind: 'end_turn' } } }] } },
    ]);
    const sub = new ResearcherCapturingSubscriber();
    await mkOrch(engine, adventure, mkDm(engine, adventure, dmLlm), sub).runOneMonsterTurn(asCharacterId('m1'));

    const attack = monsterAttackEvent(sub);
    expect(attack).toBeDefined();
    expect(attack?.interpretedBy).toBe('dm');                       // DM-decided
    expect(sub.events.some((e) => e.type === 'resolution'
      && (e as Event & { type: 'resolution' }).actorId === 'm1')).toBe(true); // dice resolved
    expect(sub.events.some((e) => e.type === 'narrate'
      && (e as Event & { type: 'narrate' }).text === 'The rat lunges!')).toBe(true); // inline narration
    // No dm:react was scripted — if runDmDrivenMonsterTurn had called react, the
    // ScriptedLlmClient would have thrown on the unmatched dm:react request.
  });

  it('falls back to the deterministic planner when the DM stalls (budget-exhausted, no action)', async () => {
    const { engine, adventure } = buildCombat();
    // stepBudget 1 + a single non-terminal narrate → the DM turn ends
    // budget-exhausted without the monster acting → planner fallback fires.
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The rat hesitates...' } }] } },
    ]);
    const sub = new ResearcherCapturingSubscriber();
    await mkOrch(engine, adventure, mkDm(engine, adventure, dmLlm, 1), sub, 1).runOneMonsterTurn(asCharacterId('m1'));

    const attack = monsterAttackEvent(sub);
    expect(attack).toBeDefined();                  // monster still attacked
    expect(attack?.interpretedBy).toBeUndefined(); // via the engine fallback, NOT the DM
  });
});

describe('Orchestrator hero-selection gate', () => {
  class FakeHeroSelect implements HeroSelectProvider {
    seen: HeroChoice[][] = [];
    constructor(private chosen: string | null, private language?: GameLanguage) {}
    async awaitHeroSelection(_id: string, options: HeroChoice[]): Promise<HeroSelection | null> {
      this.seen.push(options);
      if (this.chosen === null) return null;
      return {
        characterId: asCharacterId(this.chosen),
        ...(this.language !== undefined ? { language: this.language } : {}),
      };
    }
  }

  const mkChoice = (id: string, name: string): HeroChoice => ({
    characterId: asCharacterId(id), name, archetype: 'warrior',
    spritePath: 'heroes/warrior/south.png', blurb: 'b', health: 3,
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, dex: 0,
    normalAttack: { name: 'Slash', kind: 'melee', range: 1 },
    specialAction: { name: 'Whirl', description: 'd' },
    bonusAbility: { name: 'Teamwork', description: 'd' },
  });

  /** Two-hero scene (p1, p2 — both with AI agents). The scenario DEFAULT human
   *  is p1; the gate provider may reroute the human to a different hero. The DM
   *  requests p1 then p2; whichever is human skips, the other ends its AI turn. */
  const mkRun = (
    sub: Subscriber,
    provider: HeroSelectProvider | null,
    choices: HeroChoice[],
    abortSignal?: AbortSignal,
    langOpts?: {
      language?: GameLanguage;
      onLanguageSelected?: (l: GameLanguage) => void;
      /** Give scenes[0] an opening (EN + pt overlay) and gate on this provider,
       *  so the test can assert which language the after-beat is emitted in. */
      withOpening?: boolean;
      /** Localized hero names: language → characterId → name (OrchestratorConfig.nameOverrides). */
      nameOverrides?: Record<string, Record<string, string>>;
    },
  ) => {
    const { engine, heroes, adventure } = buildScene();  // p1 @ (0,0), p2 @ (0,1)
    if (langOpts?.withOpening) {
      adventure.scenes[0]!.opening = { before: 'EN before', after: 'EN after' };
      adventure.scenes[0]!.i18n = { pt: { opening: { before: 'PT antes', after: 'PT depois' } } };
    }
    const openingProvider = langOpts?.withOpening
      ? { awaitOpeningDismissed: () => Promise.resolve() }
      : null;
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p2' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    // Each hero's AI agent simply ends its turn — consulted only for the hero
    // the player did NOT pick (the human-controlled one skips instead).
    const aiLlm = (tag: string) => new ScriptedLlmClient([
      { match: { tag }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder, tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS,
        stepBudget: role === 'dm' ? 12 : 6, engine, adventure, partyDescription: '', tag,
        model: 'm', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => [],
      });
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-hero-sel-'));
    return new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', aiLlm('p1'), 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', aiLlm('p2'), 'p2')],
        ]),
      },
      // Scenario default human = p1 (heroes[0]); the gate may reroute it.
      human: { characterId: heroes[0]!.id, provider: new ScriptedHuman([{ kind: 'skip' }]) },
      subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'hero-sel-test',
      ...(provider ? { heroSelectProvider: provider, heroChoices: choices } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      ...(langOpts?.language ? { language: langOpts.language } : {}),
      ...(langOpts?.onLanguageSelected ? { onLanguageSelected: langOpts.onLanguageSelected } : {}),
      ...(openingProvider ? { openingProvider } : {}),
      ...(langOpts?.nameOverrides ? { nameOverrides: langOpts.nameOverrides } : {}),
    });
  };

  /** CapturingSubscriber that also records re-published snapshots (the
   *  pt-name rename pushes one per subscriber, like a scene_enter). */
  class SnapshotCapturingSubscriber extends CapturingSubscriber {
    snapshots: Array<{ characters: ReadonlyArray<{ name: string }> }> = [];
    onSnapshot(s: { characters: ReadonlyArray<{ name: string }> }): void {
      this.snapshots.push(s);
    }
  }

  const skipActor = (sub: CapturingSubscriber): string | undefined => {
    const e = sub.events.find(
      (ev) => ev.type === 'action' && (ev as Event & { type: 'action' }).action.kind === 'skip_turn',
    ) as (Event & { type: 'action'; actorId: string }) | undefined;
    return e?.actorId;
  };

  it('routes the human to the hero the player chose (p2), not the scenario default (p1)', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2');
    const choices = [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')];
    const orch = mkRun(sub, provider, choices);
    const out = await orch.run();

    expect(out.outcome).toBe('success');
    expect(orch.gameStarted).toBe(true);  // hero picked → the game began
    // The provider was asked, and offered both heroes.
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]!.map((c) => String(c.characterId))).toEqual(['p1', 'p2']);
    // p2 (the chosen hero) ran the HUMAN turn → its action is the skip.
    expect(skipActor(sub)).toBe(asCharacterId('p2'));
    // p1 (default human, NOT chosen) ran its AI turn → it ended its turn.
    const p1End = sub.events.find(
      (e) => e.type === 'action' && e.actorId === asCharacterId('p1')
        && (e as Event & { type: 'action' }).action.kind === 'end_turn',
    );
    expect(p1End).toBeDefined();
  });

  it('keeps the scenario default human (p1) when no hero-select provider is wired', async () => {
    const sub = new CapturingSubscriber();
    const orch = mkRun(sub, null, []);
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    // No gate → p1 (the default) ran the human turn (skip); p2 ran its AI turn.
    expect(skipActor(sub)).toBe(asCharacterId('p1'));
    // No gate offered (CLI / scripted / AI-only) → the game starts unconditionally.
    expect(orch.gameStarted).toBe(true);
  });

  it('applies the player language pick: fires onLanguageSelected and records pt in the manifest', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2', 'pt');
    const picked: GameLanguage[] = [];
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { onLanguageSelected: (l) => picked.push(l) },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    // The hook fired exactly once, BEFORE any turn (the gate precedes the run
    // loop) — here we can only assert it fired with the pick.
    expect(picked).toEqual(['pt']);
    const manifest = JSON.parse(readFileSync(out.manifestPath, 'utf8')) as { language?: string };
    expect(manifest.language).toBe('pt');
  });

  it('no language pick → hook silent, manifest records the scenario default (en)', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2');  // hero pick only, no language
    const picked: GameLanguage[] = [];
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { onLanguageSelected: (l) => picked.push(l) },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    expect(picked).toEqual([]);
    const manifest = JSON.parse(readFileSync(out.manifestPath, 'utf8')) as { language?: string };
    expect(manifest.language).toBe('en');
  });

  it('picking the language the run already uses does not re-fire the hook', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2', 'pt');
    const picked: GameLanguage[] = [];
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { language: 'pt', onLanguageSelected: (l) => picked.push(l) },  // scenario already pt
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    expect(picked).toEqual([]);  // no change → no hook
    const manifest = JSON.parse(readFileSync(out.manifestPath, 'utf8')) as { language?: string };
    expect(manifest.language).toBe('pt');
  });

  it('emits the opening after-beat in the PICKED language (pt overlay)', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2', 'pt');
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { withOpening: true },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    const narrations = sub.events
      .filter((e) => e.type === 'narrate')
      .map((e) => (e as Event & { type: 'narrate' }).text);
    expect(narrations).toContain('PT depois');
    expect(narrations).not.toContain('EN after');
  });

  it('emits the English after-beat when no language is picked', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect('p2');  // hero pick only
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { withOpening: true },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    const narrations = sub.events
      .filter((e) => e.type === 'narrate')
      .map((e) => (e as Event & { type: 'narrate' }).text);
    expect(narrations).toContain('EN after');
    expect(narrations).not.toContain('PT depois');
  });

  it('a pt pick renames the heroes via nameOverrides[pt] and re-publishes a snapshot', async () => {
    const sub = new SnapshotCapturingSubscriber();
    const provider = new FakeHeroSelect('p2', 'pt');
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { nameOverrides: { pt: { p1: 'Heitor', p2: 'Caio' } } },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    // A fresh snapshot went out carrying the pt names (before any turn).
    const renamed = sub.snapshots.find((s) => s.characters.some((c) => c.name === 'Heitor'));
    expect(renamed).toBeDefined();
    expect(renamed!.characters.map((c) => c.name).sort()).toEqual(['Caio', 'Heitor']);
  });

  it('an English session leaves the hero names untouched (overrides configured but dormant)', async () => {
    const sub = new SnapshotCapturingSubscriber();
    const provider = new FakeHeroSelect('p2');  // no language pick → en
    const orch = mkRun(
      sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], undefined,
      { nameOverrides: { pt: { p1: 'Heitor', p2: 'Caio' } } },
    );
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    expect(sub.snapshots.some((s) => s.characters.some((c) => c.name === 'Heitor'))).toBe(false);
  });

  it('keeps the scenario default when the gate resolves to null (disconnect)', async () => {
    const sub = new CapturingSubscriber();
    const provider = new FakeHeroSelect(null);  // e.g. tab closed before choosing
    const orch = mkRun(sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')]);
    const out = await orch.run();
    expect(out.outcome).toBe('success');
    expect(provider.seen).toHaveLength(1);       // gate fired
    expect(skipActor(sub)).toBe(asCharacterId('p1'));  // default stands
    // The run proceeded past the gates un-aborted and played to completion, so
    // the game DID start (gameStarted gates the GCS archive — a completed run
    // is a real research record regardless of who controlled the default hero).
    expect(orch.gameStarted).toBe(true);
  });

  it('gameStarted stays false when the session is reaped while parked at the chooser', async () => {
    const sub = new CapturingSubscriber();
    const ac = new AbortController();
    // Mirror WsAdapter round-4 semantics: the hero-select gate PARKS while the
    // tab is gone and only abort() (registry reap / shutdown) resolves it, with
    // null. The orchestrator must then unwind WITHOUT marking the game started.
    const provider: HeroSelectProvider = {
      awaitHeroSelection: () =>
        new Promise((resolve) => {
          ac.signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
    };
    const orch = mkRun(sub, provider, [mkChoice('p1', 'Anwen'), mkChoice('p2', 'Kael')], ac.signal);
    const runP = orch.run();
    await new Promise((r) => setTimeout(r, 20));  // let the run park at the gate
    ac.abort();
    const out = await runP;
    expect(out.outcome).toBe('aborted');
    expect(orch.gameStarted).toBe(false);  // never picked → never started → no archive
  });
});

/**
 * Off-turn reactions to ACTIONS (not just spoken messages): when an agent takes
 * a reactable action (an attack, an object smash — the motivating oil-cask
 * self-blast — a special, a rescue), every OTHER agent may react off-turn:
 * teammate AI heroes via `reactToPartyAction`, and the enemies voiced by the DM
 * via `reactAsMonsters`. Pure banter (no turn consumed, no rule state mutated),
 * broadcast off-turn, never re-scanned (cascade-free). Opt-in via
 * `partyReactions` so the deterministic suite is unaffected by default.
 */
describe('Orchestrator off-turn action reactions', () => {
  // p1 (melee hero) stands next to a smashable obstacle; p2 is a second AI hero
  // who only ever reacts; m1 is a living foe present on the board (no combat, so
  // it never takes a turn) that the DM can voice. p1 smashes the obstacle on its
  // narrative turn — the reactable action that opens the round.
  const mkActionReactRun = (sub: Subscriber, partyReactions: boolean) => {
    // Floor everywhere except a smashable obstacle at (2,1), adjacent to p1.
    const grid = new Grid(Array.from({ length: 6 }, (_, y) =>
      Array.from({ length: 6 }, (_, x) =>
        (y === 1 && x === 2 ? { kind: 'obstacle' as const } : { kind: 'floor' as const }))));
    const reg = new EffectRegistry(); registerCoreEffects(reg);

    const mkHero = (id: string, x: number, y: number): Character => ({
      id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x, y }, normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    });
    const p1 = mkHero('p1', 1, 1);
    const p2 = mkHero('p2', 4, 4);
    const m1: Character = {
      id: asCharacterId('m1'), name: 'rat', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 4, y: 1 }, normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('skitter'),    name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [p1, p2, m1], effects: reg });

    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });

    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      // Mid-turn react after the smash resolves. (No end-of-turn entry: the
      // post-turn react is deduplicated away — see dmReactedThisTurn.)
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The cask bursts!' } }] } },
      // Only when reactions are ON is the enemy-voice path consulted. With the
      // flag OFF this entry is absent, so a stray call would throw "no scripted
      // response" — proving the gate.
      ...(partyReactions ? [{ match: { tag: 'dm:monster-react' }, response: { toolUses: [
        { name: 'voice_monster', input: { monsterId: 'm1', text: 'SKREEE!', emoji: '😾' } },
      ] } }] : []),
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'attack_object', input: { pos: { x: 2, y: 1 } } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    // p2 NEVER takes a turn (the DM doesn't request it) — its only scripted
    // response is the off-turn reaction. With the gate OFF this is never read.
    const p2Llm = new ScriptedLlmClient([
      { match: { tag: 'p2:party-react' }, response: { toolUses: [
        { name: 'say', input: { text: 'Mind the splinters, p1!' } },
        { name: 'emote', input: { emoji: '😬' } },
      ] } },
    ]);

    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS, stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag, model: 'm', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-action-react-'));
    return new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', p2Llm, 'p2')],
        ]),
      },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'action-react-test', partyReactions,
    });
  };

  const sayEvents = (sub: { events: Event[] }) => sub.events.filter(
    (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'say',
  ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'say'; text: string } }>;

  it('a hero action draws a teammate reaction AND a DM-voiced enemy reaction (gate ON)', async () => {
    const sub = new CapturingSubscriber();
    const out = await mkActionReactRun(sub, true).run();
    expect(out.outcome).toBe('success');

    const says = sayEvents(sub);
    // The teammate hero p2 reacted off-turn to p1's smash...
    expect(says.some((e) => e.actorId === asCharacterId('p2') && e.action.text === 'Mind the splinters, p1!')).toBe(true);
    // ...and the ENEMY reacted too, voiced by the DM as the monster's own line.
    expect(says.some((e) => e.actorId === asCharacterId('m1') && e.action.text === 'SKREEE!')).toBe(true);
    // p2 also emoted; the foe emoted too.
    const emotes = sub.events.filter(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'emote',
    ) as Array<Event & { type: 'action'; actorId: string; action: { kind: 'emote'; emoji: string } }>;
    expect(emotes.some((e) => e.actorId === asCharacterId('p2'))).toBe(true);
    expect(emotes.some((e) => e.actorId === asCharacterId('m1'))).toBe(true);

    // Reactions came AFTER the action that triggered them.
    const smashIdx = sub.events.findIndex(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).action.kind === 'attack_object',
    );
    const p2Idx = sub.events.findIndex(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('p2') && (e as Event & { type: 'action' }).action.kind === 'say',
    );
    const m1Idx = sub.events.findIndex(
      (e) => e.type === 'action' && (e as Event & { type: 'action' }).actorId === asCharacterId('m1') && (e as Event & { type: 'action' }).action.kind === 'say',
    );
    expect(smashIdx).toBeGreaterThanOrEqual(0);
    expect(p2Idx).toBeGreaterThan(smashIdx);
    expect(m1Idx).toBeGreaterThan(smashIdx);
  });

  it('stays silent (no reaction LLM calls) when partyReactions is OFF — the default', async () => {
    // p2's only scripted response is its reaction, and the DM pool has NO
    // monster-react entry. If either reaction round fired with the gate off, the
    // run would consume a missing entry and throw "no scripted response".
    const sub = new CapturingSubscriber();
    const out = await mkActionReactRun(sub, false).run();
    expect(out.outcome).toBe('success');
    const says = sayEvents(sub);
    expect(says.some((e) => e.actorId === asCharacterId('p2'))).toBe(false);
    expect(says.some((e) => e.actorId === asCharacterId('m1'))).toBe(false);
  });

  // Shared harness for the significance-gate and latency-instrumentation tests
  // below: p1 attacks a tanky monster (4 HP, damageMod 0 → at most 1 damage,
  // never a KO, never critical) on a narrative turn. Hit or miss, the outcome
  // is ROUTINE, so the significance gate must keep the reaction round closed.
  const mkRoutineAttackRun = (
    sub: Subscriber,
    onLlmCall?: NonNullable<ConstructorParameters<typeof Orchestrator>[0]['onLlmCall']>,
  ) => {
    const grid = new Grid(Array.from({ length: 6 }, () =>
      Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))));
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const mkHero = (id: string, x: number, y: number): Character => ({
      id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x, y }, normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    });
    const p1 = mkHero('p1', 1, 1);
    const p2 = mkHero('p2', 4, 4);
    const m1: Character = {
      id: asCharacterId('m1'), name: 'tough rat', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
      health: { total: 4, damage: 0, status: 'normal' },
      pos: { x: 2, y: 1 }, normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('skitter'),    name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [p1, p2, m1], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    // NO p2:party-react and NO dm:monster-react entries anywhere: if the round
    // fired for this routine outcome, the run would throw "no scripted response".
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      // Exactly ONE react: the mid-turn resolution react. The post-turn react
      // is deduplicated away (dmReactedThisTurn), so a second entry would rot.
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The blow lands.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'm1' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const p2Llm = new ScriptedLlmClient([]);  // p2 must never be consulted

    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm, promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS, stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag, model: 'm', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const dir = mkdtempSync(path.join(tmpdir(), 'orch-routine-react-'));
    return new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', p2Llm, 'p2')],
        ]),
      },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'routine-react-test', partyReactions: true,
      ...(onLlmCall ? { onLlmCall } : {}),
    });
  };

  it('records per-role LLM latency in the manifest and feeds every call to the onLlmCall observer', async () => {
    const sub = new CapturingSubscriber();
    const seen: Array<{ role: string; durationMs?: number }> = [];
    const out = await mkRoutineAttackRun(sub, ({ role, durationMs }) => {
      seen.push({ role, ...(durationMs !== undefined ? { durationMs } : {}) });
    }).run();
    expect(out.outcome).toBe('success');

    // The observer saw every recorded call (dm ×3, dm:react ×1, p1 ×2), each
    // with a measured wall-clock duration.
    expect(seen.length).toBe(6);
    expect(seen.every((c) => typeof c.durationMs === 'number' && c.durationMs >= 0)).toBe(true);
    expect(seen.some((c) => c.role === 'dm:react')).toBe(true);

    // The manifest aggregates the same durations per role, keyed like
    // totalLlmCalls, with calls counts matching.
    const manifest = JSON.parse(readFileSync(out.manifestPath, 'utf8')) as {
      totalLlmCalls: Record<string, number>;
      llmLatencyMs: Record<string, { calls: number; totalMs: number; meanMs: number; maxMs: number }>;
    };
    expect(Object.keys(manifest.llmLatencyMs).sort()).toEqual(Object.keys(manifest.totalLlmCalls).sort());
    for (const [role, count] of Object.entries(manifest.totalLlmCalls)) {
      const lat = manifest.llmLatencyMs[role]!;
      expect(lat.calls).toBe(count);
      expect(lat.totalMs).toBeGreaterThanOrEqual(0);
      expect(lat.meanMs).toBe(lat.calls > 0 ? Math.round(lat.totalMs / lat.calls) : 0);
      expect(lat.maxMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('a ROUTINE outcome (≤1 damage, no KO, no status change) does NOT open a reaction round — the significance gate', async () => {
    const sub = new CapturingSubscriber();
    const out = await mkRoutineAttackRun(sub).run();
    expect(out.outcome).toBe('success');
    // Neither the teammate nor the foe reacted (their fixture pools were empty /
    // absent — a stray reaction call would have errored the run instead).
    const says = sayEvents(sub);
    expect(says.some((e) => e.actorId === asCharacterId('p2'))).toBe(false);
    expect(says.some((e) => e.actorId === asCharacterId('m1'))).toBe(false);
  });

  it('a significant action runs DM react + hero reactors + enemy voicing CONCURRENTLY', async () => {
    // Same board as mkActionReactRun (the smash destroys the obstacle →
    // significant), but every agent's LLM is wrapped in a tracker that counts
    // in-flight complete() calls. The reaction round must overlap the DM's
    // outcome react: dm:react + p2:party-react + dm:monster-react all in
    // flight at once → maxInflight ≥ 3. A serial regression would hold it at 1.
    const counter = { inflight: 0, max: 0 };
    const track = (inner: ScriptedLlmClient): LlmClient => ({
      complete: async (req: LlmCompleteRequest) => {
        counter.inflight += 1;
        counter.max = Math.max(counter.max, counter.inflight);
        try {
          await new Promise((r) => setTimeout(r, 2));
          return await inner.complete(req);
        } finally {
          counter.inflight -= 1;
        }
      },
    });

    const grid = new Grid(Array.from({ length: 6 }, (_, y) =>
      Array.from({ length: 6 }, (_, x) =>
        (y === 1 && x === 2 ? { kind: 'obstacle' as const } : { kind: 'floor' as const }))));
    const reg = new EffectRegistry(); registerCoreEffects(reg);
    const mkHero = (id: string, x: number, y: number): Character => ({
      id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' },
      pos: { x, y }, normalAttack: { kind: 'melee', name: 'S', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
      inventory: [], boons: [], skills: [],
    });
    const p1 = mkHero('p1', 1, 1);
    const p2 = mkHero('p2', 4, 4);
    const m1: Character = {
      id: asCharacterId('m1'), name: 'rat', kind: 'monster',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pos: { x: 4, y: 1 }, normalAttack: { kind: 'melee', name: 'B', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: '', description: '' },
      bonusAbility:  { id: asEffectId('skitter'),    name: '', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const engine = new GameEngine({ seed: 's', grid, characters: [p1, p2, m1], effects: reg });
    const adventure: Adventure = {
      id: asAdventureId('a'), title: 'A', estimatedDurationMin: 30,
      scenes: [{
        id: asSceneId('s'), intro: 'go.', conclusion: 'done.',
        map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
        monsters: [], tactics: '', abilityTests: [], transitions: [],
      }],
    };
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const dmLlm = new ScriptedLlmClient([
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'narrate', input: { text: 'Begin.' } }] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'request_action', input: { actorId: 'p1' } }] } },
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: 'The cask bursts!' } }] } },
      { match: { tag: 'dm:monster-react' }, response: { toolUses: [
        { name: 'voice_monster', input: { monsterId: 'm1', text: 'SKREEE!' } },
      ] } },
      { match: { tag: 'dm' }, response: { toolUses: [{ name: 'end_adventure', input: { outcome: 'success' } }] } },
    ]);
    const p1Llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'attack_object', input: { pos: { x: 2, y: 1 } } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const p2Llm = new ScriptedLlmClient([
      { match: { tag: 'p2:party-react' }, response: { toolUses: [
        { name: 'say', input: { text: 'Mind the splinters!' } },
      ] } },
    ]);

    const mkAgent = (role: 'dm' | 'player', actorId: string, llm: ScriptedLlmClient, tag: string) =>
      new Agent({
        role, actorId: actorId === 'dm' ? 'dm' : asCharacterId(actorId), persona: '',
        llm: track(llm), promptBuilder: builder,
        tools: role === 'dm' ? DM_TOOLS : PLAYER_TOOLS, stepBudget: role === 'dm' ? 12 : 6,
        engine, adventure, partyDescription: '', tag, model: 'm', maxTokens: 1024,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      });

    const sub = new CapturingSubscriber();
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-parallel-react-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: {
        dm: mkAgent('dm', 'dm', dmLlm, 'dm'),
        players: new Map([
          [asCharacterId('p1'), mkAgent('player', 'p1', p1Llm, 'p1')],
          [asCharacterId('p2'), mkAgent('player', 'p2', p2Llm, 'p2')],
        ]),
      },
      human: null, subscribers: [sub], stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed: 's', runId: 'parallel-react-test', partyReactions: true,
    });

    const out = await orch.run();
    expect(out.outcome).toBe('success');
    // The round overlapped: DM react + p2 reactor + DM enemy-voicing in flight
    // together (the acting p1 call had already returned by then).
    expect(counter.max).toBeGreaterThanOrEqual(3);
    // And the broadcasts still landed, in order: DM narration before banter.
    const says = sayEvents(sub);
    expect(says.some((e) => e.actorId === asCharacterId('p2') && e.action.text === 'Mind the splinters!')).toBe(true);
    expect(says.some((e) => e.actorId === asCharacterId('m1') && e.action.text === 'SKREEE!')).toBe(true);
  });
});

describe('isGatingBeat — which published events pause the beat gate', () => {
  const ev = (e: {
    type: string;
    actorId?: string;
    text?: string;
    action?: { kind: string; text?: string; emoji?: string; path?: unknown[] };
    public?: Record<string, unknown>;
  }): Event => e as unknown as Event;

  it('gates on DM narration', () => {
    expect(isGatingBeat(ev({ type: 'narrate', actorId: 'dm', text: 'The rats close in.' }))).toBe(true);
    expect(isGatingBeat(ev({ type: 'narrate', actorId: 'dm', text: '   ' }))).toBe(false);
  });

  it('gates on a hero say with non-empty text', () => {
    expect(isGatingBeat(ev({ type: 'action', actorId: 'p1', action: { kind: 'say', text: 'Look out!' } }))).toBe(true);
    expect(isGatingBeat(ev({ type: 'action', actorId: 'p1', action: { kind: 'say', text: '' } }))).toBe(false);
  });

  it('gates on a NON-DM emote (so an emote-only reaction is paced, not raced past)', () => {
    expect(isGatingBeat(ev({ type: 'action', actorId: 'p2', action: { kind: 'emote', emoji: '😱' } }))).toBe(true);
    expect(isGatingBeat(ev({ type: 'action', actorId: 'm1', action: { kind: 'emote', emoji: '😾' } }))).toBe(true);
  });

  it('does NOT gate on a DM emote (the DM has no board balloon) or an empty emoji', () => {
    expect(isGatingBeat(ev({ type: 'action', actorId: 'dm', action: { kind: 'emote', emoji: '🎲' } }))).toBe(false);
    expect(isGatingBeat(ev({ type: 'action', actorId: 'p2', action: { kind: 'emote', emoji: '   ' } }))).toBe(false);
  });

  it('does NOT gate on move / dice / state changes', () => {
    expect(isGatingBeat(ev({ type: 'action', actorId: 'p1', action: { kind: 'move', path: [] } }))).toBe(false);
    expect(isGatingBeat(ev({ type: 'resolution', actorId: 'p1', public: { hit: true } }))).toBe(false);
  });
});
