// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Target picker ("Say to") on the player's free-text prompt.
 *
 * The picker is a radio group that sits BELOW the input bar (it used to be a
 * toggle chip welded inside the bar). Two plain options — a circular dot + a
 * bare label, no visible caption: "Party" (in-character, the default, rendered
 * first) and "Dungeon Master" (out-of-character). Exactly one is selected;
 * selecting one unchecks the other. The contract under test:
 *
 *   1. The radio group renders whenever the prompt input is offered (story and
 *      combat modes alike), defaulting to "Party" (rendered first). The group's
 *      accessible name rides on aria-label ("Say to").
 *   2. Each option's `data-target` mirrors its value; the selected radio is
 *      `:checked` and its label carries `is-selected`.
 *   3. Selecting "Dungeon Master" swaps the input placeholder; the next
 *      submission (Enter or Send) calls `cb.onSubmit(text, 'dm')`.
 *   4. After a submit, the target resets to 'game' so the Party default
 *      persists across messages.
 *   5. The radio group lives BELOW the bar, OUTSIDE the `.prompt-compact`
 *      welded input group.
 */
describe('Layout prompt-target picker (Say to: Dungeon Master vs Party)', () => {
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

  // Pick a target by clicking its (visually-hidden but focusable) radio.
  const selectTarget = (target: 'dm' | 'game') =>
    root.querySelector<HTMLInputElement>(`.prompt-target-option--${target} input`)!.click();
  // The value of whichever radio is currently checked, or null.
  const checkedTarget = () =>
    root.querySelector<HTMLInputElement>('.prompt-target-option input:checked')?.value ?? null;

  it('renders the Say-to radio group defaulting to Party, rendered first', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const radios = root.querySelector<HTMLDivElement>('.prompt-target-radios');
    expect(radios, 'the Say-to radio group should render').not.toBeNull();
    // The visible caption was removed; the group's accessible name rides on aria-label.
    expect(radios!.getAttribute('aria-label')).toMatch(/say to/i);

    // Exactly two options, Party rendered FIRST then Dungeon Master, with
    // plain text labels (no emoji glyphs).
    const options = radios!.querySelectorAll<HTMLLabelElement>('.prompt-target-option');
    expect(options.length).toBe(2);
    expect(options[0]!.classList.contains('prompt-target-option--game')).toBe(true);
    expect(options[1]!.classList.contains('prompt-target-option--dm')).toBe(true);
    expect(root.querySelector('.prompt-target-option--game .prompt-target-option-face')?.textContent?.trim())
      .toBe('Party');
    expect(root.querySelector('.prompt-target-option--dm .prompt-target-option-face')?.textContent?.trim())
      .toBe('Dungeon Master');

    // Party is selected by default; Dungeon Master is not.
    expect(checkedTarget()).toBe('game');
    expect(root.querySelector('.prompt-target-option--game')?.classList.contains('is-selected')).toBe(true);
    expect(root.querySelector('.prompt-target-option--dm')?.classList.contains('is-selected')).toBe(false);

    // Default placeholder is the in-character (action) one.
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    expect(input.placeholder.toLowerCase()).toMatch(/action/);
  });

  it('renders the radio group below the bar, outside the welded input group', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const panel = root.querySelector<HTMLDivElement>('.prompt-panel')!;
    const compact = panel.querySelector<HTMLDivElement>('.prompt-compact')!;
    const radios = panel.querySelector<HTMLDivElement>('.prompt-target-radios')!;
    expect(compact).not.toBeNull();
    expect(radios).not.toBeNull();

    // The radio group is NOT inside the welded input group...
    expect(compact.contains(radios)).toBe(false);
    expect(compact.querySelector('.prompt-target-option')).toBeNull();
    // ...and the welded group holds only the input (+ the send button).
    expect(compact.querySelector('.prompt-input')).not.toBeNull();

    // It sits BELOW the bar — after the compact group in panel DOM order.
    const panelKids = Array.from(panel.children);
    const barIdx = panelKids.findIndex((c) => c.contains(compact));
    const radiosIdx = panelKids.indexOf(radios);
    expect(barIdx).toBeGreaterThanOrEqual(0);
    expect(radiosIdx).toBeGreaterThan(barIdx);
  });

  it('selecting Dungeon Master checks it, unchecks Party, and swaps the input placeholder', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');

    expect(checkedTarget()).toBe('dm');
    expect(root.querySelector('.prompt-target-option--dm')?.classList.contains('is-selected')).toBe(true);
    expect(root.querySelector('.prompt-target-option--game')?.classList.contains('is-selected')).toBe(false);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    // The DM placeholder frames the channel as "ask the DM anything" (a
    // question, an ability test, …) — not specifically a question — so it
    // keys on the stable "ask the DM" phrasing rather than the word "question".
    expect(input.placeholder.toLowerCase()).toMatch(/ask the dm/);
  });

  it('selecting Party after Dungeon Master switches back', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');
    expect(checkedTarget()).toBe('dm');
    selectTarget('game');
    expect(checkedTarget()).toBe('game');
    expect(root.querySelector('.prompt-target-option--game')?.textContent).toMatch(/party/i);
  });

  it('Enter submits with target=game by default (Party)', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'I charge the lead rat.';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('I charge the lead rat.', 'game');
  });

  it('Enter submits with target=dm after Dungeon Master is selected, then resets to game (Party)', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Can I see the door from here?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Can I see the door from here?', 'dm');

    // After the submit, the target resets to the Party (in-character) default
    // so the picker's default selection persists across messages.
    expect(checkedTarget()).toBe('game');
    expect(root.querySelector('.prompt-target-option--game')?.classList.contains('is-selected')).toBe(true);
  });

  it('DM-target submit opens the left-margin DM Aside with the question; game-target shows no aside', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    // DM-target submission (select Dungeon Master) — the OOC question moves
    // into the fixed `.dm-aside` margin slip (NOT the narrator stage), so the
    // user sees their question framed as the prologue to the DM's reply
    // without disturbing the in-fiction narration below the board.
    selectTarget('dm');
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'hey guys, can someone tell me a joke?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const aside = root.querySelector<HTMLElement>('.dm-aside');
    expect(aside, 'DM-target submission should open the DM Aside').not.toBeNull();
    expect(aside!.dataset['state']).toBe('pending');
    expect(aside!.getAttribute('role')).toBe('note');
    expect(aside!.querySelector('.dm-aside-turn--you .dm-aside-speaker')?.textContent)
      .toMatch(/you asked/i);
    expect(aside!.querySelector('.dm-aside-text--question')?.textContent)
      .toBe('hey guys, can someone tell me a joke?');

    // The OOC echo must NOT live inside the narrator window anymore — the
    // in-fiction stage stays clean.
    const window = root.querySelector<HTMLDivElement>('.narrator-window')!;
    expect(window.querySelector('.player-echo')).toBeNull();
    expect(window.querySelector('.dm-aside')).toBeNull();

    // The narrator text keeps its in-character narration (it was NOT replaced
    // by the question).
    expect(root.querySelector<HTMLDivElement>('.narrator-text')!.textContent)
      .toBe('You stand at the tavern door.');

    // Game-target submission (Party — already the default again after the
    // prior submit reset): NO aside at all — the hero-speech bubble in the
    // chat already shows what the player said, so echoing it would double up.
    selectTarget('game');
    const input2 = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input2.value = 'I press forward toward the rat.';
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(root.querySelector('.dm-aside')).toBeNull();
  });

  it('DM reply lands inside the DM Aside (not the narrator text), leaving the narration intact', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Can I see the door from here?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // Pre-reply: the aside is in its pending state — question shown, a
    // "consults the tomes…" placeholder where the answer will go, no reply
    // row yet.
    expect(root.querySelector('.dm-aside[data-state="pending"]')).not.toBeNull();
    expect(root.querySelector('.dm-aside-turn[data-role="question"]')).not.toBeNull();
    expect(root.querySelector('.dm-aside-turn[data-role="reply"]')).toBeNull();
    expect(root.querySelector('.dm-aside-pending')).not.toBeNull();

    // DM answers — the reply lands in the aside's reply row and flips the
    // panel to its answered state. Advance a little wall-clock so any pending
    // store-driven renders settle.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'dm_ooc_reply', toActorId: 'h1', text: 'Yes — three squares north.' } as never,
    });
    advance(2000);

    expect(root.querySelector('.dm-aside[data-state="answered"]')).not.toBeNull();
    expect(root.querySelector('.dm-aside-pending')).toBeNull();
    const reply = root.querySelector<HTMLElement>('.dm-aside-turn[data-role="reply"] .dm-aside-text--reply');
    expect(reply, 'the reply row should render in the aside').not.toBeNull();
    expect(reply!.textContent).toBe('Yes — three squares north.');

    // The question stays as the prologue above the answer.
    expect(root.querySelector('.dm-aside-text--question')?.textContent)
      .toBe('Can I see the door from here?');

    // Crucially, the narrator text was NEVER overwritten — the in-fiction
    // narration that was on screen when the player asked is still there.
    expect(root.querySelector<HTMLDivElement>('.narrator-text')!.textContent)
      .toBe('You stand at the tavern door.');
  });

  it('the DM Aside clears once a fresh DM narration line lands', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Can I see the door from here?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // DM answers, then narrates fresh in-character — the OOC exchange is no
    // longer in the foreground, so the aside clears entirely.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'dm_ooc_reply', toActorId: 'h1', text: 'Yes — three squares north.' } as never,
    });
    expect(root.querySelector('.dm-aside')).not.toBeNull();
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'A draft creaks through the basement.' } as never,
    });
    expect(root.querySelector('.dm-aside')).toBeNull();
  });

  it('clicking the DM Aside dismiss button closes it early (before any narration clears it)', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Can I attempt a Dexterity test to slip past?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // DM answers — the aside is up and answered.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'dm_ooc_reply', toActorId: 'h1', text: 'Yes — roll Dexterity (DC 4).' } as never,
    });
    const dismiss = root.querySelector<HTMLButtonElement>('.dm-aside-dismiss');
    expect(dismiss, 'the aside should carry a dismiss button').not.toBeNull();

    // Click it — the aside closes immediately, with NO fresh narration needed.
    dismiss!.click();
    expect(root.querySelector('.dm-aside')).toBeNull();

    // The in-fiction narration was untouched throughout.
    expect(root.querySelector<HTMLDivElement>('.narrator-text')!.textContent)
      .toBe('You stand at the tavern door.');
  });

  it('stays hidden while the game is still loading, and appears once the DM narrates', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // Snapshot + turn unlock have arrived, but the DM hasn't produced its first
    // narration line yet — the "Summoning the Tale" loader still holds the
    // screen, so the player prompt must NOT be visible behind it.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(7500);
    expect(root.querySelector('.prompt-input'), 'no prompt while loading').toBeNull();
    expect(root.querySelector('.prompt-target-radios')).toBeNull();

    // The DM's opening line lands → game is loaded → the prompt surfaces.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'You stand at the tavern door.' } as never,
    });
    advance(7500);
    expect(root.querySelector('.prompt-input'), 'prompt appears once loaded').not.toBeNull();
    expect(root.querySelector('.prompt-target-radios')).not.toBeNull();
  });

  it('radio group renders in combat mode too', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);

    // Enter combat then open prompt.
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
    advance(7500);  // initiative reveal
    advance(7500);  // narration

    expect(root.querySelector('.prompt-target-radios')).not.toBeNull();
    expect(checkedTarget()).toBe('game');
    // And it sits below the bar in combat too — inside the panel, NOT the
    // welded input group.
    expect(root.querySelector('.prompt-panel .prompt-target-radios')).not.toBeNull();
    expect(root.querySelector('.prompt-compact .prompt-target-option')).toBeNull();
  });

  // ── Send button ─────────────────────────────────────────────────────────
  // The mouse counterpart to pressing Enter: the right segment of the welded
  // [input | send] control. It is shown only while the input holds text
  // (driven purely by the CSS rule
  //   .prompt-input:not(:placeholder-shown) ~ .prompt-send
  // — a content-based reveal that jsdom can't evaluate via computed style, so
  // these tests cover the DOM contract + the submit path; the CSS visibility
  // itself is validated by the Vite build). Clicking it must submit the
  // sibling input exactly like Enter does.
  it('welds a send button to the RIGHT of the input in the compact group', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const compact = root.querySelector<HTMLDivElement>('.prompt-compact')!;
    const send = compact.querySelector<HTMLButtonElement>('.prompt-send');
    expect(send, 'send button should render').not.toBeNull();

    // Order inside the welded group: input < send (right). The target picker
    // is no longer in this group — it's the "Say to" radios below the bar.
    expect(compact.querySelector('.prompt-target-option')).toBeNull();
    const input = compact.querySelector<HTMLInputElement>('.prompt-input')!;
    const order = Array.from(compact.children);
    expect(order.indexOf(input)).toBeLessThan(order.indexOf(send!));
  });

  it('clicking Send submits the input text with target=game by default and clears it', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'I swing at the lead rat.';
    root.querySelector<HTMLButtonElement>('.prompt-send')!.click();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('I swing at the lead rat.', 'game');
    // The input is cleared after a send (same as the Enter path).
    expect(root.querySelector<HTMLInputElement>('.prompt-input')!.value).toBe('');
  });

  it('clicking Send after selecting Dungeon Master submits with target=dm, then resets to game (Party)', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    selectTarget('dm');
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = 'Can I ask the DM something?';
    root.querySelector<HTMLButtonElement>('.prompt-send')!.click();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Can I ask the DM something?', 'dm');
    // Target resets to the Party (in-character) default after the submit.
    expect(checkedTarget()).toBe('game');
  });

  it('clicking Send with an empty (or whitespace-only) input is a no-op', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    // Empty.
    root.querySelector<HTMLButtonElement>('.prompt-send')!.click();
    expect(onSubmit).not.toHaveBeenCalled();

    // Whitespace only — trims to empty, still nothing submitted.
    const input = root.querySelector<HTMLInputElement>('.prompt-input')!;
    input.value = '   ';
    root.querySelector<HTMLButtonElement>('.prompt-send')!.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('send button always wears the act-btn-active (orange) face, regardless of target', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() });
    handle.setAutoSkip(true);
    seedSnapshot(store);
    openPrompt(store);

    // Party (the default) — orange.
    expect(root.querySelector<HTMLButtonElement>('.prompt-send')!.classList.contains('act-btn-active'))
      .toBe(true);

    // Dungeon Master — still orange, so Send reads as one consistent affordance.
    selectTarget('dm');
    expect(root.querySelector<HTMLButtonElement>('.prompt-send')!.classList.contains('act-btn-active'))
      .toBe(true);
  });
});
