import React from 'react';
import { Box, Text } from 'ink';
import type { Character } from '../../engine/character.js';
import type { CharacterId } from '../../engine/ids.js';
import { heroGlyph, HEALTH_FULL, HEALTH_EMPTY, formatItemName, ACTOR_COLOR, formatPools } from './glyphs.js';

interface Props {
  characters: Character[];
  activeActor?: CharacterId | 'dm' | null;
}

const heartsFor = (c: Character): string => {
  const remaining = c.health.total - c.health.damage;
  return HEALTH_FULL.repeat(Math.max(0, remaining)) + HEALTH_EMPTY.repeat(Math.max(0, c.health.damage));
};

export const CharacterPanels: React.FC<Props> = ({ characters, activeActor }) => {
  const heroes = characters.filter((c) => c.kind === 'hero');
  return (
    <Box flexDirection="column" marginLeft={2}>
      {heroes.map((c) => {
        const inv = c.inventory.length === 0
          ? '—'
          : c.inventory.map((s) => `${formatItemName(String(s.itemId))}×${s.count}`).join(' ');
        const color = c.archetype ? ACTOR_COLOR[c.archetype] : ACTOR_COLOR.unknown;
        const isActive = c.id === activeActor;
        return (
          <Box key={c.id} flexDirection="row">
            <Text>{heroGlyph(c.archetype)} </Text>
            <Text color={color} bold={isActive}>{c.name.padEnd(8)}</Text>
            <Text>   </Text>
            <Text>HP {heartsFor(c)}  </Text>
            <Text dimColor>{formatPools(c.pools)}  </Text>
            <Text>{inv}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
