import { describe, it, expect } from 'vitest';
import {
  HeroEntrySchema,
  MonsterEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
} from '../../src/engine/catalogs.js';

describe('catalog schemas', () => {
  it('HeroEntrySchema accepts a valid warrior entry', () => {
    const valid = {
      id: 'warrior',
      name: 'Warrior',
      archetype: 'warrior',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 3,
      normalAttack: { kind: 'melee', name: 'Slashing Strike', range: 1, damageMod: 0 },
      specialAction: { effectId: 'whirlwind-attack', name: 'Whirlwind', description: '...' },
      bonusAbility: { effectId: 'teamwork', name: 'Teamwork', description: '...' },
      defaultInventory: [{ itemId: 'potion', count: 2 }],
      defaultSkills: [],
      sprite: 'warrior',
    };
    expect(() => HeroEntrySchema.parse(valid)).not.toThrow();
  });

  it('HeroEntrySchema rejects an entry with negative dice pool', () => {
    const bad = {
      id: 'broken',
      name: 'Broken',
      archetype: 'warrior',
      pools: { melee: -1, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 3,
      normalAttack: { kind: 'melee', name: 'X', range: 1, damageMod: 0 },
      specialAction: { effectId: 'noop', name: 'X', description: '' },
      bonusAbility: { effectId: 'noop', name: 'X', description: '' },
      defaultInventory: [],
      defaultSkills: [],
      sprite: 'warrior',
    };
    expect(() => HeroEntrySchema.parse(bad)).toThrow();
  });

  it('MonsterEntrySchema accepts a giant rat', () => {
    const valid = {
      id: 'giant-rat',
      name: 'Giant Rat',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
      healthTotal: 1,
      normalAttack: { kind: 'melee', name: 'Horrid Bite', range: 1, damageMod: 0 },
      specialAction: { effectId: 'pack-attack', name: 'Pack Attack', description: '' },
      bonusAbility: { effectId: 'coward', name: 'Coward', description: '' },
      sprite: 'giant-rat',
    };
    expect(() => MonsterEntrySchema.parse(valid)).not.toThrow();
  });

  it('ItemEntrySchema requires consumableEffect on consumables', () => {
    const valid = {
      id: 'potion',
      name: 'Potion',
      category: 'consumable',
      consumableEffect: 'heal-full',
      icon: 'potion',
    };
    expect(() => ItemEntrySchema.parse(valid)).not.toThrow();
  });

  it('ItemEntrySchema requires skillBonus on utility items', () => {
    const valid = {
      id: 'rope',
      name: 'Rope',
      category: 'utility',
      skillBonus: ['athletics', 'acrobatics'],
      icon: 'rope',
    };
    expect(() => ItemEntrySchema.parse(valid)).not.toThrow();
  });

  it('EquipmentEntrySchema parses a battleaxe', () => {
    const valid = {
      id: 'raiders-battleaxe',
      name: "Raider's Battleaxe",
      effectId: 'reaping-strike',
      icon: 'raiders-battleaxe',
    };
    expect(() => EquipmentEntrySchema.parse(valid)).not.toThrow();
  });

  it('BoonEntrySchema parses a sample boon', () => {
    const valid = {
      id: 'lucky-charm',
      name: 'Lucky Charm',
      description: 'Reroll one die.',
      effectId: 'reroll-one',
      icon: 'lucky-charm',
    };
    expect(() => BoonEntrySchema.parse(valid)).not.toThrow();
  });
});
