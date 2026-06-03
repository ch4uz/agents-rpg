// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Global "Enter focuses the Prompt input" hotkey.
 *
 * A bare Enter pressed anywhere on the page (when focus is NOT already on an
 * editable / interactive element) snaps the cursor into the free-text Prompt
 * input, so the player can start typing without first clicking the bar. The
 * hotkey only PARKS the cursor — it never submits; the input's own Enter
 * handler does the submit on the next press. Contract under test:
 *
 *   1. Enter from <body> focuses `.prompt-input` and does not submit.
 *   2. The hotkey does not interfere with the input's own Enter-to-submit
 *      (no double submit, value still clears).
 *   3. No-op when no prompt input is on screen (loading / run ended).
 *   4. Modifier+Enter (e.g. Shift+Enter) is ignored.
 *   5. Enter originating from an interactive element (a button) is left alone.
 */
describe('Layout Enter-focuses-prompt hotkey', () => {
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

  const openPrompt = (store: ReturnType<typeof createStore>) => {
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'You stand at the tavern door.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(7500);  // drain the narration hold so the player slot surfaces
  };

  const pressEnter = (target: EventTarget, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));

  it('Enter from <body> focuses the prompt input without submitting', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    expect(document.activeElement).not.toBe(input);

    pressEnter(document.body);

    expect(document.activeElement).toBe(input);
    // Parking the cursor must NOT submit anything.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not interfere with the input\'s own Enter-to-submit (no double submit)', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.focus();
    input.value = 'I charge the lead rat.';
    pressEnter(input);

    // Submitted exactly once (the input handler), and the field cleared — the
    // global hotkey did not pile on a second submit or steal focus mid-submit.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('I charge the lead rat.', 'game');
    expect(root.querySelector<HTMLInputElement>('.prompt-input')!.value).toBe('');
  });

  it('is a no-op while the game is still loading (no prompt input on screen)', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // Turn unlocked but the DM has not narrated yet → loader holds, no prompt.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(7500);
    expect(root.querySelector('.prompt-input')).toBeNull();

    // Should not throw and should not move focus anywhere meaningful.
    expect(() => pressEnter(document.body)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores Enter pressed with a modifier (Shift+Enter)', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    pressEnter(document.body, { shiftKey: true });

    expect(document.activeElement).not.toBe(input);
  });

  it('leaves Enter originating from an interactive element (a button) alone', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    const sendBtn = root.querySelector<HTMLButtonElement>('.prompt-send')!;
    pressEnter(sendBtn);

    // The hotkey must not yank focus onto the prompt input when a button is the
    // one handling Enter.
    expect(document.activeElement).not.toBe(input);
  });

  it('ESC leaves the prompt input — blurs without submitting or clearing the draft', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.focus();
    input.value = 'a half-typed draft';
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.activeElement).not.toBe(input);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('a half-typed draft');  // the draft survives
  });

  it('after ESC, the "A" skip hotkey is back in service', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    seedSnapshot(store);
    // Manual mode (no setAutoSkip) so the narration beat parks and the Skip
    // button is on screen.
    openPrompt(store);
    expect(root.querySelector('.dialog-skip')).not.toBeNull();

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.focus();
    // Focused: 'a' types into the input, the beat stays parked.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(root.querySelector('.dialog-skip')).not.toBeNull();

    // ESC out, then 'a' skips the (fully revealed) beat. The button stays
    // mounted (the controls are a constant pair) but goes inert — nothing
    // left to skip.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(
      root.querySelector('.dialog-skip')!.classList.contains('dialog-skip--inert'),
    ).toBe(true);
  });
});
