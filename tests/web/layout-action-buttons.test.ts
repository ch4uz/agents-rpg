// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Regression: when a single short DM-narration beat lands and `input_required`
 * arrives within the queue's minimum-hold window, no further server events
 * follow until the human acts. The renderer must still re-render after the
 * hold expires so `queueDrained` flips true and the action buttons surface.
 *
 * Without the fix, the hold-render timer is only armed when the playback
 * queue has more items behind the current beat, so the action buttons never
 * appear and the player sits at "🎮 ...'s turn — awaiting your move" with no
 * way to act (the Prompt input is gated on the same `queueDrained` flag).
 */
describe('Layout action buttons surface after the queue-hold window', () => {
  let root: HTMLElement;
  let fakeNow: number;
  const realPerfNow = performance.now.bind(performance);

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 0;
    // Layout.ts reads `performance.now()` for queue timing — Vitest's default
    // toFake list does NOT include performance, so we drive it manually and
    // advance it in lockstep with vi.advanceTimersByTime.
    performance.now = () => fakeNow;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    performance.now = realPerfNow;
    vi.useRealTimers();
    root.remove();
  });

  const advance = (ms: number) => {
    fakeNow += ms;
    vi.advanceTimersByTime(ms);
  };

  it('renders .action-buttons once the narration hold expires, even when no further events arrive', () => {
    const store = createStore();
    const onAction = vi.fn();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction, onSubmit });
    // Narration / hero-speech beats now default to manual-skip — they wait
    // for a click on the in-narrator "▶ Skip" button. This test pre-dates
    // that change and asserts auto-advance timing, so enable auto-skip up
    // front to keep the original intent.
    handle.setAutoSkip(true);

    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 } as never,
        characters: [
          {
            id: 'h1' as never,
            name: 'Bran',
            kind: 'hero',
            archetype: 'warrior',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
            inventory: [],
            boons: [],
            specialAction: { name: 'Whirlwind', description: '' },
            bonusAbility:  { name: 'Teamwork',  description: '' },
          },
        ],
        activeActor: 'h1' as never,
        recentChat: [],
      } as never,
    } as never);

    // Combat starts (initiative is rolled), then the DM narrates a single
    // short line, then the orchestrator hands the turn to the human and
    // emits input_required — the realistic ordering when the human is up
    // next in combat and the LLM reply is fast. The combat_started event is
    // required for action buttons to surface; outside combat (story mode)
    // the UI offers only the free-text Prompt input.
    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started',
        heroSide: ['h1'],
        monsterSide: [],
        order: ['h1'],
        rolls: { hero: { h1: { d6: 4, dex: 1, total: 5 } }, monster: {} },
      } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'You step into the basement.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Right after input_required arrives the buttons are still gated by the
    // narration hold — that's expected.
    expect(root.querySelector('.action-buttons')).toBeNull();

    // Advance past the initiative panel hold, then the narration hold. The
    // combat_started event ingests an `initiative` queue beat
    // (INITIATIVE_PANEL_MS = 4500) ahead of the narration beat (~3600ms for
    // a ~27-char line under TYPEWRITER_CHAR_MS=22 + POST_REVEAL_HOLD_MS=3000).
    // We advance in two steps because the queue promotion logic compares
    // `performance.now()` to the item's `shownAt`, and we drive both timers
    // and the clock together each step. No server events fire in this
    // window — the human hasn't done anything.
    advance(5000);
    advance(5000);

    // The action buttons MUST be visible now. Without the fix, no timer was
    // scheduled when the queue drained, so renderOnce never reruns and this
    // assertion fails — matching the "sometimes hangs in awaiting your move"
    // bug report.
    const buttons = root.querySelector('.action-buttons');
    expect(buttons).not.toBeNull();
    expect(buttons!.querySelectorAll('.act-btn').length).toBeGreaterThan(0);
  });
});
