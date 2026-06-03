// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Dialogue-reference hover bridge. When the DM or a hero names a coordinate
 * `(x,y)` or a creature, that run renders as a `.dlg-ref` chip across every
 * dialogue surface. Hovering a chip must call `onRefHover` with the matching
 * `RefTarget` (forwarded to Board.setHoverHighlight in the app); leaving it
 * must call `onRefHover(null)`.
 *
 * We assert against the always-present Event Log drawer, which renders chat
 * synchronously through lit-html — no typewriter / playback-queue timing to
 * coordinate — so the chips exist deterministically right after a render.
 */
describe('Layout dialogue-reference hover bridge', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => { root.remove(); });

  const seed = (store: ReturnType<typeof createStore>) => {
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 } as never,
        characters: [
          {
            id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, inventory: [], boons: [],
            specialAction: { name: 'Whirlwind', description: '' }, bonusAbility: { name: 'Teamwork', description: '' },
          },
          {
            id: 'giant-rat-1' as never, name: 'Giant Rat', kind: 'monster',
            pos: { x: 2, y: 3 }, health: { total: 1, damage: 0, status: 'normal' },
            pools: { melee: 1, ranged: 0, magic: 0, armor: 0 }, inventory: [], boons: [],
            specialAction: { name: '', description: '' }, bonusAbility: { name: '', description: '' },
          },
        ],
        activeActor: 'h1' as never,
        recentChat: [
          { event: { type: 'narrate', actorId: 'dm', text: 'The Giant Rat lurks at (2,3).', t: 1 } },
        ],
      } as never,
    } as never);
  };

  // Find a rendered chip by its kind inside the (always-present) event log.
  const chip = (kind: 'cell' | 'creature'): HTMLElement => {
    const el = root.querySelector<HTMLElement>(`#event-log-drawer .dlg-ref--${kind}`);
    if (!el) throw new Error(`no .dlg-ref--${kind} chip rendered`);
    return el;
  };

  it('renders coordinate + creature chips in the dialogue', () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onRefHover: vi.fn() });
    seed(store);
    expect(chip('cell').dataset['refX']).toBe('2');
    expect(chip('cell').dataset['refY']).toBe('3');
    expect(chip('creature').dataset['refId']).toBe('giant-rat-1');
  });

  it('hovering a creature chip highlights that creature', () => {
    const store = createStore();
    const onRefHover = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onRefHover });
    seed(store);

    chip('creature').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(onRefHover).toHaveBeenLastCalledWith({ kind: 'creature', ids: ['giant-rat-1'] });

    chip('creature').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(onRefHover).toHaveBeenLastCalledWith(null);
  });

  it('hovering a coordinate chip highlights that cell', () => {
    const store = createStore();
    const onRefHover = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onRefHover });
    seed(store);

    chip('cell').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(onRefHover).toHaveBeenLastCalledWith({ kind: 'cell', x: 2, y: 3 });
  });

  it('does not clear when moving between child nodes of the same chip', () => {
    const store = createStore();
    const onRefHover = vi.fn();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn(), onRefHover });
    seed(store);

    const c = chip('creature');
    // A mouseout whose relatedTarget is still inside the chip must NOT clear.
    c.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: c }));
    expect(onRefHover).not.toHaveBeenCalledWith(null);
  });
});
