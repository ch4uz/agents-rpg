import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../../src/runtime/orchestrator.js';
import { Agent } from '../../src/runtime/agent.js';
import { ScriptedLlmClient, type ScriptedEntry } from '../../src/runtime/llm/scripted.js';
import { PromptBuilder } from '../../src/runtime/prompt/builder.js';
import { PLAYER_TOOLS, DM_TOOLS } from '../../src/runtime/prompt/tools.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import { Grid } from '../../src/engine/grid.js';
import { EffectRegistry, registerCoreEffects } from '../../src/engine/effects.js';
import { asCharacterId, asAdventureId, asSceneId, asEffectId } from '../../src/engine/ids.js';
import type { Adventure } from '../../src/engine/adventure.js';
import type { Character } from '../../src/engine/character.js';
import type { MonsterEntry } from '../../src/engine/catalogs.js';
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
    { id: asCharacterId('p1_warrior'), name: 'Anwen', kind: 'hero', archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 0, y: 0 },
      normalAttack: { kind: 'melee', name: 'Slashing Strike', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('whirlwind-attack'), name: 'Whirlwind Attack', description: 'hit all adjacent enemies' },
      bonusAbility: { id: asEffectId('teamwork'), name: 'Teamwork', description: '' },
      inventory: [], boons: [], skills: [] },
    { id: asCharacterId('p2_warlock'), name: 'Kael', kind: 'hero', archetype: 'warlock',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 1, y: 0 },
      normalAttack: { kind: 'magic', name: 'Flaming Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Flame Burst', description: 'AoE burst, 2 squares around target' },
      bonusAbility: { id: asEffectId('arcane-mind'), name: 'Arcane Mind', description: '' },
      inventory: [], boons: [], skills: [] },
    { id: asCharacterId('human_hunter'), name: 'Bran', kind: 'hero', archetype: 'hunter',
      pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
      health: { total: 3, damage: 0, status: 'normal' }, pos: { x: 0, y: 1 },
      normalAttack: { kind: 'ranged', name: 'Quick Shot', range: 6, damageMod: 0 },
      specialAction: { id: asEffectId('split-shot'), name: 'Split Shot', description: '' },
      bonusAbility: { id: asEffectId('keen-eye'), name: 'Keen Eye', description: '' },
      inventory: [], boons: [], skills: [] },
  ];
  // The engine auto-reveals scene-declared monsters from the catalog on
  // set_scene (Task 4 / F19). Replay-test rats use armor:0 so the scripted
  // attacks always connect deterministically.
  const adventure: Adventure = {
    id: asAdventureId('stub-layer-b'), title: 'Audit Replay', estimatedDurationMin: 10,
    scenes: [{
      id: asSceneId('stub-cell-b'),
      intro: 'You stand in a dim stone room. Three rats scurry near the back wall.',
      conclusion: 'With the last rat down, the room falls quiet.',
      map: { width: 8, height: 8, background: 'stub-cell-b', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
      monsters: [
        { type: 'giant-rat', startPos: { x: 5, y: 2 } },
        { type: 'giant-rat', startPos: { x: 6, y: 2 } },
        { type: 'giant-rat', startPos: { x: 5, y: 5 } },
      ],
      tactics: 'Rats hold their position until attacked.',
      abilityTests: [], transitions: [{ to: 'END' as const, trigger: 'all-monsters-ko' as const }],
    }],
  };
  const monsterCatalog = new Map<string, MonsterEntry>([
    ['giant-rat', {
      id: 'giant-rat', name: 'Giant Rat',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
      healthTotal: 1,
      normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
      specialAction: { effectId: 'pack-attack', name: 'Pack Attack', description: '' },
      bonusAbility: { effectId: 'skitter', name: 'Skitter', description: '' },
      sprite: 'giant-rat',
    }],
  ]);
  const engine = new GameEngine({
    seed: '0xC0FFEE', grid, characters: heroes, effects: reg,
    adventure, monsters: monsterCatalog,
  });
  return { engine, adventure, heroes };
};

const readEvents = (runDir: string): Event[] => {
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

    const partyDescription = heroes.map((h) => `  - ${h.id} (${h.archetype})`).join('\n');

    const dm = new Agent({
      role: 'dm', actorId: 'dm', llm: dmLlm, tools: DM_TOOLS,
      promptBuilder: builder, persona: 'You are even-handed.', model: 'test', maxTokens: 512,
      tag: 'dm', adventure, partyDescription,
      getActiveScene: () => adventure.scenes[0]!,
      getCharacters: () => Array.from(engine.charactersById().values()),
      getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
      stepBudget: 12, engine,
    });

    const aiHeroes = heroes.filter((h) => h.id !== asCharacterId('human_hunter'));
    const players = new Map(aiHeroes.map((h, i) => [
      h.id,
      new Agent({
        role: 'player', actorId: h.id, llm: i === 0 ? p1Llm : p2Llm, tools: PLAYER_TOOLS,
        promptBuilder: builder, persona: 'p', model: 'test', maxTokens: 512,
        tag: i === 0 ? 'p1' : 'p2',
        adventure, partyDescription,
        getActiveScene: () => adventure.scenes[0]!,
        getCharacters: () => Array.from(engine.charactersById().values()),
        getMonstersInScene: () => Array.from(engine.charactersById().values()).filter((c) => c.kind === 'monster'),
        stepBudget: 6, engine,
      }),
    ]));

    const runDir = mkdtempSync(path.join(tmpdir(), 'replay-'));
    const orch = new Orchestrator({
      engine, adventure,
      agents: { dm, players },
      human: { characterId: asCharacterId('human_hunter'), provider: human },
      subscribers: [], stepBudget: { player: 6, dm: 12 },
      runDir, seed: '0xC0FFEE', runId: 'replay',
    });
    const result = await orch.run();
    const events = readEvents(runDir);

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

    // The human's free-text input becomes a verbatim `say` action — no DM
    // interpretation, no rephrasing. The follow-up normal_attack arrives
    // separately via a structured_action submission (action button).
    const literalSay = events.find((e) =>
      e.type === 'action'
      && (e as Event & { type: 'action' }).actorId === asCharacterId('human_hunter')
      && (e as Event & { type: 'action' }).action.kind === 'say'
      && (e as Event & { type: 'action'; action: { text: string } }).action.text === 'I rush toward the closest rat and swing',
    );
    expect(literalSay, 'literal say action with the exact player text').toBeDefined();
    const followUpAttack = events.find((e) =>
      e.type === 'action'
      && (e as Event & { type: 'action' }).actorId === asCharacterId('human_hunter')
      && (e as Event & { type: 'action' }).action.kind === 'normal_attack',
    );
    expect(followUpAttack, 'explicit normal_attack follows the literal say').toBeDefined();

    expect(result.outcome).toBe('success');
  });
});
