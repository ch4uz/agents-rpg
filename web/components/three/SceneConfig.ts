/**
 * Scene-tunable parameters for the 3D dice overlay — camera framing, lighting
 * rig, floor surface. Extracted from `DiceScene.ts` so Vite HMR can re-apply
 * changes live: edit a value here, save, and `DiceScene.applyConfig(...)`
 * picks it up without a full page reload.
 *
 * This module exports pure data (CAMERA, FLOOR) and a pure light factory
 * (`buildLights()`). The scene itself owns instantiation lifecycle.
 */
import * as THREE from 'three';
import woodenTextureUrl from '../../../assets/wooden.jpg?url';

export interface CameraConfig {
  /** World-space camera position. For an isometric look set X = Y ≈ Z. */
  position: THREE.Vector3;
  /** What the camera looks at. Origin by default — the tray is centered there. */
  target: THREE.Vector3;
  /** Orthographic half-height in world units. Bigger = more zoomed out. */
  zoom: number;
  near: number;
  far: number;
}

export const CAMERA: CameraConfig = {
  // Tuned via the dice-test page's live camera panel. The target Y is below
  // the floor so the camera tilts down slightly — frames the tray with more
  // breathing room above the dice. Adjust via the in-page controls and copy
  // the snippet back here to update.
  position: new THREE.Vector3(7.60, 11.80, 8.70),
  target:   new THREE.Vector3(-0.40, -2.50, 0.40),
  zoom:     7.20,
  near:     0.1,
  far:      100,
};

export const FLOOR = {
  /** Multiplier color applied on top of the texture (`final = sample × color`).
   *  White (0xffffff) = texture renders natively. Medium warm-grey tints
   *  knock brightness down a notch (so wood doesn't blow out) and compress
   *  the texture's warm hue toward neutral because R/G/B are close together. */
  color:     0xc0b3a4,
  /** Higher = more matte. Slight bump from the natural-wood default kills
   *  the warm specular sheen without flattening the surface entirely. */
  roughness: 0.92,
  metalness: 0.0,
  /** URL to a tiled albedo texture mapped over the floor. Set to `null` to
   *  fall back to the flat color. */
  texture:   woodenTextureUrl as string | null,
  /** Floor plane edge length (scene units). Sized so the isometric camera
   *  never sees past the edge — the entire visible scene is wood. */
  size:      100,
  /** Number of times the texture tiles across the full floor edge. Bigger
   *  number → smaller wood pattern → more planks visible. */
  textureRepeat: 4,
  /** When true, the floor texture is sampled with nearest-neighbor
   *  filtering — texels render as crisp blocks, matching the pixel-art
   *  feel of the screen-space pixelation pass. When false, the texture is
   *  sampled smoothly with mipmap-linear filtering (looks like a photo of
   *  wood under a chunky pixelation overlay). */
  texturePixelated: true,
};

export const PIXELATION = {
  /** Downsample factor for the low-resolution render target. The scene is
   *  rendered at `canvasSize / scale` and then upscaled to the canvas using
   *  nearest-neighbor — that's what produces the pixel-art look.
   *
   *  Lower = sharper / closer to native resolution.
   *  Higher = chunkier, more pixelated.
   *
   *  1 disables the pixelation pass. 2 is soft pixel feel. 3 is the
   *  current chunky look. 4 was the original strong pixelation. */
  scale: 3,
};

export interface VignetteConfig {
  /** Half-extent of the bright centre rectangle: Chebyshev (square) distance
   *  from centre, normalized 0–1 where 1 is the frame edge, at which the
   *  dithered fade begins. (Rect vignette — was a radial 0–~0.7 corner dist.) */
  radius:    number;
  /** Width of the soft transition from no-vignette to full-vignette. */
  softness:  number;
  /** Maximum darken at the corners. Read as ink coverage now that the fade is
   *  ordered-dithered: 0 = no effect, 1 = fully black corners. */
  intensity: number;
  /** Size (in low-res RT pixels) of one Bayer dither cell. 1 = one ink dot per
   *  pixelation block (the chunkiest, matching the Pixi board's halftone);
   *  higher spreads the 4×4 Bayer pattern over more blocks for a coarser dot
   *  grid. Mirrors the board's `DITHER_PX` (web/components/light-field.ts). */
  ditherPx:  number;
}

// The dice tray's fade-to-black is ORDERED-DITHERED (4×4 Bayer) to match the
// Pixi board's vignette (web/components/Lighting.ts VIGNETTE_FRAGMENT): instead
// of a smooth multiply, `intensity` is the fraction of pixels turned to hard
// black ink dots at the corners, so the dice overlay frames into the same
// halftone fade as the board.
export const VIGNETTE: VignetteConfig = {
  radius:    0.55,
  softness:  0.47,
  intensity: 0.97,
  ditherPx:  1,
};

export interface ThrowConfig {
  /** Horizontal distance from the focused point at which each die spawns,
   *  in scene units. Chosen so the spawn is off-camera; the die then flies
   *  inward toward the focus. */
  spawnDistance:  { min: number; max: number };
  /** Vertical spawn height range (scene units). */
  startHeight:    { min: number; max: number };
  /** Horizontal throw speed range (toward focus point), units/s. */
  throwSpeed:     { min: number; max: number };
  /** Initial downward velocity range, units/s. */
  fallSpeed:      { min: number; max: number };
  /** Random scatter added to the throw velocity per horizontal axis, units/s. */
  lateralScatter: number;
  /** Angular velocity magnitude range, applied independently on each axis (rad/s). */
  spin:           { min: number; max: number };
  /** Delay between successive dice in the same roll (ms). Models the
   *  "finger spread" stagger when throwing a handful by hand. 0 disables. */
  staggerMs:      number;
  /** Width in degrees of the azimuth arc each die's spawn is sampled from.
   *  The arc is centered on the "away-from-camera" direction in the floor
   *  plane, so dice enter from the half of the floor that projects to the
   *  upper half of the viewport.
   *  - 180 = full upper half (dice may enter from horizontal-left/right).
   *  - 130 = upper-center cone (default; dice cluster near top-center).
   *  - 60  = narrow strip directly above focus. */
  entryArcDegrees: number;
}

export const THROW: ThrowConfig = {
  // Closer to the focus point so dice enter the viewport within ~0.15s of
  // release instead of spending half a second above the top of the screen.
  // Still far enough that the spawn projects outside the viewport on every
  // azimuth in the entry arc.
  spawnDistance:   { min: 7.0,  max: 9.0 },
  // Just above the viewport top (≈ screen-y 8 in the current camera) AND
  // above wall top (y=7) so dice clear the walls on the way in. Enter the
  // visible frame quickly after release.
  startHeight:     { min: 10.0, max: 12.0 },
  // Tuned so dice land near the focus point, INSIDE the tray walls, with
  // ~0.8s of flight at the configured start height.
  throwSpeed:      { min: 8.0,  max: 11.0 },
  fallSpeed:       { min: 1.0,  max: 3.0 },
  // Tightened so landing positions cluster near focus and stay inside the
  // walls even with all the other randomization in play.
  lateralScatter:  1.0,
  spin:            { min: 18, max: 32 },
  staggerMs:       30,
  entryArcDegrees: 130,
};

/**
 * Build a fresh set of lights for the scene. Returned every time so the host
 * can dispose + rebuild on HMR without reusing torn-down Object3Ds.
 *
 * Composition:
 *   - HemisphereLight: soft sky/ground gradient — fills shadow side with a
 *     hint of cool, top with warm. Cheap global illumination.
 *   - Key DirectionalLight: warm, top-right, casts the main shading.
 *   - Fill DirectionalLight: cool, opposite side, lifts the shadow side
 *     without flattening contrast.
 *   - Rim DirectionalLight: warm back-light, picks the dice silhouette out
 *     against the dark tray.
 *
 * Tweak intensities here, save, and HMR re-applies live.
 */
export const buildLights = (): THREE.Light[] => {
  const hemi = new THREE.HemisphereLight(0xfff0d0, 0x5a4128, 1.05);
  hemi.position.set(0, 20, 0);

  const key = new THREE.DirectionalLight(0xfff5e0, 1.85);
  key.position.set(8, 14, 6);

  const fill = new THREE.DirectionalLight(0xb8d0ff, 0.7);
  fill.position.set(-6, 8, -4);

  const rim = new THREE.DirectionalLight(0xffd49a, 0.65);
  rim.position.set(-4, 6, -12);

  return [hemi, key, fill, rim];
};

export type SceneConfigModule = {
  CAMERA: CameraConfig;
  FLOOR: typeof FLOOR;
  PIXELATION: typeof PIXELATION;
  VIGNETTE: VignetteConfig;
  THROW: ThrowConfig;
  buildLights: typeof buildLights;
};
