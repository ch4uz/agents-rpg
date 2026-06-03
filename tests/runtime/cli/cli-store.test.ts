/**
 * CliStore.ingest — the request_action regression.
 *
 * The orchestrator's actual turn dispatch (in combat phase) is driven by the
 * turn-tracker's cursor, NOT by the engine's narrativeActor. A DM that emits
 * `request_action(human_hunter)` during runDmReact sets narrativeActor (no-op
 * in combat) and emits a `request_action` event. If cli-store mirrors that
 * into `activeActor`, the UI says "Turn: Hunter" even though the orchestrator
 * is actually about to dispatch the next AI player's turn (cursor != human).
 * The user sees activeActor=human + inputUnlocked=false (because requestInput
 * hasn't been called) and is stuck on "Waiting for the active turn…".
 *
 * Fix: activeActor must only change via setActive() (called by the orchestrator
 * via subscriber.onTurnStarted/onTurnEnded). request_action event ingest must
 * NOT mutate activeActor.
 */
import { describe, it, expect } from 'vitest';
import { CliStore } from '../../../src/runtime/cli/cli-store.js';
import { actorDisplay } from '../../../src/runtime/cli/glyphs.js';
import { asCharacterId } from '../../../src/engine/ids.js';
import type { Event } from '../../../src/log/events.js';

const displayFor = (id: 'dm' | ReturnType<typeof asCharacterId>) =>
  id === 'dm' ? actorDisplay({ id: 'dm', kind: 'dm' })
    : actorDisplay({ id: String(id), kind: 'hero', archetype: 'hunter', name: String(id) });

describe('CliStore.ingest — request_action does NOT mutate activeActor', () => {
  it('keeps activeActor unchanged when ingesting a request_action event', () => {
    const store = new CliStore();
    // Simulate: a real turn handler set p2_warlock as the active actor (via setActive
    // from onTurnStarted). The cursor is on p2_warlock; combat is in progress.
    store.setActive(asCharacterId('p2_warlock'));
    expect(store.getSnapshot().activeActor).toBe(asCharacterId('p2_warlock'));

    // The DM (during react after p2's turn) emits request_action(human_hunter).
    // The engine's turn cursor doesn't move — it's still p2_warlock's slot post-turn,
    // about to advance to the next combat slot (a monster, then human after that).
    // The cli-store must NOT update activeActor on this event.
    const ev: Event = {
      t: 99, type: 'request_action', actorId: 'dm', targetId: asCharacterId('human_hunter'),
    };
    store.ingest(ev, displayFor);

    expect(store.getSnapshot().activeActor).toBe(asCharacterId('p2_warlock'));
  });

  it('activeActor is the source of truth from setActive — request_action events do not override', () => {
    const store = new CliStore();
    store.setActive(asCharacterId('p1_warrior'));
    // Several request_action events fire (DM react, DM full turn, etc.) — none should
    // affect activeActor.
    for (const targetId of ['human_hunter', 'p2_warlock', 'human_hunter']) {
      store.ingest(
        { t: 0, type: 'request_action', actorId: 'dm', targetId: asCharacterId(targetId) } as Event,
        displayFor,
      );
    }
    expect(store.getSnapshot().activeActor).toBe(asCharacterId('p1_warrior'));

    // Only setActive (from onTurnStarted) changes it.
    store.setActive(asCharacterId('human_hunter'));
    expect(store.getSnapshot().activeActor).toBe(asCharacterId('human_hunter'));
  });
});

describe('CliStore.ingest — resolution events render with 🎲 prefix and formatted text (not JSON)', () => {
  it('normal_attack hit: caps text + green bold HIT segment, dim metadata', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'resolution',
        actorId: asCharacterId('p1_warrior'),
        public: { hit: true, damage: 1, attackerTop: 5, defenderTop: 4 },
        t: 10,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat.length).toBe(1);
    expect(chat[0]!.text).toBe('🎲 HIT! 1 damage (attack 5 vs armor 4)');
    expect(chat[0]!.text).not.toMatch(/[{}]/);
    expect(chat[0]!.segments).toEqual([
      { text: '🎲 ', dim: true },
      { text: 'HIT!', color: 'greenBright', bold: true },
      { text: ' 1 damage (attack 5 vs armor 4)', dim: true },
    ]);
  });

  it('normal_attack miss: caps text + red bold MISS segment, dim metadata', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'resolution',
        actorId: asCharacterId('p2_warlock'),
        public: { hit: false, damage: 0, attackerTop: 3, defenderTop: 6 },
        t: 11,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat[0]!.text).toBe('🎲 MISS (attack 3 vs armor 6)');
    expect(chat[0]!.segments).toEqual([
      { text: '🎲 ', dim: true },
      { text: 'MISS', color: 'redBright', bold: true },
      { text: ' (attack 3 vs armor 6)', dim: true },
    ]);
  });

  it('ability_test success: caps text + green bold SUCCESS segment', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'resolution',
        actorId: asCharacterId('p1_warrior'),
        public: { success: true, top: 5, difficulty: 4 },
        t: 12,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat[0]!.text).toBe('🎲 SUCCESS (rolled 5 vs DC 4)');
    expect(chat[0]!.segments).toEqual([
      { text: '🎲 ', dim: true },
      { text: 'SUCCESS', color: 'greenBright', bold: true },
      { text: ' (rolled 5 vs DC 4)', dim: true },
    ]);
  });

  it('ability_test fail: caps text + red bold FAILED segment', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'resolution',
        actorId: asCharacterId('p1_warrior'),
        public: { success: false, top: 2, difficulty: 4 },
        t: 13,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat[0]!.text).toBe('🎲 FAILED (rolled 2 vs DC 4)');
    expect(chat[0]!.segments).toEqual([
      { text: '🎲 ', dim: true },
      { text: 'FAILED', color: 'redBright', bold: true },
      { text: ' (rolled 2 vs DC 4)', dim: true },
    ]);
  });

  it('special_action narration: leaves segments undefined (no outcome word to colour)', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'resolution',
        actorId: asCharacterId('p2_warlock'),
        public: { narration: 'flame ripples outward' },
        t: 14,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat[0]!.text).toBe('🎲 flame ripples outward');
    expect(chat[0]!.segments).toBeUndefined();
  });
});

describe('CliStore.ingest — end_turn is suppressed from the chat log', () => {
  it('does NOT append a chat entry for an end_turn action event', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'action',
        actorId: asCharacterId('p1_warrior'),
        action: { kind: 'end_turn' },
        t: 20,
      } as Event,
      displayFor,
    );
    expect(store.getSnapshot().chat).toEqual([]);
  });

  it('still renders a real action (move) before an end_turn that fires next', () => {
    const store = new CliStore();
    store.ingest(
      {
        type: 'action',
        actorId: asCharacterId('p1_warrior'),
        action: { kind: 'move', path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        t: 21,
      } as Event,
      displayFor,
    );
    store.ingest(
      {
        type: 'action',
        actorId: asCharacterId('p1_warrior'),
        action: { kind: 'end_turn' },
        t: 22,
      } as Event,
      displayFor,
    );
    const chat = store.getSnapshot().chat;
    expect(chat).toHaveLength(1);
    expect(chat[0]!.text).toBe('→ move');
  });
});
