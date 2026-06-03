// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'lit-html';
import { battleOrderReveal } from '../../web/components/BattleOrderReveal.js';
import type { InitiativeRollEntry, InitiativeSummary } from '../../web/components/InitiativePanel.js';

/**
 * Pins the podium scaling on the "Order of Battle" badges: the first three
 * initiative slots carry a `--rank1/2/3` size-modifier class (1st biggest —
 * the CSS scales them 1.5 / 1.3 / 1.15), while 4th and beyond stay at the
 * base size with no rank modifier at all.
 */
const entry = (id: string, name: string, total: number): InitiativeRollEntry => ({
  characterId: id,
  name,
  archetype: 'warrior',
  sprite: null,
  kind: 'hero',
  d6: total,
  dex: 0,
  total,
});

const summary = (order: InitiativeRollEntry[]): InitiativeSummary => ({
  t: 1,
  heroes: order,
  monsters: [],
  order,
});

describe('battleOrderReveal — podium rank classes', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => { root.remove(); });

  it('tags the first three badges --rank1/2/3 and leaves 4th+ unranked', () => {
    const order = [
      entry('h1', 'Anwen', 6),
      entry('h2', 'Kael', 5),
      entry('h3', 'Bran', 4),
      entry('h4', 'Elara', 3),
    ];
    render(battleOrderReveal(summary(order)), root);

    const badges = root.querySelectorAll('.battle-order-badge');
    expect(badges.length).toBe(4);
    expect(badges[0]!.classList.contains('battle-order-badge--rank1')).toBe(true);
    expect(badges[1]!.classList.contains('battle-order-badge--rank2')).toBe(true);
    expect(badges[2]!.classList.contains('battle-order-badge--rank3')).toBe(true);
    // 4th slot: no podium modifier of any rank.
    const fourth = Array.from(badges[3]!.classList);
    expect(fourth.some((c) => c.startsWith('battle-order-badge--rank'))).toBe(false);
    // Each podium badge wears exactly ONE rank class (no bleed across slots).
    expect(root.querySelectorAll('.battle-order-badge--rank1').length).toBe(1);
    expect(root.querySelectorAll('.battle-order-badge--rank2').length).toBe(1);
    expect(root.querySelectorAll('.battle-order-badge--rank3').length).toBe(1);
  });

  it('still ranks a short order (two combatants → rank1 + rank2 only)', () => {
    const order = [entry('h1', 'Anwen', 6), entry('h2', 'Kael', 2)];
    render(battleOrderReveal(summary(order)), root);

    const badges = root.querySelectorAll('.battle-order-badge');
    expect(badges.length).toBe(2);
    expect(badges[0]!.classList.contains('battle-order-badge--rank1')).toBe(true);
    expect(badges[1]!.classList.contains('battle-order-badge--rank2')).toBe(true);
    expect(root.querySelectorAll('.battle-order-badge--rank3').length).toBe(0);
  });
});
