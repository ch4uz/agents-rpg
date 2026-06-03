// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import { resetRollMountRegistry } from '../../web/components/roll-events.js';
import {
  BATTLE_ORDER_REVEAL_MS,
  BATTLE_ORDER_REVEAL_FADE_OUT_MS,
} from '../../web/components/BattleOrderReveal.js';

/**
 * Regression (originally Kael's bug: "Kael attacks before the bar appears"):
 * the initiative panel used to stick in `currentDisplay` because the
 * promotion rule only ever *replaced* the current item, never *cleared* it.
 *
 * The flow now goes:
 *   dice settle → BattleOrderReveal plaque holds the slot for
 *                 BATTLE_ORDER_REVEAL_MS announcing turn order → plaque
 *                 dismisses → regular looping `turnOrderBar` takes over.
 *
 * This test pins that behavior end-to-end.
 */
describe('Layout — order-reveal plaque then turn-order bar mount around initiative', () => {
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

  // Advance in 100ms chunks so each scheduled timer fires with a
  // `performance.now()` value close to its true scheduled time. A single
  // big jump would set fakeNow to the END of the window before any timer
  // callback ran, breaking the queue's elapsed-time math.
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

  it('shows the BattleOrderReveal plaque after dice settle, then the regular turn-order bar after it dismisses', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (
      _dispatch: unknown,
      _ctx: unknown,
    ): Promise<void> => new Promise<void>((res) => { resolveDice = res; });
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

    // Open the scene with a DM narration so the "game loaded" gate flips.
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Combat begins.' } as never,
    });
    // combat_started enqueues the initiative panel; first combatant claims
    // the turn slot via turn_started immediately after.
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

    // Bar is hidden during the playback of narration + initiative panel.
    expect(root.querySelector('.turn-order-bar')).toBeNull();

    // Advance past the narration hold — "Combat begins." is 14 chars, so
    // the typewritten hold is 14 × TYPEWRITER_CHAR_MS (22) +
    // POST_REVEAL_HOLD_MS (3000) ≈ 3308ms. After this the queue promotes
    // the initiative item; Layout enters the 'announcing' phase, shows
    // the "To Arms!" splash, and fires the dice dispatch at
    // COMBAT_BEGINS_DISPATCH_AT_MS (720ms after promote). The splash
    // STAYS UP through the dice canvas fade-in until COMBAT_BEGINS_SPLASH_MS.
    advance(3500);
    // Splash visible, dice dispatch not yet fired (still in the pop window).
    expect(root.querySelector('.combat-begins')).not.toBeNull();
    expect(resolveDice).toBeNull();
    expect(root.querySelector('.turn-order-bar')).toBeNull();

    // Advance well past the dispatch + splash-unmount window so the dice
    // dispatch has fired and the splash is gone.
    advance(1800);
    expect(resolveDice).not.toBeNull();
    // Splash unmounted, phase 'rolling' — bar hidden, dice still tumbling.
    expect(root.querySelector('.combat-begins')).toBeNull();
    expect(root.querySelector('.turn-order-bar')).toBeNull();
    // No static initiative-results bar exists in the new behavior.
    expect(root.querySelector('.turn-order-bar--initiative')).toBeNull();

    // Resolve the dice overlay → `notifyRollResolved` fires via
    // `.then(settle, settle)`, which flips Layout into the
    // 'order-reveal' phase: the BattleOrderReveal plaque mounts and
    // holds the slot for BATTLE_ORDER_REVEAL_MS. The regular turn-order
    // bar is still hidden at this point.
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();
    const plaque = root.querySelector('.battle-order-reveal');
    expect(plaque).not.toBeNull();
    // One per-die badge per combatant, in turn order — Kael (rolled 5) is
    // 1st, the giant rat (rolled 3) is 2nd.
    const badges = plaque!.querySelectorAll('.battle-order-badge');
    expect(badges.length).toBe(2);
    const ranks = plaque!.querySelectorAll('.battle-order-badge-rank');
    expect(Array.from(ranks).map((s) => s.textContent)).toEqual(['1st', '2nd']);
    expect(Array.from(badges).map((b) => b.getAttribute('aria-label')))
      .toEqual(['1st Kael', '2nd Giant Rat']);
    // Hero / monster team styling drives the per-badge modifier class.
    expect(plaque!.querySelectorAll('.battle-order-badge--hero').length).toBe(1);
    expect(plaque!.querySelectorAll('.battle-order-badge--monster').length).toBe(1);
    // Podium scaling — the top slots carry their rank-size modifier
    // (1st biggest), so the head of the order pops off the dice.
    expect(badges[0]!.classList.contains('battle-order-badge--rank1')).toBe(true);
    expect(badges[1]!.classList.contains('battle-order-badge--rank2')).toBe(true);
    // No legacy initiative-results bar.
    expect(root.querySelector('.turn-order-bar--initiative')).toBeNull();
    // Regular looping bar stays hidden while the plaque is up.
    expect(root.querySelector('.turn-order-bar')).toBeNull();

    // Advance past the plaque's dismiss timer — the parchment unmounts
    // and the regular looping turn-order bar takes the slot back.
    advance(BATTLE_ORDER_REVEAL_MS + 50);
    expect(root.querySelector('.battle-order-reveal')).toBeNull();
    const regularBar = root.querySelector('.turn-order-bar');
    expect(regularBar).not.toBeNull();
    expect(root.querySelector('.roll-panel--initiative')).toBeNull();
  });

  it('holds the plaque indefinitely in manual mode and dismisses it on Skip click', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (
      _dispatch: unknown,
      _ctx: unknown,
    ): Promise<void> => new Promise<void>((res) => { resolveDice = res; });
    // Default mode: auto-skip OFF — narration / order-reveal beats park.
    mountLayout(root, store, {
      onAction: vi.fn(),
      onSubmit: vi.fn(),
      onDiceRoll: onDiceRoll as never,
    });

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
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });

    // Manual-skip mode: the opening narration parks indefinitely. Drain
    // the fade + typewriter so the next Skip click hits the "advance the
    // beat" branch instead of the "complete the in-flight reveal"
    // branch, then click Skip to promote the initiative queue item.
    advance(220 + 'Combat begins.'.length * 22 + 50);
    const narrationSkip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(narrationSkip).not.toBeNull();
    narrationSkip!.click();

    // Splash + dispatch + canvas-fade window — same pacing as the auto
    // test. Resolve the dice and let the settle() microtask run.
    advance(2000);
    expect(resolveDice).not.toBeNull();
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();

    const plaque = root.querySelector('.battle-order-reveal');
    expect(plaque).not.toBeNull();
    expect(plaque!.classList.contains('is-dismissing')).toBe(false);

    // Skip control is mounted for the plaque (same dialog-skip button
    // used by narration / hero-speech beats).
    const skip = root.querySelector<HTMLButtonElement>('.dialog-skip');
    expect(skip).not.toBeNull();

    // Park time well past the auto-mode lifetime — the plaque must
    // still be on screen because manual mode never schedules a timer.
    advance(BATTLE_ORDER_REVEAL_MS * 3);
    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();
    expect(root.querySelector('.turn-order-bar')).toBeNull();

    // Click Skip → plaque starts dismissing (CSS fade-out class
    // applied) but does not unmount until the fade completes.
    skip!.click();
    const dismissing = root.querySelector('.battle-order-reveal');
    expect(dismissing).not.toBeNull();
    expect(dismissing!.classList.contains('is-dismissing')).toBe(true);
    // Bar still hidden until unmount completes.
    expect(root.querySelector('.turn-order-bar')).toBeNull();

    // Advance past the fade-out — plaque unmounts, looping turn-order
    // bar takes the slot.
    advance(BATTLE_ORDER_REVEAL_FADE_OUT_MS + 50);
    expect(root.querySelector('.battle-order-reveal')).toBeNull();
    expect(root.querySelector('.turn-order-bar')).not.toBeNull();
  });

  it('blocks first-turn beats and action buttons while the plaque is up', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (
      _dispatch: unknown,
      _ctx: unknown,
    ): Promise<void> => new Promise<void>((res) => { resolveDice = res; });
    mountLayout(root, store, {
      onAction: vi.fn(),
      onSubmit: vi.fn(),
      onDiceRoll: onDiceRoll as never,
    });

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

    // Open scene, run combat, skip past the opening narration, then
    // resolve the dice — same setup as the manual-skip test above.
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
    advance(220 + 'Combat begins.'.length * 22 + 50);
    root.querySelector<HTMLButtonElement>('.dialog-skip')!.click();
    advance(2000);
    expect(resolveDice).not.toBeNull();
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();

    // Plaque is up, manual mode.
    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();

    // Now the engine fires the first-turn events: turn_started for the
    // first combatant, input_required to unlock controls, and the DM
    // narrates the new turn. NONE of these should produce visible
    // first-turn UI while the plaque holds the screen.
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Kael steps forward.' } as never,
    });

    // Plaque still up; the first combatant's TURN controls (the combat action
    // toolbar) and the fresh narration beat have not appeared — those would
    // signal the first turn has begun. The free-text Prompt is intentionally
    // exempt: it's always visible so the player can interject at any time, so
    // we no longer assert it (or the generic `.act-btn`, which the always-on
    // prompt's send button also carries) is absent.
    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();
    expect(root.querySelector('.action-buttons')).toBeNull();
    expect(root.querySelector('.act-btn-end')).toBeNull();
    const narratorText = root.querySelector('.narrator-text');
    expect(narratorText!.textContent ?? '').not.toContain('Kael steps forward');

    // Player dismisses the plaque + fade-out completes → first turn now
    // gets to play out. Action buttons surface and the queued narration
    // promotes into the narrator window.
    root.querySelector<HTMLButtonElement>('.dialog-skip')!.click();
    advance(BATTLE_ORDER_REVEAL_FADE_OUT_MS + 50);
    expect(root.querySelector('.battle-order-reveal')).toBeNull();
    // The queued "Kael steps forward." narration promotes; finish its
    // typewriter so the dialog-skip / action buttons can be sanity-checked.
    advance(220 + 'Kael steps forward.'.length * 22 + 50);
    const narratorAfter = root.querySelector('.narrator-text');
    expect(narratorAfter!.textContent ?? '').toContain('Kael steps forward');
  });

  // The reveal handshake: dismissing the plaque (Skip in manual mode, or the
  // auto-dismiss timer in auto mode) fires onInitiativeRevealDismissed exactly
  // once. main.ts relays that as the server's reveal_ack, so the first combat
  // turn does not start until the player is ready.
  const seedCombatToPlaque = async (
    store: ReturnType<typeof createStore>,
    skipNarration: (() => void) | null,
  ): Promise<void> => {
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
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Combat begins.' } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started',
        heroSide: ['h1'], monsterSide: ['r1'], order: ['h1', 'r1'],
        rolls: { hero: { h1: { d6: 5, dex: 0, total: 5 } }, monster: { r1: { d6: 3, dex: 0, total: 3 } } },
        t: 1,
      } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    if (skipNarration) {
      advance(220 + 'Combat begins.'.length * 22 + 50);
      skipNarration();
    } else {
      advance(3500);
    }
    // Splash + dispatch + canvas-fade window — by now onDiceRoll has fired
    // and the caller's captured resolveDice ref is set, ready to settle.
    advance(2000);
  };

  it('fires onInitiativeRevealDismissed exactly once on the Skip click (manual mode)', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (): Promise<void> =>
      new Promise<void>((res) => { resolveDice = res; });
    const onInitiativeRevealDismissed = vi.fn();
    mountLayout(root, store, {
      onAction: vi.fn(), onSubmit: vi.fn(),
      onDiceRoll: onDiceRoll as never,
      onInitiativeRevealDismissed,
    });

    await seedCombatToPlaque(store, () =>
      root.querySelector<HTMLButtonElement>('.dialog-skip')!.click());
    expect(resolveDice).not.toBeNull();
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();

    // Plaque up; ack NOT sent yet — the game is still stopped.
    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();
    expect(onInitiativeRevealDismissed).not.toHaveBeenCalled();

    // Click Skip → ack fires once.
    root.querySelector<HTMLButtonElement>('.dialog-skip')!.click();
    expect(onInitiativeRevealDismissed).toHaveBeenCalledTimes(1);

    // A second Skip during the fade-out is a no-op (idempotent dismiss).
    root.querySelector<HTMLButtonElement>('.dialog-skip')?.click();
    expect(onInitiativeRevealDismissed).toHaveBeenCalledTimes(1);
  });

  it('fires onInitiativeRevealDismissed via the auto-dismiss timer (auto mode), no click', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (): Promise<void> =>
      new Promise<void>((res) => { resolveDice = res; });
    const onInitiativeRevealDismissed = vi.fn();
    const handle = mountLayout(root, store, {
      onAction: vi.fn(), onSubmit: vi.fn(),
      onDiceRoll: onDiceRoll as never,
      onInitiativeRevealDismissed,
    });
    handle.setAutoSkip(true);

    await seedCombatToPlaque(store, null);
    expect(resolveDice).not.toBeNull();
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();
    expect(onInitiativeRevealDismissed).not.toHaveBeenCalled();

    // The auto-dismiss timer fires within BATTLE_ORDER_REVEAL_MS — the ack is
    // sent without any Skip click, matching "the game starts if auto-skip is on".
    advance(BATTLE_ORDER_REVEAL_MS + 50);
    expect(onInitiativeRevealDismissed).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.battle-order-reveal')).toBeNull();
  });

  it('clears the DM narrator text once the initiative roll starts', async () => {
    const store = createStore();
    let resolveDice: (() => void) | null = null;
    const onDiceRoll = (): Promise<void> =>
      new Promise<void>((res) => { resolveDice = res; });
    const handle = mountLayout(root, store, {
      onAction: vi.fn(), onSubmit: vi.fn(),
      onDiceRoll: onDiceRoll as never,
    });
    // Auto-advance the opening narration so the initiative item promotes.
    handle.setAutoSkip(true);

    // The opening DM line is on screen before combat starts.
    await seedCombatToPlaque(store, null);

    // Initiative is now rolling (dice dispatched, not yet resolved). The
    // pre-combat DM narration must be gone from the narrator window.
    const narratorDuringRoll = root.querySelector('.narrator-text');
    expect(narratorDuringRoll?.textContent ?? '').not.toContain('Combat begins');

    // Settle the dice → the Order-of-Battle plaque takes over. Narrator stays
    // blank through the reveal too.
    resolveDice!();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector('.battle-order-reveal')).not.toBeNull();
    const narratorAtPlaque = root.querySelector('.narrator-text');
    expect(narratorAtPlaque?.textContent ?? '').not.toContain('Combat begins');
  });
});
