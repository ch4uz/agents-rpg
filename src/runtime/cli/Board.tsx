import React from 'react';
import { Box, Text } from 'ink';
import type { Grid } from '../../engine/grid.js';
import type { Character } from '../../engine/character.js';
import type { CharacterId } from '../../engine/ids.js';
import type { EmojiProp } from '../../engine/snapshot.js';
import { TERRAIN_ASCII, heroAscii, monsterAscii, ACTOR_COLOR } from './glyphs.js';

interface BoardProps {
  grid: Grid;
  characters: Character[];
  props?: ReadonlyArray<EmojiProp>;
  activeActor: CharacterId | 'dm' | null;
}

interface RenderedCell {
  text: string;       // exactly 2 ASCII chars
  color?: string;     // Ink color for active-actor highlight
  bold?: boolean;
}

const cellFor = (
  pos: { x: number; y: number },
  grid: Grid,
  characters: Character[],
  props: ReadonlyArray<EmojiProp> | undefined,
  activeActor: CharacterId | 'dm' | null,
): RenderedCell => {
  for (const c of characters) {
    if (!c.pos) continue;
    if (c.pos.x !== pos.x || c.pos.y !== pos.y) continue;
    if (c.health.status === 'KO') return { text: TERRAIN_ASCII.ko, color: 'gray' };
    const text = c.kind === 'hero'
      ? heroAscii(c.archetype)
      : monsterAscii(c.name.toLowerCase().replace(/\s+/g, '-'));
    // A bound (immobilized) hero shows their glyph dimmed — distinct from a
    // live teammate, but clearly still on the board (unlike a KO'd corpse).
    if (c.health.status === 'immobilized') return { text, color: 'gray' };
    if (c.id === activeActor) return { text, color: 'yellowBright', bold: true };
    const color = c.kind === 'hero'
      ? (c.archetype ? ACTOR_COLOR[c.archetype] : ACTOR_COLOR.unknown)
      : ACTOR_COLOR.monster;
    return { text, color };
  }
  // Props sit on top of the terrain glyph when no character occupies the cell.
  // Multiple props on one cell: render the last one (most recently spawned).
  if (props) {
    let chosen: EmojiProp | null = null;
    for (const p of props) {
      if (p.pos.x === pos.x && p.pos.y === pos.y) chosen = p;
    }
    if (chosen) {
      // Ink renders one column per char, so pad/truncate the emoji to fit the
      // 2-column cell. Most emoji glyphs already render as ~2 columns in
      // modern terminals; we still pad with a trailing space for narrow ones.
      const e = chosen.emoji.length === 1 ? `${chosen.emoji} ` : chosen.emoji.slice(0, 2);
      return { text: e };
    }
  }
  const cell = grid.cellAt(pos);
  if (cell.kind === 'wall')       return { text: TERRAIN_ASCII.wall };
  if (cell.kind === 'rock')       return { text: TERRAIN_ASCII.rock };
  if (cell.kind === 'obstacle')   return { text: TERRAIN_ASCII.obstacle, color: 'yellow' };
  // A `cover-wall` is a solid cover obstacle (a barrel stack): it blocks
  // movement like a wall but renders with the destructible-obstacle glyph.
  if (cell.kind === 'cover-wall') return { text: TERRAIN_ASCII.obstacle, color: 'yellow' };
  return { text: TERRAIN_ASCII.floor, color: 'gray' };
};

export const Board: React.FC<BoardProps> = ({ grid, characters, props, activeActor }) => {
  const rows: React.ReactElement[] = [];
  for (let y = 0; y < grid.height; y++) {
    const cells: React.ReactElement[] = [];
    for (let x = 0; x < grid.width; x++) {
      const c = cellFor({ x, y }, grid, characters, props, activeActor);
      cells.push(
        <Text
          key={x}
          {...(c.color !== undefined && { color: c.color })}
          {...(c.bold !== undefined && { bold: c.bold })}
        >
          {c.text}
        </Text>,
      );
    }
    rows.push(<Box key={y} flexDirection="row">{cells}</Box>);
  }
  return <Box flexDirection="column">{rows}</Box>;
};
