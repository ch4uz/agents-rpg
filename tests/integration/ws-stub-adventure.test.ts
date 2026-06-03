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
import { WsAdapter } from '../../src/runtime/ws/adapter.js';
import type { Character } from '../../src/engine/character.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  on(_event: string, _handler: unknown) {}
}

const fakeManifest = { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {}, tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {} };

const loadJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(path.join(REPO, rel), 'utf8')) as T;

const mkEngine = async (seed: string) => {
  const cats = await loadCatalogs(path.join(REPO, 'data'));
  const adv = await loadAdventure(path.join(REPO, 'adventures/stub-layer-b.json'));

  const heroFromCat = (id: string, key: string, pos: { x: number; y: number }): Character => {
    const h = cats.heroes.get(key);
    if (!h) throw new Error(`hero ${key} not found`);
    return {
      id: asCharacterId(id), name: h.name, kind: 'hero', archetype: h.archetype,
      sprite: h.sprite,
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
      sprite: def.sprite,
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

describe('ws-stub-adventure end-to-end (scripted)', () => {
  it('orchestrator → WsAdapter pipeline emits envelopes and reaches success', async () => {
    const seed = 'ws-stub-test';
    const { engine, adventure, scene0, monsters, p1, p2, human } = await mkEngine(seed);

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

    // WsAdapter wired to a fake socket. The adapter is BOTH Subscriber and HumanInputProvider,
    // but for this scripted test we use ScriptHumanProvider for input — the adapter is
    // a Subscriber-only role here.
    const adapter = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    const initialSnapshot = engine.getRedactedSnapshot(adapter.viewer);
    adapter.attach(ws as unknown as import('ws').WebSocket, initialSnapshot);

    const dir = mkdtempSync(path.join(tmpdir(), 'ws-stub-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm: dmAgent, players: new Map([[p1.id, p1Agent], [p2.id, p2Agent]]) },
      human: { characterId: human.id, provider: humanProvider },
      subscribers: [adapter],
      stepBudget: { player: 6, dm: 12 },
      runDir: dir, seed, runId: 'ws-stub-run',
    });

    const result = await orch.run();
    expect(result.outcome).toBe('success');

    // Inspect the envelopes the adapter shipped to FakeWs.
    const envelopes = ws.sent.map((s) => JSON.parse(s) as { kind: string });
    const kinds = envelopes.map((e) => e.kind);

    // Must start with snapshot.
    expect(kinds[0]).toBe('snapshot');
    // Must include event envelopes.
    expect(kinds).toContain('event');
    // Must include lifecycle envelopes.
    expect(kinds).toContain('turn_started');
    expect(kinds).toContain('turn_ended');
    // Must end with end envelope (run-success).
    expect(kinds.at(-1)).toBe('end');
    expect(envelopes.at(-1)).toMatchObject({ kind: 'end', outcome: 'success' });

    // Sanity: rule_violation events should NOT be in the redacted stream
    // (they're filtered by the visibility predicate for non-self viewers,
    // and the human viewer doesn't see DM rule_violations as events).
    const ruleViolations = envelopes.filter((e) => {
      const env = e as { kind: string; event?: { type?: string } };
      return env.kind === 'event' && env.event?.type === 'rule_violation';
    });
    expect(ruleViolations).toHaveLength(0);
  }, 30_000);
});
