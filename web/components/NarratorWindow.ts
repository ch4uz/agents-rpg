import { html, type TemplateResult } from 'lit-html';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { ChatEntry } from '../store.js';
import { markdownInline } from './markdown.js';
import { t } from '../i18n.js';
import { markdownInlineRefsHtml, parseWithRefs } from './refs.js';
import { monsterSayReadsAsNarration } from './names.js';
import {
  renderSegmentsHtml,
  type MdSegment,
} from '../../src/util/markdown.js';

interface AnyEvent {
  type?: string;
  actorId?: string;
  text?: string;
  t?: number;
  action?: { kind?: string; text?: string };
}

/**
 * Pure: extract the latest DM narration line from the chat. Returns null
 * when no DM narration has occurred yet. DM narration = `type: 'narrate'`
 * (DM is the only narrator) or `type: 'action', actorId: 'dm', action.kind: 'narrate'`.
 * DM `say` actions are also treated as narration.
 */
export const latestNarration = (chat: ChatEntry[]): string | null => {
  for (let i = chat.length - 1; i >= 0; i--) {
    const e = chat[i]!.event as AnyEvent;
    if (e.type === 'narrate' && typeof e.text === 'string') return e.text;
    if (e.type === 'action' && e.actorId === 'dm' && e.action) {
      if (e.action.kind === 'narrate' && typeof e.action.text === 'string') return e.action.text;
      if (e.action.kind === 'say' && typeof e.action.text === 'string') return e.action.text;
    }
  }
  return null;
};

/**
 * Scan back through the chat for the most recent DM reply to an OOC question.
 * Returns the reply text or `null` if none has been recorded yet. Used by the
 * Layout to clear the player-echo "to DM" overlay once the DM has answered —
 * mirrors how `latestNarration` is used for in-character submissions.
 */
export const latestDmOocReply = (chat: ChatEntry[]): string | null => {
  for (let i = chat.length - 1; i >= 0; i--) {
    const e = chat[i]!.event as AnyEvent;
    if (e.type === 'dm_ooc_reply' && typeof e.text === 'string') return e.text;
  }
  return null;
};

/**
 * Speech-bubble payload rendered in the .hero-speech-feed below the narrator.
 * Despite the historical name "HeroSpeech", this covers both hero AND npc
 * dialogue — `spriteUrl` is pre-resolved so the renderer doesn't branch on
 * character kind.
 */
export interface HeroSpeech {
  /** Stable key derived from event ordering — `${actorId}:${chat index}`. */
  key: string;
  actorId: string;
  actorName: string;
  /** Pre-resolved portrait URL (heroes: /assets/heroes/<archetype>/south.png;
   *  npcs: /assets/npcs/<sprite>/south.png). Undefined falls back to placeholder. */
  spriteUrl?: string;
  /** True when the speaker is a monster. Monster sprites aren't humanoid (e.g.
   *  the low, horizontal giant rat), so the portrait shows the whole sprite
   *  scaled to fit rather than the humanoid head-crop that would clip the face. */
  isMonster?: boolean;
  text: string;
}

/** Resolve the speech-portrait URL for a hero, NPC, or monster. Returns
 *  undefined when the character has no archetype (hero) / sprite (npc / monster).
 *  Monsters speak when the DM voices an off-turn enemy reaction (see
 *  `reactAsMonsters`) — their bubble uses the same `/assets/monsters/<sprite>`
 *  portrait the turn-order bar / dice HUD use. */
export const characterSpeechSpriteUrl = (c: RedactedCharacter): string | undefined => {
  if (c.kind === 'hero' && c.archetype)  return `${ASSETS_BASE}/heroes/${c.archetype}/south.png`;
  if (c.kind === 'npc' && c.sprite)      return `${ASSETS_BASE}/npcs/${c.sprite}/south.png`;
  if (c.kind === 'monster' && c.sprite)  return `${ASSETS_BASE}/monsters/${c.sprite}/south.png`;
  return undefined;
};

/**
 * Pure: gather hero AND npc `say` events from chat into HeroSpeech rows.
 * Returns the speeches in chat order. Each row carries a `key` formed from
 * the chat index so callers can de-duplicate against a render-state list
 * (entries earlier than the last-seen key are already shown).
 */
export const selectHeroSpeechFeed = (
  chat: ChatEntry[],
  characters: ReadonlyArray<RedactedCharacter>,
): HeroSpeech[] => {
  const byId = new Map<string, RedactedCharacter>();
  for (const c of characters) byId.set(String(c.id), c);
  const out: HeroSpeech[] = [];
  for (let i = 0; i < chat.length; i++) {
    const e = chat[i]!.event as AnyEvent;
    if (e.type !== 'action' || !e.actorId || e.actorId === 'dm') continue;
    if (e.action?.kind !== 'say' || typeof e.action.text !== 'string') continue;
    const actor = byId.get(e.actorId);
    if (!actor || (actor.kind !== 'hero' && actor.kind !== 'npc' && actor.kind !== 'monster')) continue;
    // A monster `say` written as third-person narration ("The King Rat squeaks…")
    // is the DM narrating the foe, not the foe speaking — it belongs in the
    // DM-narration caption, not a first-person speech bubble (see Layout's
    // `matchQueueItems`, the live path). Skip it here for parity.
    if (actor.kind === 'monster' && monsterSayReadsAsNarration(e.action.text, actor.name)) continue;
    const spriteUrl = characterSpeechSpriteUrl(actor);
    out.push({
      key: `${e.actorId}:${i}`,
      actorId: e.actorId,
      actorName: actor.name,
      ...(spriteUrl !== undefined ? { spriteUrl } : {}),
      ...(actor.kind === 'monster' ? { isMonster: true } : {}),
      text: e.action.text,
    });
  }
  return out;
};

const ASSETS_BASE = '/assets';

const heroSpeechLine = (s: HeroSpeech): TemplateResult => {
  const sprite = s.spriteUrl ?? null;
  const headClass = s.isMonster ? 'hero-head hero-head--monster' : 'hero-head';
  // The `.hero-text` span has NO dynamic child interpolations on purpose —
  // lit-html preserves child nodes of containers with no dynamic children, so
  // `paintHeroSpeeches()` can typewrite into it without lit-html clobbering
  // mid-animation. `data-speech-key` / `data-speech-text` carry the payload
  // the imperative painter reads.
  return html`
    <div class="hero-speech-line" data-key=${s.key}>
      <div class="hero-portrait">
        <span class="hero-name">${s.actorName}</span>
        ${sprite
          ? html`<span
              class=${headClass}
              role="img"
              aria-label=${s.actorName}
              style="background-image: url('${sprite}')"
            ></span>`
          : html`<span class="hero-head hero-head-placeholder" aria-hidden="true"></span>`}
      </div>
      <span
        class="hero-text"
        data-speech-key=${s.key}
        data-speech-text=${s.text}
      ></span>
    </div>
  `;
};

/**
 * Vertical UI stack rendered directly below the in-game board. Order:
 *   1. .player-echo         — when the player has just asked the DM an OOC
 *                             question, a "Player asked: …" tag sits ABOVE
 *                             the narrator text so the question reads as a
 *                             prologue to the DM's reply (the reply itself
 *                             lands in `.narrator-text` below, with the
 *                             typewriter effect). Omitted for in-character
 *                             ('game') submissions, which already render as
 *                             a hero-speech bubble in the queue.
 *   2. .narrator-text       — DM narration (imperatively painted so lit-html
 *                             re-renders don't clobber it). When the DM has
 *                             just answered an OOC question, Layout pipes
 *                             the reply into this slot so it typewriter-
 *                             reveals like a normal narration beat.
 *   3. .hero-speech-feed    — recent hero dialogue (each line held for a
 *                             minimum duration; managed by Layout.ts)
 *   4. dialogSkipSlot       — "▶ Skip" / "⏸ Auto-skip ON" toggle that lets
 *                             the player advance the current narration or
 *                             speech beat (manual default). Rendered as a
 *                             slot so Layout.ts owns the click handler and
 *                             label state.
 *   5. rollSlot             — dice-roll panel (entrance pulse + fade)
 *   6. slot                 — player input (action buttons or describe panel)
 *
 * Each section is omitted when empty so the stack collapses naturally between
 * turns. `.narrator-text` is intentionally empty here — `updateNarratorText`
 * paints it imperatively; lit-html preserves nodes with no dynamic
 * interpolations, so the inner div survives across renders.
 */
/** Player echo payload — either a plain string (legacy in-character echo) or
 *  an object with the message + target. When `target: 'dm'`, the echo is
 *  rendered with a "Player asked" tag above the narrator text so the user
 *  sees their question framed as the prologue to the DM's response. The DM
 *  reply itself REPLACES the narrator line (with typewriter), so the
 *  question + answer read as a single thread above/below each other. The
 *  optional `reply` field is accepted for backwards compatibility but is
 *  no longer rendered here — Layout pipes it into the narrator text slot
 *  instead. */
export type PlayerEcho =
  | string
  | { text: string; target: 'game' | 'dm'; reply?: string | null };

const playerEchoView = (echo: PlayerEcho): TemplateResult => {
  const [text, target]: [string, 'game' | 'dm'] = typeof echo === 'string'
    ? [echo, 'game']
    : [echo.text, echo.target];
  if (target === 'dm') {
    return html`
      <div class="player-echo player-echo--dm" data-target="dm">
        <div class="player-echo-row" data-role="question">
          <span class="player-echo-indicator" aria-label=${t('echo.askedDmAria')}>
            <span class="player-echo-indicator-icon" aria-hidden="true">🎲</span>
            <span class="player-echo-indicator-label">${t('echo.playerAsked')}</span>
          </span>
          <span class="player-echo-text">${markdownInline(text)}</span>
        </div>
      </div>
    `;
  }
  return html`
    <div class="player-echo" data-target="game">${markdownInline(text)}</div>
  `;
};

export const narratorWindow = (
  slot: TemplateResult | null = null,
  playerEcho: PlayerEcho | null = null,
  heroSpeeches: ReadonlyArray<HeroSpeech> = [],
  rollSlot: TemplateResult | null = null,
  dialogSkipSlot: TemplateResult | null = null,
): TemplateResult => html`
  <div class="narrator-window" role="status" aria-live="polite">
    ${playerEcho !== null ? playerEchoView(playerEcho) : ''}
    <div class="narrator-text"></div>
    ${heroSpeeches.length > 0
      ? html`<div class="hero-speech-feed">${heroSpeeches.map(heroSpeechLine)}</div>`
      : ''}
    ${dialogSkipSlot ?? ''}
    ${rollSlot ?? ''}
    ${slot ?? ''}
  </div>
`;

/** Anything holding a cancellable typewriter interval. Both the narrator
 *  painter state and the hero-speech painter state implement this so they
 *  can share `startTypewriter` / `sliceSegments` machinery below. */
interface TypewriterTimerHolder {
  typeTimer: ReturnType<typeof setInterval> | null;
}

interface NarratorPaintState extends TypewriterTimerHolder {
  current: string | null;
  /** Pending fade-swap timer, so a rapid second update cancels the first. */
  fadeTimer: ReturnType<typeof setTimeout> | null;
}

const stateMap = new WeakMap<HTMLElement, NarratorPaintState>();

/** Per-direction fade duration. The full transition (out → swap → in) takes
 *  ~2× this. Kept short so the playback queue's minimum-display windows still
 *  dominate the user-perceived hold. */
const FADE_MS = 220;

/** Typewriter tick. ~22ms/char ≈ 45 chars/sec — cinematic pace that still
 *  gives the player time to read the DM's narration as it appears.
 *  Exported so `Layout.ts` can size each playback-queue hold window as
 *  `text.length * TYPEWRITER_CHAR_MS + POST_REVEAL_HOLD_MS`, guaranteeing
 *  that the line stays on screen for the full post-reveal hold regardless
 *  of how long the typewriter itself took. */
export const TYPEWRITER_CHAR_MS = 22;

const setPlaceholder = (el: HTMLElement): void => {
  // Empty marker span (no visible glyph): the class is the "no narration yet"
  // state hook for tests/CSS, but painting an actual "…" read as a stray
  // three-dot artifact floating under the board while the DM composed.
  const span = document.createElement('span');
  span.className = 'narrator-placeholder';
  el.replaceChildren(span);
};

const writeText = (el: HTMLElement, text: string | null): void => {
  if (text === null) {
    setPlaceholder(el);
  } else {
    // innerHTML is safe: markdownInlineRefsHtml HTML-escapes the raw text
    // before wrapping bold / italic / code / strike tags (and ref chips)
    // around it.
    el.innerHTML = markdownInlineRefsHtml(text);
  }
};

/** Split the parsed segments at character offset `revealed`, returning both
 *  halves with their bold/italic/code/strike flags intact. The partial
 *  segment at the cursor is split into a visible head and a hidden tail.
 *
 *  The typewriter paints `visible` as live HTML and `hidden` inside a
 *  `visibility: hidden` span so the unrevealed text reserves its final
 *  layout width from frame 0. Without that reservation a centered or
 *  flex-aligned container re-centers as each char appears, sliding the
 *  already-revealed letters around — exactly what we want to avoid. */
const sliceSegmentsAt = (
  segs: ReadonlyArray<MdSegment>,
  revealed: number,
): { visible: MdSegment[]; hidden: MdSegment[] } => {
  const visible: MdSegment[] = [];
  const hidden: MdSegment[] = [];
  let remaining = revealed;
  for (const s of segs) {
    if (remaining <= 0) {
      hidden.push(s);
      continue;
    }
    if (s.text.length <= remaining) {
      visible.push(s);
      remaining -= s.text.length;
      continue;
    }
    visible.push({ ...s, text: s.text.slice(0, remaining) });
    hidden.push({ ...s, text: s.text.slice(remaining) });
    remaining = 0;
  }
  return { visible, hidden };
};

const paintTypewriterFrame = (
  el: HTMLElement,
  segs: ReadonlyArray<MdSegment>,
  revealed: number,
): void => {
  const { visible, hidden } = sliceSegmentsAt(segs, revealed);
  const visibleHtml = renderSegmentsHtml(visible);
  const hiddenHtml = renderSegmentsHtml(hidden);
  // Drop the hidden span entirely once we're done so the final innerHTML
  // matches plain `markdownInlineHtml(text)` — keeps DOM tidy and lets
  // selection / copy-paste behave normally after the reveal completes.
  el.innerHTML = hiddenHtml.length > 0
    ? `${visibleHtml}<span class="typewriter-hidden" aria-hidden="true">${hiddenHtml}</span>`
    : visibleHtml;
};

const startTypewriter = (
  el: HTMLElement,
  text: string,
  state: TypewriterTimerHolder,
): void => {
  const segs = parseWithRefs(text);
  const total = segs.reduce((n, s) => n + s.text.length, 0);
  if (total === 0) {
    el.innerHTML = '';
    return;
  }
  let revealed = 1;
  paintTypewriterFrame(el, segs, revealed);
  if (revealed >= total) return;
  state.typeTimer = setInterval(() => {
    revealed += 1;
    paintTypewriterFrame(el, segs, revealed);
    if (revealed >= total) {
      clearInterval(state.typeTimer!);
      state.typeTimer = null;
    }
  }, TYPEWRITER_CHAR_MS);
};

const cancelTimers = (state: NarratorPaintState): void => {
  if (state.fadeTimer !== null) {
    clearTimeout(state.fadeTimer);
    state.fadeTimer = null;
  }
  if (state.typeTimer !== null) {
    clearInterval(state.typeTimer);
    state.typeTimer = null;
  }
};

/**
 * Paint `text` into `textEl`. Idempotent: when the text hasn't changed, this
 * is a no-op. Pass `null` to render the empty placeholder. State is keyed off
 * the DOM node via WeakMap so multiple narrator instances wouldn't collide.
 *
 * First paint is synchronous (no fade, no typewriter) so unit tests and the
 * initial boot render see content immediately. Subsequent transitions fade
 * the current text out, swap the markup, then typewriter the new text in —
 * gated by inline opacity + a CSS `transition: opacity` rule on
 * `.narrator-text`. A new narration mid-typewriter cancels both timers and
 * restarts from scratch.
 *
 * `onAnimationChange` is kept for API compatibility and currently always
 * fires `false`; the fade + typewriter are short enough that we don't want
 * to lock the action buttons or other input behind them.
 *
 * When `instant` is true (AutoSkip mode), the fade + typewriter are skipped
 * entirely: the full text is written in one paint. Any in-flight reveal is
 * cancelled first so a mid-typewriter switch into AutoSkip snaps to the
 * finished line.
 */
export const updateNarratorText = (
  textEl: HTMLElement,
  text: string | null,
  onAnimationChange?: (busy: boolean) => void,
  instant = false,
): void => {
  let state = stateMap.get(textEl);
  if (!state) {
    state = { current: text, fadeTimer: null, typeTimer: null };
    stateMap.set(textEl, state);
    writeText(textEl, text);
    textEl.style.opacity = '1';
    onAnimationChange?.(false);
    return;
  }
  if (text === state.current) return;
  state.current = text;

  // A previous transition is mid-flight — cancel it. The pending swap is
  // discarded; the new text becomes the destination of a fresh fade.
  cancelTimers(state);

  // AutoSkip: paint the new text immediately, no fade or typewriter.
  if (instant) {
    writeText(textEl, text);
    textEl.style.opacity = '1';
    onAnimationChange?.(false);
    return;
  }

  textEl.style.opacity = '0';
  state.fadeTimer = setTimeout(() => {
    if (text === null) {
      setPlaceholder(textEl);
    } else {
      startTypewriter(textEl, text, state!);
    }
    textEl.style.opacity = '1';
    state!.fadeTimer = null;
  }, FADE_MS);
  onAnimationChange?.(false);
};

interface HeroSpeechPaintState extends TypewriterTimerHolder {
  /** The HeroSpeech `key` we last typed into this element. When a new key
   *  lands the typewriter restarts from char 0; on re-render with the same
   *  key the painter is a no-op so the running animation keeps going. */
  key: string | null;
}

const heroSpeechStateMap = new WeakMap<HTMLElement, HeroSpeechPaintState>();

/**
 * Paint hero-speech `text` into `el` with a typewriter reveal. Keyed off
 * the speech's stable `key` so re-renders of the same bubble are no-ops —
 * the in-flight typewriter keeps running. A new key cancels the previous
 * timer and starts fresh from char 0. Used by `paintHeroSpeeches()`.
 *
 * When `instant` is true (AutoSkip mode), the full bubble text is written in
 * one paint instead of typewriting it char-by-char.
 */
export const updateHeroSpeechText = (
  el: HTMLElement,
  key: string,
  text: string,
  instant = false,
): void => {
  let state = heroSpeechStateMap.get(el);
  if (!state) {
    state = { key: null, typeTimer: null };
    heroSpeechStateMap.set(el, state);
  }
  if (state.key === key) return;
  state.key = key;
  if (state.typeTimer !== null) {
    clearInterval(state.typeTimer);
    state.typeTimer = null;
  }
  if (instant) {
    el.innerHTML = markdownInlineRefsHtml(text);
    return;
  }
  startTypewriter(el, text, state);
};

/**
 * Walk `root` for any `.hero-text[data-speech-key][data-speech-text]` spans
 * and drive each through `updateHeroSpeechText`. Call this immediately after
 * lit-html `render(tpl, root)` so the typewriter takes effect in the same
 * paint frame as the bubble's first appearance — no flash of full text.
 *
 * Pass `instant: true` (AutoSkip mode) to write each bubble in full at once.
 */
export const paintHeroSpeeches = (root: ParentNode, instant = false): void => {
  const nodes = root.querySelectorAll('.hero-text[data-speech-key]');
  for (const el of Array.from(nodes)) {
    if (!(el instanceof HTMLElement)) continue;
    const key = el.dataset['speechKey'] ?? '';
    const text = el.dataset['speechText'] ?? '';
    updateHeroSpeechText(el, key, text, instant);
  }
};

/**
 * True iff a fade or typewriter is still in flight inside `el`. The Skip
 * button in the narrator window consults this on click: a click during a
 * reveal completes the line in place (see `completeTypewriter`) rather than
 * advancing the playback queue past the beat. Works for both `.narrator-text`
 * (NarratorPaintState) and `.hero-text` (HeroSpeechPaintState) — the caller
 * passes whichever element it cares about.
 */
export const isTypewriterActive = (el: HTMLElement): boolean => {
  const ns = stateMap.get(el);
  if (ns && (ns.typeTimer !== null || ns.fadeTimer !== null)) return true;
  const hs = heroSpeechStateMap.get(el);
  if (hs && hs.typeTimer !== null) return true;
  return false;
};

/**
 * Cancel any in-flight fade / typewriter for `el` and snap the final text
 * into place. No-op when nothing is animating or when the destination text
 * is null (placeholder). The companion to `isTypewriterActive` — Layout
 * calls this when the player clicks Skip mid-reveal so the rest of THIS
 * line appears at once without advancing past the beat.
 */
export const completeTypewriter = (el: HTMLElement): void => {
  const ns = stateMap.get(el);
  if (ns) {
    if (ns.fadeTimer !== null) { clearTimeout(ns.fadeTimer); ns.fadeTimer = null; }
    if (ns.typeTimer !== null) { clearInterval(ns.typeTimer); ns.typeTimer = null; }
    if (ns.current === null) {
      setPlaceholder(el);
    } else {
      el.innerHTML = markdownInlineRefsHtml(ns.current);
    }
    el.style.opacity = '1';
    return;
  }
  const hs = heroSpeechStateMap.get(el);
  if (hs) {
    if (hs.typeTimer !== null) { clearInterval(hs.typeTimer); hs.typeTimer = null; }
    const text = el.dataset['speechText'] ?? '';
    el.innerHTML = markdownInlineRefsHtml(text);
  }
};
