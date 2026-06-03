// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';
import type { SelectionOverlay } from '../../web/components/ActionButtons.js';
import type { PlayerAction } from '../../src/engine/action.js';

/**
 * Normal-attack target highlighting (the ⚔ Attack button).
 *
 * Regression: the UI used to highlight EVERY living foe regardless of distance,
 * so clicking an out-of-range one round-tripped into a `rule_violation`. The
 * highlight + click guard now mirror the engine's `computeNormalAttackContext`
 * (Chebyshev range + LoS for non-melee), so only the targets the server will
 * accept are offered.
 */
describe('Layout normal-attack range gating', () => {
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

  /** A melee warrior at (0,0): one rat adjacent (in range), one far (out). */
  const setup = (): {
    handle: ReturnType<typeof mountLayout>;
    overlays: SelectionOverlay[];
    actions: PlayerAction[];
  } => {
    const store = createStore();
    const overlays: SelectionOverlay[] = [];
    const actions: PlayerAction[] = [];
    const handle = mountLayout(root, store, {
      onAction: (a) => actions.push(a),
      onSubmit: vi.fn(),
      onSelectionChange: (o) => overlays.push(o),
    });
    handle.setAutoSkip(true);

    const rats = [
      { id: 'r1', name: 'Near Rat', pos: { x: 1, y: 0 } }, // dist 1 — in melee range
      { id: 'r2', name: 'Far Rat',  pos: { x: 5, y: 0 } }, // dist 5 — out of range
    ].map((r) => ({
      ...r, kind: 'monster',
      health: { total: 1, damage: 0, status: 'normal' },
      pools: { melee: 2, ranged: 0, magic: 0, armor: 1 }, inventory: [], boons: [],
      normalAttack: { kind: 'melee', range: 1 },
      specialAction: { name: 'Pack', description: '' }, bonusAbility: { name: '', description: '' },
    }));

    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: {
          id: 'tavern-basement', assetId: 'tavern-basement', gridW: 13, gridH: 9,
          // One obstacle adjacent (in range), one far (out of range).
          obstacles: [{ x: 0, y: 1 }, { x: 6, y: 4 }] as never,
          decorations: [], exits: [], walls: false, destroyedObstacles: [],
        } as never,
        characters: [
          {
            id: 'anwen', name: 'Anwen', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, inventory: [], boons: [],
            normalAttack: { kind: 'melee', range: 1 },
            specialAction: { name: 'Whirlwind', description: '' },
            bonusAbility:  { name: 'Tough', description: '' },
          },
          ...rats,
        ],
        activeActor: 'anwen' as never,
        recentChat: [],
      } as never,
    } as never);

    store.applyEnvelope({
      kind: 'event',
      event: {
        type: 'combat_started', heroSide: ['anwen'], monsterSide: ['r1', 'r2'],
        order: ['anwen', 'r1', 'r2'],
        rolls: { hero: { anwen: { d6: 4, dex: 1, total: 5 } }, monster: {} },
      } as never,
    });
    store.applyEnvelope({ kind: 'event', event: { type: 'narrate', actorId: 'dm', text: 'The rats hiss.' } as never });
    store.applyEnvelope({ kind: 'turn_started', actorId: 'anwen' as never });
    store.applyEnvelope({ kind: 'input_required' });
    advance(5000); advance(5000);
    return { handle, overlays, actions };
  };

  const clickAttack = () => {
    const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('.action-buttons .act-btn'))
      .find((b) => /attack/i.test(b.textContent ?? ''));
    expect(btn, 'Attack button should be present').not.toBeUndefined();
    btn!.click();
  };

  it('highlights only the in-range foe and the in-range object, not the far ones', () => {
    const { overlays } = setup();
    clickAttack();
    const o = overlays[overlays.length - 1]!;
    expect(o.mode).toBe('attack');
    expect([...o.targets]).toEqual(['r1']);                 // far rat r2 excluded
    expect(o.objectTargets ?? []).toEqual([{ x: 0, y: 1 }]); // far obstacle (6,4) excluded
  });

  it('clicking the out-of-range foe is a no-op (no doomed round-trip)', () => {
    const { handle, actions } = setup();
    clickAttack();
    handle.handleCanvasClick({ pos: { x: 5, y: 0 }, actorId: 'r2' });
    expect(actions).toEqual([]);
  });

  it('clicking the in-range foe dispatches normal_attack (+ auto end_turn)', () => {
    const { handle, actions } = setup();
    clickAttack();
    handle.handleCanvasClick({ pos: { x: 1, y: 0 }, actorId: 'r1' });
    expect(actions).toEqual([
      { kind: 'normal_attack', targetId: 'r1' },
      { kind: 'end_turn' },
    ]);
  });

  it('clicking the out-of-range object is a no-op; the in-range object smashes', () => {
    const { handle, actions } = setup();
    clickAttack();
    handle.handleCanvasClick({ pos: { x: 6, y: 4 }, actorId: null });
    expect(actions).toEqual([]);
    handle.handleCanvasClick({ pos: { x: 0, y: 1 }, actorId: null });
    expect(actions).toEqual([
      { kind: 'attack_object', pos: { x: 0, y: 1 } },
      { kind: 'end_turn' },
    ]);
  });
});
