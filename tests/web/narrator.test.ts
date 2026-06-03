// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render } from 'lit-html';
import {
  latestNarration,
  narratorWindow,
  updateNarratorText,
  paintHeroSpeeches,
  selectHeroSpeechFeed,
  characterSpeechSpriteUrl,
  TYPEWRITER_CHAR_MS,
} from '../../web/components/NarratorWindow.js';

describe('latestNarration', () => {
  it('returns null when chat is empty', () => {
    expect(latestNarration([])).toBeNull();
  });

  it('returns null when no DM narration is present', () => {
    expect(latestNarration([
      { event: { type: 'action', actorId: 'h1', action: { kind: 'skip_turn' }, t: 1 } },
    ])).toBeNull();
  });

  it('returns the latest narrate event text', () => {
    expect(latestNarration([
      { event: { type: 'narrate', actorId: 'dm', text: 'Old line.', t: 1 } },
      { event: { type: 'narrate', actorId: 'dm', text: 'Newest line.', t: 2 } },
    ])).toBe('Newest line.');
  });

  it('finds DM action narrate', () => {
    expect(latestNarration([
      { event: { type: 'action', actorId: 'dm', action: { kind: 'narrate', text: 'A whisper.' }, t: 1 } },
    ])).toBe('A whisper.');
  });

  it('finds DM action say', () => {
    expect(latestNarration([
      { event: { type: 'action', actorId: 'dm', action: { kind: 'say', text: 'Hello, hero.' }, t: 1 } },
    ])).toBe('Hello, hero.');
  });

  it('returns the latest of mixed event types', () => {
    expect(latestNarration([
      { event: { type: 'narrate', actorId: 'dm', text: 'First.', t: 1 } },
      { event: { type: 'action', actorId: 'dm', action: { kind: 'say', text: 'Then this.' }, t: 2 } },
      { event: { type: 'action', actorId: 'h1', action: { kind: 'move' }, t: 3 } },
    ])).toBe('Then this.');
  });
});

describe('narratorWindow', () => {
  it('omits .player-echo when echo is null', () => {
    const div = document.createElement('div');
    render(narratorWindow(null, null, []), div);
    expect(div.querySelector('.player-echo')).toBeNull();
  });

  it('renders .player-echo with the supplied text', () => {
    const div = document.createElement('div');
    render(narratorWindow(null, 'I creep up to the rat and brandish my torch.', []), div);
    const el = div.querySelector('.player-echo');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('I creep up to the rat and brandish my torch.');
  });

  it('omits .hero-speech-feed when the list is empty', () => {
    const div = document.createElement('div');
    render(narratorWindow(null, 'echoed', []), div);
    expect(div.querySelector('.hero-speech-feed')).toBeNull();
    expect(div.querySelector('.hero-speech-line')).toBeNull();
  });

  it('renders one .hero-speech-line per supplied HeroSpeech', () => {
    vi.useFakeTimers();
    try {
      const div = document.createElement('div');
      render(
        narratorWindow(null, null, [
          { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'For the king!' },
          { key: 'h2:1', actorId: 'h2', actorName: 'Anwen', text: 'Right behind you.' },
        ]),
        div,
      );
      paintHeroSpeeches(div);
      vi.advanceTimersByTime(10_000);                   // drain typewriters
      const lines = div.querySelectorAll('.hero-speech-line');
      expect(lines.length).toBe(2);
      expect(lines[0]!.textContent).toContain('Bran');
      expect(lines[0]!.textContent).toContain('For the king!');
      expect(lines[1]!.textContent).toContain('Anwen');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stacks player-echo → narrator-text → hero-speech-feed → roll → slot', () => {
    // The player-echo now renders ABOVE the narrator text so a "Player
    // asked: …" tag reads as the prologue to the DM's reply (which lands
    // inside .narrator-text via the typewriter).
    const rollSlot = html`<div class="roll-panel">dice</div>`;
    const slot = html`<div class="action-buttons">buttons</div>`;
    const div = document.createElement('div');
    render(
      narratorWindow(
        slot,
        'echoed',
        [{ key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'hi' }],
        rollSlot,
      ),
      div,
    );
    const children = Array.from(div.querySelector('.narrator-window')!.children);
    const find = (cls: string) => children.findIndex((c) => c.classList.contains(cls));
    expect(find('player-echo')).toBe(0);
    expect(find('narrator-text')).toBe(1);
    expect(find('hero-speech-feed')).toBe(2);
    expect(find('roll-panel')).toBe(3);
    expect(find('action-buttons')).toBe(4);
  });

  it('omits the roll slot when null', () => {
    const div = document.createElement('div');
    render(narratorWindow(null, null, [], null), div);
    expect(div.querySelector('.roll-panel')).toBeNull();
  });

  it('renders markdown inside hero speech bubbles', () => {
    vi.useFakeTimers();
    try {
      const div = document.createElement('div');
      render(
        narratorWindow(null, null, [
          { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'For the **king**!' },
        ]),
        div,
      );
      paintHeroSpeeches(div);
      vi.advanceTimersByTime(10_000);
      const heroText = div.querySelector('.hero-text');
      expect(heroText).not.toBeNull();
      expect(heroText!.innerHTML).toMatch(/<strong>king<\/strong>/);
      expect(heroText!.textContent).toBe('For the king!');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders markdown inside the player echo', () => {
    const div = document.createElement('div');
    render(narratorWindow(null, 'I attack the *rat*.', []), div);
    const echo = div.querySelector('.player-echo');
    expect(echo).not.toBeNull();
    expect(echo!.innerHTML).toMatch(/<em>rat<\/em>/);
    expect(echo!.textContent).toBe('I attack the rat.');
  });
});

describe('updateNarratorText markdown rendering', () => {
  it('paints **bold** as <strong> in the narrator-text element', () => {
    const el = document.createElement('div');
    updateNarratorText(el, 'The **rats** scuttle.');
    expect(el.innerHTML).toBe('The <strong>rats</strong> scuttle.');
    expect(el.textContent).toBe('The rats scuttle.');
  });

  it('escapes raw HTML before applying markdown', () => {
    const el = document.createElement('div');
    updateNarratorText(el, 'oops <b>x</b>');
    expect(el.innerHTML).toBe('oops &lt;b&gt;x&lt;/b&gt;');
    expect(el.textContent).toBe('oops <b>x</b>');
  });

  it('renders the placeholder when text is null', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    expect(el.querySelector('.narrator-placeholder')).not.toBeNull();
  });
});

/** During the typewriter the unrevealed tail lives in a `.typewriter-hidden`
 *  span (`visibility: hidden`) so the layout reserves its final width and the
 *  visible letters never slide. These helpers strip that span so assertions
 *  can target the visible portion only. */
const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  for (const h of clone.querySelectorAll('.typewriter-hidden')) h.remove();
  return clone.textContent ?? '';
};
const visibleInnerHTML = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  for (const h of clone.querySelectorAll('.typewriter-hidden')) h.remove();
  return clone.innerHTML;
};

describe('updateNarratorText typewriter effect', () => {
  // FADE_MS is also internal to NarratorWindow.ts; CHAR_MS is the exported
  // pacing constant so tests stay in lockstep with any future tuning.
  const FADE_MS = 220;
  const CHAR_MS = TYPEWRITER_CHAR_MS;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reserves the full text width via a visibility-hidden tail so letters do not move', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'Rats!');

    vi.advanceTimersByTime(FADE_MS);                    // 1st char revealed
    // Full text is laid out under .typewriter-hidden even though only the
    // first char is shown — that is what locks already-revealed letters in
    // place across the rest of the reveal.
    expect(el.querySelector('.typewriter-hidden')).not.toBeNull();
    expect(el.textContent).toBe('Rats!');               // includes hidden tail
    expect(visibleText(el)).toBe('R');

    vi.advanceTimersByTime(CHAR_MS * 100);              // drain
    expect(el.querySelector('.typewriter-hidden')).toBeNull();
    expect(el.innerHTML).toBe('Rats!');                 // clean DOM at the end
  });

  it('reveals characters one at a time on a transition', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);                       // first paint = placeholder
    updateNarratorText(el, 'Rats!');                    // transition → typewriter

    expect(el.querySelector('.narrator-placeholder')).not.toBeNull();
    vi.advanceTimersByTime(FADE_MS);
    expect(visibleText(el)).toBe('R');

    vi.advanceTimersByTime(CHAR_MS);
    expect(visibleText(el)).toBe('Ra');

    vi.advanceTimersByTime(CHAR_MS * 3);
    expect(visibleText(el)).toBe('Rats!');
  });

  it('keeps markdown formatting on revealed characters as they appear', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'The **rats**.');

    vi.advanceTimersByTime(FADE_MS);
    expect(visibleInnerHTML(el)).toBe('T');

    vi.advanceTimersByTime(CHAR_MS * 4);                // "The r"
    expect(visibleInnerHTML(el)).toBe('The <strong>r</strong>');

    vi.advanceTimersByTime(CHAR_MS * 3);                // "The rats"
    expect(visibleInnerHTML(el)).toBe('The <strong>rats</strong>');

    vi.advanceTimersByTime(CHAR_MS);
    expect(visibleInnerHTML(el)).toBe('The <strong>rats</strong>.');
  });

  it('cancels an in-flight typewriter when a new narration arrives', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'First narration line.');

    vi.advanceTimersByTime(FADE_MS + CHAR_MS * 4);
    expect(visibleText(el)).toBe('First');

    updateNarratorText(el, 'New line.');                // mid-typewriter swap

    vi.advanceTimersByTime(FADE_MS);
    expect(visibleText(el)).toBe('N');

    vi.advanceTimersByTime(CHAR_MS * 100);
    expect(visibleText(el)).toBe('New line.');
  });

  it('switches back to the placeholder when a transition lands on null', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'Visible.');
    vi.advanceTimersByTime(FADE_MS + CHAR_MS * 20);
    expect(visibleText(el)).toBe('Visible.');

    updateNarratorText(el, null);
    vi.advanceTimersByTime(FADE_MS);
    expect(el.querySelector('.narrator-placeholder')).not.toBeNull();
  });
});

describe('paintHeroSpeeches typewriter effect', () => {
  const CHAR_MS = TYPEWRITER_CHAR_MS;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reveals hero bubble characters one at a time', () => {
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'Charge!' },
      ]),
      div,
    );
    paintHeroSpeeches(div);
    const heroText = div.querySelector('.hero-text')!;
    expect(visibleText(heroText)).toBe('C');            // first char synchronous

    vi.advanceTimersByTime(CHAR_MS);
    expect(visibleText(heroText)).toBe('Ch');

    vi.advanceTimersByTime(CHAR_MS * 5);
    expect(visibleText(heroText)).toBe('Charge!');
  });

  it('reserves full bubble width via hidden tail so letters do not slide', () => {
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'Charge!' },
      ]),
      div,
    );
    paintHeroSpeeches(div);
    const heroText = div.querySelector('.hero-text')!;
    // 6 chars still hidden, full text already in DOM occupying layout width.
    expect(heroText.querySelector('.typewriter-hidden')).not.toBeNull();
    expect(heroText.textContent).toBe('Charge!');
    expect(visibleText(heroText)).toBe('C');
  });

  it('keeps markdown formatting on revealed hero-bubble chars', () => {
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: '**Stop!**' },
      ]),
      div,
    );
    paintHeroSpeeches(div);
    const heroText = div.querySelector('.hero-text')!;
    expect(visibleInnerHTML(heroText)).toBe('<strong>S</strong>');

    vi.advanceTimersByTime(CHAR_MS * 4);
    expect(visibleInnerHTML(heroText)).toBe('<strong>Stop!</strong>');
  });

  it('does not restart the typewriter on a same-key re-render', () => {
    const div = document.createElement('div');
    const speech = { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'Charge!' };
    render(narratorWindow(null, null, [speech]), div);
    paintHeroSpeeches(div);

    vi.advanceTimersByTime(CHAR_MS * 3);                // "Char"
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('Char');

    // Re-render with the same speech — the painter must NOT reset progress.
    render(narratorWindow(null, null, [speech]), div);
    paintHeroSpeeches(div);
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('Char');

    vi.advanceTimersByTime(CHAR_MS * 4);
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('Charge!');
  });

  it('restarts the typewriter when the speech key changes on the same element', () => {
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: 'First line.' },
      ]),
      div,
    );
    paintHeroSpeeches(div);
    // First char paints synchronously, then 4 interval ticks → 5 chars total.
    vi.advanceTimersByTime(CHAR_MS * 4);
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('First');

    // Swap the speech (same single-bubble slot, new key) — lit-html reuses
    // the same `.hero-text` node and updates the data attributes. Painter
    // must cancel and restart from char 0.
    render(
      narratorWindow(null, null, [
        { key: 'h1:1', actorId: 'h1', actorName: 'Bran', text: 'New cry.' },
      ]),
      div,
    );
    paintHeroSpeeches(div);
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('N');

    vi.advanceTimersByTime(CHAR_MS * 100);
    expect(visibleText(div.querySelector('.hero-text')!)).toBe('New cry.');
  });
});

describe('updateNarratorText instant (AutoSkip) mode', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('paints the full text immediately with no fade or typewriter', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);                                   // first paint = placeholder
    updateNarratorText(el, 'The **rats** scuttle.', undefined, true); // instant transition

    // No timers advanced — the full markdown-rendered line is already present.
    expect(el.innerHTML).toBe('The <strong>rats</strong> scuttle.');
    expect(el.querySelector('.typewriter-hidden')).toBeNull();
    expect(el.style.opacity).toBe('1');
  });

  it('snaps an in-flight typewriter to the finished line when switching to instant', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'First line.');                          // animated transition
    vi.advanceTimersByTime(220 + TYPEWRITER_CHAR_MS * 2);           // mid-typewriter

    updateNarratorText(el, 'Second line.', undefined, true);        // new text, instant
    expect(el.innerHTML).toBe('Second line.');
    expect(el.querySelector('.typewriter-hidden')).toBeNull();

    // No leftover interval keeps mutating the DOM afterwards.
    vi.advanceTimersByTime(TYPEWRITER_CHAR_MS * 100);
    expect(el.innerHTML).toBe('Second line.');
  });

  it('renders the placeholder instantly on an instant transition to null', () => {
    const el = document.createElement('div');
    updateNarratorText(el, null);
    updateNarratorText(el, 'Visible.', undefined, true);
    expect(el.textContent).toBe('Visible.');

    updateNarratorText(el, null, undefined, true);
    expect(el.querySelector('.narrator-placeholder')).not.toBeNull();
  });
});

describe('paintHeroSpeeches instant (AutoSkip) mode', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes the full bubble text at once with no typewriter', () => {
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', text: '**Charge!**' },
      ]),
      div,
    );
    paintHeroSpeeches(div, true);
    const heroText = div.querySelector('.hero-text')!;

    expect(heroText.innerHTML).toBe('<strong>Charge!</strong>');
    expect(heroText.querySelector('.typewriter-hidden')).toBeNull();

    // No interval continues mutating the bubble afterwards.
    vi.advanceTimersByTime(TYPEWRITER_CHAR_MS * 100);
    expect(heroText.innerHTML).toBe('<strong>Charge!</strong>');
  });
});

describe('enemy (monster) speech', () => {
  // The DM voices off-turn enemy reactions (see Orchestrator.reactAsMonsters):
  // a monster `say` must render as a speech bubble over the foe, with its own
  // /assets/monsters/<sprite> portrait — exactly like a hero/NPC line.
  const monster = { id: 'king-rat', name: 'King Rat', kind: 'monster', sprite: 'king-rat' };
  const hero = { id: 'h1', name: 'Bran', kind: 'hero', archetype: 'hunter' };

  it('characterSpeechSpriteUrl resolves a monster portrait', () => {
    expect(characterSpeechSpriteUrl(monster as never)).toBe('/assets/monsters/king-rat/south.png');
  });

  it('selectHeroSpeechFeed includes a monster say (DM-voiced enemy reaction)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'Take that!' }, t: 1 } },
      { event: { type: 'action', actorId: 'king-rat', action: { kind: 'say', text: 'SKREEE!' }, t: 2 } },
    ];
    const feed = selectHeroSpeechFeed(chat as never, [hero, monster] as never);
    expect(feed).toHaveLength(2);
    expect(feed[0]).not.toHaveProperty('isMonster');   // hero line — humanoid crop
    expect(feed[1]).toMatchObject({
      actorId: 'king-rat',
      actorName: 'King Rat',
      spriteUrl: '/assets/monsters/king-rat/south.png',
      isMonster: true,
      text: 'SKREEE!',
    });
  });

  it('selectHeroSpeechFeed excludes a third-person "The <monster>…" narration say', () => {
    // The DM voiced this as narration about the rat, not the rat's own words —
    // it must NOT surface as the monster's speech bubble (it falls back to the
    // DM-narration caption instead).
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'Take that!' }, t: 1 } },
      { event: { type: 'action', actorId: 'king-rat', action: { kind: 'say', text: 'The King Rat squeaks in triumph, pointing his bone scepter!' }, t: 2 } },
    ];
    const feed = selectHeroSpeechFeed(chat as never, [hero, monster] as never);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ actorId: 'h1' });
  });

  it('renders the monster portrait with the whole-sprite class so the face is not clipped', () => {
    // The humanoid `.hero-head` crop zooms into the top-center of the sprite,
    // which clips a low, horizontal rat to the top of its face. Monster lines
    // carry `.hero-head--monster` (whole sprite scaled to fit) instead.
    const div = document.createElement('div');
    render(
      narratorWindow(null, null, [
        { key: 'h1:0', actorId: 'h1', actorName: 'Bran', spriteUrl: '/assets/heroes/hunter/south.png', text: 'Hi' },
        {
          key: 'king-rat:1',
          actorId: 'king-rat',
          actorName: 'King Rat',
          spriteUrl: '/assets/monsters/king-rat/south.png',
          isMonster: true,
          text: 'SKREEE!',
        },
      ]),
      div,
    );
    const heads = div.querySelectorAll('.hero-head');
    expect(heads).toHaveLength(2);
    // Hero portrait keeps the humanoid head-crop.
    expect(heads[0]!.classList.contains('hero-head--monster')).toBe(false);
    // Monster portrait opts into the whole-sprite fit.
    expect(heads[1]!.classList.contains('hero-head--monster')).toBe(true);
  });
});
