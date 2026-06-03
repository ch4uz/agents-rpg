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
import type { Viewer } from '../../src/runtime/visibility/types.js';
import type { RedactedEvent } from '../../src/runtime/visibility/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class CapturingSubscriber {
  readonly viewer: Viewer = { kind: 'human' };
  events: RedactedEvent[] = [];
  onEvent(e: RedactedEvent): void { this.events.push(e); }
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

  const p1 = heroFromCat('p1_warrior', 'warrior', { x: 0, y: 0 });
  const p2 = heroFromCat('p2_warlock',  'warlock-fire', { x: 1, y: 0 });
  const human = heroFromCat('human_hunter', 'hunter', { x: 0, y: 1 });

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
    const seed = 'test-seed-2';
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

    // 4. Free-text input produces a literal say action — no DM interpretation,
    //    no `interpretedBy: 'dm'` annotation, and the text is verbatim.
    const literalSay = sub.events.find((e) =>
      e.type === 'action'
      && (e as { actorId: string }).actorId === 'human_hunter'
      && (e as { action: { kind: string } }).action.kind === 'say'
      && (e as { action: { text?: string } }).action.text === 'I rush toward the closest rat and swing'
      && (e as { interpretedBy?: string }).interpretedBy === undefined);
    expect(literalSay).toBeDefined();

    // 5. The /attack the human submits after speaking produces a normal_attack
    //    action — also direct, no interpretedBy annotation.
    const directAction = sub.events.find((e) =>
      e.type === 'action' && (e as { actorId: string; interpretedBy?: string; action: { kind: string } }).actorId === 'human_hunter'
      && (e as { interpretedBy?: string }).interpretedBy === undefined
      && (e as { action: { kind: string } }).action.kind === 'normal_attack');
    expect(directAction).toBeDefined();

    // 6. Replay invariant.
    const events = await readEventLog(path.join(dir, 'events.jsonl'));
    expect(events.length).toBeGreaterThan(0);

    const replay = await mkEngineFromCatalog(seed);
    for (const ev of events) {
      if (ev.type === 'request_action') {
        // Re-establish narrative actor so subsequent applyAction calls succeed.
        replay.engine.applyDmAction({ kind: 'request_action', actorId: ev.targetId });
      } else if (ev.type === 'action') {
        const actorId = (ev as { actorId: string }).actorId;
        if (actorId !== 'dm') {
          const actionEv = ev as unknown as { actorId: string; action: Parameters<typeof replay.engine.applyAction>[1] };
          const r = replay.engine.applyAction(asCharacterId(actionEv.actorId), actionEv.action);
          if (!r.ok) throw new Error(`replay diverged: ${JSON.stringify(ev)}`);
          // Clear narrative actor after player turn-ending actions (mirrors orchestrator runAiTurn/runHumanTurn).
          const pAction = (ev as { action: { kind: string } }).action;
          if (pAction.kind === 'end_turn' || pAction.kind === 'skip_turn') {
            replay.engine.turn.setNarrativeActor(null);
          }
        } else {
          const actionEv = ev as unknown as { action: Parameters<typeof replay.engine.applyDmAction>[0] };
          replay.engine.applyDmAction(actionEv.action);
        }
      } else if (ev.type === 'adventure_ended') {
        replay.engine.applyDmAction({ kind: 'end_adventure', outcome: ev.outcome });
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
