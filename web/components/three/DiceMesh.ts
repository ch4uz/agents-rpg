/**
 * 3D dice mesh management — single GLB load, clone-per-die, and the
 * quaternion math that aligns a target face with world +Y.
 *
 * The pip-to-axis mapping in `FACE_NORMALS` is calibrated against the
 * `perfect_little_dice_3cm.glb` model. The cube is axis-aligned (verified by
 * `bin/inspect-dice-glb.ts`); the assignment below uses the standard Western
 * convention (opposite faces sum to 7, 1 on top in artist's default view).
 * If the rendered face doesn't match the engine's predetermined value on the
 * first live roll, swap entries here — the geometry is symmetric so only the
 * mapping changes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type Face = 1 | 2 | 3 | 4 | 5 | 6;

/* Calibrated against the GLB via the dice-test page's "Show face N" buttons.
 *
 *   axis  | pip count visible on the GLB texture for that axis
 *   ------+----------------------------------------------------
 *   -X    | 1
 *   +Y    | 2
 *   -Z    | 3
 *   +Z    | 4
 *   -Y    | 5
 *   +X    | 6
 *
 * Opposite faces correctly sum to 7 (1↔6 on ±X, 2↔5 on ±Y, 3↔4 on ∓Z). */
export const FACE_NORMALS: Record<Face, THREE.Vector3> = {
  1: new THREE.Vector3(-1,  0,  0),
  2: new THREE.Vector3( 0,  1,  0),
  3: new THREE.Vector3( 0,  0, -1),
  4: new THREE.Vector3( 0,  0,  1),
  5: new THREE.Vector3( 0, -1,  0),
  6: new THREE.Vector3( 1,  0,  0),
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Build the minimum-arc quaternion that, when applied to the die, brings
 * `FACE_NORMALS[face]` into world +Y. The alignment quaternion is unique up
 * to a spin around +Y, so we pick the one of 4 spin candidates that is
 * closest (largest |dot|) to `currentQ` — produces the shortest slerp path.
 */
export const quaternionForFace = (face: Face, currentQ: THREE.Quaternion): THREE.Quaternion => {
  const localUp = FACE_NORMALS[face];
  const align = new THREE.Quaternion().setFromUnitVectors(localUp, WORLD_UP);

  let best = new THREE.Quaternion().copy(align);
  let bestDot = Math.abs(currentQ.dot(best));
  for (let k = 1; k < 4; k++) {
    const spin = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, (k * Math.PI) / 2);
    const cand = spin.clone().multiply(align);
    const d = Math.abs(currentQ.dot(cand));
    if (d > bestDot) { bestDot = d; best = cand; }
  }
  return best;
};

let cachedScene: THREE.Object3D | null = null;
let pendingLoad: Promise<THREE.Object3D> | null = null;

/**
 * Load the dice GLB once and return the source mesh. Subsequent calls clone
 * from the cached scene. Throws if the asset can't be loaded.
 */
export const loadDiceMesh = (url: string): Promise<THREE.Object3D> => {
  if (cachedScene) return Promise.resolve(cachedScene);
  if (pendingLoad) return pendingLoad;
  const loader = new GLTFLoader();
  pendingLoad = new Promise<THREE.Object3D>((res, rej) => {
    loader.load(
      url,
      (gltf) => {
        cachedScene = gltf.scene;
        // Force nearest-neighbor filtering on the dice texture so it matches
        // the pixel-art aesthetic — no bilinear interpolation on dice pips.
        cachedScene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            const mat = obj.material as THREE.MeshStandardMaterial;
            if (mat?.map) {
              mat.map.magFilter = THREE.NearestFilter;
              mat.map.minFilter = THREE.NearestFilter;
              mat.map.generateMipmaps = false;
              mat.needsUpdate = true;
            }
          }
        });
        res(cachedScene);
      },
      undefined,
      (err) => rej(err instanceof Error ? err : new Error(String(err))),
    );
  });
  return pendingLoad;
};

/**
 * Material overrides for a single cloned die. All fields are optional and
 * stack — if `tint` is set the albedo is multiplied by it; if `roughness`
 * is set the material becomes more/less matte; etc. Used to give each die
 * a per-owner skin (see `DiceSkins.ts`).
 */
export interface DieMaterialOverrides {
  /** Albedo multiplier (texture × color). `0xffffff` or undefined = no tint. */
  tint?: number;
  /** 0 = mirror-like, 1 = fully matte. Wood dice default lives around 0.85. */
  roughness?: number;
  /** 0 = dielectric (plastic/wood/stone), 1 = pure metal. */
  metalness?: number;
  /** Emissive base color — glow tint independent of any light source. */
  emissive?: number;
  /** Strength of the emissive glow. 0 disables; 0.15–0.4 is a subtle aura;
   *  >1 obliterates the diffuse texture. */
  emissiveIntensity?: number;
}

/**
 * Produce a clone of the loaded mesh suitable for placing into a scene. Each
 * clone has independent transform (position / quaternion) AND its own copy
 * of every material — so callers can tint or otherwise mutate a single die
 * without affecting other dice in the scene. Geometry is still shared with
 * the source for memory efficiency.
 *
 * `overrides`, when present, applies per-die material tweaks (see
 * `DieMaterialOverrides`). Use this to skin a die by owner.
 */
export const cloneDie = (overrides?: DieMaterialOverrides): THREE.Object3D => {
  if (!cachedScene) throw new Error('dice mesh not loaded — call loadDiceMesh first');
  const obj = cachedScene.clone(true);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const m = (child.material as THREE.MeshStandardMaterial).clone();
      if (overrides) {
        if (overrides.tint              !== undefined && overrides.tint !== 0xffffff) m.color.setHex(overrides.tint);
        if (overrides.roughness         !== undefined) m.roughness = overrides.roughness;
        if (overrides.metalness         !== undefined) m.metalness = overrides.metalness;
        if (overrides.emissive          !== undefined) m.emissive.setHex(overrides.emissive);
        if (overrides.emissiveIntensity !== undefined) m.emissiveIntensity = overrides.emissiveIntensity;
      }
      child.material = m;
    }
  });
  return obj;
};

/** Reset for tests. Not used at runtime. */
export const __resetDiceCacheForTests = (): void => {
  cachedScene = null;
  pendingLoad = null;
};
