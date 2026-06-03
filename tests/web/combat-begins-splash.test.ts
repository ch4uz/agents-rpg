// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import {
  COMBAT_BEGINS_SPLASH_MS,
  COMBAT_BEGINS_DISPATCH_AT_MS,
} from '../../web/components/CombatBeginsSplash.js';
import { resetRollMountRegistry } from '../../web/components/roll-events.js';

/**
 * Pins the lifecycle of the "To Arms!" combat-begins splash:
 *
 *   1. Splash mounts the moment the initiative queue item promotes
 *      (engine has emitted `combat_started`, prior narration hold expired).
 *   2. The dice physics dispatch (`onDiceRoll`) fires partway through the
 *      splash lifetime — at `COMBAT_BEGINS_DISPATCH_AT_MS` — so the dice
 *      canvas fade-in starts UNDER the still-mounted splash. No visual
 *      gap between "combat declared" and "dice on screen".
 *   3. The splash unmounts at `COMBAT_BEGINS_SPLASH_MS`, by which point
 *      the dice canvas is fully visible and dice are rolling.
 *
 * This is the entrypoint of the initiative pipeline — the existing
 * `layout-initiative-clears` test covers the downstream phases (reveal
 * bar, resolve → turn-order bar takeover).
 */
describe('Layout — combat-begins splash sits between combat_started and dice dispatch', () => {
  let root: HTMLElement;
  let fakeNow: number;
  const realPerfNow = performance.now.bind(performance);

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 0;
    performance.now = () => fakeNow;
    root = document.createElement('div');
    document.body.appendChild(root);
    resetRollMountRegistry();
  });

  afterEach(() => {
    performance.now = realPerfNow;
    vi.useRealTimers();
    root.remove();
    resetRollMountRegistry();
  });

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

  it('keeps the splash mounted through the dice canvas fade-in, then unmounts it', () => {
    const store = createStore();
    let diceCalls = 0;
    const onDiceRoll = (): Promise<void> => {
      diceCalls += 1;
      // Keep pending — we only care about whether/when dispatch fires.
      return new Promise<void>(() => { /* never resolves in this test */ });
    };
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onDiceRoll: onDiceRoll as never });
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
            id: 'h1' as never, name: 'Kael', kind: 'hero', archetype: 'warrior',
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

    // Opening narration flips the "game loaded" gate. Keep it short so we
    // don't have to wait through a huge typewriter hold to reach the
    // initiative item.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Go.' } as never,
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
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });

    // No splash before the narration hold expires.
    expect(root.querySelector('.combat-begins')).toBeNull();
    expect(diceCalls).toBe(0);

    // Narration "Go." = 3 chars × 22ms + POST_REVEAL_HOLD_MS (3000) ≈ 3066ms.
    advance(3200);
    // The initiative item promoted → splash mounts → dice dispatch NOT yet
    // (the splash pop animation is still playing).
    expect(root.querySelector('.combat-begins')).not.toBeNull();
    expect(diceCalls).toBe(0);
    expect(root.querySelector('.combat-begins-title')?.textContent?.trim()).toBe('To Arms!');
    expect(root.querySelector('.combat-begins-sub')?.textContent?.trim()).toBe('Roll for Initiative');

    // Dice dispatch fires partway through the splash lifetime (at
    // COMBAT_BEGINS_DISPATCH_AT_MS). Splash remains mounted — it now sits
    // ABOVE the fading-in dice canvas so the player sees a continuous beat
    // instead of a blank handoff.
    advance(COMBAT_BEGINS_DISPATCH_AT_MS + 100);
    expect(diceCalls).toBe(1);
    expect(root.querySelector('.combat-begins')).not.toBeNull();

    // Splash stays up through the canvas fade-in window. Up until just
    // before SPLASH_MS, the splash is still rendered.
    advance(COMBAT_BEGINS_SPLASH_MS - COMBAT_BEGINS_DISPATCH_AT_MS - 300);
    expect(root.querySelector('.combat-begins')).not.toBeNull();
    expect(diceCalls).toBe(1);  // not re-dispatched

    // Once SPLASH_MS elapses, the splash unmounts. Dice are visible
    // underneath at this point (no extra dispatch).
    advance(400);
    expect(root.querySelector('.combat-begins')).toBeNull();
    expect(diceCalls).toBe(1);
  });
});
