// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import type { SelectionOverlay } from '../../web/components/ActionButtons.js';

/**
 * Regression: the Move-mode walkable highlight must treat a SMASHED obstacle's
 * cell as open floor. Earlier, `computeSelection`'s move branch built its
 * `blocked` list from every `scene.obstacles` entry without subtracting
 * `scene.destroyedObstacles`, so a destroyed stalagmite still blocked the BFS —
 * and because the breach is a solid column, every square BEYOND the gap stayed
 * dark. Players reported: "Both stalagmites were destroyed and I can't move my
 * character past them — the squares after them don't highlight."
 *
 * Scene: a full vertical wall of obstacles at x=2 (y=0..4) splits a 5×5 cave;
 * the hero stands west at (0,2). One cell — (2,2) — has been smashed. With the
 * fix, the gap and the cells east of it (3,2)/(4,2) are reachable; the still-
 * standing wall cells (2,0)/(2,1) are not.
 */
describe('Layout move-highlight crosses a destroyed-obstacle gap', () => {
  let root: HTMLElement;
  let fakeNow: number;
  const realPerfNow = performance.now.bind(performance);

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 0;
    performance.now = () => fakeNow;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    performance.now = realPerfNow;
    vi.useRealTimers();
    root.remove();
  });

  const advance = (ms: number) => {
    fakeNow += ms;
    vi.advanceTimersByTime(ms);
  };

  const has = (cells: ReadonlyArray<{ x: number; y: number }>, x: number, y: number) =>
    cells.some((c) => c.x === x && c.y === y);

  it('reaches the gap and the cells beyond it, but not the live wall cells', () => {
    const store = createStore();
    const overlays: SelectionOverlay[] = [];
    const handle = mountLayout(root, store, {
      onAction: vi.fn(),
      onSubmit: vi.fn(),
      onSelectionChange: (o) => overlays.push(o),
    });
    handle.setAutoSkip(true);

    // x=2 column is a solid breach wall; (2,2) has been smashed open.
    const wallCol = [0, 1, 2, 3, 4].map((y) => ({ type: 'stalagmite', x: 2, y }));
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: {
          id: 'rat-tunnel', assetId: 'rat-tunnel', gridW: 5, gridH: 5,
          obstacles: wallCol, decorations: [], exits: [], walls: false,
          destroyedObstacles: [{ x: 2, y: 2 }],
        } as never,
        characters: [
          {
            id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 2 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
            inventory: [], boons: [],
            specialAction: { name: 'Whirlwind', description: '' },
            bonusAbility:  { name: 'Teamwork',  description: '' },
          },
        ],
        activeActor: 'h1' as never,
        recentChat: [],
      } as never,
    } as never);

    // Surface the action buttons (combat → narrate → human's turn → unlock).
    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started', heroSide: ['h1'], monsterSide: [], order: ['h1'],
        rolls: { hero: { h1: { d6: 4, dex: 1, total: 5 } }, monster: {} },
      } as never,
    });
    store.applyEnvelope({
      kind: 'event',
      event: { type: 'narrate', actorId: 'dm', text: 'The breach gapes open.' } as never,
    });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(5000);
    advance(5000);

    // Click 👣 Move.
    const moveBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('.action-buttons .act-btn'))
      .find((b) => /move/i.test(b.textContent ?? ''));
    expect(moveBtn, 'Move button should be present').not.toBeUndefined();
    moveBtn!.click();

    const overlay = overlays[overlays.length - 1]!;
    expect(overlay.mode).toBe('move');
    const reach = overlay.reachable;

    // The smashed cell is open floor now — and the cells EAST of it (the whole
    // point of the bug report) are reachable within the 4-square budget.
    expect(has(reach, 2, 2), '(2,2) gap should be walkable').toBe(true);
    expect(has(reach, 3, 2), '(3,2) past the gap should be reachable').toBe(true);
    expect(has(reach, 4, 2), '(4,2) past the gap should be reachable').toBe(true);

    // Still-standing wall cells stay blocked (we filtered destroyed ones, not all).
    expect(has(reach, 2, 0), '(2,0) live wall must stay blocked').toBe(false);
    expect(has(reach, 2, 1), '(2,1) live wall must stay blocked').toBe(false);
  });
});
