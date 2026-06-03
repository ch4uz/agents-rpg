import { CanvasSource, Container, Filter, Texture } from 'pixi.js';
import {
  buildOccluderMask,
  deriveStaticLights,
  computeLightField,
  effectiveDitherPx,
  LIGHT_SUB,
  GLOW_SCALE,
  LIGHT_LEVELS,
  DITHER_PX,
  TINT_AMOUNT,
  AMBIENT_CAVE,
  AMBIENT_ROOM,
  VIGNETTE_DEPTH,
  VIGNETTE_STRENGTH,
  VIGNETTE_CORNER,
  type LightScene,
  type LightSource,
  type RGB,
} from './light-field.js';

/**
 * Live-tunable lighting parameters (defaults baked in light-field.ts). Exposed
 * on `window.__lighting.tune`; mutate then call `window.__lighting.refresh()`.
 */
export const lightingTune = {
  /** Light-map texels per cell (smoothness of the underlying light field). */
  sub: LIGHT_SUB,
  /** Base framebuffer-pixel size of one dither cell (LOWER = finer 8-bit
   *  halftone dots). The effective size is this scaled up on CSS-upscaled
   *  displays — see LightingLayer.setViewportScale — to avoid moiré speckle. */
  ditherPx: DITHER_PX,
  /** Brightness steps the dither ramps through (1 = pure on/off halftone). */
  levels: LIGHT_LEVELS,
  /** Additive light multiplier (how far the lit pools reach full brightness). */
  glowScale: GLOW_SCALE,
  /** 0 = lit areas keep true colour, 1 = fully tinted by the light hue. */
  tintAmt: TINT_AMOUNT,
  /** Edge-vignette depth (fraction of the board that dithers to black at each edge; 0 = off). */
  vignetteDepth: VIGNETTE_DEPTH,
  /** Edge-vignette max darkening (0..1; 1 = full black at the very edge). */
  vignetteStrength: VIGNETTE_STRENGTH,
  /** Radial corner darkening (0 = rectangular frame; →1 rounds the corners into a "circled" image). */
  vignetteCorner: VIGNETTE_CORNER,
  ambientCave: { ...AMBIENT_CAVE } as RGB,
  ambientRoom: { ...AMBIENT_ROOM } as RGB,
};

// Standard PixiJS v8 filter vertex shader (maps the quad + provides vTextureCoord).
const VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vBoardUv;   // 0..1 across the board quad (aPosition) — for the edge vignette
out float vAspect;   // board width / height — to keep the vignette band equal-thickness

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}
void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
  vBoardUv = aPosition;
  vAspect = uOutputFrame.z / max(uOutputFrame.w, 1.0);
}
`;

// Dithered-shading fragment shader (microcraft / "dithered shading" technique):
// sample the world + a smooth light map, then threshold the per-pixel brightness
// against a screen-space 4x4 Bayer matrix. A pixel shows the (optionally
// hue-tinted) scene when its brightness beats the dither threshold, else black.
// The dots stay at a fixed screen size (uDitherPx); only their DENSITY changes
// with distance from light — the classic 8-bit halftone shadow.
const FRAGMENT = `
in vec2 vTextureCoord;
in vec2 vBoardUv;            // 0..1 across the board (from the vertex shader)
in float vAspect;           // board width / height
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLightMap;
uniform float uDitherPx;
uniform float uLevels;
uniform float uTintAmt;
uniform float uDither;   // 1 = ordered Bayer halftone, 0 = smooth "standard" shading

// Analytic ordered (Bayer) dither — no GLSL arrays (which fail to compile on
// some drivers). bayer2 gives the 2x2 pattern; recursing builds 4x4 / 8x8.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void main(void) {
  vec4 scene = texture(uTexture, vTextureCoord);
  vec3 lm = texture(uLightMap, vTextureCoord).rgb;
  float peak = max(lm.r, max(lm.g, lm.b));
  float b = clamp(peak, 0.0, 1.0);

  vec2 cell = gl_FragCoord.xy / max(uDitherPx, 1.0);
  float thr = bayer4(cell);
  // Ordered-dither halftone brightness, or — when uDither is off — the smooth
  // continuous brightness for plain "standard" multiply shading. (The vignette
  // is a separate filter and keeps its own dithering regardless.)
  float qd = clamp(floor(b * uLevels + thr) / uLevels, 0.0, 1.0);
  float q = uDither > 0.5 ? qd : b;

  vec3 hue = peak > 0.0035 ? lm / peak : vec3(0.0);
  vec3 tint = mix(vec3(1.0), hue, uTintAmt);
  vec3 rgb = scene.rgb * tint * q;

  // NOTE: the edge/radial vignette is NOT applied here. It lives in its own
  // filter (VIGNETTE_FRAGMENT below) attached to the GROUND container (floor +
  // props) only, so character tokens get the lighting but never the vignette
  // darkening. Because both effects are a multiply of the scene colour, doing
  // the vignette on the ground BEFORE this lighting pass yields an identical
  // floor result — see VIGNETTE_FRAGMENT.
  finalColor = vec4(rgb, scene.a);
}
`;

// Vignette-only fragment shader. Same VERTEX (so vBoardUv/vAspect span the
// board), but it samples ONLY the incoming texture and multiplies in the
// dithered black "ink" frame — no light map. Attached to the GROUND container
// (floor + props), NEVER the character tokens, so heroes/monsters keep the
// lighting but escape the edge/corner darkening. Two layers combined by max()
// then ordered-dithered with the same screen-space Bayer threshold the lighting
// uses, so the frame stays a halftone fade-to-black in the game's pixel dots:
//   (1) a uniform-THICKNESS edge band (uVigDepthFrac, in shorter-side units); and
//   (2) a RADIAL term that eats the corners into an inscribed ellipse so the
//       rectangular image reads as "circled" (uVigCorner; inner/outer radii
//       shrink inward as it rises, biting deeper into the lit centre).
const VIGNETTE_FRAGMENT = `
in vec2 vTextureCoord;
in vec2 vBoardUv;            // 0..1 across the board (from the vertex shader)
in float vAspect;           // board width / height
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uDitherPx;
uniform float uVigDepthFrac; // edge-band thickness as a fraction of the board's shorter side (0 = off)
uniform float uVigStrength;  // ink coverage at the very edge (0..1)
uniform float uVigCorner;    // radial corner darkening (0 = rectangular frame; →1 rounds into a circle)

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void main(void) {
  vec4 scene = texture(uTexture, vTextureCoord);
  vec3 rgb = scene.rgb;

  if (uVigDepthFrac > 0.0001 || uVigCorner > 0.0001) {
    // Centre the ordered-dither threshold into (0,1) — matching the CPU BAYER4
    // path (which adds +0.5)/16. The raw analytic bayer4 is exactly 0 on a
    // regular sub-grid of fragments, and step(0.0, cov) returns 1 even when
    // cov == 0, so those fragments were inked black across the WHOLE floor
    // (a uniform speckle), not just the vignette edges. Centring guarantees
    // thr > 0, so a fragment with zero coverage is never inked.
    float thr = (bayer4(gl_FragCoord.xy / max(uDitherPx, 1.0)) * 16.0 + 0.5) / 16.0;

    // (1) rectangular edge band.
    float dx = min(vBoardUv.x, 1.0 - vBoardUv.x) * max(vAspect, 1.0);
    float dy = min(vBoardUv.y, 1.0 - vBoardUv.y) * max(1.0 / vAspect, 1.0);
    float ed = min(dx, dy);
    float vig = clamp(ed / max(uVigDepthFrac, 0.0001), 0.0, 1.0);
    float covEdge = uVigDepthFrac > 0.0001 ? (1.0 - vig) * uVigStrength : 0.0;

    // (2) radial corner darkening → bright inscribed ellipse.
    float nr = length((vBoardUv - 0.5) * 2.0);
    float inner = mix(1.0, 0.30, uVigCorner);
    float outer = mix(1.4142, 0.92, uVigCorner);
    float covCorner = clamp((nr - inner) / max(outer - inner, 0.0001), 0.0, 1.0) * uVigStrength;

    float cov = max(covEdge, covCorner);
    float ink = step(thr, cov);
    rgb *= (1.0 - ink);
  }

  finalColor = vec4(rgb, scene.a);
}
`;

/** A short-lived light from a transient VFX (explosion / fire impact / bolt). */
interface Transient {
  color: RGB;
  radius: number;
  intensity: number;
  bornMs: number;
  ttlMs: number;
  /** Start position (cell units). */
  x: number;
  y: number;
  /** End position — when != start the light travels start→end over travelMs. */
  x1: number;
  y1: number;
  travelMs: number;
  /** Fade-in time (ms). */
  attackMs: number;
}

/** Options for {@link LightingLayer.emitLight} (positions in CELL units). */
export interface TransientLightSpec {
  x: number;
  y: number;
  /** Optional travel destination; omit for a stationary flash. */
  x1?: number;
  y1?: number;
  travelMs?: number;
  radius: number;
  color: RGB;
  intensity: number;
  ttlMs: number;
  attackMs?: number;
}

/**
 * Dithered-shading lighting for the board. Owns a fragment-shader Filter applied
 * to the world container and a CPU-computed smooth light map (ambient + colored
 * light pools, with per-cell line-of-sight shadows). The shader turns that
 * smooth field into the fine, screen-resolution Bayer halftone shadow.
 */
export class LightingLayer {
  readonly filter: Filter;
  /** Vignette-only filter, attached separately to the GROUND container (floor +
   *  props) so character tokens are lit but never vignetted. */
  readonly vignetteFilter: Filter;
  private vignetteTarget: Container | null = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private lightTexture: Texture;

  private gridW = 0;
  private gridH = 0;
  private sub = LIGHT_SUB;
  private ambient: RGB = { r: 0, g: 0, b: 0 };
  private staticLights: LightSource[] = [];
  private occluders: ReadonlySet<string> = new Set();
  private lastScene: LightScene | null = null;
  private target: Container | null = null;
  // The light-map dithered-shading pass and the edge vignette are independent
  // filters on different containers, so they get independent enable flags. The
  // master `setEnabled` toggles both; `setLightingEnabled` drops only the light
  // map (heroes/floor go to full brightness, no shadows) while the vignette
  // keeps darkening the edges.
  private lightOn = true;
  private vignetteOn = true;
  // Light-map shading style: true = ordered Bayer halftone, false = smooth
  // "standard" multiply shading (the game default). Independent of the vignette,
  // which keeps its own dithering regardless.
  private dither = false;
  // Ratio of displayed DEVICE pixels to light-map/framebuffer pixels (the
  // canvas is CSS-upscaled with image-rendering:pixelated from its small
  // backing store). At a non-integer scale a 1-px Bayer dither replicates
  // unevenly and reads as a noisy moiré speckle, so the effective dither cell
  // grows with the scale to keep the halftone dots a stable on-screen size.
  // Updated by the board on resize via setViewportScale().
  private viewportScale = 1;
  private transients: Transient[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('LightingLayer: 2D canvas context unavailable');
    this.ctx = ctx;
    this.lightTexture = this.makeLightTexture();

    this.filter = Filter.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT },
      resources: {
        uLightMap: this.lightTexture.source,
        ditherUniforms: {
          uDitherPx: { value: lightingTune.ditherPx, type: 'f32' },
          uLevels: { value: lightingTune.levels, type: 'f32' },
          uTintAmt: { value: lightingTune.tintAmt, type: 'f32' },
          uDither: { value: 0, type: 'f32' },
        },
      },
    });

    this.vignetteFilter = Filter.from({
      gl: { vertex: VERTEX, fragment: VIGNETTE_FRAGMENT },
      resources: {
        vignetteUniforms: {
          uDitherPx: { value: lightingTune.ditherPx, type: 'f32' },
          uVigDepthFrac: { value: lightingTune.vignetteDepth, type: 'f32' },
          uVigStrength: { value: lightingTune.vignetteStrength, type: 'f32' },
          uVigCorner: { value: lightingTune.vignetteCorner, type: 'f32' },
        },
      },
    });
    this.applyDitherPx();
  }

  /** Push the current effective dither-cell size (base × viewport-scale
   *  compensation) onto both filters' uniforms. */
  private applyDitherPx(): void {
    const px = effectiveDitherPx(lightingTune.ditherPx, this.viewportScale);
    this.filter.resources.ditherUniforms.uniforms.uDitherPx = px;
    this.vignetteFilter.resources.vignetteUniforms.uniforms.uDitherPx = px;
  }

  /**
   * Report the canvas's displayed-device-pixels ÷ framebuffer-pixels ratio so
   * the dither cell can compensate for the pixel-art CSS upscale. Cheap; call
   * it from the board's resize handler.
   */
  setViewportScale(scale: number): void {
    if (!(scale > 0) || scale === this.viewportScale) return;
    this.viewportScale = scale;
    this.applyDitherPx();
  }

  private makeLightTexture(): Texture {
    const source = new CanvasSource({ resource: this.canvas });
    // Linear so the low-res light field reads as a smooth gradient; the dither
    // is done per screen-pixel in the shader, not by the light map's texels.
    source.scaleMode = 'linear';
    return new Texture({ source });
  }

  /** Apply the lighting to a world container (floor / props / tokens). */
  attachTo(container: Container): void {
    this.target = container;
    if (this.lightOn) container.filters = [this.filter];
  }

  /** Apply the vignette to the GROUND container (floor + props only) — kept off
   *  the token layer so heroes/monsters are lit but not vignetted. */
  attachVignetteTo(container: Container): void {
    this.vignetteTarget = container;
    if (this.vignetteOn) container.filters = [this.vignetteFilter];
  }

  /** Master toggle — flips BOTH the light map and the vignette together. */
  setEnabled(enabled: boolean): void {
    this.setLightingEnabled(enabled);
    this.setVignetteEnabled(enabled);
  }

  /** Toggle ONLY the light-map shading pass. With it off the scene renders at
   *  full brightness with no light pools or shadows, but the edge vignette
   *  (a separate filter on the ground container) is untouched. */
  setLightingEnabled(enabled: boolean): void {
    this.lightOn = enabled;
    if (this.target) this.target.filters = enabled ? [this.filter] : [];
  }

  /** Toggle ONLY the edge/corner vignette pass. */
  setVignetteEnabled(enabled: boolean): void {
    this.vignetteOn = enabled;
    if (this.vignetteTarget) this.vignetteTarget.filters = enabled ? [this.vignetteFilter] : [];
  }

  /** Switch the light-map pass between dithered halftone (true, the game look)
   *  and smooth "standard" multiply shading (false). The vignette filter is
   *  separate and keeps its own dithering either way. */
  setDithering(enabled: boolean): void {
    this.dither = enabled;
    this.filter.resources.ditherUniforms.uniforms.uDither = enabled ? 1 : 0;
  }

  /** Whether the light-map pass uses dithered halftone (vs. smooth shading). */
  get ditheringEnabled(): boolean {
    return this.dither;
  }

  /** True only when BOTH passes are on (master state). */
  get enabled(): boolean {
    return this.lightOn && this.vignetteOn;
  }

  /** Whether the light-map shading pass is currently applied. */
  get lightingEnabled(): boolean {
    return this.lightOn;
  }

  /** Whether the edge/corner vignette pass is currently applied. */
  get vignetteEnabled(): boolean {
    return this.vignetteOn;
  }

  /** Rebuild scene-static lighting state and resize the light map to the grid. */
  configure(scene: LightScene): void {
    this.lastScene = scene;
    this.gridW = scene.gridW;
    this.gridH = scene.gridH;
    this.sub = Math.max(1, Math.round(lightingTune.sub));
    this.staticLights = deriveStaticLights(scene);
    this.occluders = buildOccluderMask(scene);

    const isCave = (scene.wallCells?.length ?? 0) > 0;
    this.ambient = isCave ? lightingTune.ambientCave : lightingTune.ambientRoom;

    const w = scene.gridW * this.sub;
    const h = scene.gridH * this.sub;
    if (this.canvas.width !== w || this.canvas.height !== h || this.image === null) {
      this.canvas.width = w; // also clears the canvas
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
      // Rebind a fresh CanvasSource — a CanvasSource caches its dimensions at
      // construction, so it must be recreated whenever the canvas is resized.
      const prev = this.lightTexture;
      this.lightTexture = this.makeLightTexture();
      this.filter.resources.uLightMap = this.lightTexture.source;
      prev.destroy(true);
    }

    // Edge-vignette uniforms live on the SEPARATE vignette filter (see
    // VIGNETTE_FRAGMENT), attached to the ground container only. Read live from
    // lightingTune so the ?lighttune sliders apply on the next refresh(). The
    // dither cell is the viewport-scaled effective size (applyDitherPx), not
    // the raw base, so the halftone stays moiré-free at any display scale.
    const v = this.vignetteFilter.resources.vignetteUniforms.uniforms;
    v.uVigDepthFrac = lightingTune.vignetteDepth;
    v.uVigStrength = lightingTune.vignetteStrength;
    v.uVigCorner = lightingTune.vignetteCorner;
    this.applyDitherPx();
  }

  /** Re-apply the current scene with the latest `lightingTune` values. */
  refresh(): void {
    this.filter.resources.ditherUniforms.uniforms.uLevels = lightingTune.levels;
    this.filter.resources.ditherUniforms.uniforms.uTintAmt = lightingTune.tintAmt;
    this.applyDitherPx();
    if (this.lastScene) this.configure(this.lastScene);
  }

  /**
   * Emit a short-lived light from a transient effect (explosion flash, fire
   * impact, or a fire bolt streaking to its target). Positions are in CELL
   * units (the board converts pixel → cell as `px / CELL_PX`). The light fades
   * in over `attackMs`, holds, then eases out over the back half of its life.
   */
  emitLight(spec: TransientLightSpec): void {
    const now = performance.now();
    // Prune expired so the list can't grow unbounded while lighting is off.
    this.transients = this.transients.filter((t) => now - t.bornMs < t.ttlMs);
    this.transients.push({
      color: spec.color,
      radius: spec.radius,
      intensity: spec.intensity,
      bornMs: now,
      ttlMs: spec.ttlMs,
      x: spec.x,
      y: spec.y,
      x1: spec.x1 ?? spec.x,
      y1: spec.y1 ?? spec.y,
      travelMs: spec.travelMs ?? spec.ttlMs,
      attackMs: spec.attackMs ?? 20,
    });
  }

  /** Resolve active transient lights to LightSources for the current frame. */
  private activeTransients(nowMs: number): LightSource[] {
    if (this.transients.length === 0) return [];
    const out: LightSource[] = [];
    for (const t of this.transients) {
      const age = nowMs - t.bornMs;
      if (age < 0 || age >= t.ttlMs) continue;
      const tt = t.travelMs > 0 ? Math.min(1, age / t.travelMs) : 1;
      let env = age < t.attackMs ? age / t.attackMs : 1;
      const tail = t.ttlMs * 0.55;
      if (age > tail) {
        const k = (age - tail) / (t.ttlMs - tail);
        env *= 1 - k * k; // ease-out
      }
      out.push({
        x: t.x + (t.x1 - t.x) * tt,
        y: t.y + (t.y1 - t.y) * tt,
        radius: t.radius,
        color: t.color,
        intensity: t.intensity * env,
      });
    }
    this.transients = this.transients.filter((t) => nowMs - t.bornMs < t.ttlMs);
    return out;
  }

  /**
   * Recompute + upload the smooth light map for this frame. `dynamic` are
   * creature lights at their live positions; `nowMs` drives a subtle flicker.
   */
  render(nowMs: number, dynamic: ReadonlyArray<LightSource>): void {
    if (!this.lightOn || !this.image || this.gridW === 0) return;

    const lights = [
      ...this.applyFlicker(nowMs, [...this.staticLights, ...dynamic]),
      ...this.activeTransients(nowMs),
    ];
    computeLightField({
      gridW: this.gridW,
      gridH: this.gridH,
      sub: this.sub,
      ambient: this.ambient,
      lights,
      occluders: this.occluders,
      out: this.image.data,
      scale: lightingTune.glowScale,
      // levels:0 → smooth field; the dither is applied per screen-pixel in the shader.
    });
    this.ctx.putImageData(this.image, 0, 0);
    this.lightTexture.source.update();
  }

  private applyFlicker(nowMs: number, lights: ReadonlyArray<LightSource>): LightSource[] {
    const t = nowMs * 0.001;
    return lights.map((l, i) => {
      const flicker =
        0.95 +
        0.04 * Math.sin(t * 3.7 + i * 1.7) +
        0.02 * Math.sin(t * 6.9 + i * 4.2);
      return { ...l, intensity: l.intensity * flicker };
    });
  }

  destroy(): void {
    if (this.target) this.target.filters = [];
    this.filter.destroy();
    this.lightTexture.destroy(true);
    this.image = null;
  }
}
