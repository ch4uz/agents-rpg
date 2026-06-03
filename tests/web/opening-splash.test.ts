// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import { resetRollMountRegistry } from '../../web/components/roll-events.js';
import { openingBefore, openingCast } from '../../web/components/OpeningSplash.js';
import { setLanguage, __resetLanguageForTest } from '../../web/i18n.js';

/**
 * Pins the adventure-opening title-splash flow:
 *
 *   1. On the first snapshot, a scene carrying `opening` shows the splash over
 *      the still-hidden board, typing its `before` text out character-by-
 *      character. A single dialogue-style Skip button (`.opening-skip`, the same
 *      glyph as the narrator's Skip) sits below the text throughout.
 *   2. Clicking the Skip button once the reveal completes fires
 *      `onOpeningDismissed` exactly once (→ the host relays the opening_ack that
 *      releases the server's first-turn gate) and unmounts the splash.
 *   3. Cast names render bold with a head-crop portrait; the spoken quote is
 *      broken onto its own block.
 *   4. A scene WITHOUT an `opening` shows no splash (legacy behaviour).
 *   5. While the host's separate "Choose your hero" overlay is up
 *      (`setHeroSelectActive(true)`) the splash — and its typewriter — are held,
 *      so the text doesn't reveal unseen behind the chooser; it types out only
 *      once the chooser clears.
 */
describe('Layout — adventure-opening title splash', () => {
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

  // Drive the typewriter interval to completion (texts here are < 100 chars ≈
  // < 2.2s at 22ms/char; 4s is a safe margin).
  const advance = (ms = 4000): void => {
    const STEP = 100;
    let remaining = ms;
    while (remaining > 0) {
      const slice = Math.min(STEP, remaining);
      fakeNow += slice;
      vi.advanceTimersByTime(slice);
      remaining -= slice;
    }
  };

  const baseChar = {
    id: 'h1' as never, name: 'Kael', kind: 'hero', archetype: 'warrior',
    pos: { x: 0, y: 0 },
    health: { total: 3, damage: 0, status: 'normal' },
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    inventory: [], boons: [],
    specialAction: { name: '', description: '' },
    bonusAbility:  { name: '', description: '' },
  };

  const snapshotWithScene = (scene: unknown) => ({
    kind: 'snapshot' as const,
    viewer: { kind: 'human' as const },
    manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
    state: {
      viewer: { kind: 'human' as const },
      scene: scene as never,
      characters: [baseChar],
      activeActor: null,
      recentChat: [],
    } as never,
  } as never);

  it('types the "before" text out, then Begin holds a pending splash until the first narration lands', () => {
    const store = createStore();
    const onOpeningDismissed = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed });

    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: { before: 'The tavern erupts in alarm.', after: 'Down the ladder you go.' },
    }));

    // Splash is up. Mid-typewriter the unrevealed tail is in the DOM but hidden
    // (stable-layout reveal, like the dialogue). The dialogue-style Skip button
    // is present throughout — it fast-forwards while typing, dismisses when done.
    const app = root.querySelector('.app') as HTMLElement;
    expect(root.querySelector('.opening-splash')).not.toBeNull();
    expect(root.querySelector('.typewriter-hidden')).not.toBeNull();
    expect(root.querySelector('.opening-skip')).not.toBeNull();
    expect(app.getAttribute('data-opening')).toBe('true');

    advance();

    // Reveal complete: full line shown, nothing left hidden.
    expect(root.querySelector('.opening-body')?.textContent).toContain('The tavern erupts in alarm.');
    // The "after" half is NOT on the splash — it arrives later as narration.
    expect(root.querySelector('.opening-body')?.textContent).not.toContain('Down the ladder');
    expect(root.querySelectorAll('.typewriter-hidden')).toHaveLength(0);
    const skip = root.querySelector('.opening-skip') as HTMLButtonElement | null;
    expect(skip).not.toBeNull();

    skip!.click();
    expect(onOpeningDismissed).toHaveBeenCalledTimes(1);
    // Begin releases the gate, but the DM's first narration line hasn't landed
    // yet. The splash MUST stay up (in its quiet "summoning" pending state) so
    // the boot "Summoning the Tale" loader can't flash back in: the Skip/Begin
    // button is gone, a pending indicator is shown, and `data-opening` (which
    // suppresses the loader) is still set.
    expect(root.querySelector('.opening-splash')).not.toBeNull();
    expect(root.querySelector('.opening-skip')).toBeNull();
    expect(root.querySelector('.opening-pending')).not.toBeNull();
    expect(app.getAttribute('data-opening')).toBe('true');
    // Still showing the opening body, not the "after" narration.
    expect(root.querySelector('.opening-body')?.textContent).toContain('The tavern erupts in alarm.');

    // The DM's first narration lands → game is loaded → the splash unmounts and
    // `data-opening` clears (the board reveals behind it).
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'Down the ladder you go.' } as never,
    });
    advance();
    expect(root.querySelector('.opening-splash')).toBeNull();
    expect(app.getAttribute('data-opening')).toBeNull();
  });

  it('labels the Skip/Begin button with a localized "Continue"', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });
    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: { before: 'The tavern erupts in alarm.', after: 'Down the ladder you go.' },
    }));

    try {
      // The label is present from the first frame (while typing AND once done)
      // so the splash's sole call-to-action always reads as "Continue".
      expect(root.querySelector('.opening-skip-label')?.textContent).toBe('Continue');

      // A language flip re-renders the splash chrome live (Layout subscribes
      // to onLanguageChange), so the label localizes without a new snapshot.
      setLanguage('pt');
      expect(root.querySelector('.opening-skip-label')?.textContent).toBe('Continuar');
    } finally {
      setLanguage('en');
      __resetLanguageForTest();
    }
  });

  it('clicking the splash while typing fast-forwards the reveal', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });

    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: { before: 'The tavern erupts in alarm.', after: 'x' },
    }));

    // Mid-typewriter: the tail is still hidden.
    expect(root.querySelector('.typewriter-hidden')).not.toBeNull();
    (root.querySelector('.opening-splash') as HTMLElement).click();

    // Fast-forwarded to the full text (nothing hidden), no timer advance. The
    // Skip button remains (now wired to dismiss).
    expect(root.querySelector('.opening-body')?.textContent).toContain('The tavern erupts in alarm.');
    expect(root.querySelectorAll('.typewriter-hidden')).toHaveLength(0);
    expect(root.querySelector('.opening-skip')).not.toBeNull();
  });

  it('holds the splash + its typewriter until the hero-select overlay clears', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });

    // Real ordering: the server publishes the snapshot (carrying `opening`)
    // BEFORE the hero-select gate, so the splash arms its typewriter FIRST.
    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: { before: 'The tavern erupts in alarm.', after: 'Down the ladder you go.' },
    }));
    expect(root.querySelector('.opening-splash')).not.toBeNull();

    // The host then mounts the "Choose your hero" chooser over the board. The
    // splash is hidden AND its already-armed reveal is torn down, so it can't run
    // to completion unseen behind the overlay while the player deliberates.
    handle.setHeroSelectActive(true);
    expect(root.querySelector('.opening-splash')).toBeNull();
    advance();
    expect(root.querySelector('.opening-splash')).toBeNull();

    // Chooser dismissed → the splash reappears and types from the START (tail
    // still hidden — proving the reveal RE-armed rather than showing the text
    // that would have finished behind the chooser), then completes normally.
    handle.setHeroSelectActive(false);
    expect(root.querySelector('.opening-splash')).not.toBeNull();
    expect(root.querySelector('.typewriter-hidden')).not.toBeNull();

    advance();
    expect(root.querySelector('.opening-body')?.textContent).toContain('The tavern erupts in alarm.');
    expect(root.querySelectorAll('.typewriter-hidden')).toHaveLength(0);
  });

  it('never flashes the splash before the chooser when the first snapshot flags awaitingHeroSelect', () => {
    const store = createStore();
    const handle = mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });

    // The server's first snapshot already carries `opening` AND flags that a
    // hero-select gate is pending — it arrives BEFORE the `hero_select_request`
    // that mounts the chooser. The splash must NOT render (nor arm its
    // typewriter) in that window: this is the flash the flag exists to prevent.
    const scene = {
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: { before: 'The tavern erupts in alarm.', after: 'Down the ladder you go.' },
    };
    store.applyEnvelope({ ...(snapshotWithScene(scene) as object), awaitingHeroSelect: true } as never);

    const app = root.querySelector('.app') as HTMLElement;
    expect(root.querySelector('.opening-splash')).toBeNull();
    expect(app.getAttribute('data-opening')).toBeNull();
    // Even past the typewriter cadence, still nothing — the reveal never armed
    // behind a blank screen while the player was about to pick a hero.
    advance();
    expect(root.querySelector('.opening-splash')).toBeNull();

    // The chooser mounts (host calls setHeroSelectActive(true)) — still no splash.
    handle.setHeroSelectActive(true);
    expect(root.querySelector('.opening-splash')).toBeNull();

    // Player picks → chooser clears → NOW the splash reveals, typing from the
    // START, even though the (stale) snapshot still flags awaitingHeroSelect:
    // the local heroSelectDone latch overrides it so the reveal isn't stranded.
    handle.setHeroSelectActive(false);
    expect(root.querySelector('.opening-splash')).not.toBeNull();
    expect(root.querySelector('.typewriter-hidden')).not.toBeNull();
    advance();
    expect(root.querySelector('.opening-body')?.textContent).toContain('The tavern erupts in alarm.');
    expect(root.querySelectorAll('.typewriter-hidden')).toHaveLength(0);
  });

  it('bolds cast names, inlines portraits at first mention, and breaks the quote onto its own block', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });

    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
      opening: {
        before: 'You are Bran.\n\nMaeve shouts: "Giant rats took Elara!"',
        after: 'Down the ladder.',
        cast: [
          { name: 'Bran', portrait: 'heroes/hunter/south.png' },
          { name: 'Elara', portrait: 'heroes/healer/south.png' },
          { name: 'Maeve' },
        ],
      },
    }));
    advance();

    // Every cast name is bolded.
    const names = [...root.querySelectorAll('.opening-name')].map((n) => n.textContent);
    expect(names).toEqual(expect.arrayContaining(['Bran', 'Elara', 'Maeve']));

    // Portraits inline for the two cast members that have one (Bran, Elara); not
    // Maeve. Rendered as a background-image head-crop (face, not full body) to
    // match the dialogue speech-portrait, so assert on the style, not an <img src>.
    const avatars = [...root.querySelectorAll('.opening-avatar')] as HTMLElement[];
    expect(avatars).toHaveLength(2);
    const bgImages = avatars.map((a) => a.getAttribute('style') ?? '');
    expect(bgImages.some((s) => s.includes('/assets/heroes/hunter/south.png'))).toBe(true);
    expect(bgImages.some((s) => s.includes('/assets/heroes/healer/south.png'))).toBe(true);

    // The spoken line is broken into its own block and still bolds the name inside it.
    const quote = root.querySelector('.opening-quote');
    expect(quote).not.toBeNull();
    expect(quote?.tagName.toLowerCase()).toBe('blockquote');
    expect(quote?.textContent).toContain('Giant rats took');
    expect(quote?.querySelector('.opening-name')?.textContent).toBe('Elara');
  });

  it('shows no splash for a scene without an opening', () => {
    const store = createStore();
    const onOpeningDismissed = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed });

    store.applyEnvelope(snapshotWithScene({
      id: 's', assetId: 's', gridW: 5, gridH: 5,
      obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
    }));

    expect(root.querySelector('.opening-splash')).toBeNull();
    expect(onOpeningDismissed).not.toHaveBeenCalled();
  });

  it('does not re-show the splash once narration has landed (mid-run reconnect)', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onOpeningDismissed: vi.fn() });

    // Reconnect snapshot: scene still carries `opening`, but prior narration is
    // already in recentChat → gameLoaded is true → no splash.
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: {
          id: 's', assetId: 's', gridW: 5, gridH: 5,
          obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [],
          opening: { before: 'B', after: 'A' },
        } as never,
        characters: [baseChar],
        activeActor: null,
        recentChat: [{ event: { type: 'narrate', actorId: 'dm', text: 'Down the ladder you go.' } }],
      } as never,
    } as never);

    expect(root.querySelector('.opening-splash')).toBeNull();
  });
});

describe('openingBefore — language-aware splash text', () => {
  afterEach(() => {
    setLanguage('en');
    __resetLanguageForTest();
  });

  const opening = {
    before: 'Three young heroes set out.',
    after: 'Down the ladder.',
    i18n: { pt: { before: 'Três jovens heróis partem.', after: 'Descendo a escada.' } },
  };

  it('returns English by default and the pt variant when the UI language is pt', () => {
    expect(openingBefore(opening)).toBe('Three young heroes set out.');
    setLanguage('pt');
    expect(openingBefore(opening)).toBe('Três jovens heróis partem.');
  });

  it('falls back to English in pt when the scene has no translated opening', () => {
    setLanguage('pt');
    expect(openingBefore({ before: 'EN only.' })).toBe('EN only.');
  });
});

describe('openingCast — language-aware cast names', () => {
  afterEach(() => {
    setLanguage('en');
    __resetLanguageForTest();
  });

  const cast = [
    { name: 'Gareth', names: { pt: 'Heitor' }, portrait: 'heroes/warrior/south.png' },
    { name: 'Maeve' },  // shared across languages — no names record
  ];

  it('keeps English names by default and maps to the names record under pt', () => {
    expect(openingCast(cast).map((c) => c.name)).toEqual(['Gareth', 'Maeve']);
    setLanguage('pt');
    expect(openingCast(cast).map((c) => c.name)).toEqual(['Heitor', 'Maeve']);
    // Portraits ride along untouched.
    expect(openingCast(cast)[0]!.portrait).toBe('heroes/warrior/south.png');
  });
});
