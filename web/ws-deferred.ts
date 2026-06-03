import type { ServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { Store } from './store.js';
import { computeFlightMs } from './components/Projectile.js';
import { CELL_PX } from './components/Board.js';
import { waitForRollResolved, isRollResolved, resetRollMountRegistry } from './components/roll-events.js';

/**
 * Wraps `store.applyEnvelope` so that events arriving from the WS are held
 * back for the duration of a projectile's flight whenever a ranged/magic
 * attack just fired. The visual effect: HP-bar damage and KO removal happen
 * AT impact, not at trigger — matching the projectile + HIT/MISS flash that
 * Board.ts already times to land at the impact moment.
 *
 * Why this lives at the dispatcher (not the renderer):
 *  - state_change events are what mutate the store's characters[]. Deferring
 *    them here defers EVERY downstream consumer (HP bar, KO token removal,
 *    chat list) in one place. Trying to lag rendering inside Board would
 *    require a shadow snapshot.
 *  - Order across events is preserved: while a defer is in flight, all
 *    subsequent envelopes queue. The next projectile from a split-shot
 *    therefore waits its turn instead of two bolts firing simultaneously.
 *  - Snapshots short-circuit the queue: a reconnect-snapshot is the new
 *    truth and resets the world view, so any queued partial-state events
 *    become irrelevant.
 *
 * Timing source-of-truth:
 *  - The drain is anchored to `waitForRollResolved(t)` — i.e. the
 *    `notifyRollResolved` signal Layout fires when the Dice3DOverlay's
 *    roll promise settles. Event-driven, NOT a fixed delay: the dice take
 *    as long as they take (physics duration varies; the verdict reveal has
 *    its own animation timing). Ranged/magic add `computeFlightMs(...)` so
 *    the state_change additionally waits for the projectile (which Board
 *    launches once the same signal fires) to actually impact.
 */
export interface DeferredDispatcher {
  apply(env: ServerEnvelope): void;
}

interface DeferPlan {
  /** Logical step counter of the resolution event — keys
   *  `waitForRollResolved`. */
  resolvedKey: number;
  /** Milliseconds to wait AFTER the overlay signals resolved before
   *  draining. Zero for melee/special; projectile flight time for
   *  ranged/magic. */
  postResolvedMs: number;
}

export const createDeferredDispatcher = (store: Store): DeferredDispatcher => {
  const queue: ServerEnvelope[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let deferring = false;
  /** Bumped on snapshot — outstanding `waitForRollResolved.then` callbacks
   *  check this before scheduling a drain. Stops a stale signal (from
   *  before a snapshot reset) from firing a drain into the post-snapshot
   *  world. */
  let gen = 0;

  /**
   * If `env` is a dice-bearing resolution event, return the `DeferPlan` for
   * the drain. Otherwise return null (apply normally, no defer).
   *
   * Melee/special-action resolutions wait for the resolved signal only:
   * the dice physics + verdict + post-snap hold has elapsed by then, so
   * the state_change for HP/KO can land immediately. Ranged/magic add
   * `computeFlightMs(...)` so the state_change additionally waits for the
   * projectile to travel.
   *
   * Positions are read from the store's CURRENT state — at the moment of
   * the resolution, neither the attacker nor the target has moved or KO'd
   * yet, so this matches the geometry Board.ts will see when it fires the
   * projectile.
   */
  const planFor = (env: ServerEnvelope): DeferPlan | null => {
    if (env.kind !== 'event') return null;
    const e = env.event as {
      t?: number;
      type?: string;
      actorId?: string;
      public?: { hit?: boolean; targetId?: string; attackKind?: string };
    };
    if (e.type !== 'resolution') return null;
    if (typeof e.t !== 'number') return null;
    // Only character-attack resolutions get a dice panel — Layout's
    // rollSummaryAt requires hit/damage/attackerTop/defenderTop. Object
    // attacks (`success`/`pos`) and ability tests skip the panel, so
    // `waitForRollResolved` would never resolve and the drain would stall
    // forever. Apply those events synchronously.
    if (typeof e.public?.hit !== 'boolean') return null;
    const resolvedKey = e.t;
    const kind = e.public?.attackKind;
    const targetId = e.public?.targetId;
    if (!e.actorId || !targetId) return { resolvedKey, postResolvedMs: 0 };
    const snap = store.getSnapshot();
    const attacker = snap.characters.find((c) => String(c.id) === e.actorId);
    const target   = snap.characters.find((c) => String(c.id) === targetId);
    if (!attacker?.pos || !target?.pos) return { resolvedKey, postResolvedMs: 0 };
    if (kind !== 'ranged' && kind !== 'magic') return { resolvedKey, postResolvedMs: 0 };
    const dx = (target.pos.x - attacker.pos.x) * CELL_PX;
    const dy = (target.pos.y - attacker.pos.y) * CELL_PX;
    return { resolvedKey, postResolvedMs: computeFlightMs(dx, dy) };
  };

  /**
   * A physics-rolled `attack_object` resolution that should be HELD (its own
   * application deferred) until `waitForRollResolved(t)` fires — not just the
   * events that follow it.
   *
   * Character attacks apply their resolution immediately and only defer the
   * trailing `state_change` (HP / KO). An object smash is different: its
   * consequence — the smashed sprite (obstacleDestroyed → scene.destroyedObstacles
   * → prop-layer rebuild), the durability-pip drain (obstacleDamaged), any prop
   * removal, AND the HIT flash + explosion that Board fires off the same event —
   * is all encoded INLINE in the resolution event. Applying it on arrival makes
   * the cask vanish (and the flash play) at trigger time, often a beat BEFORE the
   * 3D dice have even settled. Holding the whole event until the overlay signals
   * resolved is what sequences it as dice → flash/explosion → cask gone.
   *
   * Gated on `rollRequestId` (set only when the browser physics actually rolled
   * the check): seeded / non-physics object smashes have no dice to wait for, so
   * they fall through to immediate apply (gating them would stall forever).
   */
  const holdPlanFor = (env: ServerEnvelope): DeferPlan | null => {
    if (env.kind !== 'event') return null;
    const e = env.event as {
      t?: number;
      type?: string;
      public?: { hit?: unknown; success?: unknown; pos?: unknown; targetKind?: unknown; rollRequestId?: unknown };
    };
    if (e.type !== 'resolution') return null;
    if (typeof e.t !== 'number') return null;
    if (typeof e.public?.rollRequestId !== 'string') return null;
    // Object-attack shape: `success` (not `hit`), anchored on a cell, targeting
    // an obstacle/prop. Excludes character attacks (hit boolean) and ability_test
    // / free_ally checks (no pos / targetKind).
    const isObjectAttack =
      typeof e.public.hit !== 'boolean' &&
      typeof e.public.success === 'boolean' &&
      e.public.pos !== undefined &&
      (e.public.targetKind === 'obstacle' || e.public.targetKind === 'prop');
    if (!isObjectAttack) return null;
    return { resolvedKey: e.t, postResolvedMs: 0 };
  };

  /** Schedule the post-resolved drain. Microtask via
   *  `waitForRollResolved.then`, then (for ranged/magic) a setTimeout for
   *  the projectile's flight. Gen-checked so a stale signal (from before
   *  a snapshot reset) can't fire a drain. */
  const armDrainAfterResolved = (plan: DeferPlan): void => {
    deferring = true;
    const myGen = gen;
    void waitForRollResolved(plan.resolvedKey).then(() => {
      if (myGen !== gen) return;
      if (plan.postResolvedMs > 0) {
        drainTimer = setTimeout(tryDrain, plan.postResolvedMs);
      } else {
        tryDrain();
      }
    });
  };

  /** Drain queued envelopes one at a time, re-arming the timer whenever a
   *  queued envelope itself triggers a new defer. */
  const tryDrain = (): void => {
    drainTimer = null;
    while (queue.length > 0) {
      const env = queue[0]!;
      // A queued object smash whose own dice haven't settled yet (e.g. a second
      // smash stacked behind the one that just resolved) re-arms on ITS signal
      // instead of being applied early. `isRollResolved` guards against
      // re-holding the event that just fired this drain — its signal is already
      // recorded, so we fall through and apply it.
      const hold = holdPlanFor(env);
      if (hold && !isRollResolved(hold.resolvedKey)) {
        armDrainAfterResolved(hold);
        return;
      }
      queue.shift();
      const plan = planFor(env);
      store.applyEnvelope(env);
      if (plan) {
        armDrainAfterResolved(plan);
        return;
      }
    }
    deferring = false;
  };

  return {
    apply: (env: ServerEnvelope): void => {
      // Snapshots reset world state — never defer them, and flush any
      // in-flight queue since it's no longer relevant.
      if (env.kind === 'snapshot') {
        queue.length = 0;
        if (drainTimer != null) { clearTimeout(drainTimer); drainTimer = null; }
        deferring = false;
        gen++;
        resetRollMountRegistry();
        store.applyEnvelope(env);
        return;
      }
      // Either already deferring, or the queue is non-empty (preserve order):
      // park this envelope and let the drain pick it up.
      if (deferring || queue.length > 0) {
        queue.push(env);
        return;
      }
      // A physics-rolled object smash holds its OWN application (the smashed
      // sprite + HIT flash + explosion are inline in this event) until the
      // dice settle — park it and arm the drain on its resolved signal.
      const hold = holdPlanFor(env);
      if (hold) {
        queue.push(env);
        armDrainAfterResolved(hold);
        return;
      }
      // Free to apply now. Compute the plan BEFORE applying so position
      // lookups see the pre-mutation state.
      const plan = planFor(env);
      store.applyEnvelope(env);
      if (plan) armDrainAfterResolved(plan);
    },
  };
};
