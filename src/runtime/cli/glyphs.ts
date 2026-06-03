import type { Archetype } from '../../engine/character.js';

// Glyphs deliberately avoid VS-16 (U+FE0F variation selector) emojis
// (⚔️, 🗡️, 🛡️, ⬇️, ❤️) because terminals render them at inconsistent
// column widths. All entries below are unambiguous emoji presentation.
export const HERO_GLYPHS: Record<Archetype, string> = {
  warrior: '💂', hunter: '🧝', healer: '👼', warlock: '🧙',
  rogue:   '🥷', knight: '🤺', brute:  '🧌',
};

/** Pool-channel glyphs for the side panel HUD. The 🛡️ shield uses VS-16
 *  (one of the few VS-16 glyphs we accept) because no presentation-form
 *  shield codepoint exists in standard emoji. Side panel rendering uses
 *  per-cell `<Text>` elements so minor width drift won't break alignment. */
export const POOL_GLYPHS: { melee: string; ranged: string; magic: string; armor: string } = {
  melee:  '💪',
  ranged: '🏹',
  magic:  '🪄',
  armor:  '🛡️',
};

/**
 * Render the four dice pools as `<emoji>×N` tokens, omitting any pool with a
 * value of 0. Returns an empty string when no pool has dice (rare/unused).
 * Used by the side panel HUD; spaces separate the tokens so the join is safe
 * to drop into a single Ink `<Text>` cell.
 */
export const formatPools = (pools: { melee: number; ranged: number; magic: number; armor: number }): string => {
  const parts: string[] = [];
  if (pools.melee  > 0) parts.push(`${POOL_GLYPHS.melee}×${pools.melee}`);
  if (pools.ranged > 0) parts.push(`${POOL_GLYPHS.ranged}×${pools.ranged}`);
  if (pools.magic  > 0) parts.push(`${POOL_GLYPHS.magic}×${pools.magic}`);
  if (pools.armor  > 0) parts.push(`${POOL_GLYPHS.armor}×${pools.armor}`);
  return parts.join(' ');
};

export const MONSTER_GLYPHS: Record<string, string> = {
  'giant-rat': '🐀',
  'king-rat':  '👑',
};

export const TERRAIN = {
  floor:    '⬜',
  wall:     '⬛',
  rock:     '🟫',
  obstacle: '🪵',
  ko:       '💀',
} as const;

export const STATUS = {
  active:  '⭐',
  engaged: '⚡',
  prone:   '🔻',
  immobilized: '⛓️',
} as const;

export const HEALTH_FULL  = '🟥';
export const HEALTH_EMPTY = '⬛';

export const heroGlyph = (archetype: Archetype | undefined): string =>
  archetype ? HERO_GLYPHS[archetype] : '👤';

export const monsterGlyph = (typeId: string): string => MONSTER_GLYPHS[typeId] ?? '❓';

/**
 * Render an item id as a display name. Hyphen-separated kebab ids become
 * Title Case ("healing-potion" → "Healing Potion"; "rope" → "Rope"). Used by
 * the inventory column in the side panel HUD instead of an emoji glyph,
 * because per-item emojis read as decoration without conveying which item
 * it is at a glance. Single-word v1 ids (potion, rope, bomb, food, gold,
 * herbs) round-trip with a leading capital.
 */
export const formatItemName = (id: string): string =>
  id.split('-')
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

/**
 * ASCII glyphs for the grid. Emoji width is unreliable across terminal
 * fonts (the visual cell width drifts 2.0–2.2), which breaks vertical
 * column alignment when mixed in a grid. Side panel + chat log keep
 * emojis; only the grid uses ASCII.
 *
 * Convention: every glyph is exactly 2 characters wide.
 *   Heroes  uppercase first letter + ' '   (W /H /C /M /T /K /B /h )
 *   Monsters lowercase first letter + ' '  (r /R for king-rat /b for brute)
 *   Terrain punctuation + ' '              (. /# /o )
 *   KO marker                              (x )
 *   Active actor: bright color via Text.color, glyph unchanged.
 */
export const HERO_ASCII: Record<Archetype, string> = {
  warrior: 'W ', hunter: 'H ', healer: 'C ', warlock: 'M ',
  rogue:   'T ', knight: 'K ', brute:  'B ',
};

export const MONSTER_ASCII: Record<string, string> = {
  'giant-rat': 'r ',
  'king-rat':  'R ',
};

export const TERRAIN_ASCII = {
  floor:    '. ',
  wall:     '# ',
  rock:     '# ',
  obstacle: 'o ',
  ko:       'x ',
} as const;

export const heroAscii = (archetype: Archetype | undefined): string =>
  archetype ? HERO_ASCII[archetype] : 'h ';

export const monsterAscii = (typeId: string): string => MONSTER_ASCII[typeId] ?? '? ';

/**
 * Per-actor display palette. Each archetype + the DM + the generic monster
 * slot gets a distinct Ink color so users can track who's speaking/acting
 * across the chat log and the grid. Active-actor highlight (yellowBright +
 * bold) is layered on top of these in Board.tsx.
 */
export const ACTOR_COLOR: Record<Archetype | 'dm' | 'monster' | 'unknown', string> = {
  warrior: 'cyanBright',
  hunter:  'greenBright',
  healer:  'magentaBright',
  warlock: 'yellowBright',
  rogue:   'blueBright',
  knight:  'whiteBright',
  brute:   'red',
  dm:      'white',
  monster: 'redBright',
  unknown: 'gray',
};

export interface ActorDisplay {
  /** Human-readable label, e.g. "Warrior", "DM", "Giant Rat #1". */
  who: string;
  /** Emoji glyph for chat/panel prefixes; never used in the grid. */
  emoji: string;
  /** Ink color name. */
  color: string;
}

export const actorDisplay = (params: {
  id: string;
  kind?: 'hero' | 'monster' | 'dm';
  archetype?: Archetype;
  name?: string;
  monsterTypeId?: string;
}): ActorDisplay => {
  if (params.kind === 'dm' || params.id === 'dm') {
    // 🎲 is reserved for dice-roll resolution events (formatted by cli-store).
    return { who: 'DM', emoji: '📖', color: ACTOR_COLOR.dm };
  }
  if (params.kind === 'monster') {
    return {
      who: params.name ?? params.id,
      emoji: monsterGlyph(params.monsterTypeId ?? params.name?.toLowerCase().replace(/\s+/g, '-') ?? ''),
      color: ACTOR_COLOR.monster,
    };
  }
  // hero
  if (params.archetype) {
    return {
      who: params.name ?? params.id,
      emoji: heroGlyph(params.archetype),
      color: ACTOR_COLOR[params.archetype],
    };
  }
  return { who: params.name ?? params.id, emoji: '👤', color: ACTOR_COLOR.unknown };
};
