// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Story mode vs combat mode UI split.
 *
 * - When NOT in combat (no `combat_started` seen yet, or `combat_ended` after
 *   the most recent `combat_started`), the board is hidden via the
 *   `data-mode="story"` attribute on `.app`, the turn-order bar is absent,
 *   and the only player control is the free-text Prompt input — no action
 *   buttons (Move/Attack/Special/End Turn).
 * - When in combat, `data-mode="combat"` is set, the board renders, and the
 *   action toolbar appears alongside the prompt input.
 */
describe('Layout story-mode vs combat-mode UI', () => {
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

  const advance = (ms: number) => {
    fakeNow += ms;
    vi.advanceTimersByTime(ms);
  };

  const seedSnapshot = (store: ReturnType<typeof createStore>) => {
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
  };

  it('starts in story mode: data-mode="story" and only the Prompt input + Skip button are offered', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    // Tests pre-date the manual-skip default: enable auto-skip so narration
    // beats drain on the original timed hold, matching what the assertions
    // below were written against.
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // DM opens with narration — no combat has started yet.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'You stand at the tavern door.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Drain the narration hold so the player slot can surface.
    advance(7500);

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-mode')).toBe('story');

    // Action buttons are HIDDEN in story mode — the player only has the
    // free-text Prompt input plus a Skip button to talk to the DM.
    expect(root.querySelector('.action-buttons')).toBeNull();
    expect(root.querySelector('.prompt-input')).not.toBeNull();
    expect(root.querySelector('.prompt-skip')).not.toBeNull();
  });

  it('Skip button in story mode dispatches a skip_turn action', () => {
    const store = createStore();
    const onAction = vi.fn();
    const handle = mountLayout(root, store, { onAction, onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The hearth crackles.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(7500);

    const skip = root.querySelector<HTMLButtonElement>('.prompt-skip');
    expect(skip).not.toBeNull();
    skip!.click();
    expect(onAction).toHaveBeenCalledWith({ kind: 'skip_turn' });
  });

  it('switches to combat mode on combat_started: data-mode="combat", action buttons appear', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

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
      event: { type: 'narrate', actorId: 'dm', text: 'A rat lunges.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    advance(7500);  // initiative panel hold
    advance(7500);  // narration hold

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-mode')).toBe('combat');
    expect(root.querySelector('.action-buttons')).not.toBeNull();
    expect(root.querySelector('.prompt-input')).not.toBeNull();
    // Skip pill only exists in story mode — combat's End Turn button
    // already covers the "skip my turn" role inside the action toolbar.
    expect(root.querySelector('.prompt-skip')).toBeNull();
  });

  it('returns to story mode on combat_ended: data-mode flips back, action buttons disappear', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // Enter combat.
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
    expect(store.getSnapshot().inCombat).toBe(true);

    // Exit combat — engine emits combat_ended after the last monster falls.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'combat_ended' } as never,
    });
    expect(store.getSnapshot().inCombat).toBe(false);

    // DM narrates the aftermath, then hands control back to the human.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The rat lies still.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Drain initiative + narration holds — same shape as the combat-mode
    // test, since combat_started ran first and queued the initiative beat
    // even though combat has since ended.
    advance(7500);
    advance(7500);

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-mode')).toBe('story');
    expect(root.querySelector('.action-buttons')).toBeNull();
    expect(root.querySelector('.prompt-input')).not.toBeNull();
  });
});
