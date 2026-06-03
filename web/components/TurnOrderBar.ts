import { html, type TemplateResult } from 'lit-html';
import { ref, createRef } from 'lit-html/directives/ref.js';
import type { ChatEntry } from '../store.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { displayName } from './names.js';
import { t } from '../i18n.js';

const ASSETS_BASE = '/assets';

/** One slot on the turn-order tape. */
export interface TurnOrderEntry {
  id: string;
  name: string;
  archetype: string | null;
  sprite: string | null;
  kind: 'hero' | 'monster' | 'npc';
  /** True when this slot is the current actor (and still alive). */
  isActive: boolean;
  /** True when this character has been KO'd. They stay in their slot as a
   *  grey "DEAD" stub so the continuous-tape ordering is preserved. */
  isDead: boolean;
  /** True when the cursor has already moved past this slot in the current
   *  round. Renders dimmed during the brief moment it's still on-screen
   *  before the track translate clips it. */
  isPassed: boolean;
}

export interface TurnOrderState {
  /** All combatants from `combat_started.order` in declaration order. The
   *  array is stable across renders so the DOM nodes persist and the CSS
   *  translate on `.turn-order-track` produces a true continuous-tape
   *  slide as the cursor advances. */
  entries: TurnOrderEntry[];
  /** Index of the active actor in `entries`. Drives the `--turn-cursor`
   *  custom property on the track. */
  cursorIdx: number;
  /** Identifier for the combat instance — the `t` timestamp of the
   *  `combat_started` event. Used by the bar's slide state to detect
   *  combat changes and reset the snap tracking. */
  combatId: number;
}

interface AnyEvent {
  type?: string;
  order?: unknown[];
  t?: number;
}

/**
 * Pure: derive the turn-order tape state from chat + characters + active
 * actor. Returns null when combat isn't active (no recent `combat_started`,
 * or a `combat_ended` came after it).
 *
 * Dead-but-already-on-the-tape characters stay in their slot with
 * `isDead: true` so the tape's spatial ordering doesn't change when someone
 * gets KO'd. Filtering of "future not-yet-visible" combatants happens at the
 * render layer via the tape's overflow viewport — slots are mounted in the
 * DOM but clipped if they would never have entered the viewport.
 */
export const selectTurnOrder = (
  chat: ReadonlyArray<ChatEntry>,
  characters: ReadonlyArray<RedactedCharacter>,
  activeActor: string | null,
): TurnOrderState | null => {
  let lastStarted = -1;
  let lastEnded = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    const e = chat[i]?.event as AnyEvent | undefined;
    if (!e) continue;
    if (lastStarted === -1 && e.type === 'combat_started' && Array.isArray(e.order)) {
      lastStarted = i;
    }
    if (lastEnded === -1 && e.type === 'combat_ended') {
      lastEnded = i;
    }
    if (lastStarted !== -1 && lastEnded !== -1) break;
  }
  if (lastStarted === -1) return null;
  if (lastEnded > lastStarted) return null;

  const startedEvent = chat[lastStarted]!.event as AnyEvent;
  const orderIds = Array.isArray(startedEvent.order)
    ? startedEvent.order.map(String)
    : [];
  if (orderIds.length === 0) return null;

  const byId = new Map<string, RedactedCharacter>();
  for (const c of characters) byId.set(String(c.id), c);

  const activeId = activeActor !== null ? String(activeActor) : null;
  const rawCursor = activeId !== null ? orderIds.indexOf(activeId) : -1;
  // When the active actor isn't in the order (out of combat / interlude),
  // anchor the cursor at the head of the tape so the lead slot stays in view.
  const cursorIdx = rawCursor >= 0 ? rawCursor : 0;

  const entries: TurnOrderEntry[] = orderIds.map((id, i) => {
    const c = byId.get(id);
    const isDead = c !== undefined && c.health.status === 'KO';
    return {
      id,
      name: c ? displayName(c.name) : displayName(id),
      archetype: c?.archetype ?? null,
      sprite: c?.sprite ?? null,
      kind: c?.kind ?? 'hero',
      isActive: i === cursorIdx && !isDead && rawCursor >= 0,
      isDead,
      isPassed: i < cursorIdx,
    };
  });

  const combatId = typeof startedEvent.t === 'number' ? startedEvent.t : 0;
  return { entries, cursorIdx, combatId };
};

const avatarUrl = (
  kind: 'hero' | 'monster' | 'npc',
  archetype: string | null,
  sprite: string | null,
): string | null => {
  if (kind === 'hero' && archetype) return `${ASSETS_BASE}/heroes/${archetype}/south.png`;
  if (kind === 'monster' && sprite) return `${ASSETS_BASE}/monsters/${sprite}/south.png`;
  // 'npc' avatar lookup is deferred to Task 12 (manifest wiring for NPCs).
  // Until manifest.npcs exists, NPC slots fall through to the placeholder avatar below.
  return null;
};

const slotTpl = (
  entry: TurnOrderEntry,
  copyIdx: number,
  idx: number,
): TemplateResult => {
  const bg = avatarUrl(entry.kind, entry.archetype, entry.sprite);
  // Only the middle copy (copyIdx === 1) carries the active/passed visual
  // states. The other two copies are pure decoration — they tile the same
  // characters out to the left ("history") and right ("future preview"),
  // so the tape always has populated content beyond the lead, no matter
  // how far the slide has advanced. KO ("dead") is a character-state
  // property, not a turn-state one, so it applies to every copy of that
  // entry.
  const isMiddleCopy = copyIdx === 1;
  const classes = [
    'turn-order-slot',
    `turn-order-slot--${entry.kind}`,
    `turn-order-slot--copy-${copyIdx}`,
    isMiddleCopy && entry.isActive ? 'turn-order-slot--active' : '',
    entry.isDead ? 'turn-order-slot--dead' : '',
    isMiddleCopy && entry.isPassed ? 'turn-order-slot--passed' : '',
  ].filter(Boolean).join(' ');
  return html`
    <div
      class=${classes}
      data-actor-id=${entry.id}
      data-slot-idx=${idx}
      aria-label=${entry.isDead ? `${entry.name} — dead` : entry.name}
    >
      <span class="turn-order-coin-cell" aria-hidden="true">
        <span class="turn-order-coin">
          <span class="turn-order-coin-ring"></span>
          ${bg
            ? html`<span
                class=${`turn-order-avatar turn-order-avatar--${entry.kind}`}
                role="img"
                aria-label=${entry.name}
                style="background-image: url('${bg}')"
              ></span>`
            : html`<span class="turn-order-avatar turn-order-avatar--placeholder" aria-hidden="true"></span>`}
          ${entry.isDead
            ? html`<span class="turn-order-skull" aria-hidden="true">✕</span>`
            : ''}
        </span>
      </span>
      <span class="turn-order-info">
        <span class="turn-order-name">${entry.name}</span>
        ${entry.isDead
          ? html`<span class="turn-order-dead-label" aria-hidden="true">${t('turnOrder.dead')}</span>`
          : ''}
      </span>
    </div>
  `;
};

// Module-level ref to the track element. lit-html updates this in place when
// the bar (re)renders, so we can measure the current DOM in the post-render
// effect below without a global `document.querySelector`.
const trackRef = createRef<HTMLElement>();

// Number of times the entries are tiled in the DOM. We always keep the
// active slot in the MIDDLE copy (index 1) so the viewport has populated
// content on both sides of the lead at every moment — that's what allows
// the per-round "snap" (shift by exactly one cycleWidth) to be invisible:
// the characters at every visible position match before and after.
const COPIES = 3;

// Slide-state tracked across renders so we can detect the wrap moment
// (cursor returning from the last slot back to the first) and run an
// invisible snap-then-animate instead of letting the CSS transition play
// the rewind. Reset whenever the combat instance changes.
interface SlideState {
  combatId: number;
  prevCursorIdx: number;
}
let slideState: SlideState | null = null;

/**
 * Heraldic ribbon rendered above the board listing the current round's turn
 * order as a continuous tape. The active actor sits at the lead (left); as
 * turns advance, the tape slides right-to-left so the next character drops
 * into the lead position. KO'd characters stay in their slot rendered as
 * grey "DEAD" stubs — they're not removed, so the tape's positions never
 * shift unexpectedly.
 *
 * Implementation: slots have intrinsic widths (each fits its avatar + name),
 * so the slide amount per turn varies. After every render we measure the
 * active slot's `offsetLeft` and write `--turn-offset` in pixels onto the
 * track. The CSS transition on `transform` then drives the smooth slide.
 * The inline `--turn-cursor` is kept as a render-time hint for tests and
 * debugging; it doesn't drive the visual position itself.
 *
 * Infinite-tape illusion: the slide animation runs only for FORWARD moves
 * (track sliding further left). When the cursor wraps from the last slot
 * back to the first — which would otherwise produce a visible rewind
 * animation right across the whole round — we kill the CSS transition for
 * just that frame and snap the track to its new position. To the viewer
 * the tape never animates backwards; it either advances smoothly or it's
 * already in its new place when the next round begins.
 */
export const turnOrderBar = (state: TurnOrderState | null): TemplateResult => {
  if (state === null || state.entries.length === 0) {
    slideState = null;
    return html``;
  }
  const N = state.entries.length;
  // Schedule the post-commit measurement+slide as a microtask. Microtasks
  // run synchronously after lit-html's render() returns but BEFORE the
  // browser's next paint — so the active slot's --turn-offset is set in
  // the same frame the new DOM is committed. requestAnimationFrame would
  // fire on or after the paint, leaving one frame where the track is at
  // the old offset and the user sees a small "correction" slide as the
  // RAF callback catches up.
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => {
      const track = trackRef.value;
      if (!track) return;
      const slots = track.querySelectorAll<HTMLElement>('.turn-order-slot');
      if (slots.length < COPIES * N) return;
      // Active slot lives in the middle copy (index 1). Its DOM index is
      // N + cursorIdx. The end of the previous copy (slot[N - 1]) is the
      // snap target — visually identical to the end of the middle copy
      // (slot[2N - 1]) because the entries repeat every cycleWidth.
      const activeSlot = slots[N + state.cursorIdx];
      const prevCopyEnd = slots[N - 1];
      if (!activeSlot || !prevCopyEnd) return;

      const activeOffset = -activeSlot.offsetLeft;

      const combatChanged =
        slideState === null || slideState.combatId !== state.combatId;
      const wrapped =
        !combatChanged &&
        slideState !== null &&
        slideState.prevCursorIdx >= 0 &&
        state.cursorIdx < slideState.prevCursorIdx;

      if (combatChanged) {
        // First render of a new combat: place the track at the active
        // slot's position with no transition (so the bar doesn't animate
        // in from wherever it was last frame for the previous combat).
        track.style.transition = 'none';
        track.style.setProperty('--turn-offset', `${activeOffset}px`);
        void track.offsetWidth;
        track.style.transition = '';
        slideState = { combatId: state.combatId, prevCursorIdx: state.cursorIdx };
        return;
      }

      if (wrapped) {
        // Invisible cycle snap. The previous frame left the track with the
        // middle-copy END (slot[2N-1]) at the lead. Snap the track right by
        // exactly one cycleWidth so the PREVIOUS-copy end (slot[N-1]) is
        // now at the lead — same character, same visible neighbours, no
        // visual change. Then animate forward to the active slot, which is
        // one step to the right of slot[N-1]. The browser commits the
        // snap and the new animated target in a single frame so the
        // intermediate state is never painted as a separate step.
        track.style.transition = 'none';
        track.style.setProperty('--turn-offset', `${-prevCopyEnd.offsetLeft}px`);
        void track.offsetWidth;
        track.style.transition = '';
        track.style.setProperty('--turn-offset', `${activeOffset}px`);
      } else {
        // Normal forward step within the round — let the CSS transition
        // animate the slide.
        track.style.setProperty('--turn-offset', `${activeOffset}px`);
      }
      slideState!.prevCursorIdx = state.cursorIdx;
    });
  }
  // Render entries × COPIES. Copy 1 (middle) is the "active" copy whose
  // slot template renders the active/passed visual state; the other
  // copies are decorative tiles that fill the viewport beyond the lead.
  const copies: Array<{ entry: TurnOrderEntry; copyIdx: number; idx: number }> = [];
  for (let c = 0; c < COPIES; c++) {
    state.entries.forEach((entry, i) => copies.push({ entry, copyIdx: c, idx: i }));
  }
  return html`
    <div class="turn-order-bar" role="status" aria-live="polite" aria-label="Turn order">
      <div class="turn-order-viewport">
        <div
          ${ref(trackRef)}
          class="turn-order-track"
          style=${`--turn-cursor: ${state.cursorIdx}`}
        >
          ${copies.map(({ entry, copyIdx, idx }) => slotTpl(entry, copyIdx, idx))}
        </div>
      </div>
    </div>
  `;
};
