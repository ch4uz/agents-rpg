import { Assets, Sprite, Texture, type Container } from 'pixi.js';
import type { AssetManifest } from '../../src/runtime/ws/manifest.js';

export type AttackKind = 'melee' | 'ranged' | 'magic';

export interface ProjectileSpec {
  /** Attacker pixel (cell-center). */
  fromX: number;
  fromY: number;
  /** Target pixel (cell-center). */
  toX: number;
  toY: number;
  /** Selects the bolt sprite + impact effect. */
  attackKind: AttackKind;
  /** True when the engine resolved this attack as a hit. */
  hit: boolean;
  /** Optional special-effect id (e.g. 'flame-burst') — biases impact sprite + bolt suppression. */
  specialEffectId?: string;
}

/** Pure: pick the projectile id from the manifest for an attack kind. */
export const projectileIdForKind = (
  kind: AttackKind,
  specialEffectId: string | undefined,
  manifest: AssetManifest,
): string | null => {
  if (specialEffectId === 'flame-burst') return null; // AOE-only — no flying bolt
  // Lookup order: kind-specific id, then a generic fallback.
  const ids = kind === 'magic'
    ? ['magic-bolt', 'fire-bolt']
    : kind === 'ranged'
      ? ['arrow', 'magic-bolt']
      : []; // melee: no flying projectile
  for (const id of ids) {
    if (manifest.projectiles[id]) return id;
  }
  return null;
};

/** Pure: pick the impact sprite for an attack. */
export const impactIdFor = (
  kind: AttackKind,
  specialEffectId: string | undefined,
  manifest: AssetManifest,
): string | null => {
  const ids = specialEffectId === 'flame-burst'
    ? ['fire-impact']
    : kind === 'magic'
      ? ['fire-impact']
      : kind === 'ranged'
        ? []  // arrows skip impact sprite — HIT/MISS label is enough
        : []; // melee: no projectile, no impact
  for (const id of ids) {
    if (manifest.projectiles[id]) return id;
  }
  return null;
};

/**
 * Resolve a manifest projectile entry to a full PNG path.
 *
 * Two value shapes are supported:
 *  - Direct `.png` path — used verbatim (impact bursts).
 *  - Folder path — resolves to `<folder>/north.png`, the canonical
 *    "pointing UP" base sprite. PixelLab's north view consistently
 *    centers the projectile vertically with the tip at the top, which
 *    rotates cleanly to any direction; the east view is slightly
 *    off-axis on some sprites and produces a visibly tilted result.
 *
 *    The runtime rotates this base by `atan2(dy, dx) + π/2` so the tip
 *    follows the exact flight vector. (See ROTATION_OFFSET below.)
 */
export const resolveProjectilePath = (
  rel: string,
  assetsBase: string,
): string => {
  if (rel.endsWith('.png')) return `${assetsBase}/${rel}`;
  return `${assetsBase}/${rel}/north.png`;
};

/**
 * Radians to add to `atan2(dy, dx)` so a north-facing (tip-up) base sprite
 * rotates to face the flight direction.
 *
 *   atan2(dy, dx) is 0 for due east, π/2 for due south, etc.
 *   The base sprite points up (north = -π/2 in atan2 terms).
 *   To align north → east we need to rotate by +π/2, so the offset is +π/2.
 *
 * Exported for tests so this load-bearing constant has one source of truth.
 */
export const ROTATION_OFFSET = Math.PI / 2;

export const BOLT_PX_PER_MS = 0.42;   // ≈ one 64-px cell every ~150ms — fast but readable
export const BOLT_MIN_MS = 140;
export const BOLT_MAX_MS = 520;
const IMPACT_MS = 260;

/**
 * Pure: ms a projectile takes to travel `(dx, dy)` pixels. Same clamped
 * formula `runProjectile` uses internally — exported so the HIT/MISS label
 * timing in Board.ts and the WS event-deferral dispatcher can match exactly.
 */
export const computeFlightMs = (dx: number, dy: number): number => {
  const dist = Math.hypot(dx, dy);
  return Math.min(BOLT_MAX_MS, Math.max(BOLT_MIN_MS, dist / BOLT_PX_PER_MS));
};

/**
 * Animate a single projectile from (fromX,fromY) to (toX,toY), then play a
 * brief impact flash at the target. Both phases use requestAnimationFrame and
 * destroy the sprites when finished, so no caller cleanup is required.
 *
 * Returns immediately; the animation lifecycle is owned internally.
 */
export const triggerProjectile = (
  parent: Container,
  spec: ProjectileSpec,
  manifest: AssetManifest,
  assetsBase: string,
): void => {
  void runProjectile(parent, spec, manifest, assetsBase);
};

const runProjectile = async (
  parent: Container,
  spec: ProjectileSpec,
  manifest: AssetManifest,
  assetsBase: string,
): Promise<void> => {
  const dx = spec.toX - spec.fromX;
  const dy = spec.toY - spec.fromY;
  const dist = Math.hypot(dx, dy);
  // Flight heading in radians. The base sprite points UP (north); we add
  // π/2 so atan2's east-zero convention aligns with the sprite's tip-up
  // orientation. Net effect: the projectile's tip always faces the target,
  // for any attacker/target geometry — no cardinal snapping artifacts.
  const heading = Math.atan2(dy, dx) + ROTATION_OFFSET;
  const boltId = projectileIdForKind(spec.attackKind, spec.specialEffectId, manifest);

  // Bolt phase. Skip entirely for melee or when no sprite is registered for
  // the kind — we still play the impact effect after a 0-ms "flight."
  if (boltId) {
    const rel = manifest.projectiles[boltId]!;
    const path = resolveProjectilePath(rel, assetsBase);
    const flightMs = Math.min(BOLT_MAX_MS, Math.max(BOLT_MIN_MS, dist / BOLT_PX_PER_MS));
    try {
      const tex = await Assets.load(path) as Texture;
      tex.source.scaleMode = 'nearest';
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5, 0.5);
      sprite.rotation = heading;
      // The texture is generated at 68×68 to match CELL_PX≈64 with some breathing
      // room for trails/tails. Render at native pixel size.
      sprite.x = spec.fromX;
      sprite.y = spec.fromY;
      parent.addChild(sprite);
      await tween(flightMs, (t) => {
        sprite.x = spec.fromX + dx * t;
        sprite.y = spec.fromY + dy * t;
      });
      parent.removeChild(sprite);
      sprite.destroy();
    } catch {
      // Texture load failure — skip the bolt phase silently. The HIT/MISS
      // label from flashRoll still tells the player the attack landed.
    }
  }

  // Impact phase. Always shown for HITs of magic/special. Skipped for misses
  // and ranged-arrow hits (the existing HIT label is enough).
  if (!spec.hit) return;
  const impactId = impactIdFor(spec.attackKind, spec.specialEffectId, manifest);
  if (!impactId) return;
  const impactRel = manifest.projectiles[impactId]!;
  const impactPath = resolveProjectilePath(impactRel, assetsBase);
  try {
    const tex = await Assets.load(impactPath) as Texture;
    tex.source.scaleMode = 'nearest';
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.x = spec.toX;
    sprite.y = spec.toY;
    parent.addChild(sprite);
    await tween(IMPACT_MS, (t) => {
      // Quick pop: scale 0.6 → 1.25, alpha 1 → 0 in the last third.
      const s = 0.6 + 0.65 * Math.min(1, t * 1.4);
      sprite.scale.set(s);
      sprite.alpha = t < 0.66 ? 1 : Math.max(0, 1 - (t - 0.66) / 0.34);
    });
    parent.removeChild(sprite);
    sprite.destroy();
  } catch {
    // Same fallback strategy as the bolt phase.
  }
};

/** requestAnimationFrame-based 0→1 tween that resolves when complete. */
const tween = (ms: number, step: (t: number) => void): Promise<void> => {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      step(t);
      if (t >= 1) { resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
};
