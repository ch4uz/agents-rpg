// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { duelVerdict } from '../../web/components/DiceHUD.js';

/**
 * The SUCCESS/FAIL stamp always reads from the LEFT frame's perspective. The
 * left frame is always the attacker (see `beginDuel`), and `hit` is true
 * exactly when the attacker won the roll, so the verdict is a direct mapping —
 * regardless of whether the left unit is a hero, monster, npc, or DM skill
 * check. When a monster attacks a hero (monster on the left) and lands its
 * swing, the left unit won, so the stamp shows SUCCESS.
 */
describe('duelVerdict', () => {
  it('left unit (attacker) won → success', () => {
    expect(duelVerdict(true)).toBe('success');
  });

  it('left unit (attacker) lost → fail', () => {
    expect(duelVerdict(false)).toBe('fail');
  });
});
