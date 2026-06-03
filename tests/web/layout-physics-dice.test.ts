// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { matchQueueItems } from '../../web/components/Layout.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const hero = (id: string, name: string): RedactedCharacter => ({
  id: id as never, name, kind: 'hero', archetype: 'warrior', dex: 0,
  pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
  pools: { melee: 2, ranged: 0, magic: 0, armor: 1 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});
const monster = (id: string): RedactedCharacter => ({
  id: id as never, name: 'giant-rat', kind: 'monster', sprite: 'giant-rat', dex: 0,
  pos: { x: 1, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
  pools: { melee: 1, ranged: 0, magic: 0, armor: 1 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});

const cast = [hero('h1', 'Bran'), monster('r1')];

const resolution = (extraPublic: Record<string, unknown> = {}) => ({
  event: {
    type: 'resolution',
    actorId: 'h1',
    t: 7,
    public: {
      hit: true, damage: 1, attackerTop: 5, defenderTop: 3, targetId: 'r1', attackKind: 'melee',
      ...extraPublic,
    },
  },
});

describe('matchQueueItems — physics-as-truth dice suppression', () => {
  it('emits a dice item for a seeded (engine-rolled) resolution', () => {
    const items = matchQueueItems([resolution()] as never, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('dice');
  });

  it('suppresses the dice item when the resolution carries a rollRequestId', () => {
    // The browser already animated these dice in response to roll_request, so
    // re-enqueuing would roll them a second time.
    const items = matchQueueItems([resolution({ rollRequestId: 'roll-run1-2' })] as never, 0, cast);
    expect(items).toEqual([]);
  });

  it('suppresses the dice item for a SEEDED fallback in physics mode (no rollRequestId)', () => {
    // Physics run, but the browser never answered the roll_request so the
    // engine fell back to seeded dice — the resolution has no rollRequestId.
    // Re-enqueuing a dice beat here would (a) re-animate a roll the player
    // never triggered and (b) risk wedging the queue if that overlay never
    // settles (the rat-tunnel freeze). With physicsMode on, drop it.
    const items = matchQueueItems([resolution()] as never, 0, cast, true);
    expect(items).toEqual([]);
  });

  it('still emits the dice item for a seeded resolution when NOT in physics mode (legacy 2D path)', () => {
    const items = matchQueueItems([resolution()] as never, 0, cast, false);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('dice');
  });
});
