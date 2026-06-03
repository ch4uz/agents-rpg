// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import { INITIATIVE_PANEL_MS } from '../../web/components/InitiativePanel.js';

/**
 * Regression: between `turn_ended(A)` and `turn_started(B)` the store clears
 * `activeActor` to null. The turn-order tape's `selectTurnOrder` falls back
 * to `cursorIdx = 0` when activeActor is null — so the cursor would visibly
 * snap *backwards* to the head of the order, then forward to slot B's
 * position once `turn_started` arrived. Players see this as the bar
 * "glitching backwards then forwards very fast" between every two combatant
 * turns.
 *
 * Layout.ts now keeps a sticky `lastCombatActor` and feeds it to
 * `selectTurnOrder` whenever the store reports null. This test pins the
 * fixed behavior: after `turn_ended` lands, the tape's `--turn-cursor`
 * inline style must still reflect the just-ended actor's slot.
 */
describe('turn-order bar — sticky cursor across turn_ended', () => {
  let root: HTMLElement;
  let fakeNow: number;
  const realPerfNow = performance.now.bind(performance);

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 0;
    performance.now = () => fakeNow;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    performance.now = realPerfNow;
    vi.useRealTimers();
    root.remove();
  });

  // Advance in small chunks so each scheduled timer fires with a
  // `performance.now()` value close to its real scheduled time, rather than
  // the END of one big advance window. Multi-step queue transitions
  // (narration hold → initiative hold → next-item displacement) only work
  // when each renderOnce sees a plausible `now`.
  const advance = (ms: number) => {
    const STEP = 100;
    let remaining = ms;
    while (remaining > 0) {
      const slice = Math.min(STEP, remaining);
      fakeNow += slice;
      vi.advanceTimersByTime(slice);
      remaining -= slice;
    }
  };

  /** Read the `--turn-cursor` value inlined on `.turn-order-track`.
   *  Returns null when the bar isn't mounted. */
  const readCursor = (): number | null => {
    const track = root.querySelector('.turn-order-track');
    if (!(track instanceof HTMLElement)) return null;
    const style = track.getAttribute('style') ?? '';
    const m = style.match(/--turn-cursor:\s*(-?\d+)/);
    return m ? Number(m[1]) : null;
  };

  it('holds the cursor on the last active slot when activeActor goes null', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    // Narration beats now require a Skip click by default; this test asserts
    // auto-advance timing so opt back into the original behavior.
    handle.setAutoSkip(true);

    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 's', assetId: 's', gridW: 5, gridH: 5 } as never,
        characters: [
          {
            id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
            inventory: [], boons: [],
            specialAction: { name: '', description: '' },
            bonusAbility:  { name: '', description: '' },
          },
          {
            id: 'r1' as never, name: 'giant-rat', kind: 'monster', sprite: 'giant-rat',
            pos: { x: 1, y: 0 },
            health: { total: 1, damage: 0, status: 'normal' },
            pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
            inventory: [], boons: [],
            specialAction: { name: '', description: '' },
            bonusAbility:  { name: '', description: '' },
          },
        ],
        activeActor: null,
        recentChat: [],
      } as never,
    } as never);

    // Open the scene with a DM narration so the "game loaded" gate flips,
    // then start combat (initiative panel is enqueued).
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Combat begins.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started',
        heroSide: ['h1'],
        monsterSide: ['r1'],
        order: ['h1', 'r1'],
        rolls: {
          hero:    { h1: { d6: 5, dex: 0, total: 5 } },
          monster: { r1: { d6: 3, dex: 0, total: 3 } },
        },
        t: 1,
      } as never,
    });
    // First combatant claims the turn. Bar is still hidden behind the
    // initiative panel that's pending in the queue.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    expect(readCursor()).toBeNull();

    // Step past the narration hold (7000ms) AND the initiative hold
    // (INITIATIVE_PANEL_MS = 7000ms). After this, `currentDisplay` is still
    // the initiative panel because the queue has no follow-up to displace it
    // — `initiativePending` therefore stays true and the bar is still
    // hidden. A second narration event displaces it so the bar can mount.
    advance(7000 + INITIATIVE_PANEL_MS + 100);
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The rat scuttles forward.' } as never,
    });

    // Now the bar is up, with h1 marked active at slot 0.
    expect(readCursor()).toBe(0);

    // h1 finishes — `activeActor` goes null. Without the sticky-cursor fix,
    // the cursor would snap to slot 0 here (which happens to be h1's slot
    // already, so we can't distinguish — the critical case comes next).
    store.applyEnvelope({ kind: 'turn_ended', actorId: 'h1' as never });
    expect(readCursor()).toBe(0);

    // r1 takes the next turn — cursor advances to slot 1.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'r1' as never });
    expect(readCursor()).toBe(1);

    // CRITICAL: r1 finishes and `activeActor` is cleared. Without the fix,
    // `selectTurnOrder`'s fallback would push `--turn-cursor` back to 0 —
    // the "backwards snap" the player sees. With the fix, `lastCombatActor`
    // holds the cursor on slot 1 until the next `turn_started`.
    store.applyEnvelope({ kind: 'turn_ended', actorId: 'r1' as never });
    expect(readCursor()).toBe(1);
  });

  it('holds the cursor on a combatant whose move sprite is still animating', () => {
    // r1 finishes its turn (engine reports `turn_ended`, then `turn_started`
    // for h1 a moment later) but its sprite is still sliding on the board.
    // Board.ts pushes the still-animating set into Layout via
    // `setMovingActors`; the bar's cursor must stay on r1 until that set
    // empties, even though the WS layer has already moved on to h1.
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    // See first test in this file — manual-skip is the new default; opt
    // back into auto-advance so the existing timing assertions hold.
    handle.setAutoSkip(true);

    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 's', assetId: 's', gridW: 5, gridH: 5 } as never,
        characters: [
          {
            id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
            inventory: [], boons: [],
            specialAction: { name: '', description: '' },
            bonusAbility:  { name: '', description: '' },
          },
          {
            id: 'r1' as never, name: 'giant-rat', kind: 'monster', sprite: 'giant-rat',
            pos: { x: 1, y: 0 },
            health: { total: 1, damage: 0, status: 'normal' },
            pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
            inventory: [], boons: [],
            specialAction: { name: '', description: '' },
            bonusAbility:  { name: '', description: '' },
          },
        ],
        activeActor: null,
        recentChat: [],
      } as never,
    } as never);
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Combat begins.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started',
        heroSide: ['h1'], monsterSide: ['r1'],
        order: ['h1', 'r1'],
        rolls: {
          hero:    { h1: { d6: 5, dex: 0, total: 5 } },
          monster: { r1: { d6: 3, dex: 0, total: 3 } },
        },
        t: 1,
      } as never,
    });
    // Drain the narration + initiative panel so the regular turn-order bar
    // is mounted.
    advance(7000 + INITIATIVE_PANEL_MS + 100);
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The fight begins.' } as never,
    });
    // r1 takes its turn (cursor 1), then `turn_ended` fires. r1's sprite is
    // still sliding so Board reports it as a moving actor.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'r1' as never });
    handle.setMovingActors(new Set(['r1']));
    expect(readCursor()).toBe(1);

    store.applyEnvelope({ kind: 'turn_ended', actorId: 'r1' as never });
    expect(readCursor()).toBe(1);

    // h1's `turn_started` arrives WHILE r1 is still mid-move. Without the
    // movingActors gate, the cursor would jump to 0 immediately; with the
    // gate, it holds on r1's slot until Board reports the animation done.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    expect(readCursor()).toBe(1);

    // r1's sprite lands; Board fires the change. The cursor finally moves
    // to h1's slot.
    handle.setMovingActors(new Set());
    expect(readCursor()).toBe(0);
  });
});
