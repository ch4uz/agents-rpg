import { describe, it, expect } from 'vitest';
import { Agent, summarizeHpOutcome, computeTurnThinkingBudget, type AgentRunHooks } from '../../src/runtime/agent.js';
import { ScriptedLlmClient } from '../../src/runtime/llm/scripted.js';
import { LlmAbortedError, type LlmClient } from '../../src/runtime/llm/llm-client.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asAdventureId, asSceneId } from '../../src/engine/ids.js';
import type { Character } from '../../src/engine/character.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Event } from '../../src/log/events.js';

const buildEnv = (opts?: { ratArmor?: number; heroDamage?: number }) => {
  const grid = new Grid(
    Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => ({ kind: 'floor' as const }))),
  );
  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const hero: Character = {
    id: asCharacterId('p1'), name: 'Gareth', kind: 'hero', archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total: 3, damage: opts?.heroDamage ?? 0, status: 'normal' },
    pos: { x: 1, y: 1 },
    normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility: { id: asEffectId('teamwork'), name: '', description: '' },
    inventory: [], boons: [], skills: [],
  };
  const { archetype: _unused, ...heroWithoutArchetype } = hero;
  void _unused;
  const rat: Character = {
    ...heroWithoutArchetype,
    id: asCharacterId('m1'), name: 'Rat', kind: 'monster',
    pos: { x: 2, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
    pools: { ...heroWithoutArchetype.pools, armor: opts?.ratArmor ?? heroWithoutArchetype.pools.armor },
  };
  const engine = new GameEngine({ seed: 'agent-test', grid, characters: [hero, rat], effects: reg });
  engine.beginNarrativeTurn(asCharacterId('p1'));

  const adventure: Adventure = {
    id: asAdventureId('a'), title: 'A',
    estimatedDurationMin: 30,
    scenes: [{
      id: asSceneId('s'), intro: '', conclusion: '',
      tactics: '',
      map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
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
    const durations: Array<number | undefined> = [];
    const hooks: AgentRunHooks = {
      emitThought: (text) => emitted.push(text),
      onLlmResponse: (_role, _usage, durationMs) => durations.push(durationMs),
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
    // Every LLM round-trip reports its measured wall-clock duration
    // (Agent.completeTimed) so the orchestrator can aggregate latency.
    expect(durations).toHaveLength(2);
    expect(durations.every((d) => typeof d === 'number' && d >= 0)).toBe(true);
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

  it('player turn: a chained reply (move + attack + end_turn) is applied in order in ONE LLM call', async () => {
    const { engine, hero, adventure } = buildEnv({ ratArmor: 0 });
    const reqs: Array<{ allowParallelTools?: boolean; thinking?: { budgetTokens?: number } }> = [];
    const llm: LlmClient = {
      complete: async (req) => {
        reqs.push(req as { allowParallelTools?: boolean });
        return {
          thinkingBlocks: ['Plan the whole turn.'],
          toolUses: [
            { name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } },
            { name: 'normal_attack', input: { targetId: 'm1' } },
            { name: 'end_turn', input: {} },
          ],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
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

    const gaps: string[] = [];
    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {
      onChainGap: async (prev) => { gaps.push(prev.kind); },
    });
    expect(out.reason).toBe('end_turn');
    // One LLM round-trip produced three applied steps...
    expect(reqs).toHaveLength(1);
    expect(out.steps.map((s) => s.toolName)).toEqual(['move', 'normal_attack', 'end_turn']);
    // ...the player request allows parallel tool calls (the chain)...
    expect(reqs[0]!.allowParallelTools).toBe(true);
    // ...with thinking capped to the explicit turn budget (not provider auto).
    expect(reqs[0]!.thinking).toEqual({ type: 'enabled', budgetTokens: 1024 });
    // ...the pacing hook fired BETWEEN chained actions (N-1 times, with the
    // action whose beat must land before the next one fires)...
    expect(gaps).toEqual(['move', 'normal_attack']);
    // ...and the response's thinking is attributed to the FIRST step only.
    expect(out.steps[0]!.thought).toBe('Plan the whole turn.');
    expect(out.steps[1]!.thought).toBe('');
    expect(out.steps[2]!.thought).toBe('');
  });

  it('player turn: a chained reply stops at the first rule violation — the rest is dropped', async () => {
    const { engine, hero, rat, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // Illegal first link (moving onto the rat's square): the chained attack
      // and end_turn must NOT be applied — they were premised on the move.
      { match: { tag: 'p1' }, response: { toolUses: [
        { name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } },
        { name: 'normal_attack', input: { targetId: 'm1' } },
        { name: 'end_turn', input: {} },
      ] } },
      // Recovery round-trip after the violation observation.
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
    // Step 1: the violation. Step 2: the recovery end_turn. No attack step.
    expect(out.steps[0]!.observation).toMatchObject({ kind: 'rule_violation' });
    expect(out.steps.map((s) => s.toolName)).toEqual(['move', 'end_turn']);
    // The chained attack never reached the engine: the rat is unharmed.
    expect(engine.charactersById().get(rat.id)!.health.damage).toBe(0);
  });

  it('player turn: a STREAMING client applies tool calls live (no double apply, thought first, deltas forwarded)', async () => {
    const { engine, hero, rat, adventure } = buildEnv({ ratArmor: 0 });
    const order: string[] = [];
    // Minimal streaming double: fires the callbacks in provider order
    // (thinking deltas → block done → each tool call, awaited), then returns
    // the assembled response — exactly the LlmClient.completeStream contract.
    const llm: LlmClient = {
      complete: async () => { throw new Error('batch complete() must not be used when streaming'); },
      completeStream: async (_req, cb) => {
        cb.onThinkingDelta?.('Hit the ');
        cb.onThinkingDelta?.('rat.');
        cb.onThinkingBlockDone?.('Hit the rat.');
        await cb.onToolUse?.({ name: 'normal_attack', input: { targetId: 'm1' } });
        await cb.onToolUse?.({ name: 'end_turn', input: {} });
        return {
          thinkingBlocks: ['Hit the rat.'],
          toolUses: [
            { name: 'normal_attack', input: { targetId: 'm1' } },
            { name: 'end_turn', input: {} },
          ],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
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

    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {
      emitThinkingDelta: (text) => order.push(`delta:${text}`),
      emitThought: (text) => order.push(`thought:${text}`),
      applyPlayerAction: async (id, action) => {
        order.push(`apply:${action.kind}`);
        return engine.applyAction(id, action);
      },
    });

    expect(out.reason).toBe('end_turn');
    expect(out.steps.map((s) => s.toolName)).toEqual(['normal_attack', 'end_turn']);
    // Deltas streamed live; the atomic thought event landed BEFORE any action
    // applied (log order preserved); each tool call applied exactly ONCE (the
    // post-stream loop skipped what the callbacks already consumed).
    expect(order).toEqual([
      'delta:Hit the ', 'delta:rat.',
      'thought:Hit the rat.',
      'apply:normal_attack',
      'apply:end_turn',
    ]);
    // The rat genuinely took the (armor-0, deterministic) hit once.
    expect(engine.charactersById().get(rat.id)!.health.damage).toBe(1);
  });

  it('computeTurnThinkingBudget: base 1024, +1024 per signal, clamped at 4096', () => {
    const none = { combatOpening: false, allyInDanger: false, outnumbered: false, retryingViolation: false };
    expect(computeTurnThinkingBudget(none)).toBe(1024);
    expect(computeTurnThinkingBudget({ ...none, combatOpening: true })).toBe(2048);
    expect(computeTurnThinkingBudget({ ...none, allyInDanger: true })).toBe(2048);
    expect(computeTurnThinkingBudget({ ...none, outnumbered: true })).toBe(2048);
    expect(computeTurnThinkingBudget({ ...none, retryingViolation: true })).toBe(2048);
    expect(computeTurnThinkingBudget({ ...none, combatOpening: true, allyInDanger: true, outnumbered: true })).toBe(4096);
    // All four would be 5120 — clamped to the 4096 ceiling.
    expect(computeTurnThinkingBudget({ combatOpening: true, allyInDanger: true, outnumbered: true, retryingViolation: true })).toBe(4096);
  });

  it('player turn: a wounded board raises the adaptive thinking ceiling', async () => {
    // Hero at 1/3 HP (critical → allyInDanger): the budget should be
    // base 1024 + 1024 = 2048 instead of the routine 1024.
    const { engine, hero, adventure } = buildEnv({ heroDamage: 2 });
    const reqs: Array<{ thinking?: { budgetTokens?: number } }> = [];
    const llm: LlmClient = {
      complete: async (req) => {
        reqs.push(req as { thinking?: { budgetTokens?: number } });
        return {
          thinkingBlocks: [], toolUses: [{ name: 'end_turn', input: {} }],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
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
    await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {});
    expect(reqs[0]!.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
  });

  it('player turn: a zero-tool reply is a violation and the loop retries', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { toolUses: [] } },
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
    expect(out.steps[0]!.observation).toMatchObject({
      kind: 'rule_violation', reason: 'expected at least 1 tool call, got 0',
    });
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

  it('player turn: an aborted LLM call (human interjection) returns reason "interrupted" without forcing a terminal action', async () => {
    const { engine, hero, adventure } = buildEnv();
    // The signal fires while the agent is "thinking"; complete() rejects with
    // LlmAbortedError, exactly as AnthropicLlmClient does on abort.
    let calls = 0;
    const llm: LlmClient = { complete: async () => { calls += 1; throw new LlmAbortedError(); } };
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

    const ac = new AbortController(); ac.abort();
    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, { signal: ac.signal });
    expect(out.reason).toBe('interrupted');
    expect(out.steps).toHaveLength(0);   // bailed before recording a step
    expect(calls).toBe(1);               // stopped the ReACT loop, didn't retry
    // No forced action / budget-exhausted fallback was emitted.
    const events = engine.flushEvents();
    expect(events.some((e) => e.type === 'rule_violation')).toBe(false);
  });

  it('reactToPartyMessage: returns the say + emoji from the reaction, and empty arrays when silent', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // First reaction: both a line AND an emoji (allowParallelTools).
      { match: { tag: 'p1:party-react' }, response: { toolUses: [
        { name: 'say', input: { text: "Aye — I've got your flank!" } },
        { name: 'emote', input: { emoji: '😤' } },
      ] } },
      // Second reaction: no tool call → the hero stays silent.
      { match: { tag: 'p1:party-react' }, response: { toolUses: [] } },
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

    const r1 = await agent.reactToPartyMessage('Charge the rats!', 'Bran', [], 0, {});
    expect(r1.says).toEqual(["Aye — I've got your flank!"]);
    expect(r1.emojis).toEqual(['😤']);
    // reacting is pure banter — it applied NOTHING to the engine.
    expect(engine.flushEvents().some((e) => e.type === 'action')).toBe(false);

    const r2 = await agent.reactToPartyMessage('Charge the rats!', 'Bran', [], 0, {});
    expect(r2.says).toEqual([]);
    expect(r2.emojis).toEqual([]);
  });

  it('reactToPartyMessage: rejects on a DM agent', async () => {
    const { engine, hero, adventure } = buildEnv();
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: new ScriptedLlmClient([]), promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });
    await expect(agent.reactToPartyMessage('hi', 'Bran', [], 0, {})).rejects.toThrow(/only valid on a player/i);
  });

  it('reactToPartyAction: returns the say + emoji reacting to a teammate action, empty when silent', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // React to Bran blowing himself up: a quip AND a face emoji.
      { match: { tag: 'p1:party-react' }, response: { toolUses: [
        { name: 'say', input: { text: 'Bran! The cask was the ENEMY, not you!' } },
        { name: 'emote', input: { emoji: '😱' } },
      ] } },
      // Routine action: stay silent.
      { match: { tag: 'p1:party-react' }, response: { toolUses: [] } },
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

    const r1 = await agent.reactToPartyAction('Bran smashed the oil cask and caught the blast himself — now at 1 HP.', [], 0, {});
    expect(r1.says).toEqual(['Bran! The cask was the ENEMY, not you!']);
    expect(r1.emojis).toEqual(['😱']);
    // Reacting is pure banter — nothing was applied to the engine.
    expect(engine.flushEvents().some((e) => e.type === 'action')).toBe(false);

    const r2 = await agent.reactToPartyAction('Bran moved two squares.', [], 0, {});
    expect(r2.says).toEqual([]);
    expect(r2.emojis).toEqual([]);
  });

  it('reactToPartyAction: rejects on a DM agent', async () => {
    const { engine, hero, adventure } = buildEnv();
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: new ScriptedLlmClient([]), promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });
    await expect(agent.reactToPartyAction('something', [], 0, {})).rejects.toThrow(/only valid on a player/i);
  });

  it('reactAsMonsters: DM voices per-monster reactions, drops empty/no calls', async () => {
    const { engine, hero, rat, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // One foe screeches (line + emoji); a second emits nothing useful and is dropped.
      { match: { tag: 'dm:monster-react' }, response: { toolUses: [
        { name: 'voice_monster', input: { monsterId: 'm1', text: 'SKREEE!', emoji: '😾' } },
        { name: 'voice_monster', input: { monsterId: 'm2' } },
      ] } },
      // No reaction at all.
      { match: { tag: 'dm:monster-react' }, response: { toolUses: [] } },
    ]);
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero, rat],
      getMonstersInScene: () => [rat],
    });

    const r1 = await agent.reactAsMonsters('Bran blew himself up on the oil cask — now at 1 HP.', [], 0, {});
    expect(r1).toEqual([{ monsterId: 'm1', say: 'SKREEE!', emoji: '😾' }]);
    // Pure banter — nothing applied to the engine.
    expect(engine.flushEvents().some((e) => e.type === 'action')).toBe(false);

    const r2 = await agent.reactAsMonsters('Bran moved closer.', [], 0, {});
    expect(r2).toEqual([]);
  });

  it('reactAsMonsters: rejects on a player agent', async () => {
    const { engine, hero, adventure } = buildEnv();
    const agent = new Agent({
      role: 'player', actorId: hero.id, persona: '',
      llm: new ScriptedLlmClient([]), promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: PLAYER_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'p1',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
    });
    await expect(agent.reactAsMonsters('something', [], 0, {})).rejects.toThrow(/only valid on a DM/i);
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

describe('Agent emits rule_violation events on engine rejection', () => {
  it('appends a rule_violation event when the engine returns err', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // Illegal: attack a non-existent target → unknown-id violation
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'ghost' } }] } },
      // Legal: end turn so the loop terminates cleanly
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

    const events: Event[] = engine.flushEvents();
    const violations = events.filter((e) => e.type === 'rule_violation');
    expect(violations.length).toBeGreaterThan(0);
    const v = violations[0]! as Extract<Event, { type: 'rule_violation' }>;
    expect(v.actorId).toBe(hero.id);
    expect(v.violation.reason).toBe('unknown-id');
  });

  it('rule_violation event includes the attempted action (F26)', async () => {
    const { engine, hero, adventure } = buildEnv();
    const llm = new ScriptedLlmClient([
      // Illegal: attack a non-existent target → unknown-id violation
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'normal_attack', input: { targetId: 'ghost' } }] } },
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

    await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {});
    const events: Event[] = engine.flushEvents();
    const violations = events.filter((e) => e.type === 'rule_violation') as Array<Extract<Event, { type: 'rule_violation' }>>;
    expect(violations[0]!.attempted).toEqual({ kind: 'normal_attack', targetId: asCharacterId('ghost') });
  });
});

describe('Agent.interpretHumanTurn — DM classifies an on-turn "ask the DM" message', () => {
  const buildDmAgent = (entries: ConstructorParameters<typeof ScriptedLlmClient>[0]) => {
    const { engine, hero, rat, adventure } = buildEnv();
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm: new ScriptedLlmClient(entries),
      promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 12,
      engine, adventure, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero, rat],
      getMonstersInScene: () => [rat],
    });
    return { agent, hero, rat };
  };

  it('a QUESTION → { kind: "reply" } carrying the ooc_reply text', async () => {
    const { agent, hero } = buildDmAgent([
      { match: { tag: 'dm:ooc' }, response: { toolUses: [
        { name: 'ooc_reply', input: { text: 'Three rats, clustered to the north.' } },
      ] } },
    ]);
    const out = await agent.interpretHumanTurn('how many rats are there?', hero.id, [], 0, {});
    expect(out.kind).toBe('reply');
    if (out.kind === 'reply') expect(out.text).toMatch(/three rats/i);
  });

  it('an ACTION intent → { kind: "act" } with the decoded player action', async () => {
    const { agent, hero } = buildDmAgent([
      { match: { tag: 'dm:ooc' }, response: { toolUses: [
        { name: 'ability_test', input: { characteristic: 'melee', difficulty: 4, describe: 'vault the barrels' } },
      ] } },
    ]);
    const out = await agent.interpretHumanTurn('I run and jump over the barrels', hero.id, [], 0, {});
    expect(out.kind).toBe('act');
    if (out.kind === 'act') {
      expect(out.actions).toHaveLength(1);
      expect(out.actions[0]).toMatchObject({ kind: 'ability_test', characteristic: 'melee', difficulty: 4 });
    }
  });

  it('a multi-step intent → the full sequence (move then main action) in order', async () => {
    // buildEnv's monster is 'm1'; reference it literally (the agent isn't built
    // until after this entries array is constructed).
    const { agent, hero } = buildDmAgent([
      { match: { tag: 'dm:ooc' }, response: { toolUses: [
        { name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } },
        { name: 'normal_attack', input: { targetId: 'm1' } },
      ] } },
    ]);
    const out = await agent.interpretHumanTurn('move up and hit the rat', hero.id, [], 0, {});
    expect(out.kind).toBe('act');
    if (out.kind === 'act') {
      expect(out.actions.map((a) => a.kind)).toEqual(['move', 'normal_attack']);
    }
  });

  it('an empty / unparseable response degrades to a reply so the turn never wedges', async () => {
    const { agent, hero } = buildDmAgent([
      { match: { tag: 'dm:ooc' }, response: { toolUses: [] } },
    ]);
    const out = await agent.interpretHumanTurn('???', hero.id, [], 0, {});
    expect(out.kind).toBe('reply');
  });
});

describe('summarizeHpOutcome (narration anchors to engine-truth HP)', () => {
  const charAt = (id: string, total: number, damage: number, status = 'normal'): Character => ({
    id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    health: { total, damage, status: status as Character['health']['status'] },
    pos: { x: 0, y: 0 },
    normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
    bonusAbility: { id: asEffectId('teamwork'), name: '', description: '' },
    inventory: [], boons: [], skills: [],
  });

  it('reports resulting absolute HP after a hit — the reported regression', () => {
    // Rat-4 bit Bran (3 HP total) for 1 → engine truth is 2/3, NOT 1/3. The DM
    // had narrated "down to 1 HP" by double-counting off the state block.
    const drained: Event[] = [
      { type: 'resolution', actorId: asCharacterId('giant-rat-4'),
        public: { hit: true, damage: 1, targetId: 'human_hunter', attackKind: 'melee' }, t: 1 },
      { type: 'state_change', changes: [{ id: asCharacterId('human_hunter'), damage: 1, status: 'normal' }], t: 2 },
    ];
    const bran = charAt('human_hunter', 3, 1); // post-hit engine state
    const s = summarizeHpOutcome(drained, (id) => (id === bran.id ? bran : undefined));
    expect(s).toContain('HIT human_hunter for 1');
    expect(s).toContain('human_hunter now 2/3 HP (normal)');
    expect(s).not.toContain('1/3'); // must never re-subtract the damage
  });

  it('a lethal hit surfaces the KO status', () => {
    const drained: Event[] = [
      { type: 'resolution', actorId: asCharacterId('p1'),
        public: { hit: true, damage: 1, targetId: 'm1', attackKind: 'melee' }, t: 1 },
      { type: 'state_change', changes: [{ id: asCharacterId('m1'), damage: 1, status: 'KO' }], t: 2 },
    ];
    const m1 = charAt('m1', 1, 1, 'KO');
    expect(summarizeHpOutcome(drained, () => m1)).toContain('m1 now 0/1 HP (KO)');
  });

  it('a miss reports the whiff and no HP line', () => {
    const drained: Event[] = [
      { type: 'resolution', actorId: asCharacterId('giant-rat-4'),
        public: { hit: false, damage: 0, targetId: 'human_hunter', attackKind: 'melee' }, t: 1 },
    ];
    const s = summarizeHpOutcome(drained, () => charAt('human_hunter', 3, 0));
    expect(s).toContain('MISS on human_hunter');
    expect(s).not.toContain('HP');
  });

  it('is empty for actions that change no HP/status (a move)', () => {
    const drained: Event[] = [
      { type: 'state_change', changes: [{ id: asCharacterId('p1'), pos: { x: 1, y: 1 } }], t: 1 },
    ];
    expect(summarizeHpOutcome(drained, () => charAt('p1', 3, 0))).toBe('');
  });

  it('names the character next to its id — the narrator speaks names, never ids (regression: "Anwen" improvised from a name-bearing id)', () => {
    const drained: Event[] = [
      { type: 'resolution', actorId: asCharacterId('giant-rat-4'),
        public: { hit: true, damage: 1, targetId: 'p1_warrior', attackKind: 'melee' }, t: 1 },
      { type: 'state_change', changes: [{ id: asCharacterId('p1_warrior'), damage: 1, status: 'normal' }], t: 2 },
    ];
    const gareth = { ...charAt('p1_warrior', 8, 1), name: 'Gareth' };
    const s = summarizeHpOutcome(drained, (id) => (id === gareth.id ? gareth : undefined));
    expect(s).toContain('HIT p1_warrior (Gareth) for 1');
    expect(s).toContain('p1_warrior (Gareth) now 7/8 HP (normal)');
  });
});

describe('Agent attack observation carries engine-truth HP', () => {
  it('a player attack observation quotes the target HP, not just the verb', async () => {
    // armor 0 → the hit always lands, so the rat is deterministically KO'd.
    const { engine, hero, rat, adventure } = buildEnv({ ratArmor: 0 });
    const llm = new ScriptedLlmClient([
      { match: { tag: 'p1' }, response: { thinkingBlocks: ['Strike!'], toolUses: [{ name: 'normal_attack', input: { targetId: 'm1' } }] } },
      { match: { tag: 'p1' }, response: { toolUses: [{ name: 'end_turn', input: {} }] } },
    ]);
    const agent = new Agent({
      role: 'player', actorId: hero.id, persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: PLAYER_TOOLS, stepBudget: 6,
      engine, adventure, partyDescription: '', tag: 'p1',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => [hero, rat],
      getMonstersInScene: () => [rat],
    });
    // Wire the engine drain the orchestrator normally provides.
    const out = await agent.takeTurn({ kind: 'fresh_turn' }, [], 0, {
      onEngineActed: async () => engine.flushEvents(),
    });
    const attackStep = out.steps[0]!;
    expect(attackStep.observation.kind).toBe('public_resolution');
    const summary = (attackStep.observation as { kind: 'public_resolution'; summary: string }).summary;
    expect(summary).toContain('HIT m1 (Rat)');
    expect(summary).toContain('m1 (Rat) now 0/1 HP (KO)');
  });
});

describe('DM uiShowsIntro — intro suppression on EVERY DM prompt build', () => {
  // The browser splash + the engine-emitted `opening.after` already showed the
  // player the intro; the DM re-narrating it duplicates it under the revealed
  // board. The flag must reach the system prompt on every DM call kind (turn,
  // react, ooc, interpret, monster-react) — both for behavior AND to keep the
  // DM system band byte-stable within a scene (prompt caching).
  const INTRO = 'You enter the cellar of many rats.';

  const buildDmEnv = (opening: boolean) => {
    const { engine, hero, adventure } = buildEnv();
    const scene = {
      ...adventure.scenes[0]!,
      intro: INTRO,
      ...(opening ? { opening: { before: 'Splash before.', after: 'Splash after.' } } : {}),
    };
    const adv: Adventure = { ...adventure, scenes: [scene] };
    const systems: string[] = [];
    const inner = new ScriptedLlmClient([
      { match: { tag: 'dm:react' }, response: { toolUses: [{ name: 'narrate', input: { text: '' } }] } },
    ]);
    const llm: LlmClient = {
      complete: (req) => {
        systems.push(req.system.map((s) => s.text).join('\n'));
        return inner.complete(req);
      },
    };
    const agent = new Agent({
      role: 'dm', actorId: 'dm', persona: '',
      llm, promptBuilder: new PromptBuilder({ snapshotEveryTurns: 3 }),
      tools: DM_TOOLS, stepBudget: 6,
      engine, adventure: adv, partyDescription: '', tag: 'dm',
      model: 'claude-sonnet-4-6', maxTokens: 1024,
      getActiveScene: () => adv.scenes[0]!,
      getCharacters: () => [hero],
      getMonstersInScene: () => [],
      uiShowsIntro: true,
    });
    return { agent, systems };
  };

  it('react() prompt suppresses the intro when the UI showed the opening', async () => {
    const { agent, systems } = buildDmEnv(true);
    await agent.react([], 0, {});
    expect(systems).toHaveLength(1);
    expect(systems[0]!).toMatch(/do NOT narrate it/);
    expect(systems[0]!).not.toContain(INTRO);
  });

  it('react() prompt keeps the intro when the scene has no opening (nothing was splashed)', async () => {
    const { agent, systems } = buildDmEnv(false);
    await agent.react([], 0, {});
    expect(systems).toHaveLength(1);
    expect(systems[0]!).toContain(INTRO);
    expect(systems[0]!).not.toMatch(/do NOT narrate it/);
  });
});

