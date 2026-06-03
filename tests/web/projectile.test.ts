import { describe, it, expect } from 'vitest';
import {
  projectileIdForKind,
  impactIdFor,
  resolveProjectilePath,
  ROTATION_OFFSET,
} from '../../web/components/Projectile.js';
import type { AssetManifest } from '../../src/runtime/ws/manifest.js';

const baseManifest: AssetManifest = {
  heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
  tilesets: {}, props: {}, npcs: {},
  projectiles: {
    'fire-bolt':   'projectiles/fire-bolt',
    'arrow':       'projectiles/arrow',
    'magic-bolt':  'projectiles/magic-bolt',
    'fire-impact': 'projectiles/fire-impact.png',
  },
  animations: {},
};

describe('projectileIdForKind', () => {
  it('magic prefers magic-bolt', () => {
    expect(projectileIdForKind('magic', undefined, baseManifest)).toBe('magic-bolt');
  });
  it('ranged prefers arrow', () => {
    expect(projectileIdForKind('ranged', undefined, baseManifest)).toBe('arrow');
  });
  it('melee has no flying projectile', () => {
    expect(projectileIdForKind('melee', undefined, baseManifest)).toBeNull();
  });
  it('flame-burst suppresses the flying bolt (it is AOE)', () => {
    expect(projectileIdForKind('magic', 'flame-burst', baseManifest)).toBeNull();
  });
  it('magic falls back to fire-bolt when magic-bolt is missing', () => {
    const partial: AssetManifest = {
      ...baseManifest,
      projectiles: { 'fire-bolt': 'projectiles/fire-bolt' },
    };
    expect(projectileIdForKind('magic', undefined, partial)).toBe('fire-bolt');
  });
  it('returns null when nothing matches', () => {
    const empty: AssetManifest = { ...baseManifest, projectiles: {} };
    expect(projectileIdForKind('magic', undefined, empty)).toBeNull();
    expect(projectileIdForKind('ranged', undefined, empty)).toBeNull();
  });
});

describe('impactIdFor', () => {
  it('flame-burst always uses fire-impact', () => {
    expect(impactIdFor('magic', 'flame-burst', baseManifest)).toBe('fire-impact');
  });
  it('magic uses fire-impact', () => {
    expect(impactIdFor('magic', undefined, baseManifest)).toBe('fire-impact');
  });
  it('ranged has no impact sprite (HIT/MISS label is enough)', () => {
    expect(impactIdFor('ranged', undefined, baseManifest)).toBeNull();
  });
  it('melee has no impact sprite', () => {
    expect(impactIdFor('melee', undefined, baseManifest)).toBeNull();
  });
});

describe('resolveProjectilePath', () => {
  it('resolves folder entries to the canonical north.png base sprite', () => {
    expect(
      resolveProjectilePath('projectiles/fire-bolt', '/assets'),
    ).toBe('/assets/projectiles/fire-bolt/north.png');
  });
  it('passes .png entries through verbatim', () => {
    expect(
      resolveProjectilePath('projectiles/fire-impact.png', '/assets'),
    ).toBe('/assets/projectiles/fire-impact.png');
  });
});

describe('rotation math (base sprite points north / tip-up)', () => {
  // The runtime applies: sprite.rotation = Math.atan2(dy, dx) + ROTATION_OFFSET.
  // These tests pin the four cardinals so a regression in the offset shows up
  // immediately, instead of only being noticeable as a wrong-facing projectile.
  const rotationFor = (dx: number, dy: number) =>
    Math.atan2(dy, dx) + ROTATION_OFFSET;

  // Y axis points down in screen space (Pixi convention), so:
  //   east  → dx>0, dy=0  → atan2=0     → rotation = +π/2 (90° CW from north → east)
  //   south → dx=0, dy>0  → atan2=+π/2  → rotation = +π   (180°: north → south)
  //   west  → dx<0, dy=0  → atan2=±π    → rotation = +3π/2 or -π/2 (north → west)
  //   north → dx=0, dy<0  → atan2=-π/2  → rotation = 0    (sprite already faces north)
  const TAU = Math.PI * 2;
  const normalize = (r: number) => ((r % TAU) + TAU) % TAU;

  it('east flight → +90° rotation', () => {
    expect(normalize(rotationFor(5, 0))).toBeCloseTo(Math.PI / 2);
  });
  it('south flight → +180° rotation', () => {
    expect(normalize(rotationFor(0, 5))).toBeCloseTo(Math.PI);
  });
  it('west flight → +270° rotation', () => {
    expect(normalize(rotationFor(-5, 0))).toBeCloseTo(3 * Math.PI / 2);
  });
  it('north flight → 0° rotation (base orientation)', () => {
    expect(normalize(rotationFor(0, -5))).toBeCloseTo(0);
  });
  it('north-east flight → +45° rotation', () => {
    expect(normalize(rotationFor(5, -5))).toBeCloseTo(Math.PI / 4);
  });
});
