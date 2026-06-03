import { describe, it, expect } from 'vitest';
import { applyDamage, healDamage, isKO } from '../../src/engine/character.js';
import type { Character } from '../../src/engine/character.js';
import { asCharacterId, asEffectId } from '../../src/engine/ids.js';

const hero = (): Character => ({
  id: asCharacterId('test-hero'),
  name: 'Test',
  kind: 'hero',
  archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('noop'), name: 'Noop', description: '' },
  bonusAbility: { id: asEffectId('noop'), name: 'Noop', description: '' },
  inventory: [],
  boons: [],
  skills: [],
});

describe('character health', () => {
  it('applyDamage marks a box and stays normal under threshold', () => {
    const c = hero();
    const next = applyDamage(c, 1);
    expect(next.health.damage).toBe(1);
    expect(next.health.status).toBe('normal');
    expect(isKO(next)).toBe(false);
  });

  it('applyDamage transitions to prone+KO when damage equals total', () => {
    const c = hero();
    const next = applyDamage(c, 3);
    expect(next.health.damage).toBe(3);
    expect(next.health.status).toBe('KO');
    expect(isKO(next)).toBe(true);
  });

  it('applyDamage clamps damage at total', () => {
    const c = hero();
    const next = applyDamage(c, 10);
    expect(next.health.damage).toBe(3);
  });

  it('healDamage reduces damage and clears KO if any damage cleared', () => {
    const c = applyDamage(hero(), 3);
    const healed = healDamage(c, 1);
    expect(healed.health.damage).toBe(2);
    expect(healed.health.status).toBe('normal');
  });

  it('healDamage with amount Infinity heals to full', () => {
    const c = applyDamage(hero(), 3);
    const healed = healDamage(c, Infinity);
    expect(healed.health.damage).toBe(0);
  });
});
