// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * End-of-game "The End" step.
 *
 * When the adventure ends — the server's `end` envelope, which fires after the
 * last scene's `all-monsters-ko → END` transition (the king rat dies) — the
 * board hides and the narrator gets the last word:
 *   - `.app` gains a `data-ended="<outcome>"` attribute (CSS fades the board
 *     canvas to opacity 0 and hides the turn-order ribbon).
 *   - an `.ending-banner` ("Victory!" + "The End") mounts where the board was.
 *   - the narrator window is dropped, so no leftover DM narration or hero/NPC
 *     speech text sits beneath the banner — the closing screen is the banner
 *     alone.
 */
describe('Layout end-of-game ending step', () => {
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
        scene: { id: 'rat-tunnel', assetId: 'rat-tunnel', gridW: 15, gridH: 11 } as never,
        characters: [
          {
            id: 'h1' as never,
            name: 'Bran',
            kind: 'hero',
            archetype: 'warrior',
            pos: { x: 0, y: 5 },
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

  const CONCLUSION =
    'With a final strike the King Rat topples, his crooked crown rolling into the dirt.';

  it('shows no ending banner mid-run', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The cave is dark and cold.' } as never,
    });
    advance(7500);

    const app = root.querySelector('.app')!;
    expect(app.hasAttribute('data-ended')).toBe(false);
    expect(root.querySelector('.ending-banner')).toBeNull();
    // The narrator window is present mid-run.
    expect(root.querySelector('.narrator-window')).not.toBeNull();
  });

  it('on the `end` envelope: marks data-ended, mounts the banner, hides all hero/narrator text', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // King rat + pack fall → combat auto-ends → DM reads the scene CONCLUSION.
    store.applyEnvelope({ kind: 'event', event: { type: 'combat_ended' } as never });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: CONCLUSION } as never,
    });
    advance(7500);

    // Before the end envelope, the conclusion is on the narrator window.
    expect(root.querySelector('.narrator-text')?.textContent).toContain('King Rat topples');

    // The DM then calls end_adventure('success') → server ships `end`, the
    // VICTORY UI shows up.
    store.applyEnvelope({ kind: 'end', outcome: 'success' });
    advance(7500);

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-ended')).toBe('success');

    const banner = root.querySelector('.ending-banner');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('data-outcome')).toBe('success');
    expect(root.querySelector('.ending-title')?.textContent).toBe('Victory!');

    // Once the VICTORY UI is up, ALL hero/narrator text is hidden — the
    // narrator window (DM narration + hero/NPC speech feed + player echo) is
    // dropped entirely, so the banner is the whole closing screen.
    expect(root.querySelector('.narrator-window')).toBeNull();
    expect(root.querySelector('.narrator-text')).toBeNull();
    expect(root.querySelector('.hero-speech-feed')).toBeNull();
    expect(root.querySelector('.player-echo')).toBeNull();

    // No player input is offered once the run has ended.
    expect(store.getSnapshot().inputUnlocked).toBe(false);
    expect(root.querySelector('.action-buttons')).toBeNull();
  });

  it('hides the player prompt as soon as the adventure ends — before the end envelope and under the Victory UI', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // Mid-run: the DM has narrated, so the always-visible prompt is offered.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The cave falls silent.' } as never,
    });
    advance(7500);
    expect(root.querySelector('.prompt-input'), 'prompt offered mid-run').not.toBeNull();

    // The engine emits `adventure_ended` BEFORE the server's `end` envelope.
    // The prompt must already be gone — the Victory UI is imminent.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'adventure_ended', outcome: 'success' } as never,
    });
    advance(100);
    expect(store.getSnapshot().ended, 'end envelope not sent yet').toBeUndefined();
    expect(root.querySelector('.prompt-input'), 'prompt hidden once the adventure ends').toBeNull();
    expect(root.querySelector('.prompt-target-radios')).toBeNull();

    // And it stays hidden once the banner (Victory UI) is up.
    store.applyEnvelope({ kind: 'end', outcome: 'success' });
    advance(100);
    expect(root.querySelector('.ending-banner')).not.toBeNull();
    expect(root.querySelector('.prompt-input')).toBeNull();
  });

  it('renders a muted title for a failure outcome', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    store.applyEnvelope({ kind: 'end', outcome: 'failure' });
    advance(100);

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-ended')).toBe('failure');
    expect(root.querySelector('.ending-banner')?.getAttribute('data-outcome')).toBe('failure');
    expect(root.querySelector('.ending-title')?.textContent).toBe('The Heroes Fall');
    // A plain failure (no reason) is NOT a party wipe — the game-over screen
    // is reserved for the every-hero-KO'd case.
    expect(root.querySelector('.game-over')).toBeNull();
  });

  it('on a party-wipe failure: shows the dedicated GAME OVER screen naming the fallen', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);  // party of one: Bran

    // Every hero KO'd → orchestrator emits adventure_ended(failure, party_wipe)
    // → server ships `end` with the reason → the game-over screen takes over.
    store.applyEnvelope({ kind: 'end', outcome: 'failure', reason: 'party_wipe' });
    advance(100);

    const app = root.querySelector('.app')!;
    expect(app.getAttribute('data-ended')).toBe('failure');

    // The punchy GAME OVER screen replaces the gentle ending banner.
    expect(root.querySelector('.game-over')).not.toBeNull();
    expect(root.querySelector('.ending-banner')).toBeNull();
    expect(root.querySelector('.game-over-title')?.textContent).toBe('Game Over');
    // The fallen hero is named on the tombstone roll.
    const fallen = Array.from(root.querySelectorAll('.game-over-fallen-name')).map(
      (el) => el.textContent,
    );
    expect(fallen).toEqual(['Bran']);

    // Closing screen: the narrator window + player prompt are dropped, as with
    // the victory banner.
    expect(root.querySelector('.narrator-window')).toBeNull();
    expect(root.querySelector('.prompt-input')).toBeNull();
    expect(store.getSnapshot().inputUnlocked).toBe(false);
  });
});
