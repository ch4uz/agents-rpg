// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeferredDispatcher } from '../../web/ws-deferred.js';
import { notifyRollResolved, resetRollMountRegistry } from '../../web/components/roll-events.js';
import type { ServerEnvelope } from '../../src/runtime/ws/protocol.js';
import type { Store, StoreState } from '../../web/store.js';

/**
 * A minimal Store stub: records each applyEnvelope call in arrival order
 * and lets the test seed character positions for the dispatcher to read.
 *
 * No subscribe/notify wiring is needed — the dispatcher only calls
 * `getSnapshot` (to look up attacker/target positions) and `applyEnvelope`.
 */
const makeStubStore = (chars: { id: string; pos?: { x: number; y: number } }[]): {
  store: Store;
  applied: ServerEnvelope[];
} => {
  const applied: ServerEnvelope[] = [];
  const snap: StoreState = {
    scene: null,
    characters: chars.map((c) => ({
      id: c.id as never,
      name: c.id,
      kind: 'hero' as const,
      ...(c.pos ? { pos: c.pos } : {}),
      health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [],
      boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility:  { name: '', description: '' },
    })) as never,
    props: [],
    activeActor: null,
    chat: [],
    thinking: new Set(),
    thinkingText: new Map(),
    inputUnlocked: false,
    hasMoved: false,
    hasActed: false,
    inCombat: false,
    pendingBeatGate: null,
    queued: null,
    sessionGone: false,
    awaitingHeroSelect: false,
    surveyAck: null,
    physicsActive: false,
  };
  const store: Store = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    applyEnvelope: (env) => { applied.push(env); },
    setInputUnlocked: () => {},
    markDestroyed: () => {},
    markPhysicsActive: () => {},
  };
  return { store, applied };
};

const resolutionEvent = (
  actorId: string,
  targetId: string,
  attackKind: 'melee' | 'ranged' | 'magic',
  hit: boolean,
  t = 1,
): ServerEnvelope => ({
  kind: 'event',
  event: {
    t,
    type: 'resolution',
    actorId,
    public: { hit, targetId, attackKind, damage: hit ? 1 : 0, attackerTop: 5, defenderTop: 3 },
  } as never,
});

const stateChangeEvent = (id: string, damage: number, status = 'normal'): ServerEnvelope => ({
  kind: 'event',
  event: {
    t: 2, type: 'state_change',
    changes: [{ id, damage, status }],
  } as never,
});

const meleeAction = (actorId: string, targetId: string): ServerEnvelope => ({
  kind: 'event',
  event: { t: 0, type: 'action', actorId, action: { kind: 'normal_attack', targetId } } as never,
});

/**
 * Flushes microtasks so any chained `.then` callbacks on
 * `waitForRollResolved` fire BEFORE the next `vi.advanceTimersByTime`
 * reads the timer queue. Without this, the post-resolved flight-ms timer
 * wouldn't be armed yet (for ranged/magic), and the queue wouldn't drain.
 */
const flushMicrotasks = async (): Promise<void> => {
  // A single resolved-promise await flushes the next microtask tick;
  // two awaits handle a `.then(...).then(...)` chain if one exists.
  await Promise.resolve();
  await Promise.resolve();
};

describe('createDeferredDispatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); resetRollMountRegistry(); });
  afterEach(() => { vi.useRealTimers(); resetRollMountRegistry(); });

  it('applies non-attack events synchronously', () => {
    const { store, applied } = makeStubStore([]);
    const d = createDeferredDispatcher(store);
    d.apply({ kind: 'turn_started', actorId: 'h1' as never });
    expect(applied).toHaveLength(1);
  });

  it('defers state_change after a melee-attack resolution until the dice overlay signals resolved', async () => {
    // Melee = no projectile flight, so once the overlay's resolved signal
    // fires the state_change drains on the next microtask. No timer wait.
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
      { id: 'm1', pos: { x: 1, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(meleeAction('h1', 'm1'));
    d.apply(resolutionEvent('h1', 'm1', 'melee', true, /* t */ 1));
    d.apply(stateChangeEvent('m1', 1));
    // action + resolution applied immediately; state_change held back.
    expect(applied).toHaveLength(2);
    // Even after a long wait, the drain stays parked — the dice overlay
    // hasn't signaled resolved yet (physics still running, Layout's
    // playback queue may still be busy with prior narration).
    vi.advanceTimersByTime(60_000);
    expect(applied).toHaveLength(2);
    // Dice overlay finishes the roll and signals resolved.
    notifyRollResolved(1);
    await flushMicrotasks();
    // Melee = no flight delay; drain fires synchronously after the signal.
    expect(applied).toHaveLength(3);
  });

  it('defers state_change after a ranged-attack resolution by projectile flight ms after resolved', async () => {
    // Attacker at (0,0), target at (4,0) → 4 cells × 64 px = 256 px.
    // computeFlightMs: 256 / 0.42 ≈ 609.5, clamped to BOLT_MAX_MS = 520.
    // Total defer (after resolved signal): 520ms for projectile travel.
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
      { id: 'm1', pos: { x: 4, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(resolutionEvent('h1', 'm1', 'ranged', true, /* t */ 7));
    d.apply(stateChangeEvent('m1', 1));
    // Resolution applied immediately so Layout can queue the dice overlay.
    expect(applied).toHaveLength(1);
    expect((applied[0] as { kind: string }).kind).toBe('event');
    // state_change held back until overlay signals resolved AND flight completes.
    notifyRollResolved(7);
    await flushMicrotasks();
    vi.advanceTimersByTime(519);
    expect(applied).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(applied).toHaveLength(2);
  });

  it('also defers KO state_changes so the token does not disappear early', async () => {
    const { store, applied } = makeStubStore([
      { id: 'kael', pos: { x: 0, y: 0 } },
      { id: 'rat',  pos: { x: 2, y: 1 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(resolutionEvent('kael', 'rat', 'magic', true, /* t */ 3));
    d.apply(stateChangeEvent('rat', 1, 'KO'));
    expect(applied).toHaveLength(1);
    notifyRollResolved(3);
    await flushMicrotasks();
    // Advance well past the projectile flight window (≤ BOLT_MAX_MS = 520).
    vi.advanceTimersByTime(600);
    expect(applied).toHaveLength(2);
    const last = applied[1] as { event: { changes: { status: string }[] } } | undefined;
    expect(last?.event.changes[0]?.status).toBe('KO');
  });

  it('preserves total order: a second attack queues behind the first impact', async () => {
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
      { id: 'm1', pos: { x: 2, y: 0 } },  // distance 2 → 128px → ~305ms
      { id: 'm2', pos: { x: 3, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(resolutionEvent('h1', 'm1', 'ranged', true, /* t */ 11));
    d.apply(stateChangeEvent('m1', 1));
    d.apply(meleeAction('h1', 'm2'));  // would normally apply now, but queue holds order
    expect(applied).toHaveLength(1);
    notifyRollResolved(11);
    await flushMicrotasks();
    vi.advanceTimersByTime(400);
    // After projectile flight: state_change(m1) AND meleeAction(m2) both drain.
    expect(applied).toHaveLength(3);
  });

  it('snapshot envelopes flush the queue and apply immediately', async () => {
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
      { id: 'm1', pos: { x: 5, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(resolutionEvent('h1', 'm1', 'ranged', true, /* t */ 5));
    d.apply(stateChangeEvent('m1', 1));  // queued
    expect(applied).toHaveLength(1);
    d.apply({ kind: 'snapshot', viewer: { kind: 'human' } as never, manifest: {
      heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {},
    }, state: { viewer: { kind: 'human' } as never, scene: null, characters: [], activeActor: null, recentChat: [] } as never });
    // Snapshot applied; queued state_change discarded; advancing timers
    // should NOT replay it — and a stale resolved signal for the
    // pre-snapshot resolution must not arm a drain into the new world.
    expect(applied).toHaveLength(2);
    notifyRollResolved(5);
    await flushMicrotasks();
    vi.advanceTimersByTime(60_000);
    expect(applied).toHaveLength(2);
  });

  it('SEEDED object-attack resolutions do NOT defer (no dice overlay runs for them)', () => {
    // A seeded (non-physics) attack_object carries NO rollRequestId, so no dice
    // overlay runs and notifyRollResolved never fires — holding it would stall
    // the queue forever. The dispatcher must apply these resolutions (and any
    // envelopes that follow) synchronously.
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply({
      kind: 'event',
      event: {
        t: 1,
        type: 'resolution',
        actorId: 'h1',
        public: {
          success: true, top: 6, difficulty: 3, attackKind: 'melee',
          targetKind: 'obstacle', pos: { x: 1, y: 0 },
          obstacleDestroyed: { x: 1, y: 0 },
        },
      } as never,
    });
    d.apply({ kind: 'turn_ended', actorId: 'h1' as never });
    // Both envelopes apply immediately — nothing is parked.
    expect(applied).toHaveLength(2);
  });

  it('PHYSICS object-attack resolutions are HELD until the dice overlay signals resolved', async () => {
    // A physics-rolled smash carries a rollRequestId — the browser rolled real
    // 3D dice. The resolution (smashed sprite + HIT flash + explosion are inline
    // in it) must be HELD until the overlay signals resolved, so the cask
    // doesn't vanish before the dice settle.
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply({
      kind: 'event',
      event: {
        t: 4,
        type: 'resolution',
        actorId: 'h1',
        public: {
          success: true, top: 6, difficulty: 3, attackKind: 'melee',
          targetKind: 'obstacle', pos: { x: 1, y: 0 },
          obstacleDestroyed: { x: 1, y: 0 },
          rollRequestId: 'req-1',
        },
      } as never,
    });
    // A trailing event (e.g. the explosion victims' HP drain) queues behind it.
    d.apply(stateChangeEvent('h1', 1));
    // Nothing applied yet — the smash is parked waiting on the dice.
    expect(applied).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(applied).toHaveLength(0);
    // Overlay finishes the roll + verdict and signals resolved.
    notifyRollResolved(4);
    await flushMicrotasks();
    // The held resolution AND the trailing state_change both drain, in order.
    expect(applied).toHaveLength(2);
    expect((applied[0] as { event: { type: string } }).event.type).toBe('resolution');
  });

  it('missed ranged attacks still defer (the bolt still flies and misses)', async () => {
    const { store, applied } = makeStubStore([
      { id: 'h1', pos: { x: 0, y: 0 } },
      { id: 'm1', pos: { x: 3, y: 0 } },
    ]);
    const d = createDeferredDispatcher(store);
    d.apply(resolutionEvent('h1', 'm1', 'ranged', false, /* t */ 9));
    d.apply({ kind: 'turn_ended', actorId: 'h1' as never });
    expect(applied).toHaveLength(1);
    notifyRollResolved(9);
    await flushMicrotasks();
    vi.advanceTimersByTime(600);
    expect(applied).toHaveLength(2);
  });
});
