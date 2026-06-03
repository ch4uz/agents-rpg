import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameEngine,
  Grid,
  EffectRegistry,
  registerCoreEffects,
  loadCatalogs,
  loadAdventure,
  asCharacterId,
  asEffectId,
} from '../../src/engine/index.js';
import { EventLog, readEventLog } from '../../src/log/event-log.js';
import { snapshotEngineState } from '../../src/log/replay.js';
import type { Character } from '../../src/engine/character.js';
import type { HeroEntry, MonsterEntry } from '../../src/engine/catalogs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const heroFromCatalog = (
  id: string,
  hero: HeroEntry,
  pos: { x: number; y: number },
): Character => ({
  id: asCharacterId(id),
  name: hero.name,
  kind: 'hero',
  archetype: hero.archetype,
  pools: hero.pools,
  health: { total: hero.healthTotal, damage: 0, status: 'normal' },
  pos,
  normalAttack: hero.normalAttack,
  specialAction: {
    id: asEffectId(hero.specialAction.effectId),
    name: hero.specialAction.name,
    description: hero.specialAction.description,
  },
  bonusAbility: {
    id: asEffectId(hero.bonusAbility.effectId),
    name: hero.bonusAbility.name,
    description: hero.bonusAbility.description,
  },
  inventory: [...hero.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
  boons: [],
  skills: hero.defaultSkills as Character['skills'],
});

const monsterFromCatalog = (
  id: string,
  m: MonsterEntry,
  pos: { x: number; y: number },
): Character => ({
  id: asCharacterId(id),
  name: m.name,
  kind: 'monster',
  pools: m.pools,
  health: { total: m.healthTotal, damage: 0, status: 'normal' },
  pos,
  normalAttack: m.normalAttack,
  specialAction: {
    id: asEffectId(m.specialAction.effectId),
    name: m.specialAction.name,
    description: m.specialAction.description,
  },
  bonusAbility: {
    id: asEffectId(m.bonusAbility.effectId),
    name: m.bonusAbility.name,
    description: m.bonusAbility.description,
  },
  inventory: [],
  boons: [],
  skills: [],
});

describe('stub adventure end-to-end', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stub-run-'));
  });

  it('runs the scripted sequence, persists, and replays identically', async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(REPO, 'tests/fixtures/full-stub-run.json'), 'utf8'),
    );
    const cats = await loadCatalogs(path.join(REPO, 'data'));
    const adv = await loadAdventure(path.join(REPO, fixture.adventureFile));

    // Build characters: 2 AI heroes + 1 human-controlled hero + 1 rat from scene[0].monsters[0].
    const warrior = heroFromCatalog('h-warrior', cats.heroes.get('warrior')!, { x: 1, y: 1 });
    const warlock = heroFromCatalog('h-warlock-fire', cats.heroes.get('warlock-fire')!, { x: 2, y: 1 });
    const human = heroFromCatalog('h-human', cats.heroes.get('hunter')!, { x: 1, y: 2 });
    const rat = monsterFromCatalog(
      'm-giant-rat-1',
      cats.monsters.get('giant-rat')!,
      adv.scenes[0]!.monsters[0]!.startPos,
    );

    const grid = new Grid(
      Array.from({ length: 8 }, () =>
        Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
      ),
    );
    const reg = new EffectRegistry();
    registerCoreEffects(reg);

    const engine = new GameEngine({
      seed: fixture.seed,
      grid,
      characters: [warrior, warlock, human, rat],
      effects: reg,
      items: cats.items,
    });

    const log = await EventLog.create(path.join(dir, 'events.jsonl'));

    for (const step of fixture.actions) {
      const result =
        step.actor === 'dm'
          ? engine.applyDmAction(step.action)
          : engine.applyAction(asCharacterId(step.actor), step.action);
      if (!result.ok) {
        throw new Error(`Step failed: ${JSON.stringify(step)} → ${JSON.stringify(result.error)}`);
      }
      for (const ev of engine.flushEvents()) await log.append(ev);
    }
    await log.close();

    // Read back events and assert non-empty.
    const events = await readEventLog(path.join(dir, 'events.jsonl'));
    expect(events.length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'narrate')).toBeDefined();
    expect(events.find((e) => e.type === 'combat_started')).toBeDefined();

    // Replay invariant: rebuilding the engine with same seed + actions yields same state.
    const engine2 = new GameEngine({
      seed: fixture.seed,
      grid,
      characters: [warrior, warlock, human, rat].map((c) => ({ ...c })), // fresh copies
      effects: reg,
      items: cats.items,
    });
    for (const step of fixture.actions) {
      if (step.actor === 'dm') engine2.applyDmAction(step.action);
      else engine2.applyAction(asCharacterId(step.actor), step.action);
    }

    expect(snapshotEngineState(engine2)).toEqual(snapshotEngineState(engine));
  });
});
