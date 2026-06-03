// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeTokenPositions, fitTokenScale, CELL_PX, resolveCharacterSprite, creatureRingColor, tokenZIndex } from '../../web/components/Board.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { AssetManifest } from '../../src/runtime/ws/manifest.js';

const baseChar = (overrides: Partial<RedactedCharacter>): RedactedCharacter => ({
  id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
  pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
  pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: 'X', description: '' },
  bonusAbility:  { name: 'Y', description: '' },
  ...overrides,
});

describe('Board.computeTokenPositions', () => {
  it('places a token at (x*CELL_PX, y*CELL_PX)', () => {
    const c = baseChar({ pos: { x: 2, y: 3 } });
    const positions = computeTokenPositions([c], CELL_PX);
    expect(positions.get('h1')).toEqual({ x: 2 * CELL_PX, y: 3 * CELL_PX });
  });

  it('omits a character with null pos', () => {
    const c = baseChar({ pos: null });
    expect(computeTokenPositions([c], CELL_PX).has('h1')).toBe(false);
  });

  it('handles multiple characters with mixed positions', () => {
    const a = baseChar({ id: 'a' as never, pos: { x: 0, y: 0 } });
    const b = baseChar({ id: 'b' as never, pos: { x: 4, y: 7 } });
    const c = baseChar({ id: 'c' as never, pos: null });
    const positions = computeTokenPositions([a, b, c], CELL_PX);
    expect(positions.size).toBe(2);
    expect(positions.get('b')).toEqual({ x: 4 * CELL_PX, y: 7 * CELL_PX });
  });

  it('CELL_PX is exported and equals 64', () => {
    expect(CELL_PX).toBe(64);
  });
});

describe('Board.fitTokenScale', () => {
  it('downscales a very large sprite by an integer divisor (300×389 → /7)', () => {
    // 389 / 64 = 6.08 → ceil → k=7, so 300/7 ≈ 43, 389/7 ≈ 56.
    expect(fitTokenScale(300, 389, 64)).toEqual({ w: 43, h: 56 });
  });

  it('downscales a wide sprite by an integer divisor (800×200 → /13)', () => {
    // 800 / 64 = 12.5 → ceil → k=13, so 800/13 ≈ 62, 200/13 ≈ 15.
    expect(fitTokenScale(800, 200, 64)).toEqual({ w: 62, h: 15 });
  });

  it('downscales a 128×128 sprite by 1/2 to fit a 64-cell exactly', () => {
    expect(fitTokenScale(128, 128, 64)).toEqual({ w: 64, h: 64 });
  });

  it('renders near-cell sprites at NATIVE size (no fractional scale)', () => {
    // 68 / 64 = 1.06 → within the 1.25× tolerance → no scaling.
    expect(fitTokenScale(68, 68, 64)).toEqual({ w: 68, h: 68 });
  });

  it('upscales small sprites by an integer factor', () => {
    expect(fitTokenScale(32, 32, 64)).toEqual({ w: 64, h: 64 });
    expect(fitTokenScale(24, 24, 64)).toEqual({ w: 48, h: 48 });
  });

  it('returns cell × cell for degenerate (zero) inputs', () => {
    expect(fitTokenScale(0, 100, 64)).toEqual({ w: 64, h: 64 });
    expect(fitTokenScale(100, 0, 64)).toEqual({ w: 64, h: 64 });
  });
});

describe('Board.resolveCharacterSprite (bound captive)', () => {
  const manifest = {
    heroes: { healer: 'heroes/healer', 'healer-bound': 'heroes/healer-bound/south.png', warrior: 'heroes/warrior' },
    monsters: {}, npcs: {},
  } as unknown as AssetManifest;

  it('uses the normal sprite for a healthy healer', () => {
    const r = resolveCharacterSprite(baseChar({ archetype: 'healer', sprite: 'healer' }), manifest);
    expect(r).toEqual({ id: 'healer', value: 'heroes/healer' });
  });

  it('swaps to the dedicated -bound sprite for an immobilized healer', () => {
    const r = resolveCharacterSprite(
      baseChar({ archetype: 'healer', sprite: 'healer', health: { total: 3, damage: 0, status: 'immobilized' } }),
      manifest,
    );
    expect(r).toEqual({ id: 'healer-bound', value: 'heroes/healer-bound/south.png' });
  });

  it('falls back to the base sprite when no -bound variant exists', () => {
    const r = resolveCharacterSprite(
      baseChar({ archetype: 'warrior', sprite: 'warrior', health: { total: 3, damage: 0, status: 'immobilized' } }),
      manifest,
    );
    expect(r).toEqual({ id: 'warrior', value: 'heroes/warrior' });
  });
});

describe('Board.creatureRingColor (dialogue-ref highlight matches chip colour)', () => {
  it('rings a monster in salmon-red (matching .dlg-ref--monster #ff8f7a)', () => {
    expect(creatureRingColor('monster')).toBe(0xff8f7a);
  });

  it('rings a hero in amber (matching .dlg-ref--hero #ffcf7a)', () => {
    expect(creatureRingColor('hero')).toBe(0xffcf7a);
  });

  it('rings an npc in green (matching .dlg-ref--npc #8fe0a0)', () => {
    expect(creatureRingColor('npc')).toBe(0x8fe0a0);
  });

  it('falls back to the bare-chip gold for an unknown kind', () => {
    expect(creatureRingColor('prop')).toBe(0xffe85c);
  });
});

describe('Board.tokenZIndex (corpses render below the living)', () => {
  it('puts a KO corpse below every living status', () => {
    for (const living of ['normal', 'prone', 'immobilized'] as const) {
      expect(tokenZIndex('KO')).toBeLessThan(tokenZIndex(living));
    }
  });

  it('keeps all living statuses on the same layer (insertion order untouched)', () => {
    expect(tokenZIndex('normal')).toBe(tokenZIndex('prone'));
    expect(tokenZIndex('normal')).toBe(tokenZIndex('immobilized'));
  });
});
