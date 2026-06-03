// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { formatHearts, createDurabilityBarEl, updateDurabilityBarEl } from '../../web/components/MiniBar.js';

describe('formatHearts', () => {
  it('renders all full hearts at full HP', () => {
    expect(formatHearts(3, 0)).toBe('♥♥♥');
  });
  it('renders empty hearts for damage', () => {
    expect(formatHearts(3, 1)).toBe('♥♥♡');
    expect(formatHearts(3, 2)).toBe('♥♡♡');
    expect(formatHearts(3, 3)).toBe('♡♡♡');
  });
  it('clamps when damage exceeds total', () => {
    expect(formatHearts(3, 5)).toBe('♡♡♡♡♡');
  });
  it('handles zero total', () => {
    expect(formatHearts(0, 0)).toBe('');
  });
});

describe('durability bar (obstacle pips)', () => {
  const counts = (el: HTMLElement) => ({
    total: el.querySelectorAll('.dura-shard').length,
    empty: el.querySelectorAll('.dura-shard-empty').length,
  });

  it('renders `max` shards, all full at full durability', () => {
    const el = createDurabilityBarEl(2, 2);
    expect(counts(el)).toEqual({ total: 2, empty: 0 });
  });

  it('drains one shard per hit', () => {
    const el = createDurabilityBarEl(2, 2);
    updateDurabilityBarEl(el, 1, 2);
    expect(counts(el)).toEqual({ total: 2, empty: 1 });
    updateDurabilityBarEl(el, 0, 2);
    expect(counts(el)).toEqual({ total: 2, empty: 2 });
  });

  it('is a distinct element/icon from the HP hearts', () => {
    const el = createDurabilityBarEl(2, 2);
    expect(el.className).toBe('dura-bar');
    expect(el.querySelectorAll('.mini-heart').length).toBe(0);
  });
});
