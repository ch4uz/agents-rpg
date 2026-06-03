import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Grid } from '../../src/engine/grid.js';
import { GameEngine } from '../../src/engine/game-engine.js';
import {
  EffectRegistry,
  registerCoreEffects,
} from '../../src/engine/effects.js';
import { asCharacterId, asEffectId, asItemId, asBoonId } from '../../src/engine/ids.js';
import type { BoonEntry } from '../../src/engine/catalogs.js';
import { replayFromFixture, snapshotEngineState } from '../../src/log/replay.js';
import type { ReplayFixture } from '../../src/log/replay.js';
import type { Character } from '../../src/engine/character.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, '..', 'fixtures', 'basic-attack-sequence.json'), 'utf8'),
);

const buildEngine = (seed: string, chars: Character[]): GameEngine => {
  const grid = new Grid(
    Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ kind: 'floor' as const })),
    ),
  );
  const reg = new EffectRegistry();
  registerCoreEffects(reg);
  return new GameEngine({ seed, grid, characters: chars, effects: reg });
};

const charsFromFixture = (): Character[] =>
  (fixture.characters as Array<Record<string, unknown>>).map((c) => ({
    id: asCharacterId(c['id'] as string),
    name: c['name'] as string,
    kind: c['kind'] as 'hero' | 'monster',
    ...(c['archetype'] ? { archetype: c['archetype'] as Character['archetype'] } : {}),
    pools: c['pools'] as Character['pools'],
    health: { total: c['healthTotal'] as number, damage: 0, status: 'normal' },
    pos: c['pos'] as Character['pos'],
    normalAttack: c['normalAttack'] as Character['normalAttack'],
    specialAction: {
      id: asEffectId((c['specialAction'] as { id: string }).id),
      name: '',
      description: '',
    },
    bonusAbility: {
      id: asEffectId((c['bonusAbility'] as { id: string }).id),
      name: '',
      description: '',
    },
    inventory: [],
    boons: [],
    skills: [],
  })) as Character[];

describe('replay invariant', () => {
  it('replaying the same fixture twice produces identical engine state', () => {
    const engine1 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine1, fixture);
    const snap1 = snapshotEngineState(engine1);

    const engine2 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine2, fixture);
    const snap2 = snapshotEngineState(engine2);

    expect(snap2).toEqual(snap1);
  });

  it('different seed produces different snapshot', () => {
    const engine1 = buildEngine(fixture.seed, charsFromFixture());
    replayFromFixture(engine1, fixture);
    const snap1 = snapshotEngineState(engine1);

    const engine2 = buildEngine('seed3', charsFromFixture());
    replayFromFixture(engine2, fixture);
    const snap2 = snapshotEngineState(engine2);

    expect(snap2).not.toEqual(snap1);
  });
});

describe('snapshotEngineState shape', () => {
  it('includes inventory, boons, and equipped per character', () => {
    const engine = buildEngine('seed-snap', charsFromFixture());
    const snap = snapshotEngineState(engine);
    for (const c of snap.characters) {
      expect(c).toHaveProperty('inventory');
      expect(c).toHaveProperty('boons');
      expect(c).toHaveProperty('equipped');
    }
  });

  it('replaying an item-use sequence twice produces identical inventories', () => {
    const fx = JSON.parse(
      readFileSync(join(HERE, '..', 'fixtures', 'item-roundtrip-sequence.json'), 'utf8'),
    ) as Record<string, unknown>;

    // Pre-load h1 with 1 potion to verify it is captured.
    const seedChars = (fx.characters as Array<Record<string, unknown>>).map((c) => ({
      ...(c as object),
      inventory: c['id'] === 'h1' ? [{ itemId: 'potion', count: 1 }] : [],
      boons: [],
    }));
    const fixtureWithInv = { ...fx, characters: seedChars } as unknown as ReplayFixture;

    const make = (): GameEngine => {
      const cs = (fixtureWithInv.characters as Array<Record<string, unknown>>).map((c) => {
        const charData: Record<string, unknown> = {
          id: asCharacterId(c['id'] as string),
          name: c['name'] as string,
          kind: c['kind'] as 'hero' | 'monster',
          pools: c['pools'] as Character['pools'],
          health: {
            total: c['healthTotal'] as number,
            damage: 0,
            status: 'normal' as const,
          },
          pos: c['pos'] as Character['pos'],
          normalAttack: c['normalAttack'] as Character['normalAttack'],
          specialAction: {
            id: asEffectId((c['specialAction'] as { id: string }).id),
            name: '',
            description: '',
          },
          bonusAbility: {
            id: asEffectId((c['bonusAbility'] as { id: string }).id),
            name: '',
            description: '',
          },
          inventory: ((c as { inventory?: Array<{ itemId: string; count: number }> }).inventory ?? []).map(
            (s) => ({ itemId: asItemId(s.itemId), count: s.count }),
          ),
          boons: ((c as { boons?: string[] }).boons ?? []).map((b) => asBoonId(b)),
          skills: [],
        };
        if (c['archetype']) {
          charData['archetype'] = c['archetype'] as Character['archetype'];
        }
        return charData;
      }) as unknown as Character[];

      const grid = new Grid(
        Array.from({ length: 6 }, () =>
          Array.from({ length: 6 }, () => ({ kind: 'floor' as const })),
        ),
      );
      const reg = new EffectRegistry();
      registerCoreEffects(reg);
      const items = new Map<string, { id: string; name: string; category: 'consumable' | 'utility'; consumableEffect?: string; icon: string }>([
        ['potion', { id: 'potion', name: 'Potion', category: 'consumable', consumableEffect: 'heal-full', icon: 'p' }],
      ]);
      return new GameEngine({
        seed: fixtureWithInv.seed as string,
        grid,
        characters: cs,
        effects: reg,
        items,
      });
    };

    const e1 = make();
    replayFromFixture(e1, fixtureWithInv);
    const snap1 = snapshotEngineState(e1);

    const e2 = make();
    replayFromFixture(e2, fixtureWithInv);
    const snap2 = snapshotEngineState(e2);

    // Verify snapshots are identical after replay
    expect(snap2).toEqual(snap1);

    // Verify inventory is captured
    const h1 = snap1.characters.find((c) => c.id === 'h1')!;
    expect(h1.inventory).toEqual([]);
  });

  it('replaying a boon-use sequence twice produces identical snapshots', () => {
    const fx = JSON.parse(
      readFileSync(join(HERE, '..', 'fixtures', 'boon-roundtrip-sequence.json'), 'utf8'),
    ) as ReplayFixture;

    const make = (): GameEngine => {
      const cs = (fx.characters as Array<Record<string, unknown>>).map((c) => {
        const charData: Record<string, unknown> = {
          id: asCharacterId(c['id'] as string),
          name: c['name'] as string,
          kind: c['kind'] as 'hero' | 'monster',
          pools: c['pools'] as Character['pools'],
          health: {
            total: c['healthTotal'] as number,
            damage: 1,
            status: 'normal' as const,
          },
          pos: c['pos'] as Character['pos'],
          normalAttack: c['normalAttack'] as Character['normalAttack'],
          specialAction: {
            id: asEffectId((c['specialAction'] as { id: string }).id),
            name: '',
            description: '',
          },
          bonusAbility: {
            id: asEffectId((c['bonusAbility'] as { id: string }).id),
            name: '',
            description: '',
          },
          inventory: [],
          boons: [asBoonId('fixture-heal-boon')],
          skills: [],
        };
        if (c['archetype']) {
          charData['archetype'] = c['archetype'] as Character['archetype'];
        }
        return charData;
      }) as unknown as Character[];

      const grid = new Grid(
        Array.from({ length: 4 }, () =>
          Array.from({ length: 4 }, () => ({ kind: 'floor' as const })),
        ),
      );
      const reg = new EffectRegistry();
      registerCoreEffects(reg);
      reg.register('fixture-boon-heal', {
        kind: 'boon',
        apply: ({ actor }) => ({
          changes: [{ kind: 'heal', characterId: actor.id, amount: 1 }],
        }),
      });
      const boons = new Map<string, BoonEntry>([
        ['fixture-heal-boon', { id: 'fixture-heal-boon', name: 'Test Boon', description: '', effectId: 'fixture-boon-heal', icon: 'b' }],
      ]);
      return new GameEngine({
        seed: fx.seed as string,
        grid,
        characters: cs,
        effects: reg,
        boons,
      });
    };

    const e1 = make();
    replayFromFixture(e1, fx);

    const e2 = make();
    replayFromFixture(e2, fx);

    expect(snapshotEngineState(e2)).toEqual(snapshotEngineState(e1));

    // Hero healed from damage:1 to damage:0 and lost the boon.
    const hero = snapshotEngineState(e1).characters.find((c) => c.id === 'h')!;
    expect(hero.health.damage).toBe(0);
    expect(hero.boons).toEqual([]);
  });
});
