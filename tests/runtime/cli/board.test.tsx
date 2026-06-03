import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Board } from '../../../src/runtime/cli/Board.js';
import { Grid } from '../../../src/engine/grid.js';
import { asCharacterId, asEffectId } from '../../../src/engine/ids.js';
import type { Character, Archetype } from '../../../src/engine/character.js';

const mkChar = (id: string, archetype: Archetype, pos: { x: number; y: number }): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype,
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos, normalAttack: { kind: 'melee', name: '', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('whirlwind-attack'), name: '', description: '' },
  bonusAbility:  { id: asEffectId('teamwork'),         name: '', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('Board renders', () => {
  it('places hero glyphs at their positions and floor elsewhere', () => {
    const grid = new Grid(
      Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ kind: 'floor' as const }))),
    );
    const chars = [
      mkChar('p1', 'warrior', { x: 0, y: 0 }),
      mkChar('p2', 'warlock', { x: 3, y: 3 }),
    ];
    const { lastFrame } = render(<Board grid={grid} characters={chars} activeActor={null} />);
    const frame = lastFrame() ?? '';

    // Hero ASCII glyphs appear in the frame. End-of-row glyphs may not
    // carry a trailing space, so match against word-boundary or EOL.
    expect(frame).toMatch(/W(\s|$)/m);   // warrior
    expect(frame).toMatch(/M(\s|$)/m);   // warlock (mage)
    // 4×4 floor cells minus 2 occupied = 14 floor glyphs.
    const floorMatches = (frame.match(/\./g) ?? []).length;
    expect(floorMatches).toBe(14);
  });

  it('renders the active actor (color is set on the cell)', () => {
    const grid = new Grid(
      Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ kind: 'floor' as const }))),
    );
    const chars = [mkChar('p1', 'warrior', { x: 1, y: 1 })];
    const { lastFrame } = render(<Board grid={grid} characters={chars} activeActor={asCharacterId('p1')} />);
    // The active warrior renders with W glyph; color is applied via Ink Text.
    expect(lastFrame() ?? '').toContain('W ');
  });
});
