import { Text, FillGradient, type Container } from 'pixi.js';

/**
 * Drop a HIT/MISS callout above the (x, y) tile position. The label scales
 * up with overshoot, drifts upward, then fades. Anchored at bottom-center
 * so the caller passes the cell's top-center pixel coordinates.
 *
 * Visual style is deliberately arcade — King of Fighters / Capcom-style:
 *  - HIT pops in a fire-yellow → orange → red vertical gradient, large.
 *  - MISS is smaller, flat gray, italic — quieter so it doesn't compete
 *    with HIT for retina attention.
 *  - Both share a thick black outline, drop shadow, and a slight italic
 *    skew (Jersey 10 lacks true italic glyphs, so we slant the sprite).
 */

// Top-to-bottom: hot core, fiery mid, scorched bottom. Color stops chosen so
// the brightest band sits ≈ ⅓ down the glyph, the way KoF-style FX read on
// a CRT.
const HIT_GRADIENT_STOPS = [
  { offset: 0.0,  color: '#fff6a3' },  // pale yellow highlight
  { offset: 0.35, color: '#ffe23a' },  // saturated yellow
  { offset: 0.7,  color: '#ff7a14' },  // orange
  { offset: 1.0,  color: '#c61f12' },  // deep red base
] as const;

const MISS_FLAT_COLOR = '#b8c0c8';

const buildLinearGradient = (stops: readonly { offset: number; color: string }[]): FillGradient =>
  new FillGradient({
    type: 'linear',
    // Local-space gradient (default): 0 maps to the top of the text bbox,
    // 1 maps to the bottom — exactly what we want for a vertical color sweep.
    start: { x: 0, y: 0 },
    end:   { x: 0, y: 1 },
    colorStops: stops as { offset: number; color: string }[],
  });

/**
 * Per-anchor stack slot tracking. When two HIT/MISS labels fire at the same
 * tile before the first fades, the second claims the next free slot and is
 * pushed upward by `slot * STACK_OFFSET_PX` so the two read as stacked
 * column instead of overlapping pixel-perfectly. Slots are released on
 * teardown so a third label after the first fades reuses slot 0.
 *
 * Keyed by `(parent.uid, roundedX, roundedY)` — different boards / tiles
 * keep independent stacks. Sub-pixel anchor jitter is normalized away by
 * rounding the coordinates.
 */
const activeStackSlots = new Map<string, Set<number>>();
const STACK_OFFSET_PX = 52;

const stackKey = (parent: Container, x: number, y: number): string =>
  `${(parent as unknown as { uid?: number | string }).uid ?? 'p'}_${Math.round(x)}_${Math.round(y)}`;

const claimStackSlot = (key: string): number => {
  let slots = activeStackSlots.get(key);
  if (!slots) {
    slots = new Set<number>();
    activeStackSlots.set(key, slots);
  }
  let idx = 0;
  while (slots.has(idx)) idx += 1;
  slots.add(idx);
  return idx;
};

const releaseStackSlot = (key: string, idx: number): void => {
  const slots = activeStackSlots.get(key);
  if (!slots) return;
  slots.delete(idx);
  if (slots.size === 0) activeStackSlots.delete(key);
};

export const flashRoll = (
  parent: Container,
  x: number,
  y: number,
  hit: boolean,
  durationMs = 2000,
): void => {
  const key = stackKey(parent, x, y);
  const slot = claimStackSlot(key);
  const baseY = y - slot * STACK_OFFSET_PX;
  const gradient = hit ? buildLinearGradient(HIT_GRADIENT_STOPS) : null;
  // The board canvas is CSS-upscaled ~2-3× with `image-rendering: pixelated`,
  // so anything Pixi rasterizes at the renderer's default resolution gets
  // nearest-neighbor magnified by CSS. For a pixel font like Jersey 10, that
  // turns Canvas2D's subpixel antialiasing into visible blur. Pre-rasterizing
  // the text at a higher resolution gives the texture enough density that
  // the CSS upscale (and the scale animation below) doesn't lose definition.
  // `devicePixelRatio * 2` matches HiDPI displays without exploding texture
  // memory; clamp the floor to 3 so non-HiDPI screens still get a sharp glyph.
  const TEXT_RESOLUTION = Math.max(
    3,
    Math.ceil((typeof window !== 'undefined' ? window.devicePixelRatio : 1) * 2),
  );
  const label = new Text({
    text: hit ? 'HIT!' : 'MISS',
    resolution: TEXT_RESOLUTION,
    // Match the rest of the canvas's pixel-art texture filtering. Without
    // this, Pixi bilinear-filters the rasterized glyph whenever the scale
    // animation samples it at non-integer factors — the AA'd glyph's soft
    // edges get smeared by each frame's interpolation, reading as "blur".
    // Nearest-neighbor preserves the edge definition the resolution bump
    // already gave us. The `textureStyle` option is the Pixi v8 supported
    // path for this (the Text class doesn't expose its internal texture).
    textureStyle: { scaleMode: 'nearest' },
    // Round on-screen position to whole pixels each frame so the texture
    // samples on aligned boundaries — sub-pixel positioning is a secondary
    // blur source even with nearest-filter sampling.
    roundPixels: true,
    style: {
      fontFamily: '"Jersey 10", "Press Start 2P", monospace',
      // HIT dominates the screen at 48 px; MISS sits noticeably smaller so
      // it reads as a quieter callout. Both stay inside one tile post-settle.
      fontSize: hit ? 48 : 28,
      fontWeight: hit ? '900' : '700',
      // Italic for arcade slant. Most pixel fonts lack a true italic face,
      // so this is paired with `label.skew.x` below to guarantee the slant
      // shows even when the font falls back to its upright glyphs.
      fontStyle: 'italic',
      fill: gradient ?? MISS_FLAT_COLOR,
      // Heavy stroke gives HIT its "stamped onto the screen" look. MISS
      // takes a thinner outline to match its smaller body.
      stroke: { color: 0x000000, width: hit ? 6 : 3, join: 'round' },
      dropShadow: {
        color: 0x000000,
        alpha: 0.9,
        blur: 3,
        distance: 3,
        // Below + slightly right — same convention as the parent canvas's
        // existing prop/token shadows.
        angle: Math.PI / 2,
      },
      letterSpacing: 3,
    },
  });
  label.anchor.set(0.5, 1.0);
  // Skew the sprite ~10° leftward at the top so it reads as italic even when
  // the underlying font has no italic glyphs. Slight, not theatrical.
  label.skew.set(-0.18, 0);
  label.x = Math.round(x);
  label.y = Math.round(baseY);
  parent.addChild(label);

  const t0 = performance.now();
  const RISE_PX = 28;          // a touch more travel than before
  // KoF-style pop: overshoot bigger, settle tighter so the label "bites"
  // onto the target before settling.
  const POP_MS = 140;
  const POP_FROM = 0.55;
  const POP_TO = 1.30;
  const SETTLE_MS = 200;
  const POP_SETTLE = 1.0;

  const tick = () => {
    const elapsed = performance.now() - t0;
    if (elapsed > durationMs) {
      parent.removeChild(label);
      label.destroy();
      // FillGradient owns a GPU texture under the hood; release it.
      gradient?.destroy();
      releaseStackSlot(key, slot);
      return;
    }
    // Two-segment scale: overshoot, then ease back.
    let s: number;
    if (elapsed < POP_MS) {
      const k = elapsed / POP_MS;
      s = POP_FROM + (POP_TO - POP_FROM) * k;
    } else {
      const k = Math.min(1, (elapsed - POP_MS) / SETTLE_MS);
      // Quadratic ease-out for a cushioned settle.
      const eased = 1 - (1 - k) * (1 - k);
      s = POP_TO + (POP_SETTLE - POP_TO) * eased;
    }
    label.scale.set(s);
    // Drift up the whole duration; fade only over the final third so the
    // value stays legible for most of its life. Round to integer pixels so
    // the texture samples on aligned boundaries — sub-pixel positioning is
    // a secondary source of perceived blur even with nearest-filter sampling.
    const t = elapsed / durationMs;
    label.y = Math.round(baseY - RISE_PX * t);
    label.alpha = t < 0.66 ? 1 : Math.max(0, 1 - (t - 0.66) / 0.34);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
