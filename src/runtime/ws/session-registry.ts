/**
 * Tracks ONE independent game session per browser `sid`, so a single WS server
 * process can host several playthroughs in parallel — each with its own engine,
 * agents, orchestrator and run directory.
 *
 * The server (server.ts) accepts every socket and reports its `sid`; this
 * registry decides what that socket means:
 *   - a brand-new `sid`  → build a fresh session via `opts.create`
 *   - a known `sid`      → re-attach to the existing session (a tab reconnecting
 *                          after a transient WS blip — see web/ws-client.ts,
 *                          which reuses the sid for the life of a page load)
 *
 * Message routing is NOT this class's concern: each session's `WsAdapter` binds
 * its own `ws.on('message')` listener in `attach()`, so once `create`/`reattach`
 * have wired a socket to its adapter, traffic flows straight to the right game.
 *
 * Lifecycle / leak control:
 *   - When a session's `runPromise` settles on its own (win / party-wipe /
 *     abort) it is dropped from the registry.
 *   - When the CURRENT socket of a session closes and no socket reconnects with
 *     that sid within `graceMs`, the session is aborted and reaped — without
 *     this, every closed tab would leak a whole game (engine + agents blocked
 *     forever on human input). A reconnect inside the grace window cancels the
 *     reap, so a brief network blip or laptop sleep doesn't kill the run.
 *
 * Session cap + wait queue (`maxSessions`):
 *   - Each session runs its own DM + hero LLM agents, so unbounded parallel
 *     games can overwhelm the host (CPU, memory, token spend). With a cap set,
 *     a NEW sid arriving while `maxSessions` sessions are live joins a FIFO
 *     wait queue instead of starting a game; `onQueued` tells its socket the
 *     1-based position (the browser shows "you are #N in line"), re-sent
 *     whenever the line moves. When a running session ends (or is reaped),
 *     the head of the queue is admitted and its game starts. A queued socket
 *     closing leaves the line immediately; a same-sid reconnect while waiting
 *     keeps its place (socket swapped). Reattaches to EXISTING sessions are
 *     always allowed — the cap gates session creation only.
 *   - QUEUE PRESSURE: the 5-minute disconnect grace exists for transient blips
 *     and laptop sleeps — but while someone is WAITING for a slot, letting a
 *     disconnected (often abandoned) session hold its seat that long stalls
 *     the whole line (observed live 2026-06-03: refreshed tabs left zombie
 *     sessions pinning all 3 slots while fresh sids queued behind them). So
 *     whenever the line is non-empty, a disconnected session is reaped after
 *     the much shorter `queueGraceMs` instead — applied both when the socket
 *     closes while people wait AND retroactively to already-running reap
 *     timers the moment someone joins the line.
 *   - IDLE SWEEP (also queue pressure): a CONNECTED session can be just as
 *     abandoned as a disconnected one — a tab someone clicked into and forgot
 *     keeps its socket open and pins a slot indefinitely (observed live
 *     2026-06-03, round 2: three forgotten tabs auto-grabbed every slot at
 *     server boot and the line never moved). While anyone is waiting, a
 *     periodic sweep reaps sessions whose HUMAN has produced no input for
 *     `idlePressureMs` (the per-session `lastHumanActivityMs` hook supplies
 *     the stamp; automatic page traffic doesn't refresh it). Sessions without
 *     the hook are never idle-reaped.
 *   - REATTACH-ONLY connects: a browser that already HELD a session this page
 *     load (it received a snapshot) marks its reconnect attempts; if this
 *     server doesn't know the sid (process restarted, session reaped/ended),
 *     the connect is REFUSED via `onRefused` instead of silently starting a
 *     fresh game — otherwise every forgotten tab's reconnect loop grabs a
 *     slot the moment the server comes back up.
 *
 * The class is socket-type-agnostic (generic `S`) and takes injectable
 * `onClose` / timers, so it unit-tests with a fake socket and manual clock.
 */

/** Opaque timer handle (`ReturnType<typeof setTimeout>` in production, a number
 *  in tests). The registry only stores it and hands it back to `clearTimer`. */
export type TimerHandle = unknown;

/**
 * A live session the registry owns. `create`/`reattach` hand sockets to it; the
 * registry calls `abort()` to tear it down (reap / shutdown) and watches
 * `runPromise` to know when it ended by itself.
 */
export interface ManagedSession<S> {
  /** Cancel the run and resolve once it has fully unwound (so shutdown can wait
   *  for every session). Must unblock any pending human-input wait too. */
  abort: () => Promise<void>;
  /** Re-bind a fresh socket to the existing session (same-sid reconnect). */
  reattach?: (ws: S) => void;
  /** Settles when the run ends on its own — the registry drops the session then. */
  runPromise: Promise<void>;
  /** Epoch ms of the human's last input (see the IDLE SWEEP note in the class
   *  doc — production wires `WsAdapter.lastHumanActivityMs`). Absent → the
   *  session is exempt from idle reaping. */
  lastHumanActivityMs?: () => number;
}

/** A waiting socket's standing in the line for a free session slot. */
export interface QueueStanding {
  /** 1-based place in the line (1 = next to be admitted). */
  position: number;
  /** The configured `maxSessions` cap, for "server is full (N seats)" copy. */
  capacity: number;
}

export interface SessionRegistryOpts<S> {
  /** Build a brand-new session for a sid, attaching the first socket. Called
   *  once per new sid; the returned `ManagedSession` is owned by the registry. */
  create: (sid: string, ws: S) => Promise<ManagedSession<S>>;
  /** Register a close listener on a socket. Production passes
   *  `(ws, cb) => ws.on('close', cb)`; tests inject a fake. */
  onClose: (ws: S, listener: () => void) => void;
  /** Maximum number of CONCURRENT sessions. A new sid arriving at the cap
   *  waits in a FIFO queue until a running session ends or is reaped (see the
   *  class doc). `<= 0` / undefined = unlimited (default — nothing queues). */
  maxSessions?: number;
  /** Notify a WAITING socket of its queue standing. Invoked when it joins the
   *  line and again whenever the line moves. Production sends a `queued`
   *  envelope (bin/play.ts); tests inject a spy. Errors are swallowed — a
   *  dead socket's close listener removes it from the line. */
  onQueued?: (ws: S, standing: QueueStanding) => void;
  /** Grace period (ms) after a session's current socket closes before it is
   *  aborted. `<= 0` disables reaping (sessions live until they end or the
   *  server shuts down). Defaults to {@link DEFAULT_SESSION_GRACE_MS}. */
  graceMs?: number;
  /** Disconnect grace used INSTEAD of `graceMs` while the wait queue is
   *  non-empty (see "QUEUE PRESSURE" in the class doc) — never longer than
   *  `graceMs` itself. Defaults to {@link DEFAULT_QUEUE_PRESSURE_GRACE_MS}.
   *  Reaping stays fully disabled when `graceMs <= 0`. */
  queueGraceMs?: number;
  /** While the wait queue is non-empty, a CONNECTED session whose human has
   *  produced no input for this long is reaped (see "IDLE SWEEP" in the class
   *  doc). Requires the session's `lastHumanActivityMs` hook. `<= 0` disables
   *  the sweep; reaping as a whole stays disabled when `graceMs <= 0`.
   *  Defaults to {@link DEFAULT_IDLE_PRESSURE_MS}. */
  idlePressureMs?: number;
  /** Refuse handler for reattach-only connects whose sid this server doesn't
   *  know (see "REATTACH-ONLY connects" in the class doc). Production sends
   *  `rejected: session_gone` + closes the socket; tests inject a spy. */
  onRefused?: (ws: S, sid: string) => void;
  /** Injectable clock for the idle sweep (defaults to `Date.now`). */
  now?: () => number;
  /** Injectable timer scheduler (defaults to a self-unref'd `setTimeout`). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable timer canceller (defaults to `clearTimeout`). */
  clearTimer?: (handle: TimerHandle) => void;
  /** Optional progress logger (session started / reattached / ended / reaped). */
  log?: (msg: string) => void;
}

/** Five minutes: long enough to survive a laptop sleep or flaky link, short
 *  enough that abandoned tabs don't pile up engines + agents indefinitely. */
export const DEFAULT_SESSION_GRACE_MS = 5 * 60_000;

/** Fifteen seconds: with people WAITING for a slot, a gone tab only gets long
 *  enough to ride out a genuine reconnect blip before its seat is handed on. */
export const DEFAULT_QUEUE_PRESSURE_GRACE_MS = 15_000;

/** Two minutes: with people WAITING, a connected tab whose human hasn't acted
 *  in this long reads as abandoned (a real player's own turn comes around far
 *  more often than this) and its seat is handed on. */
export const DEFAULT_IDLE_PRESSURE_MS = 120_000;

interface Entry<S> {
  sid: string;
  session: ManagedSession<S>;
  /** The socket currently bound to this session. Only a close of THIS socket
   *  may schedule a reap — a socket already superseded by a reconnect closing
   *  later must not kill the live session. */
  currentWs: S;
  reapTimer: TimerHandle | null;
}

export class SessionRegistry<S> {
  private readonly entries = new Map<string, Entry<S>>();
  /** FIFO line of sids waiting for a free session slot (cap reached). The
   *  entry's `ws` is the socket to notify / eventually admit; a same-sid
   *  reconnect while waiting swaps it in place (keeping the position). */
  private readonly waiting: Array<{ sid: string; ws: S }> = [];
  /** Connect handling is serialized so two near-simultaneous opens for the same
   *  sid can't both miss the map and build two sessions. */
  private inFlight: Promise<void> = Promise.resolve();
  private readonly maxSessions: number;
  private readonly graceMs: number;
  private readonly queueGraceMs: number;
  private readonly idlePressureMs: number;
  /** Pending idle-sweep tick while the queue is non-empty (null = no sweep). */
  private sweepTimer: TimerHandle | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SessionRegistryOpts<S>) {
    this.maxSessions = opts.maxSessions ?? 0;
    this.graceMs = opts.graceMs ?? DEFAULT_SESSION_GRACE_MS;
    this.queueGraceMs = opts.queueGraceMs ?? DEFAULT_QUEUE_PRESSURE_GRACE_MS;
    this.idlePressureMs = opts.idlePressureMs ?? DEFAULT_IDLE_PRESSURE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();  // don't keep the process alive
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = opts.log ?? (() => { /* silent */ });
  }

  /** Number of live sessions (diagnostics / tests). */
  get size(): number { return this.entries.size; }

  /** Currently-live sids (diagnostics / tests). */
  activeSids(): string[] { return [...this.entries.keys()]; }

  /** Number of sids waiting for a free slot (diagnostics / tests). */
  get queueLength(): number { return this.waiting.length; }

  /** Waiting sids in admission order (diagnostics / tests). */
  waitingSids(): string[] { return this.waiting.map((w) => w.sid); }

  /**
   * Route an incoming socket to its session. New sid → create; known sid →
   * reattach. Serialized through `inFlight`; errors are logged, never thrown
   * (a failed connect must not wedge the chain for other sessions).
   * `opts.reattachOnly` marks a reconnect from a tab that already HELD a
   * session this page load — an unknown sid is then refused rather than
   * given a fresh game (see "REATTACH-ONLY connects" in the class doc).
   */
  handleConnection(ws: S, sid: string, opts?: { reattachOnly?: boolean }): void {
    this.inFlight = this.inFlight
      .then(() => this.onConnect(ws, sid, opts?.reattachOnly === true))
      .catch((e) => this.log(`[session ${sid}] connect failed: ${String(e)}`));
  }

  private async onConnect(ws: S, sid: string, reattachOnly: boolean): Promise<void> {
    const existing = this.entries.get(sid);
    if (existing) {
      // Same-sid reconnect: cancel any pending reap, rebind to the new socket.
      // Always allowed even at capacity — the session already holds its slot.
      this.clearReap(existing);
      existing.currentWs = ws;
      existing.session.reattach?.(ws);
      this.bindClose(existing, ws);
      this.log(`[session ${sid}] reattached (${this.entries.size} active)`);
      return;
    }
    // Already in line (a WS blip while waiting): swap to the new socket and
    // keep the place — re-notify so the fresh socket learns its position.
    const queued = this.waiting.find((w) => w.sid === sid);
    if (queued) {
      queued.ws = ws;
      this.bindQueueClose(ws, sid);
      this.notifyQueue();
      return;
    }
    // The tab claims an existing session but this server has none for the sid
    // (process restarted / session reaped or ended). Refuse rather than start
    // a fresh game: forgotten tabs' reconnect loops must not grab slots. The
    // browser stops reconnecting on the refusal and asks for a reload.
    if (reattachOnly) {
      this.log(`[session ${sid}] reattach refused — no such session (tab must reload to rejoin)`);
      try {
        this.opts.onRefused?.(ws, sid);
      } catch {
        /* dead socket — nothing to refuse */
      }
      return;
    }
    // At capacity — or below it while others are still waiting (a slot freed
    // but the admit step hasn't run yet): join the line rather than jump it.
    if (this.maxSessions > 0 && (this.entries.size >= this.maxSessions || this.waiting.length > 0)) {
      this.waiting.push({ sid, ws });
      this.bindQueueClose(ws, sid);
      this.log(`[session ${sid}] queued for a free slot (#${this.waiting.length} waiting, ${this.entries.size}/${this.maxSessions} active)`);
      this.notifyQueue();
      // Any session already sitting disconnected on the LONG grace is now
      // blocking this waiter — shorten its clock to the queue-pressure grace.
      this.tightenReapsUnderPressure();
      // And start watching for CONNECTED-but-abandoned sessions too.
      this.ensureIdleSweep();
      return;
    }
    await this.startSession(sid, ws);
  }

  /** Build + register the session for a sid (the socket is attached inside
   *  `create`). Shared by the direct-connect path and queue admission. */
  private async startSession(sid: string, ws: S): Promise<void> {
    const session = await this.opts.create(sid, ws);
    const entry: Entry<S> = { sid, session, currentWs: ws, reapTimer: null };
    this.entries.set(sid, entry);
    this.bindClose(entry, ws);
    // Drop from the registry once the run ends on its own (win / wipe / abort).
    void session.runPromise.then(
      () => this.drop(sid, session),
      () => this.drop(sid, session),
    );
    this.log(`[session ${sid}] started (${this.entries.size} active)`);
  }

  /** Close listener for a WAITING socket: leave the line immediately (no
   *  grace — a gone tab must not be admitted into a dead session, and the
   *  rest of the line moves up). A socket superseded by a same-sid reconnect
   *  (or already admitted) no longer matches its entry and is a no-op. A sid
   *  that closes and later reconnects re-joins at the BACK of the line. */
  private bindQueueClose(ws: S, sid: string): void {
    this.opts.onClose(ws, () => {
      const idx = this.waiting.findIndex((w) => w.sid === sid && w.ws === ws);
      if (idx === -1) return;
      this.waiting.splice(idx, 1);
      this.log(`[session ${sid}] left the queue (${this.waiting.length} waiting)`);
      this.notifyQueue();
    });
  }

  /** Tell every waiting socket its current 1-based standing. */
  private notifyQueue(): void {
    const notify = this.opts.onQueued;
    if (!notify) return;
    this.waiting.forEach((w, i) => {
      try {
        notify(w.ws, { position: i + 1, capacity: this.maxSessions });
      } catch {
        /* dead socket — its close listener removes it from the line */
      }
    });
  }

  /**
   * A slot may have freed (run ended / session reaped): admit waiting sids in
   * FIFO order until the cap is hit again or the line is empty. Serialized
   * through the connect chain so an admission can't race a concurrent connect;
   * a failed create logs and moves on to the next in line.
   */
  private admitNext(): void {
    if (this.waiting.length === 0) return;
    this.inFlight = this.inFlight.then(async () => {
      while (this.waiting.length > 0 && (this.maxSessions <= 0 || this.entries.size < this.maxSessions)) {
        const next = this.waiting.shift()!;
        try {
          await this.startSession(next.sid, next.ws);
        } catch (e) {
          this.log(`[session ${next.sid}] admit failed: ${String(e)}`);
        }
      }
      this.notifyQueue();
    });
  }

  private bindClose(entry: Entry<S>, ws: S): void {
    this.opts.onClose(ws, () => {
      const cur = this.entries.get(entry.sid);
      // Only the session's CURRENT socket closing schedules a reap. A superseded
      // socket (replaced by a reconnect) closing later is a no-op.
      if (cur && cur.currentWs === ws) this.scheduleReap(cur);
    });
  }

  private scheduleReap(entry: Entry<S>): void {
    if (this.graceMs <= 0) return;  // reaping disabled
    this.clearReap(entry);
    // Queue pressure: while someone is waiting for a slot, a gone tab only
    // gets the short grace — its seat is wanted (never longer than graceMs).
    const ms = this.waiting.length > 0
      ? Math.min(this.graceMs, this.queueGraceMs)
      : this.graceMs;
    entry.reapTimer = this.setTimer(
      () => { void this.reap(entry.sid, entry.session); },
      ms,
    );
  }

  /** Someone just joined the line: every ALREADY-disconnected session (a
   *  pending reap timer is exactly that) now holds a seat someone wants —
   *  restart its reap on the short queue-pressure grace so the line moves in
   *  seconds, not minutes. Connected sessions are untouched. */
  private tightenReapsUnderPressure(): void {
    if (this.graceMs <= 0) return;  // reaping disabled
    for (const entry of this.entries.values()) {
      if (entry.reapTimer !== null) this.scheduleReap(entry);
    }
  }

  /** Start the idle sweep if the queue is non-empty and none is running. The
   *  sweep re-arms itself after each tick while pressure persists and stops
   *  by itself once the line empties. */
  private ensureIdleSweep(): void {
    if (this.graceMs <= 0 || this.idlePressureMs <= 0) return;  // disabled
    if (this.sweepTimer !== null || this.waiting.length === 0) return;
    const interval = Math.max(1_000, Math.min(this.queueGraceMs, this.idlePressureMs));
    this.sweepTimer = this.setTimer(() => {
      this.sweepTimer = null;
      this.sweepIdleSessions();
    }, interval);
  }

  /** One idle-sweep tick: while people wait, reap CONNECTED sessions whose
   *  human has been silent past `idlePressureMs` (see "IDLE SWEEP" in the
   *  class doc) — but only AS MANY AS THERE ARE WAITERS, oldest-idle first.
   *  An idle session that nobody needs the seat of yet is left parked (it
   *  costs nothing while gated, and its human may come back); the next waiter
   *  to arrive claims it within one sweep interval. Disconnected sessions
   *  (pending reap timer) are skipped — they're already on the queue-pressure
   *  disconnect clock. */
  private sweepIdleSessions(): void {
    if (this.waiting.length === 0) return;  // pressure gone — sweep stops
    const now = this.now();
    const idle = [...this.entries.values()]
      .filter((e) => e.reapTimer === null)           // connected only
      .map((e) => ({ entry: e, last: e.session.lastHumanActivityMs?.() }))
      .filter((x): x is { entry: Entry<S>; last: number } =>
        x.last !== undefined && now - x.last > this.idlePressureMs)
      .sort((a, b) => a.last - b.last);              // longest-silent first
    for (const { entry } of idle.slice(0, this.waiting.length)) {
      void this.reap(entry.sid, entry.session, 'idle under queue pressure');
    }
    this.ensureIdleSweep();  // keep sweeping while the line is non-empty
  }

  private clearReap(entry: Entry<S>): void {
    if (entry.reapTimer !== null) {
      this.clearTimer(entry.reapTimer);
      entry.reapTimer = null;
    }
  }

  private async reap(
    sid: string,
    session: ManagedSession<S>,
    reason = 'after disconnect grace',
  ): Promise<void> {
    const entry = this.entries.get(sid);
    if (!entry || entry.session !== session) return;  // replaced / already gone
    this.entries.delete(sid);
    this.log(`[session ${sid}] reaped ${reason} (${this.entries.size} active)`);
    this.admitNext();  // the freed slot goes to the head of the wait queue
    try {
      await session.abort();
    } catch (e) {
      this.log(`[session ${sid}] reap abort error: ${String(e)}`);
    }
  }

  private drop(sid: string, session: ManagedSession<S>): void {
    const entry = this.entries.get(sid);
    if (!entry || entry.session !== session) return;  // already reaped / replaced
    this.clearReap(entry);
    this.entries.delete(sid);
    this.log(`[session ${sid}] ended (${this.entries.size} active)`);
    this.admitNext();  // the freed slot goes to the head of the wait queue
  }

  /** Abort every live session and return once all have unwound (server shutdown). */
  async shutdownAll(): Promise<void> {
    this.waiting.length = 0;  // waiting sockets just see the server close
    if (this.sweepTimer !== null) {
      this.clearTimer(this.sweepTimer);
      this.sweepTimer = null;
    }
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const e of entries) this.clearReap(e);
    await Promise.allSettled(entries.map((e) => e.session.abort()));
  }
}
