import { describe, it, expect } from 'vitest';
import {
  HERO_GLYPHS,
  MONSTER_GLYPHS,
  POOL_GLYPHS,
  heroGlyph,
  monsterGlyph,
  actorDisplay,
  formatPools,
  formatItemName,
} from '../../../src/runtime/cli/glyphs.js';

describe('glyph registry', () => {
  it('every v1 archetype has a glyph', () => {
    expect(HERO_GLYPHS.warrior).toBeTruthy();
    expect(HERO_GLYPHS.hunter).toBeTruthy();
    expect(HERO_GLYPHS.healer).toBeTruthy();
    expect(HERO_GLYPHS.warlock).toBeTruthy();
  });

  it('giant-rat and king-rat have glyphs', () => {
    expect(MONSTER_GLYPHS['giant-rat']).toBe('🐀');
    expect(MONSTER_GLYPHS['king-rat']).toBe('👑');
  });

  it('helpers fall back gracefully', () => {
    expect(heroGlyph(undefined)).toBeTruthy();
    expect(monsterGlyph('unknown-bestiary-id')).toBeTruthy();
  });

  it('DM emoji is 📖 (book), reserving 🎲 for dice-roll resolution events', () => {
    const d = actorDisplay({ id: 'dm', kind: 'dm' });
    expect(d.emoji).toBe('📖');
    expect(d.emoji).not.toBe('🎲');
    expect(d.who).toBe('DM');
  });

  it('hero glyphs are person-themed', () => {
    expect(HERO_GLYPHS.warrior).toBe('💂');
    expect(HERO_GLYPHS.hunter).toBe('🧝');
    expect(HERO_GLYPHS.healer).toBe('👼');
    expect(HERO_GLYPHS.warlock).toBe('🧙');
    expect(HERO_GLYPHS.rogue).toBe('🥷');
    expect(HERO_GLYPHS.knight).toBe('🤺');
    expect(HERO_GLYPHS.brute).toBe('🧌');
  });

  it('POOL_GLYPHS map: melee 💪 / ranged 🏹 / magic 🪄 / armor 🛡️', () => {
    expect(POOL_GLYPHS.melee).toBe('💪');
    expect(POOL_GLYPHS.ranged).toBe('🏹');
    expect(POOL_GLYPHS.magic).toBe('🪄');
    expect(POOL_GLYPHS.armor).toBe('🛡️');
  });
});

describe('formatPools', () => {
  it('renders only non-zero pools, joined by spaces', () => {
    // Anwen the Warrior: melee + armor
    expect(formatPools({ melee: 2, ranged: 0, magic: 0, armor: 2 })).toBe('💪×2 🛡️×2');
    // Kael the Warlock: magic + armor
    expect(formatPools({ melee: 0, ranged: 0, magic: 2, armor: 1 })).toBe('🪄×2 🛡️×1');
    // Bran the Hunter: ranged + armor
    expect(formatPools({ melee: 0, ranged: 2, magic: 0, armor: 2 })).toBe('🏹×2 🛡️×2');
  });

  it('preserves declaration order: melee → ranged → magic → armor', () => {
    expect(formatPools({ melee: 1, ranged: 1, magic: 1, armor: 1 })).toBe('💪×1 🏹×1 🪄×1 🛡️×1');
  });

  it('returns empty string when every pool is zero', () => {
    expect(formatPools({ melee: 0, ranged: 0, magic: 0, armor: 0 })).toBe('');
  });

  it('does NOT use the M/R/G/A letter abbreviations anywhere', () => {
    const out = formatPools({ melee: 2, ranged: 2, magic: 2, armor: 2 });
    expect(out).not.toMatch(/\bM\d/);
    expect(out).not.toMatch(/\bR\d/);
    expect(out).not.toMatch(/\bG\d/);
    expect(out).not.toMatch(/\bA\d/);
  });
});

describe('formatItemName', () => {
  it('title-cases v1 single-word ids', () => {
    expect(formatItemName('potion')).toBe('Potion');
    expect(formatItemName('rope')).toBe('Rope');
    expect(formatItemName('bomb')).toBe('Bomb');
    expect(formatItemName('food')).toBe('Food');
    expect(formatItemName('gold')).toBe('Gold');
    expect(formatItemName('herbs')).toBe('Herbs');
  });

  it('title-cases each word of a kebab id', () => {
    expect(formatItemName('healing-potion')).toBe('Healing Potion');
    expect(formatItemName('throwing-knife-bundle')).toBe('Throwing Knife Bundle');
  });

  it('returns plain text — no emoji, no glyph', () => {
    const out = formatItemName('potion');
    // U+1F9EA is the test tube; assert it's not in the output.
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
