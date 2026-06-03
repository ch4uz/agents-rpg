import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-character animation strip. `path` points at a folder containing one
 * horizontal sprite strip per direction (`{south,east,north,west}.png`),
 * each strip laying out `frames` columns at the character's native canvas
 * size. `fps` is the suggested playback rate; renderers may clamp it.
 */
export interface AnimationStrip {
  path: string;
  frames: number;
  fps: number;
}

export type CharacterAnimations = Partial<Record<
  'idle' | 'walk' | 'attack' | 'death' | 'spawn',
  AnimationStrip
>>;

export interface AssetManifest {
  /**
   * Hero / monster sprite entry. Two shapes are accepted:
   *  - `.png` path → single static sprite (legacy / non-directional).
   *  - folder path → must contain `south.png` and (optionally) `east.png`,
   *    `north.png`, `west.png`. The renderer reads `<folder>/<facing>.png`
   *    when swapping facing direction.
   */
  heroes:    Record<string, string>;
  monsters:  Record<string, string>;
  npcs:      Record<string, string>;
  /**
   * @deprecated Single-PNG scene backgrounds were removed — every scene now
   * renders from a `tilesets` entry. Kept optional so older fixtures that still
   * pass `maps: {}` keep type-checking; nothing reads it.
   */
  maps?:     Record<string, string>;
  items:     Record<string, string>;
  equipment: Record<string, string>;
  boons:     Record<string, string>;
  tilesets:  Record<string, { image: string; metadata: string }>;
  props:     Record<string, string>;
  /**
   * VFX sprites used by the in-game projectile layer. Two flavors:
   *  - directional (`{south,east,north,west}.png` under a folder) for flying
   *    projectiles (fire bolts, arrows, magic bolts) — the value is the folder
   *    relative path WITHOUT a per-direction suffix, e.g. `projectiles/fire-bolt`.
   *  - single-frame impact effects — value is a full path to one PNG.
   * The browser distinguishes by checking whether the resolved path ends in `.png`.
   */
  projectiles: Record<string, string>;
  /**
   * Per-character animation set. Keyed by the same id used in `heroes` /
   * `monsters` (the archetype or sprite key). Each animation is a folder of
   * directional strips. Missing entries are fine — the renderer falls back
   * to the static rotation image for unknown animations.
   */
  animations: Record<string, CharacterAnimations>;
  /**
   * 3D dice models (`.glb`). The browser-side 3D dice overlay loads these
   * through three.js' GLTFLoader. Each entry is a relative path ending in
   * `.glb`. Today the only key is `default`, used for every d6 roll. Optional
   * so legacy test fixtures (predating the 3D overlay) still satisfy the
   * type without an extra `dice: {}` line.
   */
  dice?: Record<string, string>;
}

export const loadManifest = (path: string): AssetManifest => {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AssetManifest>;
  return {
    heroes:      parsed.heroes      ?? {},
    monsters:    parsed.monsters    ?? {},
    npcs:        parsed.npcs        ?? {},
    items:       parsed.items       ?? {},
    equipment:   parsed.equipment   ?? {},
    boons:       parsed.boons       ?? {},
    tilesets:    parsed.tilesets    ?? {},
    props:       parsed.props       ?? {},
    projectiles: parsed.projectiles ?? {},
    animations:  parsed.animations  ?? {},
    dice:        parsed.dice        ?? {},
  };
};

/**
 * Groups where each entry value is a plain file path. `heroes`, `monsters`,
 * and `props` accept BOTH `.png` paths (legacy single sprite) and folder
 * paths (directional set — must contain at least `south.png`).
 */
const FLAT_PNG_GROUPS = ['items', 'equipment', 'boons'] as const;
const FLAT_DIRECTIONAL_GROUPS = ['heroes', 'monsters', 'npcs', 'props'] as const;

const checkFile = (full: string, label: string): void => {
  try {
    const s = statSync(full);
    if (!s.isFile()) throw new Error(`Manifest asset is not a file: ${label}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Missing manifest asset ${label} (${msg})`);
  }
};

export const validateManifest = (m: AssetManifest, assetsRoot: string): void => {
  for (const g of FLAT_PNG_GROUPS) {
    for (const [id, rel] of Object.entries(m[g])) {
      checkFile(join(assetsRoot, rel), `${g}.${id}: ${rel}`);
    }
  }
  for (const g of FLAT_DIRECTIONAL_GROUPS) {
    for (const [id, rel] of Object.entries(m[g])) {
      // Folder form → require south.png; .png form → use as-is.
      const probe = rel.endsWith('.png') ? rel : `${rel}/south.png`;
      checkFile(join(assetsRoot, probe), `${g}.${id}: ${probe}`);
    }
  }
  for (const [id, ts] of Object.entries(m.tilesets)) {
    checkFile(join(assetsRoot, ts.image),    `tilesets.${id}.image: ${ts.image}`);
    checkFile(join(assetsRoot, ts.metadata), `tilesets.${id}.metadata: ${ts.metadata}`);
  }
  // Projectile entries are either a direct .png (single-frame impact) OR a
  // folder containing north.png (the canonical "tip-up" base sprite — the
  // renderer rotates this to the exact flight vector).
  for (const [id, rel] of Object.entries(m.projectiles)) {
    const probe = rel.endsWith('.png') ? rel : `${rel}/north.png`;
    checkFile(join(assetsRoot, probe), `projectiles.${id}: ${probe}`);
  }
  // Animation entries (optional) — when present, require each (animation,
  // direction) folder to contain at least frame `0.png`. Per-frame layout
  // is `<path>/<facing>/<frameIdx>.png` for frameIdx = 0..frames-1. The
  // renderer loads frames lazily by frameIdx, so we only smoke-test frame 0.
  for (const [charId, anims] of Object.entries(m.animations)) {
    for (const [animName, strip] of Object.entries(anims)) {
      if (!strip) continue;
      checkFile(
        join(assetsRoot, strip.path, 'south', '0.png'),
        `animations.${charId}.${animName}: ${strip.path}/south/0.png`,
      );
    }
  }
  for (const [id, rel] of Object.entries(m.dice ?? {})) {
    if (!rel.endsWith('.glb')) {
      throw new Error(`Manifest asset dice.${id} must be a .glb (got ${rel})`);
    }
    checkFile(join(assetsRoot, rel), `dice.${id}: ${rel}`);
  }
};
