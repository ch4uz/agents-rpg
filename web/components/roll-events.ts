/**
 * Coordination signal between the dice-panel UI (Layout.ts) and the
 * resolution-driven visual effects on the board (Board.ts) + the WS
 * state-change drain (ws-deferred.ts).
 *
 * The dice panel mounts when Layout's playback queue promotes a `dice` item
 * to `currentDisplay`. That moment can lag arbitrarily behind the resolution
 * event's arrival in chat — there may be DM narration or hero speech still
 * being typewritten ahead of it. Without this signal, Board and ws-deferred
 * would fire their HIT/MISS flash, projectile, HP drain, and KO removal on
 * a fixed timer from the resolution's arrival, which can land BEFORE the
 * dice panel has even appeared (the "MISS before dice rolled" bug).
 *
 * Keyed by the engine event's logical step counter (`t`) — globally unique
 * per event, accessible from every consumer without needing to know the
 * chat-array index.
 *
 * In physics-as-truth mode the same registry is also keyed by the string
 * `roll_request` id: the roll_request handler in `main.ts` signals
 * `notifyRollResolved(requestId)` when its animation completes, and a bridge
 * in `ws-client.ts` re-signals under the resolution's numeric `t` so Board
 * and ws-deferred (which key off `t`) fire at the right moment. Hence the
 * `string | number` key type — numeric `t`s and string request ids never
 * collide.
 */
type RollKey = string | number;

const mountedAt = new Map<RollKey, number>();
const mountResolvers = new Map<RollKey, ((at: number) => void)[]>();

const resolvedAt = new Map<RollKey, number>();
const resolvedResolvers = new Map<RollKey, ((at: number) => void)[]>();

const nowMs = (): number =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

/**
 * Layout calls this exactly once per resolution `t` when the dice panel
 * promotes to `currentDisplay`. Subsequent calls for the same `t` are no-ops
 * so a re-render can't double-fire downstream effects.
 */
export const notifyRollMounted = (t: RollKey): void => {
  if (mountedAt.has(t)) return;
  const at = nowMs();
  mountedAt.set(t, at);
  const queued = mountResolvers.get(t);
  mountResolvers.delete(t);
  for (const r of queued ?? []) r(at);
};

/**
 * Resolves with the `performance.now()` timestamp at which the dice panel
 * for resolution `t` mounted. If the panel has already mounted, resolves
 * immediately. Otherwise the promise stays pending until `notifyRollMounted`
 * is called for that `t`.
 */
export const waitForRollMount = (t: RollKey): Promise<number> => {
  const existing = mountedAt.get(t);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise<number>((resolve) => {
    const list = mountResolvers.get(t) ?? [];
    list.push(resolve);
    mountResolvers.set(t, list);
  });
};

/**
 * Layout calls this when the dice overlay's roll promise settles for
 * resolution `t` — i.e. the dice physics has finished AND the post-snap
 * hold has elapsed AND the canvas hide has been scheduled. Downstream
 * consequences (HP/KO drain in ws-deferred, projectile / flashRoll / attack
 * animation in Board) gate on this so they only fire after the player has
 * seen the dice and verdict resolve.
 *
 * Idempotent: subsequent calls for the same `t` are no-ops.
 */
export const notifyRollResolved = (t: RollKey): void => {
  if (resolvedAt.has(t)) return;
  const at = nowMs();
  resolvedAt.set(t, at);
  const queued = resolvedResolvers.get(t);
  resolvedResolvers.delete(t);
  for (const r of queued ?? []) r(at);
};

/**
 * Resolves with the `performance.now()` timestamp at which the dice overlay
 * signaled that resolution `t` was fully resolved. If already resolved,
 * returns immediately. Otherwise stays pending until `notifyRollResolved`
 * is called for that `t`.
 */
export const waitForRollResolved = (t: RollKey): Promise<number> => {
  const existing = resolvedAt.get(t);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise<number>((resolve) => {
    const list = resolvedResolvers.get(t) ?? [];
    list.push(resolve);
    resolvedResolvers.set(t, list);
  });
};

/**
 * Synchronous check: has `notifyRollResolved` already fired for `t`?
 * Used by Layout's playback queue to decide whether a dice/initiative item
 * is ready to be displaced from `currentDisplay` — the queue is driven by
 * the signal, not a fixed lifespan.
 */
export const isRollResolved = (t: RollKey): boolean => resolvedAt.has(t);

/**
 * Cleared on `snapshot` envelopes (handled by ws-deferred) — the world is
 * being reset, so any pending registrations from the prior session would
 * never fire. Exposed for tests too.
 */
export const resetRollMountRegistry = (): void => {
  mountedAt.clear();
  mountResolvers.clear();
  resolvedAt.clear();
  resolvedResolvers.clear();
};
