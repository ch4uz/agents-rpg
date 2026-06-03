/**
 * Transient emoji balloon: a simple translucent dialog shape that floats
 * above a hero's sprite for ~2.3s, then fades. Mounted into the same
 * `.mini-bar-layer` overlay div as the HP bars and emoji props, so it
 * shares the canvas-scale math via the caller-supplied `positionAt`
 * closure.
 *
 * The shape (rounded body + downward tail) is a single inline SVG path
 * with a dark-gray translucent fill — no strokes, no gradients, no chrome.
 * The emoji glyph stays as an HTML <span> on top so native color-emoji
 * rendering still applies.
 *
 * Lifecycle is timer-driven (wall clock). Board owns the per-actor stack
 * and is responsible for repositioning the balloon if the actor moves
 * during its lifetime — see Board.ts onResize / move-anim ticker.
 */

export interface SpawnEmojiBalloonOpts {
  /** Overlay div that wraps the canvas; balloons mount here. */
  overlayLayer: HTMLDivElement;
  /** Emoji glyph (single grapheme expected, but no enforcement). */
  emoji: string;
  /** Grid cell of the actor at spawn time. */
  gridX: number;
  gridY: number;
  /**
   * Positions the balloon element relative to a cell. Caller wraps
   * Board's `positionMiniBar` math with an extra vertical lift so the
   * balloon sits above the hero's head rather than at the cell edge.
   */
  positionAt: (el: HTMLDivElement, gridX: number, gridY: number) => void;
  /**
   * Per-actor stack index. 0 = newest, 1, 2 fan up-and-right so older
   * balloons remain visible.
   */
  stackIndex: number;
}

export interface EmojiBalloonHandle {
  /** The mounted DOM element. Repositioned by Board on move / resize. */
  el: HTMLDivElement;
  /** Force-remove early (used when stack overflows). */
  dispose: () => void;
}

export const EMOTE_BALLOON_HOLD_MS = 1800;
export const EMOTE_BALLOON_FADE_MS = 500;
/** Total lifetime before DOM removal. */
export const EMOTE_BALLOON_LIFETIME_MS =
  EMOTE_BALLOON_HOLD_MS + EMOTE_BALLOON_FADE_MS;

/**
 * Inline SVG for the balloon shape — a single path filled with a
 * translucent neutral dark gray. The path defines a rounded body
 * (corners at (96,12)/(96,58)/(4,58)/(4,12)) with a triangular tail
 * descending to apex (50, 82). No strokes, no gradients, no chrome.
 */
const BALLOON_SVG =
  '<svg class="emote-svg" viewBox="0 0 100 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="xMidYMid meet">' +
  '<path d="M 12 4 L 88 4 Q 96 4 96 12 L 96 50 Q 96 58 88 58 L 60 58 L 50 82 L 40 58 L 12 58 Q 4 58 4 50 L 4 12 Q 4 4 12 4 Z" ' +
  'fill="rgba(20, 22, 26, 0.45)" stroke="none"/>' +
  '</svg>';

export const spawnEmojiBalloon = (opts: SpawnEmojiBalloonOpts): EmojiBalloonHandle => {
  const { overlayLayer, emoji, gridX, gridY, positionAt, stackIndex } = opts;

  const el = document.createElement('div');
  el.className = 'emote-balloon';
  // Stack offset: each older balloon fans up (negative Y) and right.
  el.style.setProperty('--stack-x', `${stackIndex * 14}px`);
  el.style.setProperty('--stack-y', `${stackIndex * -10}px`);

  // Mount the balloon SVG. innerHTML is fine here — the markup is fully
  // hardcoded inside this module, so there's no untrusted user content
  // that could escape into the DOM.
  el.innerHTML = BALLOON_SVG;

  const glyph = document.createElement('span');
  glyph.className = 'emote-glyph';
  glyph.textContent = emoji;
  el.appendChild(glyph);

  overlayLayer.appendChild(el);
  positionAt(el, gridX, gridY);

  let disposed = false;
  // setTimeout indirection keeps the IDs scoped so dispose() can clear them.
  const fadeTimer = window.setTimeout(() => {
    if (!disposed) el.classList.add('emote-balloon--fading');
  }, EMOTE_BALLOON_HOLD_MS);
  const removeTimer = window.setTimeout(() => {
    if (!disposed) {
      disposed = true;
      el.remove();
    }
  }, EMOTE_BALLOON_LIFETIME_MS);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(fadeTimer);
    window.clearTimeout(removeTimer);
    el.remove();
  };

  return { el, dispose };
};
