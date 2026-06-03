// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import {
  selectTurnOrder,
  turnOrderBar,
} from '../../web/components/TurnOrderBar.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const hero = (
  id: string,
  name: string,
  archetype = 'warrior',
  status: 'normal' | 'KO' = 'normal',
): RedactedCharacter => ({
  id: id as never, name, kind: 'hero', archetype, dex: 0,
  pos: { x: 0, y: 0 },
  health: { total: 3, damage: status === 'KO' ? 3 : 0, status },
  pools: { melee: 2, ranged: 0, magic: 0, armor: 1 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});
const monster = (
  id: string,
  name = 'giant-rat',
  status: 'normal' | 'KO' = 'normal',
): RedactedCharacter => ({
  id: id as never, name, kind: 'monster', sprite: name, dex: 0,
  pos: { x: 1, y: 1 },
  health: { total: 1, damage: status === 'KO' ? 1 : 0, status },
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});

const combatStarted = (orderIds: string[], t = 1): { event: unknown } => ({
  event: {
    type: 'combat_started',
    heroSide: orderIds.filter((id) => id.startsWith('h')),
    monsterSide: orderIds.filter((id) => !id.startsWith('h')),
    order: orderIds,
    rolls: { hero: {}, monster: {} },
    t,
  },
});

const renderToHtml = (
  state: ReturnType<typeof selectTurnOrder>,
): string => {
  const div = document.createElement('div');
  render(turnOrderBar(state), div);
  return div.innerHTML;
};
const renderToText = (
  state: ReturnType<typeof selectTurnOrder>,
): string => {
  const div = document.createElement('div');
  render(turnOrderBar(state), div);
  return div.textContent ?? '';
};

describe('selectTurnOrder', () => {
  const cast = [
    hero('h1', 'Bran'),
    hero('h2', 'Anwen', 'healer'),
    monster('r1', 'giant-rat'),
    monster('r2', 'giant-rat'),
  ];

  it('returns null when there is no combat_started in the chat', () => {
    expect(selectTurnOrder([], cast, null)).toBeNull();
    expect(selectTurnOrder(
      [{ event: { type: 'narrate', text: 'x', t: 1 } }],
      cast,
      'h1',
    )).toBeNull();
  });

  it('returns null after combat_ended', () => {
    const chat = [
      combatStarted(['h1', 'r1']),
      { event: { type: 'combat_ended', t: 2 } },
    ];
    expect(selectTurnOrder(chat, cast, 'h1')).toBeNull();
  });

  it('keeps entries in declaration order (the tape is a continuous strip — never rotates)', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2', 'r2'])];
    // Even when h2 is active, the entries[] stays in declaration order;
    // the slide is driven by `cursorIdx` translating the track, not by
    // reshuffling the array.
    const state = selectTurnOrder(chat, cast, 'h2')!;
    expect(state.entries.map((e) => e.id)).toEqual(['h1', 'r1', 'h2', 'r2']);
    expect(state.cursorIdx).toBe(2);
  });

  it('marks the active actor with isActive: true and only that one', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const state = selectTurnOrder(chat, cast, 'r1')!;
    expect(state.entries.find((e) => e.id === 'r1')?.isActive).toBe(true);
    expect(state.entries.filter((e) => e.isActive).length).toBe(1);
    expect(state.cursorIdx).toBe(1);
  });

  it('marks slots before the cursor as isPassed', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const state = selectTurnOrder(chat, cast, 'h2')!;
    expect(state.entries.find((e) => e.id === 'h1')?.isPassed).toBe(true);
    expect(state.entries.find((e) => e.id === 'r1')?.isPassed).toBe(true);
    expect(state.entries.find((e) => e.id === 'h2')?.isPassed).toBe(false);
  });

  it('KEEPS dead characters in their slot with isDead: true (they are NOT removed)', () => {
    const woundedCast = [
      hero('h1', 'Bran'),
      hero('h2', 'Anwen', 'healer'),
      monster('r1', 'giant-rat', 'KO'),    // dead but stays on tape
      monster('r2', 'giant-rat'),
    ];
    const chat = [combatStarted(['h1', 'r1', 'h2', 'r2'])];
    const state = selectTurnOrder(chat, woundedCast, 'h1')!;
    // Tape order preserved exactly — no shuffling.
    expect(state.entries.map((e) => e.id)).toEqual(['h1', 'r1', 'h2', 'r2']);
    const r1 = state.entries.find((e) => e.id === 'r1')!;
    expect(r1.isDead).toBe(true);
    expect(r1.isActive).toBe(false);
  });

  it('a dead character at the cursor position is NOT marked active', () => {
    const woundedCast = [
      hero('h1', 'Bran', 'warrior', 'KO'),
      monster('r1', 'giant-rat'),
    ];
    const chat = [combatStarted(['h1', 'r1'])];
    const state = selectTurnOrder(chat, woundedCast, 'h1')!;
    const h1 = state.entries.find((e) => e.id === 'h1')!;
    expect(h1.isDead).toBe(true);
    expect(h1.isActive).toBe(false);
  });

  it('uses the most recent combat_started when multiple appear', () => {
    const chat = [
      combatStarted(['h1', 'r1'], 1),
      { event: { type: 'combat_ended', t: 2 } },
      combatStarted(['h2', 'r2'], 3),
    ];
    const state = selectTurnOrder(chat, cast, 'h2')!;
    expect(state.entries.map((e) => e.id)).toEqual(['h2', 'r2']);
    expect(state.cursorIdx).toBe(0);
  });

  it('anchors the cursor at 0 when the active actor is not in the order', () => {
    const chat = [combatStarted(['h1', 'r1'])];
    const state = selectTurnOrder(chat, cast, null)!;
    expect(state.cursorIdx).toBe(0);
    // With no active actor, no slot is marked active.
    expect(state.entries.every((e) => !e.isActive)).toBe(true);
  });
});

describe('turnOrderBar rendering', () => {
  const cast = [
    hero('h1', 'Bran'),
    hero('h2', 'Anwen', 'healer'),
    monster('r1', 'giant-rat'),
  ];

  it('renders an empty template when state is null (out of combat)', () => {
    const div = document.createElement('div');
    render(turnOrderBar(null), div);
    expect(div.textContent ?? '').toBe('');
  });

  it('renders ALL entries in declaration order — including dead', () => {
    const woundedCast = [
      hero('h1', 'Bran'),
      hero('h2', 'Anwen', 'healer'),
      monster('r1', 'giant-rat', 'KO'),
    ];
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const text = renderToText(selectTurnOrder(chat, woundedCast, 'h1'));
    expect(text).toContain('Bran');
    expect(text).toContain('Anwen');
    // Dead rat is still on the tape — not removed.
    expect(text).toContain('Giant Rat');
    // And it carries the DEAD badge.
    expect(text).toContain('DEAD');
  });

  it('drives the slide via the --turn-cursor custom property on the track', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const cursor0 = renderToHtml(selectTurnOrder(chat, cast, 'h1'));
    const cursor1 = renderToHtml(selectTurnOrder(chat, cast, 'r1'));
    const cursor2 = renderToHtml(selectTurnOrder(chat, cast, 'h2'));
    expect(cursor0).toContain('--turn-cursor: 0');
    expect(cursor1).toContain('--turn-cursor: 1');
    expect(cursor2).toContain('--turn-cursor: 2');
  });

  it('marks the active slot with .turn-order-slot--active and ONLY that one', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const html = renderToHtml(selectTurnOrder(chat, cast, 'r1'));
    const actives = html.match(/turn-order-slot--active/g);
    expect(actives).not.toBeNull();
    expect(actives!.length).toBe(1);
    expect(html).toMatch(/turn-order-slot[^"]*--active[^"]*"[^>]*data-actor-id="r1"/);
  });

  it('marks dead slots with .turn-order-slot--dead and a DEAD label', () => {
    const woundedCast = [
      hero('h1', 'Bran'),
      monster('r1', 'giant-rat', 'KO'),
    ];
    const chat = [combatStarted(['h1', 'r1'])];
    const html = renderToHtml(selectTurnOrder(chat, woundedCast, 'h1'));
    expect(html).toMatch(/turn-order-slot[^"]*--dead/);
    expect(html).toContain('turn-order-dead-label');
    expect(html).toContain('DEAD');
  });

  it('marks passed slots with .turn-order-slot--passed', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const html = renderToHtml(selectTurnOrder(chat, cast, 'h2'));
    const passed = html.match(/turn-order-slot--passed/g);
    expect(passed).not.toBeNull();
    expect(passed!.length).toBe(2);   // h1 and r1 already acted
  });

  it('mounts every slot in the DOM (continuous tape — no keyed remount per turn)', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const html = renderToHtml(selectTurnOrder(chat, cast, 'r1'));
    // 3 entries × 3 tiled copies = 9 slots in the DOM. Tiling is what
    // gives the tape its infinite-slide feel.
    expect((html.match(/data-actor-id="/g) ?? []).length).toBe(9);
  });

  it('does NOT render the ⚔ end-caps flanking the viewport', () => {
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const html = renderToHtml(selectTurnOrder(chat, cast, 'h1'));
    expect(html).not.toContain('turn-order-cap');
    expect(renderToText(selectTurnOrder(chat, cast, 'h1'))).not.toContain('⚔');
  });

  it('exposes the bar so it can stretch to the board width', () => {
    // The CSS rule `width: var(--canvas-displayed-w)` lives in main.css —
    // verify the bar element is the one tagged for that rule.
    const chat = [combatStarted(['h1', 'r1', 'h2'])];
    const html = renderToHtml(selectTurnOrder(chat, cast, 'h1'));
    expect(html).toContain('class="turn-order-bar"');
  });
});
