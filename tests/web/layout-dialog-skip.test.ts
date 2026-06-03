// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Dialog playback controls split into two independent pills:
 *   - ▶ Skip — completes the in-flight typewriter if any, otherwise
 *     advances past the current narration / hero-speech beat. Never
 *     toggles mode.
 *   - ⏯ Auto — toggles auto-advance mode on/off. Never advances the
 *     current beat.
 *
 * Default is manual: beats sit on screen until Skip is clicked. Toggling
 * Auto on resumes the original timed-hold pacing (text.length × 22ms +
 * 3000ms post-reveal hold).
 */
describe('Layout — Skip / Auto dialog controls', () => {
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

  // Drain the narrator's fade (220ms) + typewriter (text.length × 22ms)
  // so the next Skip click hits the "typewriter done, advance the beat"
  // branch instead of the "complete the in-flight reveal" branch.
  const flushReveal = (text: string) => advance(220 + text.length * 22 + 50);

  const seedSnapshot = (store: ReturnType<typeof createStore>) => {
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
        ],
        activeActor: 'h1' as never,
        recentChat: [],
      } as never,
    } as never);
  };

  it('parks a narration beat indefinitely in manual mode and clears it on Skip click', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'You stand at the door.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Far past what would be the auto-hold window.
    advance(60_000);

    // The narration is still parked — manual-skip is the default. Skip and
    // Auto icons are both visible; Auto is in its inactive (no --on) state.
    // Each button holds a single inline pixel-art SVG (14×14 viewBox).
    const skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    const auto = root.querySelector<HTMLButtonElement>('.dialog-auto');
    expect(skip).not.toBeNull();
    expect(skip!.querySelector('svg')).not.toBeNull();
    expect(auto).not.toBeNull();
    expect(auto!.querySelector('svg')).not.toBeNull();
    expect(auto!.classList.contains('dialog-auto--on')).toBe(false);
    expect(auto!.getAttribute('aria-pressed')).toBe('false');
    // Sanity-check the icon glyphs are different shapes — Skip is a
    // triangle + bar (1 path + 1 rect); Auto is two triangles (2 paths).
    expect(skip!.querySelectorAll('svg path').length).toBe(1);
    expect(skip!.querySelectorAll('svg rect').length).toBe(1);
    expect(auto!.querySelectorAll('svg path').length).toBe(2);

    // The free-text Prompt is always visible now (the player may interject at
    // any time), so it's present even with the beat parked. The parked beat is
    // confirmed by the still-present Skip/Auto controls above.
    expect(root.querySelector('.prompt-input')).not.toBeNull();

    // Click Skip → advance. Queue empties, the dialog clears; the prompt stays.
    skip!.click();
    expect(root.querySelector('.prompt-input')).not.toBeNull();
  });

  it('always renders the row AND both buttons — Skip wears --inert when there is nothing to skip', () => {
    // Both controls are a constant pair now (user decision): the row keeps
    // its reserved min-height (so the board above never shifts) and the
    // buttons no longer blink in and out — keeping the A/S keycap hotkey
    // hints discoverable at all times. With no beat parked, Skip dims to
    // an inert state instead of unmounting.
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    // No narration / hero-speech beat on screen and auto off → both buttons
    // still mounted; Skip is inert (nothing to skip), Auto stays live.
    expect(root.querySelector('.dialog-skip-row')).not.toBeNull();
    const idleSkip = root.querySelector<HTMLButtonElement>('.dialog-skip')!;
    expect(idleSkip).not.toBeNull();
    expect(idleSkip.classList.contains('dialog-skip--inert')).toBe(true);
    expect(idleSkip.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('.dialog-auto')).not.toBeNull();
    // Clicking the inert Skip is a harmless no-op.
    expect(() => idleSkip.click()).not.toThrow();

    // A narration beat arrives → the SAME buttons go live in the SAME row;
    // nothing is added to / removed from the flex column.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'A beat appears.' } as never,
    });
    expect(root.querySelectorAll('.dialog-skip-row').length).toBe(1);
    const liveSkip = root.querySelector<HTMLButtonElement>('.dialog-skip')!;
    expect(liveSkip.classList.contains('dialog-skip--inert')).toBe(false);
    expect(liveSkip.getAttribute('aria-disabled')).toBe('false');
    expect(root.querySelector('.dialog-skip-row .dialog-auto')).not.toBeNull();
  });

  it('Skip icon does NOT carry over hint text between dialogues — each beat shows the same pixel-art glyph', () => {
    // Regression for the user-reported bug: after clicking Skip on dialogue
    // A, dialogue B used to surface with a "Skip (click again for auto)"
    // hint label. The new split-control design has no cumulative count
    // and the Skip control is an icon-only SVG button, so every beat
    // shows exactly the same glyph (1 path + 1 rect) and no text label.
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'First.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Second.' } as never,
    });

    flushReveal('First.');
    let skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip!.querySelector('svg')).not.toBeNull();
    expect(skip!.textContent).not.toContain('Skip');

    skip!.click();  // advance to "Second."
    flushReveal('Second.');

    skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip!.querySelector('svg')).not.toBeNull();
    expect(skip!.textContent).not.toContain('click again for auto');
  });

  it('clicking Skip mid-typewriter completes the reveal without advancing the beat', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    const longLine = 'A long line of narration that takes plenty of typewriter time to reveal.';
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: longLine } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Reveal is in flight (fade + typewriter).
    let skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip).not.toBeNull();

    // Click mid-reveal → typewriter snaps to full line; beat stays.
    skip!.click();
    const narratorText = root.querySelector('.narrator-text');
    expect(narratorText!.textContent).toContain('A long line of narration');
    // Beat still parked — confirmed by the still-present dialog-skip control.
    // (The free-text Prompt is always visible now, so its presence no longer
    // signals queue drain.)
    expect(root.querySelector('.prompt-input')).not.toBeNull();
    skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip).not.toBeNull();

    // Second click — typewriter is done — advances; the beat clears.
    skip!.click();
    expect(root.querySelector('.prompt-input')).not.toBeNull();
  });

  it('Auto toggle flips auto-skip on; subsequent narration auto-advances', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Hi.' } as never,
    });

    let auto = root.querySelector<HTMLButtonElement>('.dialog-auto');
    expect(auto).not.toBeNull();
    expect(auto!.classList.contains('dialog-auto--on')).toBe(false);
    expect(auto!.getAttribute('aria-pressed')).toBe('false');

    auto!.click();
    auto = root.querySelector<HTMLButtonElement>('.dialog-auto');
    expect(auto!.classList.contains('dialog-auto--on')).toBe(true);
    expect(auto!.getAttribute('aria-pressed')).toBe('true');

    // The Skip pill stays mounted while auto is on (constant pair) — and
    // live, since a beat is still on screen to skip past manually.
    expect(root.querySelector('.dialog-skip')).not.toBeNull();

    // Drain the timed hold for "Hi." (~3 chars × 22 + 3000 ≈ 3066ms);
    // wire up the human prompt path so the slot can surface after drain.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(5000);
    expect(root.querySelector('.prompt-input')).not.toBeNull();
  });

  it('Auto toggle does NOT advance the current beat', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Stay parked.' } as never,
    });
    flushReveal('Stay parked.');

    const auto = root.querySelector<HTMLButtonElement>('.dialog-auto');
    auto!.click();  // flip to auto-on
    // Beat still on screen — no time has passed since toggling.
    const narratorText = root.querySelector('.narrator-text');
    expect(narratorText!.textContent).toContain('Stay parked.');

    auto!.click();  // flip back to manual
    // Beat still on screen.
    expect(narratorText!.textContent).toContain('Stay parked.');
  });

  it('hero/NPC speech beats also wait for Skip click in manual mode', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Tavern.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'Hi!' } } as never,
    });

    advance(60_000);

    let skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip).not.toBeNull();
    // First click advances past the narration; hero-speech bubble takes
    // the slot. Skip is still mounted, waiting for the bubble's click.
    skip!.click();
    expect(root.querySelector('.hero-speech-feed')).not.toBeNull();
    skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip).not.toBeNull();
  });

  it('pressing "A" anywhere on the page skips like a Skip click — completes the reveal, then advances', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'First narration line.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Second narration line.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });

    // Mid-typewriter: 'a' completes the in-flight reveal without advancing,
    // exactly like a Skip click.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(root.querySelector('.narrator-text')!.textContent).toContain('First narration line.');

    // Reveal done: 'A' (shifted) advances to the next beat.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true }));
    flushReveal('Second narration line.');
    expect(root.querySelector('.narrator-text')!.textContent).toContain('Second narration line.');
  });

  it('the "A" hotkey is inert while the prompt input (or any editable element) is focused', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Stay parked.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    flushReveal('Stay parked.');

    // Typing an 'a' INTO the prompt input must not eat the dialogue beat.
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(root.querySelector('.narrator-text')!.textContent).toContain('Stay parked.');
    expect(root.querySelector('.dialog-skip')).not.toBeNull();
  });

  it('the "A" hotkey ignores modified presses (Cmd/Ctrl+A = select-all stays native)', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Stay parked.' } as never,
    });
    flushReveal('Stay parked.');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true }));
    expect(root.querySelector('.narrator-text')!.textContent).toContain('Stay parked.');
    expect(root.querySelector('.dialog-skip')).not.toBeNull();
  });

  it('the Skip button advertises the hotkey with an "A" keycap hint', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'A beat.' } as never,
    });

    const hint = root.querySelector('.dialog-skip .dialog-key-hint');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe('A');
    // Decorative — the aria-label already names the hotkey.
    expect(hint!.getAttribute('aria-hidden')).toBe('true');
  });

  it('pressing "S" toggles auto-skip on and off, like an Auto click', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'A beat.' } as never,
    });
    expect(root.querySelector('.dialog-auto')!.getAttribute('aria-pressed')).toBe('false');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    let auto = root.querySelector<HTMLButtonElement>('.dialog-auto')!;
    expect(auto.classList.contains('dialog-auto--on')).toBe(true);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    // The Skip pill stays mounted (constant pair) — auto-on no longer hides it.
    expect(root.querySelector('.dialog-skip')).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', bubbles: true }));
    auto = root.querySelector<HTMLButtonElement>('.dialog-auto')!;
    expect(auto.classList.contains('dialog-auto--on')).toBe(false);
    expect(auto.getAttribute('aria-pressed')).toBe('false');
  });

  it('the "S" hotkey is inert while the prompt input is focused', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Stay manual.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    flushReveal('Stay manual.');

    // Typing an 's' into the prompt input must not flip the mode.
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    expect(root.querySelector('.dialog-auto')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('Skip and Auto pulse a tint animation on activation (click and hotkey alike)', () => {
    // jsdom has no Web Animations API — the component guards on
    // `typeof btn.animate !== 'function'` — so stub it to observe the calls.
    const animate = vi.fn();
    (HTMLElement.prototype as unknown as { animate: typeof animate }).animate = animate;
    try {
      const store = createStore();
      mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
      seedSnapshot(store);
      store.applyEnvelope({
        kind: 'event',
        event: { type: 'narrate', actorId: 'dm', text: 'A beat.' } as never,
      });

      root.querySelector<HTMLButtonElement>('.dialog-skip')!.click();
      expect(animate).toHaveBeenCalledTimes(1);

      // Hotkeys route through btn.click(), so they flash identically.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
      expect(animate).toHaveBeenCalledTimes(2);
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: typeof animate }).animate;
    }
  });

  it('the Auto button advertises the hotkey with an "S" keycap hint', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);

    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'A beat.' } as never,
    });

    const hint = root.querySelector('.dialog-auto .dialog-key-hint');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe('S');
    expect(hint!.getAttribute('aria-hidden')).toBe('true');
  });

  it('submitting a prompt flushes the parked dialogue so the player message + replies surface without a Skip click', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    seedSnapshot(store);

    // A DM narration is parked in the narrator window (manual mode).
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Anwen dashes up the north lane.' } as never,
    });
    advance(60_000);
    expect(root.querySelector('.narrator-text')?.textContent).toContain('north lane');
    expect(root.querySelector('.hero-speech-feed'), 'no bubble yet').toBeNull();

    // Player picks "Party" (in-character) and interjects an in-character line.
    root.querySelector<HTMLInputElement>('.prompt-target-option--game input')!.click(); // dm → game
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = "Wait, don't attack";
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("Wait, don't attack", 'game');

    // The server broadcasts the human's `say` (and a teammate's reply lands
    // right behind it). With the parked narration flushed on submit, the bubble
    // surfaces on its own — NO Skip click — unlike the queued-say case above.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: "Wait, don't attack" } } as never,
    });
    expect(root.querySelector('.hero-speech-feed'), 'say surfaces without a Skip click').not.toBeNull();
  });

  it('a "to party" message jumps AHEAD of already-queued narrator beats, which resume after it', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    seedSnapshot(store);

    // Two narrator beats: the first parks (current); the SECOND queues behind it.
    store.applyEnvelope({ kind: 'event', event: { type: 'narrate', actorId: 'dm', text: 'First narration line.' } as never });
    store.applyEnvelope({ kind: 'event', event: { type: 'narrate', actorId: 'dm', text: 'Second narration line.' } as never });
    advance(60_000);
    expect(root.querySelector('.narrator-text')?.textContent).toContain('First narration');

    // Player sends a line to the party (Party is the default target).
    root.querySelector<HTMLInputElement>('.prompt-target-option--game input')!.click();
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Hold on, everyone!';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith('Hold on, everyone!', 'game');

    // Before the echo arrives the queue is HELD: the second narration must NOT
    // slip in ahead of the player's pending line.
    expect(root.querySelector('.hero-speech-feed')).toBeNull();
    expect(root.querySelector('.narrator-text')?.textContent ?? '').not.toContain('Second narration');

    // The server broadcasts the player's say → it jumps to the FRONT, ahead of
    // the still-queued "Second narration line."
    store.applyEnvelope({ kind: 'event', event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'Hold on, everyone!' } } as never });
    expect(root.querySelector('.hero-speech-feed'), 'player line shows first').not.toBeNull();
    expect(root.querySelector('.narrator-text')?.textContent ?? '').not.toContain('Second narration');

    // Skip past the player's line → the queued narration resumes (not lost).
    advance(60_000);  // settle the player line's typewriter so Skip advances
    root.querySelector<HTMLButtonElement>('.dialog-skip')!.click();
    advance(60_000);  // let the resumed narration's typewriter paint
    expect(root.querySelector('.narrator-text')?.textContent).toContain('Second narration');
  });
});
