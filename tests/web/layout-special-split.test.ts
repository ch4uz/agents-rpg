// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import type { SelectionOverlay } from '../../web/components/ActionButtons.js';
import type { PlayerAction } from '../../src/engine/action.js';

/**
 * Multi-target split-special UI (hunter split-shot / warrior whirlwind).
 *
 * Regression for the live `invalid-shape` bug: the browser used to dispatch a
 * split `special_action` with a single target and NO `params.diceSplit`, which
 * the engine rejects with `invalid-split-shape`. The proper UI lets the human
 * assign the actor's whole pool across one or more in-range targets and only
 * fires once the pool is fully assigned — always with a valid diceSplit.
 */
describe('Layout multi-target split-special allocation', () => {
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
  const advance = (ms: number) => { fakeNow += ms; vi.advanceTimersByTime(ms); };

  /** A hunter (split-shot, ranged pool 2, range 6, requires LoS) at (0,0) with
   *  `count` rats in range + clear LoS along the top row. */
  const setup = (
    targeting: unknown,
    rats = 2,
  ): { handle: ReturnType<typeof mountLayout>; overlays: SelectionOverlay[]; actions: PlayerAction[] } => {
    const store = createStore();
    const overlays: SelectionOverlay[] = [];
    const actions: PlayerAction[] = [];
    const handle = mountLayout(root, store, {
      onAction: (a) => actions.push(a),
      onSubmit: vi.fn(),
      onSelectionChange: (o) => overlays.push(o),
    });
    handle.setAutoSkip(true);

    const ratChars = Array.from({ length: rats }, (_, i) => ({
      id: `r${i + 1}`, name: `Giant Rat ${i + 1}`, kind: 'monster',
      pos: { x: 2 + i, y: 0 },
      health: { total: 1, damage: 0, status: 'normal' },
      pools: { melee: 2, ranged: 0, magic: 0, armor: 1 }, inventory: [], boons: [],
      specialAction: { name: 'Pack', description: '' }, bonusAbility: { name: '', description: '' },
    }));
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: {
          id: 'rat-tunnel', assetId: 'rat-tunnel', gridW: 10, gridH: 6,
          obstacles: [], decorations: [], exits: [], walls: false, destroyedObstacles: [],
        } as never,
        characters: [
          {
            id: 'bran', name: 'Bran', kind: 'hero', archetype: 'hunter',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 0, ranged: 2, magic: 0, armor: 2 }, inventory: [], boons: [],
            specialAction: { name: 'Arrow-Split Shot', description: '', targeting },
            bonusAbility:  { name: 'Evasive', description: '' },
          },
          ...ratChars,
        ],
        activeActor: 'bran' as never,
        recentChat: [],
      } as never,
    } as never);

    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started', heroSide: ['bran'], monsterSide: ratChars.map((r) => r.id),
        order: ['bran', ...ratChars.map((r) => r.id)],
        rolls: { hero: { bran: { d6: 4, dex: 1, total: 5 } }, monster: {} },
      } as never,
    });
    store.applyEnvelope({ kind: 'event', event: { type: 'narrate', actorId: 'dm', text: 'The rats hiss.' } as never });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'bran' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(5000); advance(5000);
    return { handle, overlays, actions };
  };

  const RANGED_SPLIT = { mode: 'split', attackKind: 'ranged', pool: 2, range: 6, requiresLos: true };

  const clickSpecial = () => {
    const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('.action-buttons .act-btn'))
      .find((b) => /special/i.test(b.textContent ?? ''));
    expect(btn, 'Special button should be present').not.toBeUndefined();
    btn!.click();
  };

  it('highlights only in-range targets and tracks the dice budget', () => {
    const { overlays } = setup(RANGED_SPLIT);
    clickSpecial();
    const o = overlays[overlays.length - 1]!;
    expect(o.mode).toBe('special');
    expect([...o.targets].sort()).toEqual(['r1', 'r2']);
    expect(o.budgetLeft).toBe(2);
    expect(o.allocations ?? []).toEqual([]);
  });

  it('splitting one die per rat fires a special_action with a valid diceSplit + end_turn', () => {
    const { handle, overlays, actions } = setup(RANGED_SPLIT);
    clickSpecial();

    handle.handleCanvasClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    // One die placed — not yet fired; budget + allocation tracked for the HUD.
    expect(actions).toEqual([]);
    const mid = overlays[overlays.length - 1]!;
    expect(mid.budgetLeft).toBe(1);
    expect(mid.allocations).toEqual([{ id: 'r1', dice: 1 }]);

    handle.handleCanvasClick({ pos: { x: 3, y: 0 }, actorId: 'r2' });
    // Pool fully assigned → dispatch.
    expect(actions).toEqual([
      { kind: 'special_action', targetIds: ['r1', 'r2'], params: { diceSplit: { r1: 1, r2: 1 } } },
      { kind: 'end_turn' },
    ]);
  });

  it('stacking both dice on one target fires a single-target diceSplit', () => {
    const { handle, actions } = setup(RANGED_SPLIT);
    clickSpecial();
    handle.handleCanvasClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    handle.handleCanvasClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    expect(actions[0]).toEqual({
      kind: 'special_action', targetIds: ['r1'], params: { diceSplit: { r1: 2 } },
    });
  });

  it('right-click removes an over-assigned die and refunds the budget', () => {
    const { handle, overlays, actions } = setup(RANGED_SPLIT);
    clickSpecial();
    handle.handleCanvasClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    handle.handleCanvasRightClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    const o = overlays[overlays.length - 1]!;
    expect(o.allocations).toEqual([]);
    expect(o.budgetLeft).toBe(2);
    expect(actions).toEqual([]); // nothing fired
  });

  it('falls back to a single-click special (no diceSplit) when targeting is single/absent', () => {
    // A non-split special (or a snapshot predating the targeting field) keeps
    // the original one-target dispatch — no diceSplit, fired on the first click.
    const { handle, actions } = setup({ mode: 'single' });
    clickSpecial();
    handle.handleCanvasClick({ pos: { x: 2, y: 0 }, actorId: 'r1' });
    expect(actions).toEqual([
      { kind: 'special_action', targetIds: ['r1'] },
      { kind: 'end_turn' },
    ]);
  });
});
