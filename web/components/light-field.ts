/**
 * Pixelated 2D lighting + tile-granular shadow casting (pure / renderer-free).
 *
 * The board is darkened by a "light map" that is composited over the world with
 * a MULTIPLY blend (see Lighting.ts). This module computes that light map on the
 * CPU as an RGBA buffer at `sub` texels per grid cell, so nearest-neighbour
 * upscaling yields the chunky, pixel-art-matching light/shadow look the game
 * uses everywhere else.
 *
 * Shadows are cast per-CELL: a cell is lit by a light only when the straight
 * line between the light's cell and the target cell is not blocked by an
 * occluder (wall ring / carved-cave rock / standing obstacle). Light *falloff*
 * is evaluated per-texel (smooth radial gradient), and the per-cell visibility
 * mask is bilinearly sampled per-texel, so a shadow boundary fades over ~1 cell
 * (a soft sub-cell penumbra) rather than snapping to a hard cell edge — the
 * latter read as rectangular light pools wherever a torch sat beside a straight
 * wall of obstacles.
 *
 * Everything here is deterministic and side-effect-free (flicker is applied by
 * the caller before `computeLightField`), so it is unit-tested directly.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A light source positioned in fractional CELL coordinates (cell centre = x+0.5). */
export interface LightSource {
  /** Centre x in cell units (a hero at cell 3 sits at x≈3.5). */
  x: number;
  /** Centre y in cell units. */
  y: number;
  /** Reach in cells; beyond this the light contributes nothing. */
  radius: number;
  /** Emitted colour (0..255 per channel). */
  color: RGB;
  /** Brightness multiplier (1 ≈ a normal torch). Flicker is folded in here by the caller. */
  intensity: number;
}

/** Minimal scene shape this module needs — a structural subset of the snapshot. */
export interface LightScene {
  gridW: number;
  gridH: number;
  /** True → rectangular perimeter ring is wall (legacy rooms). */
  walls: boolean;
  /** Carved-cave impassable rock cells (cave scenes). */
  wallCells?: { x: number; y: number }[];
  /** Standing obstacles (stalagmites, barrels…) block light until smashed. */
  obstacles: { x: number; y: number }[];
  /** Decorations may emit light (e.g. glowing mushrooms). */
  decorations: { type: string; x: number; y: number }[];
  /** Obstacle cells already smashed mid-scene — no longer occluders. */
  destroyedObstacles?: { x: number; y: number }[];
}

const key = (x: number, y: number): string => `${x},${y}`;
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Light emission per prop / obstacle type. Cell-centre is added by the caller.
 * Keep entries here so adding a torch to the catalog automatically lights a map.
 */
export const PROP_LIGHTS: Record<string, Omit<LightSource, 'x' | 'y'>> = {
  // Eerie cool glow from cave fungus.
  'glowing-mushroom': { radius: 2.8, color: { r: 120, g: 245, b: 175 }, intensity: 0.8 },
  // Warm firelight.
  brazier: { radius: 4.6, color: { r: 255, g: 150, b: 60 }, intensity: 1.2 },
};

/** Hero-carried torch (warm). Every hero carries one. */
export const HERO_TORCH: Omit<LightSource, 'x' | 'y'> = {
  radius: 4.2,
  color: { r: 255, g: 206, b: 138 },
  intensity: 1.05,
};

/** Faint cool beacon emitted by a bound/immobilized hero so the captive is findable. */
export const CAPTIVE_BEACON: Omit<LightSource, 'x' | 'y'> = {
  radius: 2.6,
  color: { r: 175, g: 215, b: 255 },
  intensity: 0.7,
};

/** Menacing red glow for a boss lurking in the dark (e.g. the king rat). */
export const BOSS_GLOW: Omit<LightSource, 'x' | 'y'> = {
  radius: 2.4,
  color: { r: 255, g: 70, b: 50 },
  intensity: 0.6,
};

// --- Transient effect lights (emitted via LightingLayer.emitLight) ---------

/** Warm light that streaks along a fire / magic bolt in flight. */
export const FIRE_BOLT_LIGHT = { radius: 2.4, color: { r: 255, g: 140, b: 45 } as RGB, intensity: 1.25 };
/** Flash where a fire bolt / fire spell strikes. */
export const FIRE_IMPACT_LIGHT = { radius: 2.9, color: { r: 255, g: 160, b: 70 } as RGB, intensity: 1.8, ttlMs: 360 };
/** Bigger flash for an area fire effect (flame-burst). */
export const FLAME_BURST_LIGHT = { radius: 3.8, color: { r: 255, g: 150, b: 60 } as RGB, intensity: 2.3, ttlMs: 420 };
/** Bright white-hot flash for an explosion; on-screen radius scales with the blast. */
export const EXPLOSION_LIGHT = { color: { r: 255, g: 214, b: 150 } as RGB, intensity: 2.8, ttlMs: 620 };

/**
 * Ambient floor brightness baked into the light map (0..255). In the dithered-
 * shading model this is the brightness of *unlit* floor: low → those areas
 * dither down toward black (sparse dots), so this sets how dark the room reads
 * away from any light. Cave is darker + blue (night); the tavern's plank floor
 * is already dark so it gets a touch more so the room stays navigable.
 */
export const AMBIENT_CAVE: RGB = { r: 82, g: 92, b: 135 };
export const AMBIENT_ROOM: RGB = { r: 157, g: 143, b: 124 };

/**
 * Global multiplier on every light's contribution. Tuned so a single torch
 * reaches ~full brightness (a clear lit pool) at its centre.
 */
export const GLOW_SCALE = 0.4;

/**
 * Light-map texels per grid cell. The shader linear-samples this and dithers at
 * SCREEN resolution, so the map only needs to be smooth — a modest value is fine.
 */
export const LIGHT_SUB = 6;

/**
 * Screen-pixel size of one Bayer dither cell. LOW (2-3) → fine 8-bit halftone
 * dots like classic software-rendered dithered lighting.
 */
export const DITHER_PX = 1;

/**
 * Brightness levels the dithered shading ramps through. 1 = pure on/off
 * halftone; 3 adds two mid-shades so pools fade through dim → bright with
 * dithered transitions between each step.
 */
export const LIGHT_LEVELS = 4;

/** How strongly lit areas take on the light's hue (0 = true colour, 1 = full tint). */
export const TINT_AMOUNT = 1.0;

/**
 * Edge vignette applied in the lighting SHADER (see Lighting.ts FRAGMENT) as a
 * dithered black "ink" frame — lighting-INDEPENDENT, so it reads uniformly on
 * all four edges even where the board is dark (a light-map vignette only shows
 * where there's light to darken). `DEPTH` is the band thickness as a fraction of
 * the board's SHORTER side (so the px thickness is equal on all edges);
 * `STRENGTH` is the ink coverage at the very edge (1 = solid black). The shader
 * ordered-dithers the coverage with the same Bayer threshold as the lighting,
 * so the border is a halftone fade-to-black in the game's pixel-art dots.
 */
export const VIGNETTE_DEPTH = 0.12;
export const VIGNETTE_STRENGTH = 1.0;

/**
 * Radial vignette layered on top of the rectangular edge band (above), combined
 * by max() and dithered with the same Bayer threshold. 0 = pure rectangular
 * frame (legacy); as it rises toward 1 the darkening eats progressively deeper
 * into the LIT centre, carving the play area down to a bright ellipse so the
 * rectangular image reads as "circled". It must reach inward past the (already
 * black) corners to be visible — see the Lighting.ts FRAGMENT vignette block.
 */
export const VIGNETTE_CORNER = 0.2;

/**
 * 4×4 ordered (Bayer) dither matrix, values 0..15. Used as a per-texel
 * threshold so the fractional part of a quantized brightness is rendered as a
 * stable checkerboard/crosshatch of on/off texels — the classic NES / Game Boy
 * shadow look — instead of a smooth ramp. One Bayer tile spans 4 light texels.
 */
export const BAYER4: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Quantize an intensity `n` ∈ [0,1] to one of `levels` steps, ordered-dithered
 * with Bayer threshold `m` ∈ [0,1). 0 stays 0 and 1 stays the top level;
 * intermediate values dither between the two nearest levels in proportion to
 * their fractional distance. Returns the chosen level as a fraction in [0,1].
 */
const ditherLevel = (n: number, m: number, levels: number): number => {
  let level = Math.floor(n * (levels - 1) + m);
  if (level < 0) level = 0;
  else if (level > levels - 1) level = levels - 1;
  return level / (levels - 1);
};

/**
 * Effective Bayer dither-cell size (in framebuffer px) for a base size and the
 * canvas display scale (`viewportScale` = displayed DEVICE px ÷ framebuffer px).
 * The pixel-art board is CSS-upscaled with `image-rendering: pixelated` from a
 * small backing store; at a non-integer scale a 1-px dither replicates unevenly
 * and reads as a noisy moiré speckle (worst on hi-dpi / large screens). Growing
 * the cell with the scale keeps the halftone dots a stable on-screen size:
 * the base near native (≤1.3×), 2× for typical upscales, 3× for extreme ones.
 */
export const effectiveDitherPx = (baseDitherPx: number, viewportScale: number): number => {
  const factor = viewportScale <= 1.3 ? 1 : viewportScale <= 3.2 ? 2 : 3;
  return Math.max(1, Math.round(baseDitherPx * factor));
};

/**
 * Build the set of light-blocking cells for a scene, mirroring exactly what the
 * tilemap renderer treats as wall (carved `wallCells` OR the rectangular ring),
 * plus every standing obstacle that has not been smashed.
 */
export const buildOccluderMask = (scene: LightScene): Set<string> => {
  const occ = new Set<string>();
  const { gridW, gridH } = scene;
  const wallCells = scene.wallCells ?? [];
  if (wallCells.length > 0) {
    for (const c of wallCells) occ.add(key(c.x, c.y));
  } else if (scene.walls) {
    for (let x = 0; x < gridW; x++) {
      occ.add(key(x, 0));
      occ.add(key(x, gridH - 1));
    }
    for (let y = 0; y < gridH; y++) {
      occ.add(key(0, y));
      occ.add(key(gridW - 1, y));
    }
  }
  const destroyed = new Set((scene.destroyedObstacles ?? []).map((d) => key(d.x, d.y)));
  for (const o of scene.obstacles) {
    if (destroyed.has(key(o.x, o.y))) continue;
    occ.add(key(o.x, o.y));
  }
  return occ;
};

/**
 * Static lights a scene emits on its own (independent of creatures): glowing
 * decorations and light-emitting obstacles, each placed at its cell centre.
 */
export const deriveStaticLights = (scene: LightScene): LightSource[] => {
  const out: LightSource[] = [];
  const destroyed = new Set((scene.destroyedObstacles ?? []).map((d) => key(d.x, d.y)));
  const add = (type: string, x: number, y: number): void => {
    const spec = PROP_LIGHTS[type];
    if (!spec) return;
    out.push({ x: x + 0.5, y: y + 0.5, ...spec });
  };
  for (const d of scene.decorations) add(d.type, d.x, d.y);
  for (const o of scene.obstacles) {
    if (destroyed.has(key(o.x, o.y))) continue;
    add((o as { type?: string }).type ?? '', o.x, o.y);
  }
  return out;
};

/** Cave scenes (carved rock) are dark; plain rooms get a warmer, brighter floor. */
export const ambientFor = (scene: LightScene): RGB =>
  (scene.wallCells?.length ?? 0) > 0 ? AMBIENT_CAVE : AMBIENT_ROOM;

/**
 * Cell line-of-sight via integer Bresenham. Returns false when any cell STRICTLY
 * between (x0,y0) and (x1,y1) is an occluder. The endpoints are never tested, so
 * a light can sit beside a wall and the wall's near face still lights up (only
 * cells *behind* it fall into shadow).
 */
export const hasLineOfSight = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  isOcc: (x: number, y: number) => boolean,
): boolean => {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;
  // Bounded by the grid diagonal; the guard prevents any pathological infinite loop.
  for (let guard = 0; guard < dx + dy + 2; guard++) {
    if (cx === x1 && cy === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
    if (cx === x1 && cy === y1) return true;
    if (isOcc(cx, cy)) return false;
  }
  return true;
};

export interface LightFieldOpts {
  gridW: number;
  gridH: number;
  /** Texels per cell. */
  sub: number;
  ambient: RGB;
  lights: ReadonlyArray<LightSource>;
  occluders: ReadonlySet<string>;
  /** RGBA destination, length gridW*sub * gridH*sub * 4. Reused across frames. */
  out: Uint8ClampedArray;
  /** Multiplier on every light's contribution (default 1). See GLOW_SCALE. */
  scale?: number;
  /**
   * When > 1, quantize each channel to this many brightness levels and Bayer-
   * dither the transitions (8-bit dithered shadows). 0/undefined → smooth.
   */
  levels?: number;
}

/**
 * Accumulate the light map into `opts.out` (RGBA, row-major, sub texels/cell).
 *
 * Per light we first compute a per-cell visibility mask (cheap: cells × lights ×
 * line length). Then every texel sums ambient + each visible light's
 * distance-falloff contribution and is clamped to [0,255]. The visibility mask
 * is bilinearly interpolated per-texel, so shadow edges fade over ~1 cell (soft
 * sub-cell penumbra) instead of landing hard on cell boundaries; falloff within
 * a lit cell is smooth.
 */
export const computeLightField = (opts: LightFieldOpts): Uint8ClampedArray => {
  const { gridW, gridH, sub, ambient, lights, occluders, out } = opts;
  const scale = opts.scale ?? 1;
  const levels = opts.levels ?? 0;
  const dither = levels > 1;
  const W = gridW * sub;
  const H = gridH * sub;
  const isOcc = (x: number, y: number): boolean => occluders.has(key(x, y));

  // Per-light per-cell visibility, only filled within each light's bounding box.
  const vis: Uint8Array[] = lights.map((light) => {
    const mask = new Uint8Array(gridW * gridH);
    const lcx = Math.floor(light.x);
    const lcy = Math.floor(light.y);
    const r = Math.ceil(light.radius) + 1;
    const minX = Math.max(0, lcx - r);
    const maxX = Math.min(gridW - 1, lcx + r);
    const minY = Math.max(0, lcy - r);
    const maxY = Math.min(gridH - 1, lcy + r);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        if (hasLineOfSight(lcx, lcy, cx, cy, isOcc)) mask[cy * gridW + cx] = 1;
      }
    }
    return mask;
  });

  // Bilinearly sample a per-cell visibility mask at cell-space (wx,wy). Cell
  // centres sit at c+0.5, so a texel between two cells blends their visibility:
  // a hard 0→1 shadow boundary becomes a ~1-cell penumbra ramp instead of a
  // cell-edge step. (The step read as rectangular light pools wherever a torch
  // sat next to a straight wall of obstacles, e.g. the central barrel
  // barricade.) Edge cells clamp — there are no occluders beyond the grid.
  const sampleVis = (mask: Uint8Array, wx: number, wy: number): number => {
    const fx = wx - 0.5;
    const fy = wy - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const fracX = fx - ix;
    const fracY = fy - iy;
    const clampX = (v: number): number => (v < 0 ? 0 : v > gridW - 1 ? gridW - 1 : v);
    const clampY = (v: number): number => (v < 0 ? 0 : v > gridH - 1 ? gridH - 1 : v);
    const x0 = clampX(ix);
    const x1 = clampX(ix + 1);
    const y0 = clampY(iy);
    const y1 = clampY(iy + 1);
    const v00 = mask[y0 * gridW + x0]!;
    const v10 = mask[y0 * gridW + x1]!;
    const v01 = mask[y1 * gridW + x0]!;
    const v11 = mask[y1 * gridW + x1]!;
    const top = v00 + (v10 - v00) * fracX;
    const bot = v01 + (v11 - v01) * fracX;
    return top + (bot - top) * fracY;
  };

  for (let ty = 0; ty < H; ty++) {
    const wy = (ty + 0.5) / sub; // world (cell-space) y of this texel centre
    for (let tx = 0; tx < W; tx++) {
      const wx = (tx + 0.5) / sub;
      let r = ambient.r;
      let g = ambient.g;
      let b = ambient.b;
      for (let li = 0; li < lights.length; li++) {
        const light = lights[li]!;
        const ddx = wx - light.x;
        const ddy = wy - light.y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist >= light.radius) continue;
        // Soft per-texel visibility (0..1): hard shadow boundaries fade over
        // ~1 cell instead of snapping to a rectangular cell edge.
        const v = sampleVis(vis[li]!, wx, wy);
        if (v <= 0) continue;
        // Quadratic falloff: bright core, soft edge.
        const t = 1 - dist / light.radius;
        const f = t * t * light.intensity * scale * v;
        r += light.color.r * f;
        g += light.color.g * f;
        b += light.color.b * f;
      }
      const o = (ty * W + tx) * 4;
      if (dither) {
        // Dither the LUMINANCE (peak channel) and scale the colour by the
        // chosen level, so R/G/B step together — clean light/dark dither dots
        // in the light's own hue, not rainbow per-channel speckle. The peak
        // channel lands exactly on a level; the others keep their ratio.
        const lum = r > g ? (r > b ? r : b) : g > b ? g : b;
        if (lum <= 0) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
        } else {
          const m = (BAYER4[ty & 3]![tx & 3]! + 0.5) / 16;
          const n = lum >= 255 ? 1 : lum / 255;
          const s = (ditherLevel(n, m, levels) * 255) / lum;
          out[o] = r * s;
          out[o + 1] = g * s;
          out[o + 2] = b * s;
        }
      } else {
        out[o] = clamp255(r);
        out[o + 1] = clamp255(g);
        out[o + 2] = clamp255(b);
      }
      out[o + 3] = 255;
    }
  }
  return out;
};
