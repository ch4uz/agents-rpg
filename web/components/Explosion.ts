import { Container, Graphics } from 'pixi.js';

/**
 * 16-bit pixel-art explosion for an explosive obstacle (the oil cask).
 * When a cask is smashed the engine emits a `blast { pos, radius, ... }` on the
 * resolution event; the board fires `triggerExplosion` over the inflicted area.
 *
 * Style target: SNES-era fire VFX (think Chrono Trigger). Instead of the old
 * smooth, additive-blended fireball this draws onto a coarse ART-PIXEL grid —
 * chunky opaque squares, a hard-banded fire palette (white-hot → maroon) with
 * NO gradients, a stepped ~12-frame animation (not a continuous 60fps tween),
 * a classic 8-point ignition star, flying ember pixels, and a resolve into
 * drifting gray smoke. Self-contained transient VFX, same idiom as `flashRoll`:
 * add a Container to the board, step it with requestAnimationFrame, then destroy
 * it. No asset — pure Pixi Graphics. (The board's lighting pass still emits the
 * blast glow separately, so the sprite itself stays crisp and opaque.)
 */

export interface ExplosionCell { x: number; y: number }

/**
 * Pure: every in-bounds grid cell within Chebyshev `radius` of `pos` — the
 * exact area an explosive obstacle's blast inflicts (matches the engine's
 * `chebyshevDistance(c.pos, pos) <= radius` victim test). Out-of-bounds cells
 * are clipped so a cask blown at the map edge doesn't flash off-grid.
 */
export const explosionCells = (
  pos: { x: number; y: number },
  radius: number,
  gridW: number,
  gridH: number,
): ExplosionCell[] => {
  const out: ExplosionCell[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = pos.x + dx;
      const y = pos.y + dy;
      if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
      out.push({ x, y });
    }
  }
  return out;
};

export interface TriggerExplosionOpts {
  /** Blast origin cell (the cask). */
  pos: { x: number; y: number };
  /** Chebyshev blast radius (from the engine's `blast.radius`). */
  radius: number;
  /** Cell size in pixels (CELL_PX). */
  cellPx: number;
  /** Scene grid bounds, so edge blasts don't flash off-grid. */
  gridW: number;
  gridH: number;
  /** Total animation length. */
  durationMs?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ----------------------------------------------------------------------------
// Palettes — hard color bands, no interpolation. The fire ramp runs hot→cool;
// the smoke ramp light→dark. These are the only colors a frame ever paints, so
// the result reads as a hand-limited 16-bit sprite rather than a soft glow.
// ----------------------------------------------------------------------------
const FIRE_RAMP = [
  0xfff7d6, // 0 white-hot core
  0xffe24a, // 1 bright yellow
  0xffa022, // 2 amber
  0xf2600f, // 3 orange
  0xc0260a, // 4 red
  0x7a1208, // 5 deep maroon rim
] as const;
const SMOKE_RAMP = [
  0x9b8f86, // light ash
  0x6f655d, // mid smoke
  0x473f3a, // dark smoke
] as const;
const SPARK_HOT = 0xfffdf2; // star tip / fresh ember
const SPARK_MID = 0xffe24a; // star body
const EMBER_MID = 0xf2600f;
const EMBER_OLD = 0x7a1208;

// ----------------------------------------------------------------------------
// Hand-tuned animation frames. Each index is one rendered cel (no tweening
// between them). Same length across all tables == NUM_FRAMES.
//   RADIUS_FRAC — fireball size vs the full blast radius
//   COOL_BANDS  — bands added to every pixel's fire index (center cools to red)
//   SMOKE_AMT   — fraction of the cloud (outer-in) that has turned to smoke
//   ALPHA_F     — whole-effect opacity (smoke fades the tiles back in)
//   DRIFT_PX    — upward smoke drift, in art-pixels
//   SPARK_FRAC  — ignition-star reach / visibility (0 = gone)
// ----------------------------------------------------------------------------
//                          f:   0     1     2     3     4     5     6     7     8     9    10    11
const RADIUS_FRAC = [           0.30, 0.62, 0.85, 1.00, 1.06, 1.08, 1.05, 0.98, 0.90, 0.80, 0.72, 0.64] as const;
const COOL_BANDS  = [           0,    0,    0,    0,    1,    1,    2,    2,    3,    3,    3,    3   ] as const;
const SMOKE_AMT   = [           0,    0,    0,    0,    0,    0.10, 0.25, 0.45, 0.65, 0.85, 0.95, 1.00] as const;
const ALPHA_F     = [           1,    1,    1,    1,    1,    1,    1,    0.96, 0.90, 0.78, 0.55, 0.28] as const;
const DRIFT_PX    = [           0,    0,    0,    0,    0,    0,    0,    1,    2,    3,    5,    7   ] as const;
const SPARK_FRAC  = [           0.5,  1.0,  0.7,  0.35, 0,    0,    0,    0,    0,    0,    0,    0   ] as const;
const NUM_FRAMES = RADIUS_FRAC.length;

const SPARK_DIRS = 8;   // 8-point ignition star
const NUM_EMBERS = 14;  // flying pixel sparks
const NUM_PUFFS = 7;    // central blob + ring lobes that make the lumpy outline

/** Deterministic 0..1 hash so a given blast cell always bursts the same shape
 *  (no Math.random — keeps the VFX stable for the same cask, like the engine). */
const hash01 = (n: number): number => {
  let t = (n | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Queue a fill-color → flat [x,y,x,y,…] top-left rect map, then flush it as
 *  one Pixi path per color (so a frame is a handful of `fill()` calls, not one
 *  per pixel). */
type Buckets = Map<number, number[]>;
const push = (b: Buckets, color: number, x: number, y: number): void => {
  let arr = b.get(color);
  if (!arr) { arr = []; b.set(color, arr); }
  arr.push(x, y);
};
const flush = (g: Graphics, b: Buckets, size: number): void => {
  for (const [color, coords] of b) {
    for (let i = 0; i < coords.length; i += 2) g.rect(coords[i]!, coords[i + 1]!, size, size);
    g.fill({ color, alpha: 1 });
  }
};

export const triggerExplosion = (
  parent: Container,
  opts: TriggerExplosionOpts,
): void => {
  const { pos, radius, cellPx, gridW, gridH } = opts;
  const durationMs = opts.durationMs ?? 620;
  const frameMs = durationMs / NUM_FRAMES;
  const centerX = pos.x * cellPx + cellPx / 2;
  const centerY = pos.y * cellPx + cellPx / 2;

  // Chunky art pixel: bigger == coarser/more retro. Tuned so a ~48px cell gives
  // ~4px squares. The whole effect is drawn on this integer grid.
  const PX = Math.max(2, Math.round(cellPx / 12));
  // Fireball sized to span the inflicted square (radius cells out + a margin),
  // expressed in art-pixels.
  const RfullArt = ((radius + 0.4) * cellPx) / PX;
  const cellArt = cellPx / PX;

  // Stable seed per blast location → repeatable lumpy silhouette.
  const seed = (Math.imul(pos.x, 73856093) ^ Math.imul(pos.y, 19349663) ^ 0x9e3779b9) >>> 0;

  // --- Puffs: a central blob + ring lobes give the lumpy fire outline, and one
  //     small puff per inflicted cell guarantees the FULL blast area lights up
  //     (so corners of a multi-cell blast get flame tongues, like the old
  //     per-cell embers). All radii/positions are art-pixels at full size and
  //     get scaled by the frame's RADIUS_FRAC. ---
  const puffAX: number[] = [];
  const puffAY: number[] = [];
  const puffR: number[] = [];
  puffAX.push(0); puffAY.push(0); puffR.push(RfullArt * 0.62); // central blob
  for (let i = 1; i < NUM_PUFFS; i++) {
    const a = ((i - 1) / (NUM_PUFFS - 1)) * Math.PI * 2 + hash01(seed + i) * 0.7;
    const dist = RfullArt * (0.42 + hash01(seed + i * 7) * 0.18);
    puffAX.push(Math.cos(a) * dist);
    puffAY.push(Math.sin(a) * dist);
    puffR.push(RfullArt * (0.42 + hash01(seed + i * 13) * 0.16));
  }
  for (const c of explosionCells(pos, radius, gridW, gridH)) {
    if (c.x === pos.x && c.y === pos.y) continue;
    puffAX.push((c.x - pos.x) * cellArt);
    puffAY.push((c.y - pos.y) * cellArt);
    puffR.push(cellArt * 0.5);
  }
  const puffCount = puffAX.length;

  // Bounding half-extent for the per-pixel scan (sparks/embers fly past it but
  // are drawn from explicit rays, so they aren't bound by H).
  const maxScale = Math.max(...RADIUS_FRAC);
  const maxDrift = Math.max(...DRIFT_PX);
  const H = Math.ceil(RfullArt * maxScale * 1.18) + maxDrift + 2;

  const fx = new Container();
  fx.x = centerX;
  fx.y = centerY;
  const fire = new Graphics();    // the fire/smoke cloud
  const sparks = new Graphics();  // ignition star + flying embers, drawn on top
  fx.addChild(fire, sparks);
  parent.addChild(fx);

  const drawFrame = (f: number): void => {
    fx.alpha = ALPHA_F[f]!;
    fire.clear();
    sparks.clear();

    const sc = RADIUS_FRAC[f]!;
    const Rart = RfullArt * sc;
    const cool = COOL_BANDS[f]!;
    const smokeAmt = SMOKE_AMT[f]!;
    const drift = DRIFT_PX[f]!;
    const innerSolid = Rart * 0.82; // inner core is always solid; puffs lump the rim

    // --- Fire/smoke cloud: scan the art-pixel grid once, bucket each lit pixel
    //     by its hard palette color, then flush. ---
    const cloud: Buckets = new Map();
    const smokeEdge = 1 - smokeAmt;
    for (let iy = -H; iy <= H; iy++) {
      for (let ix = -H; ix <= H; ix++) {
        const dCenter = Math.sqrt(ix * ix + iy * iy);
        let inside = dCenter <= innerSolid;
        if (!inside) {
          for (let p = 0; p < puffCount; p++) {
            const dx = ix - puffAX[p]! * sc;
            const dy = iy - puffAY[p]! * sc;
            const pr = puffR[p]! * sc;
            if (dx * dx + dy * dy <= pr * pr) { inside = true; break; }
          }
        }
        if (!inside) continue;

        // Wavy band fraction: distance-from-center mapped 0(core)→1(rim), with a
        // small per-angle wobble so the color rings aren't perfect circles.
        const ang = Math.atan2(iy, ix);
        const wob = (hash01(seed + Math.round(ang * 7) * 131 + 17) - 0.5) * 0.2;
        const bandT = clamp01((Rart <= 0 ? 0 : dCenter / Rart) + wob);

        if (smokeAmt > 0 && bandT >= smokeEdge) {
          // Outer shell has turned to smoke; it drifts upward.
          const k = smokeAmt <= 0 ? 0 : (bandT - smokeEdge) / smokeAmt;
          const si = Math.min(SMOKE_RAMP.length - 1, Math.round(k * (SMOKE_RAMP.length - 1)));
          push(cloud, SMOKE_RAMP[si]!, ix * PX - PX / 2, (iy - drift) * PX - PX / 2);
        } else {
          let bi = Math.round(bandT * (FIRE_RAMP.length - 1)) + cool;
          if (bi < 0) bi = 0;
          if (bi > FIRE_RAMP.length - 1) bi = FIRE_RAMP.length - 1;
          push(cloud, FIRE_RAMP[bi]!, ix * PX - PX / 2, iy * PX - PX / 2);
        }
      }
    }
    flush(fire, cloud, PX);

    // --- Sparks: 8-point ignition star (early frames) + flying embers. ---
    const spark: Buckets = new Map();
    const sf = SPARK_FRAC[f]!;
    if (sf > 0) {
      const reach = RfullArt * 1.7 * sf;
      for (let d = 0; d < SPARK_DIRS; d++) {
        const a = (d / SPARK_DIRS) * Math.PI * 2 + 0.13;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        for (let r = innerSolid; r <= reach; r += 1) {
          const sx = Math.round(ca * r);
          const sy = Math.round(sa * r);
          const color = r > reach - 2 ? SPARK_HOT : SPARK_MID;
          push(spark, color, sx * PX - PX / 2, sy * PX - PX / 2);
        }
      }
    }
    for (let e = 0; e < NUM_EMBERS; e++) {
      const a = (e / NUM_EMBERS) * Math.PI * 2 + hash01(seed * 3 + e) * 0.7;
      const speed = RfullArt * (0.16 + hash01(seed * 5 + e) * 0.12);
      const r = speed * (f + 1);
      const maxR = RfullArt * 2.2;
      if (r > maxR) continue;
      const ageK = clamp01(r / maxR);
      const color = ageK < 0.45 ? SPARK_HOT : ageK < 0.8 ? EMBER_MID : EMBER_OLD;
      const sx = Math.round(Math.cos(a) * r);
      const sy = Math.round(Math.sin(a) * r) - Math.round(drift * 0.5);
      push(spark, color, sx * PX - PX / 2, sy * PX - PX / 2);
    }
    flush(sparks, spark, PX);
  };

  const t0 = performance.now();
  let lastFrame = -1;
  const tick = (): void => {
    if (fx.destroyed) return;
    const elapsed = performance.now() - t0;
    if (elapsed >= durationMs) {
      if (!parent.destroyed) parent.removeChild(fx);
      fx.destroy({ children: true });
      return;
    }
    const f = Math.min(NUM_FRAMES - 1, Math.floor(elapsed / frameMs));
    if (f !== lastFrame) { lastFrame = f; drawFrame(f); }
    requestAnimationFrame(tick);
  };
  drawFrame(0);
  requestAnimationFrame(tick);
};
