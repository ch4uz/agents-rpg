import { describe, it, expect } from 'vitest';
import { Dice } from '../../src/engine/dice.js';
import { TurnTracker } from '../../src/engine/turn-tracker.js';
import { asCharacterId, type CharacterId } from '../../src/engine/ids.js';

describe('TurnTracker', () => {
  it('starts in narrative phase with no active actor (DM picks)', () => {
    const t = new TurnTracker();
    expect(t.phase).toBe('narrative');
    expect(t.activeActorId).toBeNull();
  });

  it('startCombat rolls per-character initiative and exposes the combined order', () => {
    const t = new TurnTracker();
    const heroes = [asCharacterId('h1'), asCharacterId('h2')];
    const monsters = [asCharacterId('m1')];
    const dice = new Dice('initiative-1');
    const result = t.startCombat(dice, heroes, monsters);
    expect(t.phase).toBe('combat');
    expect(t.combatOrder).not.toBeNull();
    expect(result.order).toHaveLength(3);
    // Per-character rolls: one d6 per character, keyed by id, with d6+dex+total.
    expect(Object.keys(result.rolls.hero).sort()).toEqual(['h1', 'h2']);
    expect(Object.keys(result.rolls.monster)).toEqual(['m1']);
    for (const r of [...Object.values(result.rolls.hero), ...Object.values(result.rolls.monster)]) {
      expect(r.d6).toBeGreaterThanOrEqual(1);
      expect(r.d6).toBeLessThanOrEqual(6);
      expect(r.total).toBe(r.d6 + r.dex);
    }
    // Combined turn order = every character listed exactly once.
    expect(result.order.length).toBe(3);
    expect(new Set(result.order.map(String))).toEqual(new Set(['h1', 'h2', 'm1']));
  });

  it('records the DEX breakdown but orders by the rolled d6 alone (DEX never reorders)', () => {
    const t = new TurnTracker();
    const dice = new (class extends Dice { rollD6(): number { return 3; } })('x');
    // Everyone rolls the same d6=3. If dex still counted toward the order,
    // m2 (dex 5 → total 8) would lead; instead the rolled die ties for all
    // three, so declaration order stands and dex is purely informational.
    const dexFor = (id: { toString(): string }): number => {
      const s = String(id);
      if (s === 'h1') return 2;
      if (s === 'm2') return 5;
      return 0;
    };
    const r = t.startCombat(
      dice,
      [asCharacterId('h1')],
      [asCharacterId('m1'), asCharacterId('m2')],
      dexFor,
    );
    // dex + total are still recorded for the audit breakdown…
    expect(r.rolls.hero['h1']).toEqual({ d6: 3, dex: 2, total: 5 });
    expect(r.rolls.monster['m1']).toEqual({ d6: 3, dex: 0, total: 3 });
    expect(r.rolls.monster['m2']).toEqual({ d6: 3, dex: 5, total: 8 });
    // …but the order ignores dex: all d6 tie → declaration order.
    expect(r.order.map(String)).toEqual(['h1', 'm1', 'm2']);
  });

  it('a higher rolled d6 outranks a higher d6+dex total', () => {
    const t = new TurnTracker();
    let i = 0;
    // h1 rolls 3, m1 rolls 5.
    const sequence = [3, 5];
    const dice = new (class extends Dice {
      rollD6(): number { return sequence[i++]!; }
    })('x');
    // h1 has dex 3 (total 6), m1 has dex 0 (total 5). By total h1 would lead;
    // by the rolled die m1 (5) beats h1 (3) and acts first.
    const dexFor = (id: { toString(): string }): number =>
      String(id) === 'h1' ? 3 : 0;
    const r = t.startCombat(
      dice,
      [asCharacterId('h1')],
      [asCharacterId('m1')],
      dexFor,
    );
    expect(r.order.map(String)).toEqual(['m1', 'h1']);
  });

  it('combined turn order interleaves heroes and monsters by the rolled d6', () => {
    const t = new TurnTracker();
    // Pre-determined rolls per call: heroes (h1, h2), monsters (m1, m2).
    let i = 0;
    const sequence = [2, 5, 4, 1];
    const dice = new (class extends Dice {
      rollD6(): number { return sequence[i++]!; }
    })('x');
    // Order follows the dice: h2(5), m1(4), h1(2), m2(1).
    const r = t.startCombat(
      dice,
      [asCharacterId('h1'), asCharacterId('h2')],
      [asCharacterId('m1'), asCharacterId('m2')],
    );
    expect(r.order.map(String)).toEqual(['h2', 'm1', 'h1', 'm2']);
  });

  it('declaration order is the final tiebreak fallback', () => {
    const t = new TurnTracker();
    // Stub Dice always returns 4. h1.d6=4, m1.d6=4 → tied rolled die →
    // declaration order acts as the deterministic fallback (h1 first).
    const dice = new (class extends Dice { rollD6(): number { return 4; } })('x');
    const r = t.startCombat(dice, [asCharacterId('h1')], [asCharacterId('m1')]);
    expect(String(r.order[0])).toBe('h1');
  });

  it('advance cycles through every combatant in initiative order', () => {
    const t = new TurnTracker();
    // Dice sequence (h1, h2, m1): 1, 6, 4 → order is h2(6), m1(4), h1(1).
    let i = 0;
    const sequence = [1, 6, 4];
    const dice = new (class extends Dice {
      rollD6(): number { return sequence[i++]!; }
    })('x');
    t.startCombat(
      dice,
      [asCharacterId('h1'), asCharacterId('h2')],
      [asCharacterId('m1')],
    );
    const order: string[] = [];
    for (let n = 0; n < 5; n++) {
      order.push(String(t.activeActorId));
      t.advance();
    }
    expect(order[0]).toBe('h2');
    expect(order[1]).toBe('m1');
    expect(order[2]).toBe('h1');
    expect(order[3]).toBe('h2'); // wraps
    expect(order[4]).toBe('m1');
  });

  it('endCombat returns to narrative phase', () => {
    const t = new TurnTracker();
    t.startCombat(new Dice('x'), [asCharacterId('h1')], [asCharacterId('m1')]);
    t.endCombat();
    expect(t.phase).toBe('narrative');
    expect(t.activeActorId).toBeNull();
  });

  it('setNarrativeActor sets the active actor in narrative phase', () => {
    const t = new TurnTracker();
    t.setNarrativeActor(asCharacterId('h1'));
    expect(t.activeActorId).toBe('h1');
    t.setNarrativeActor(null);
    expect(t.activeActorId).toBeNull();
  });
});

describe('advance skips KO actors', () => {
  it('rotates past actors marked not-alive by the predicate', () => {
    const tt = new TurnTracker();
    const dice = new Dice('seed');
    tt.startCombat(
      dice,
      [asCharacterId('h1'), asCharacterId('h2')],
      [asCharacterId('m1'), asCharacterId('m2')],
    );
    // First, find what the next actor would be with no predicate.
    tt.advance();
    const nextNoPredicate = tt.activeActorId!;
    expect(nextNoPredicate).not.toBeNull();

    // Reset by re-creating a tracker with the same sides and same seed —
    // initiative roll is deterministic so the order matches.
    const tt2 = new TurnTracker();
    const dice2 = new Dice('seed');
    tt2.startCombat(
      dice2,
      [asCharacterId('h1'), asCharacterId('h2')],
      [asCharacterId('m1'), asCharacterId('m2')],
    );
    // Mark `nextNoPredicate` "dead" so the predicate-aware advance must skip past it.
    const isAlive = (id: CharacterId): boolean => id !== nextNoPredicate;
    tt2.advance(isAlive);
    expect(tt2.activeActorId).not.toBe(nextNoPredicate);
    expect(isAlive(tt2.activeActorId!)).toBe(true);
  });

  it('returns without spinning when all actors are dead', () => {
    const tt = new TurnTracker();
    const dice = new Dice('seed');
    tt.startCombat(dice, [asCharacterId('h1')], [asCharacterId('m1')]);
    const allDead = (): boolean => false;
    expect(() => tt.advance(allDead)).not.toThrow();
  });
});

describe('TurnTracker combat round counter', () => {
  // Stub dice → deterministic order; round counting is independent of the order
  // itself, only the cycle length matters.
  const order3 = (): TurnTracker => {
    const t = new TurnTracker();
    t.startCombat(new Dice('seed'), [asCharacterId('h1'), asCharacterId('h2')], [asCharacterId('m1')]);
    return t;
  };

  it('is 0 out of combat and 1 once combat starts', () => {
    const t = new TurnTracker();
    expect(t.roundNumber).toBe(0);
    t.startCombat(new Dice('x'), [asCharacterId('h1')], [asCharacterId('m1')]);
    expect(t.roundNumber).toBe(1);
  });

  it('increments by one each full cycle through the initiative order', () => {
    const t = order3(); // 3 combatants → a round is 3 advances
    expect(t.roundNumber).toBe(1);
    t.advance(); // 1st → 2nd actor
    t.advance(); // 2nd → 3rd actor
    expect(t.roundNumber).toBe(1); // still inside round 1
    t.advance(); // 3rd → wraps to 1st: round 2 begins
    expect(t.roundNumber).toBe(2);
    t.advance();
    t.advance();
    expect(t.roundNumber).toBe(2); // mid round 2
    t.advance(); // wraps again
    expect(t.roundNumber).toBe(3);
  });

  it('does NOT over-count a round when advance skips a run of dead actors past the wrap', () => {
    const t = order3();
    const order = t.combatOrder!.order;
    // Kill everyone except the actor at cursor 0; advancing from the last slot
    // must wrap exactly once even though it steps over dead actors to get back.
    // First move the cursor to the last slot.
    t.advance();
    t.advance();
    expect(t.roundNumber).toBe(1); // at the 3rd (last) actor, still round 1
    const survivor = order[0]!;
    const isAlive = (id: CharacterId): boolean => id === survivor;
    t.advance(isAlive); // wraps past two dead actors back to the survivor
    expect(t.activeActorId).toBe(survivor);
    expect(t.roundNumber).toBe(2); // exactly one increment, not three
  });

  it('endCombat resets the round counter to 0', () => {
    const t = order3();
    t.advance(); t.advance(); t.advance(); // round 2
    expect(t.roundNumber).toBe(2);
    t.endCombat();
    expect(t.roundNumber).toBe(0);
  });

  it('a fresh startCombat resets the round counter back to 1', () => {
    const t = order3();
    t.advance(); t.advance(); t.advance();
    expect(t.roundNumber).toBe(2);
    t.startCombat(new Dice('y'), [asCharacterId('a')], [asCharacterId('b')]);
    expect(t.roundNumber).toBe(1);
  });
});

describe('TurnTracker per-turn flags (1 move + 1 main action enforcement hooks)', () => {
  it('hasMoved/hasActed both start false', () => {
    const t = new TurnTracker();
    expect(t.hasMoved()).toBe(false);
    expect(t.hasActed()).toBe(false);
  });

  it('markMoved/markActed flip the flags', () => {
    const t = new TurnTracker();
    t.markMoved();
    expect(t.hasMoved()).toBe(true);
    expect(t.hasActed()).toBe(false);
    t.markActed();
    expect(t.hasActed()).toBe(true);
  });

  it('setNarrativeActor resets flags so the next narrative actor starts clean', () => {
    const t = new TurnTracker();
    t.setNarrativeActor(asCharacterId('h1'));
    t.markMoved();
    t.markActed();
    t.setNarrativeActor(asCharacterId('h2'));
    expect(t.hasMoved()).toBe(false);
    expect(t.hasActed()).toBe(false);
  });

  it('setNarrativeActor(null) also resets (DM regains control)', () => {
    const t = new TurnTracker();
    t.setNarrativeActor(asCharacterId('h1'));
    t.markMoved();
    t.setNarrativeActor(null);
    expect(t.hasMoved()).toBe(false);
  });

  it('startCombat clears stale narrative-phase flags', () => {
    const t = new TurnTracker();
    t.setNarrativeActor(asCharacterId('h1'));
    t.markMoved();
    t.markActed();
    t.startCombat(new Dice('x'), [asCharacterId('h1')], [asCharacterId('m1')]);
    expect(t.hasMoved()).toBe(false);
    expect(t.hasActed()).toBe(false);
  });

  it('advance resets flags so each combat actor gets a fresh turn', () => {
    const t = new TurnTracker();
    t.startCombat(new Dice('seed'), [asCharacterId('h1'), asCharacterId('h2')], [asCharacterId('m1')]);
    t.markMoved();
    t.markActed();
    t.advance();
    expect(t.hasMoved()).toBe(false);
    expect(t.hasActed()).toBe(false);
  });

  it('endCombat resets flags', () => {
    const t = new TurnTracker();
    t.startCombat(new Dice('x'), [asCharacterId('h1')], [asCharacterId('m1')]);
    t.markMoved();
    t.markActed();
    t.endCombat();
    expect(t.hasMoved()).toBe(false);
    expect(t.hasActed()).toBe(false);
  });
});
