import { describe, it, expect, vi } from 'vitest';
import {
  SessionRegistry,
  DEFAULT_SESSION_GRACE_MS,
} from '../../../src/runtime/ws/session-registry.js';

/** Minimal stand-in for a ws WebSocket: records close listeners and can fire
 *  them on demand (simulates the tab going away). */
class FakeWs {
  closeListeners: Array<() => void> = [];
  on(event: string, cb: () => void): void {
    if (event === 'close') this.closeListeners.push(cb);
  }
  emitClose(): void {
    for (const cb of [...this.closeListeners]) cb();
  }
}

/** Drain the microtask queue (handleConnection serializes through a promise
 *  chain whose steps `await` create()). One setImmediate macrotask runs after
 *  all pending microtasks, so the connect handling has settled by the time it
 *  resolves. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A fake ManagedSession whose abort/reattach are spies. Return type is
 *  inferred so the vi.fn() Mock generics stay concrete (assignable to
 *  ManagedSession<FakeWs>), while `endRun` lets a test resolve the run as if the
 *  game ended on its own. */
const makeSession = () => {
  let resolveRun!: () => void;
  const runPromise = new Promise<void>((r) => { resolveRun = r; });
  // abort() also resolves the run (mirrors production: abort cancels the
  // orchestrator and awaits its unwind).
  const abort = vi.fn(async (): Promise<void> => { resolveRun(); });
  const reattach = vi.fn((_ws: FakeWs): void => { /* spy */ });
  return { abort, reattach, runPromise, endRun: () => resolveRun() };
};

/** A manually-driven clock so reap timing is deterministic. */
const makeClock = () => {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void): number => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimer: (h: unknown): void => { timers.delete(h as number); },
    /** Fire every pending timer, then drain microtasks (reap is async). */
    fire: async (): Promise<void> => {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
      await tick();
    },
    pending: (): number => timers.size,
  };
};

describe('SessionRegistry — parallel sessions', () => {
  it('hosts two DIFFERENT sids as independent sessions', async () => {
    const create = vi.fn(async (_sid: string, _ws: FakeWs) => makeSession());
    const reg = new SessionRegistry<FakeWs>({ create, onClose: (ws, l) => ws.on('close', l) });

    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();

    expect(create).toHaveBeenCalledTimes(2);
    expect(reg.size).toBe(2);
    expect(reg.activeSids().sort()).toEqual(['sid-a', 'sid-b']);
  });

  it('reattaches the SAME sid to its existing session (no new session)', async () => {
    const session = makeSession();
    const create = vi.fn(async () => session);
    const reg = new SessionRegistry<FakeWs>({ create, onClose: (ws, l) => ws.on('close', l) });

    reg.handleConnection(new FakeWs(), 'sid-a');
    await tick();
    const ws2 = new FakeWs();
    reg.handleConnection(ws2, 'sid-a');
    await tick();

    expect(create).toHaveBeenCalledTimes(1);
    expect(session.reattach).toHaveBeenCalledTimes(1);
    expect(session.reattach).toHaveBeenCalledWith(ws2);
    expect(reg.size).toBe(1);
  });

  it('drops a session when its run ends on its own', async () => {
    const session = makeSession();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => session,
      onClose: (ws, l) => ws.on('close', l),
    });

    reg.handleConnection(new FakeWs(), 'sid-a');
    await tick();
    expect(reg.size).toBe(1);

    session.endRun();
    await tick();
    expect(reg.size).toBe(0);
  });

  it('aborts every live session on shutdownAll', async () => {
    const sessions = [makeSession(), makeSession()];
    let i = 0;
    const reg = new SessionRegistry<FakeWs>({
      create: async () => sessions[i++]!,
      onClose: (ws, l) => ws.on('close', l),
    });

    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();
    expect(reg.size).toBe(2);

    await reg.shutdownAll();
    expect(sessions[0]!.abort).toHaveBeenCalledTimes(1);
    expect(sessions[1]!.abort).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });

  it('survives a create() failure without wedging the registry', async () => {
    const log = vi.fn();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => { throw new Error('boom'); },
      onClose: (ws, l) => ws.on('close', l),
      log,
    });

    reg.handleConnection(new FakeWs(), 'sid-a');
    await tick();

    expect(reg.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connect failed'));

    // A subsequent good connection still works (chain not poisoned).
    const reg2 = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
    });
    reg2.handleConnection(new FakeWs(), 'sid-b');
    await tick();
    expect(reg2.size).toBe(1);
  });
});

describe('SessionRegistry — disconnect reaping', () => {
  it('reaps a session after the disconnect grace elapses', async () => {
    const clock = makeClock();
    const session = makeSession();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => session,
      onClose: (ws, l) => ws.on('close', l),
      graceMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const ws1 = new FakeWs();
    reg.handleConnection(ws1, 'sid-a');
    await tick();

    ws1.emitClose();              // tab gone
    expect(clock.pending()).toBe(1);  // reap scheduled
    expect(session.abort).not.toHaveBeenCalled();

    await clock.fire();           // grace elapses
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });

  it('a reconnect within the grace window cancels the reap', async () => {
    const clock = makeClock();
    const session = makeSession();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => session,
      onClose: (ws, l) => ws.on('close', l),
      graceMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const ws1 = new FakeWs();
    reg.handleConnection(ws1, 'sid-a');
    await tick();
    ws1.emitClose();
    expect(clock.pending()).toBe(1);

    reg.handleConnection(new FakeWs(), 'sid-a');  // reconnect
    await tick();

    expect(clock.pending()).toBe(0);              // reap cancelled
    expect(session.abort).not.toHaveBeenCalled();
    expect(reg.size).toBe(1);
  });

  it('a superseded socket closing does NOT reap the live session', async () => {
    const clock = makeClock();
    const session = makeSession();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => session,
      onClose: (ws, l) => ws.on('close', l),
      graceMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const ws1 = new FakeWs();
    reg.handleConnection(ws1, 'sid-a');
    await tick();
    reg.handleConnection(new FakeWs(), 'sid-a');  // ws2 becomes current
    await tick();

    ws1.emitClose();                  // the OLD socket closes after the swap
    expect(clock.pending()).toBe(0);  // no reap scheduled
    expect(reg.size).toBe(1);
  });

  it('graceMs <= 0 disables reaping (sessions persist past disconnect)', async () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
      graceMs: 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const ws1 = new FakeWs();
    reg.handleConnection(ws1, 'sid-a');
    await tick();
    ws1.emitClose();

    expect(clock.pending()).toBe(0);
    expect(reg.size).toBe(1);
  });

  it('uses DEFAULT_SESSION_GRACE_MS when no grace is configured', async () => {
    let capturedMs = -1;
    const reg = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
      setTimer: (_fn, ms) => { capturedMs = ms; return 1; },
      clearTimer: () => {},
    });

    const ws1 = new FakeWs();
    reg.handleConnection(ws1, 'sid-a');
    await tick();
    ws1.emitClose();

    expect(capturedMs).toBe(DEFAULT_SESSION_GRACE_MS);
  });
});

describe('SessionRegistry — session cap + wait queue', () => {
  /** Registry with maxSessions=1, recording onQueued notifications. */
  const makeCapped = (opts: {
    maxSessions?: number;
    create?: (sid: string, ws: FakeWs) => Promise<ReturnType<typeof makeSession>>;
  } = {}) => {
    const sessions = new Map<string, ReturnType<typeof makeSession>>();
    const create = vi.fn(async (sid: string, ws: FakeWs) => {
      if (opts.create) {
        const s = await opts.create(sid, ws);
        sessions.set(sid, s);
        return s;
      }
      const s = makeSession();
      sessions.set(sid, s);
      return s;
    });
    const onQueued = vi.fn((_ws: FakeWs, _standing: { position: number; capacity: number }) => {});
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: opts.maxSessions ?? 1,
      onQueued,
    });
    return { reg, create, onQueued, sessions };
  };

  it('caps concurrent sessions: overflow sids queue FIFO with 1-based positions', async () => {
    const { reg, create, onQueued } = makeCapped({ maxSessions: 1 });
    const wsB = new FakeWs();
    const wsC = new FakeWs();
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(wsB, 'sid-b');
    reg.handleConnection(wsC, 'sid-c');
    await tick();

    expect(create).toHaveBeenCalledTimes(1);          // only sid-a got a game
    expect(reg.size).toBe(1);
    expect(reg.queueLength).toBe(2);
    expect(reg.waitingSids()).toEqual(['sid-b', 'sid-c']);
    // Latest standings tell each waiting socket its place + the capacity.
    expect(onQueued).toHaveBeenLastCalledWith(wsC, { position: 2, capacity: 1 });
    expect(onQueued).toHaveBeenCalledWith(wsB, { position: 1, capacity: 1 });
  });

  it('admits the head of the queue when a running session ends', async () => {
    const { reg, create, onQueued, sessions } = makeCapped({ maxSessions: 1 });
    const wsC = new FakeWs();
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    reg.handleConnection(wsC, 'sid-c');
    await tick();

    sessions.get('sid-a')!.endRun();
    await tick();

    expect(create).toHaveBeenCalledTimes(2);          // sid-b admitted
    expect(create).toHaveBeenLastCalledWith('sid-b', expect.anything());
    expect(reg.activeSids()).toEqual(['sid-b']);
    expect(reg.waitingSids()).toEqual(['sid-c']);
    expect(onQueued).toHaveBeenLastCalledWith(wsC, { position: 1, capacity: 1 });
  });

  it('admits from the queue when a session is reaped after the disconnect grace', async () => {
    const clock = makeClock();
    const session = makeSession();
    const create = vi.fn(async (sid: string) => (sid === 'sid-a' ? session : makeSession()));
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const wsA = new FakeWs();
    reg.handleConnection(wsA, 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();
    expect(reg.waitingSids()).toEqual(['sid-b']);

    wsA.emitClose();        // sid-a's tab goes away
    await clock.fire();     // grace elapses → reap
    await tick();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(reg.activeSids()).toEqual(['sid-b']);
    expect(reg.queueLength).toBe(0);
  });

  it('a queued socket closing leaves the line and the rest move up', async () => {
    const { reg, onQueued } = makeCapped({ maxSessions: 1 });
    const wsB = new FakeWs();
    const wsC = new FakeWs();
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(wsB, 'sid-b');
    reg.handleConnection(wsC, 'sid-c');
    await tick();

    wsB.emitClose();        // sid-b abandons the wait

    expect(reg.waitingSids()).toEqual(['sid-c']);
    expect(onQueued).toHaveBeenLastCalledWith(wsC, { position: 1, capacity: 1 });
  });

  it('a queued sid reconnecting keeps its place with the socket swapped', async () => {
    const { reg, create, onQueued } = makeCapped({ maxSessions: 1 });
    const wsB1 = new FakeWs();
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(wsB1, 'sid-b');
    reg.handleConnection(new FakeWs(), 'sid-c');
    await tick();

    const wsB2 = new FakeWs();
    reg.handleConnection(wsB2, 'sid-b');   // WS blip while waiting
    await tick();

    expect(create).toHaveBeenCalledTimes(1);                 // still no new game
    expect(reg.waitingSids()).toEqual(['sid-b', 'sid-c']);   // place kept
    expect(onQueued).toHaveBeenCalledWith(wsB2, { position: 1, capacity: 1 });

    wsB1.emitClose();       // the SUPERSEDED socket closing is a no-op
    expect(reg.waitingSids()).toEqual(['sid-b', 'sid-c']);
  });

  it('a reattach to an ACTIVE session is allowed at capacity', async () => {
    const { reg, create, sessions } = makeCapped({ maxSessions: 1 });
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');   // queued
    await tick();

    const ws2 = new FakeWs();
    reg.handleConnection(ws2, 'sid-a');            // sid-a reconnects
    await tick();

    expect(create).toHaveBeenCalledTimes(1);
    expect(sessions.get('sid-a')!.reattach).toHaveBeenCalledWith(ws2);
    expect(reg.waitingSids()).toEqual(['sid-b']);  // line untouched
  });

  it('a new sid cannot jump a non-empty queue even while a slot is free', async () => {
    const { reg, create, sessions } = makeCapped({ maxSessions: 1 });
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');   // queued at #1
    await tick();

    // End sid-a and connect sid-c in the same beat: the freed slot must go to
    // sid-b (FIFO), with sid-c joining the line behind it — even if sid-c's
    // connect is processed while the slot is momentarily free.
    sessions.get('sid-a')!.endRun();
    reg.handleConnection(new FakeWs(), 'sid-c');
    await tick();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith('sid-b', expect.anything());
    expect(reg.activeSids()).toEqual(['sid-b']);
    expect(reg.waitingSids()).toEqual(['sid-c']);
  });

  it('a failed create during admission moves on to the next in line', async () => {
    const sessions = new Map<string, ReturnType<typeof makeSession>>();
    const create = vi.fn(async (sid: string) => {
      if (sid === 'sid-b') throw new Error('boom');
      const s = makeSession();
      sessions.set(sid, s);
      return s;
    });
    const log = vi.fn();
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      log,
    });
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    reg.handleConnection(new FakeWs(), 'sid-c');
    await tick();

    sessions.get('sid-a')!.endRun();
    await tick();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('admit failed'));
    expect(reg.activeSids()).toEqual(['sid-c']);   // sid-b's failure didn't wedge the line
    expect(reg.queueLength).toBe(0);
  });

  it('shutdownAll clears the wait queue', async () => {
    const { reg } = makeCapped({ maxSessions: 1 });
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();
    expect(reg.queueLength).toBe(1);

    await reg.shutdownAll();
    expect(reg.size).toBe(0);
    expect(reg.queueLength).toBe(0);
  });

  it('maxSessions <= 0 (or unset) disables the cap — nothing ever queues', async () => {
    const { reg, create, onQueued } = makeCapped({ maxSessions: 0 });
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    reg.handleConnection(new FakeWs(), 'sid-c');
    await tick();

    expect(create).toHaveBeenCalledTimes(3);
    expect(reg.queueLength).toBe(0);
    expect(onQueued).not.toHaveBeenCalled();
  });
});

describe('SessionRegistry — queue-pressure reaping', () => {
  /** Clock that also records the ms of every scheduled timer. */
  const makeRecordingClock = () => {
    const clock = makeClock();
    const scheduledMs: number[] = [];
    return {
      ...clock,
      scheduledMs,
      setTimer: (fn: () => void, ms: number): number => {
        scheduledMs.push(ms);
        return clock.setTimer(fn);
      },
    };
  };

  it('a disconnect WHILE people wait schedules the SHORT queue-pressure grace', async () => {
    const clock = makeRecordingClock();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 300_000,
      queueGraceMs: 15_000,
      idlePressureMs: 0,   // isolate the disconnect grace (no sweep timers)
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const wsA = new FakeWs();
    reg.handleConnection(wsA, 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');   // someone is waiting
    await tick();

    wsA.emitClose();                               // active tab leaves under pressure
    expect(clock.scheduledMs).toEqual([15_000]);   // short grace, not 300s
  });

  it('someone JOINING the line tightens an already-running long-grace reap, and the freed slot goes to them', async () => {
    const clock = makeRecordingClock();
    const session = makeSession();
    const create = vi.fn(async (sid: string) => (sid === 'sid-a' ? session : makeSession()));
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 300_000,
      queueGraceMs: 15_000,
      idlePressureMs: 0,   // isolate the disconnect grace (no sweep timers)
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const wsA = new FakeWs();
    reg.handleConnection(wsA, 'sid-a');
    await tick();
    wsA.emitClose();                               // empty line → LONG grace
    expect(clock.scheduledMs).toEqual([300_000]);

    reg.handleConnection(new FakeWs(), 'sid-b');   // pressure arrives
    await tick();
    expect(clock.scheduledMs).toEqual([300_000, 15_000]);  // reap rescheduled short

    await clock.fire();                            // short grace elapses → reap
    await tick();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith('sid-b', expect.anything());
    expect(reg.activeSids()).toEqual(['sid-b']);
  });

  it('the queue-pressure grace never exceeds graceMs itself', async () => {
    const clock = makeRecordingClock();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 1_000,                              // shorter than the default 15s
      idlePressureMs: 0,   // isolate the disconnect grace (no sweep timers)
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const wsA = new FakeWs();
    reg.handleConnection(wsA, 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();
    wsA.emitClose();

    expect(clock.scheduledMs).toEqual([1_000]);
  });

  it('graceMs <= 0 keeps reaping fully disabled even under queue pressure', async () => {
    const clock = makeRecordingClock();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => makeSession(),
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const wsA = new FakeWs();
    reg.handleConnection(wsA, 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');   // waiting
    await tick();
    wsA.emitClose();

    expect(clock.scheduledMs).toEqual([]);         // no reap, by configuration
    expect(reg.size).toBe(1);
  });
});

describe('SessionRegistry — idle sweep under queue pressure', () => {
  /** Capped registry with an injectable clock + idle stamps per sid. */
  const makeIdleRig = () => {
    const clock = makeClock();
    let nowMs = 0;
    const activity = new Map<string, number | undefined>();
    const sessions = new Map<string, ReturnType<typeof makeSession>>();
    const create = vi.fn(async (sid: string) => {
      const base = makeSession();
      sessions.set(sid, base);
      const stamp = () => activity.get(sid);
      return {
        ...base,
        // Only sids with a recorded stamp expose the hook (undefined = exempt).
        ...(activity.has(sid) ? { lastHumanActivityMs: () => stamp()! } : {}),
      };
    });
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      graceMs: 300_000,
      queueGraceMs: 15_000,
      idlePressureMs: 120_000,
      now: () => nowMs,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { reg, create, sessions, clock, activity, setNow: (ms: number) => { nowMs = ms; } };
  };

  it('reaps a CONNECTED session idle past the threshold and admits the waiter', async () => {
    const { reg, create, sessions, clock, activity, setNow } = makeIdleRig();
    activity.set('sid-a', 0);                      // human last acted at t=0
    reg.handleConnection(new FakeWs(), 'sid-a');
    await tick();
    expect(clock.pending()).toBe(0);               // no pressure → no sweep

    reg.handleConnection(new FakeWs(), 'sid-b');   // pressure → sweep armed
    await tick();
    expect(clock.pending()).toBe(1);

    setNow(130_000);                               // 130s of silence > 120s
    await clock.fire();                            // sweep tick
    await tick();

    expect(sessions.get('sid-a')!.abort).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith('sid-b', expect.anything());
    expect(reg.activeSids()).toEqual(['sid-b']);
    expect(reg.queueLength).toBe(0);
  });

  it('recent human activity protects a session from the sweep', async () => {
    const { reg, sessions, clock, activity, setNow } = makeIdleRig();
    activity.set('sid-a', 0);
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();

    activity.set('sid-a', 100_000);                // acted 30s ago
    setNow(130_000);
    await clock.fire();
    await tick();

    expect(sessions.get('sid-a')!.abort).not.toHaveBeenCalled();
    expect(reg.activeSids()).toEqual(['sid-a']);
    expect(reg.waitingSids()).toEqual(['sid-b']);
    expect(clock.pending()).toBe(1);               // sweep re-armed while pressure persists
  });

  it('reaps only AS MANY idle sessions as there are waiters, longest-silent first', async () => {
    const clock = makeClock();
    let nowMs = 0;
    const sessions = new Map<string, ReturnType<typeof makeSession>>();
    const lastBySid: Record<string, number> = { 'sid-a': 0, 'sid-b': 50_000 };
    const create = vi.fn(async (sid: string) => {
      const base = makeSession();
      sessions.set(sid, base);
      return { ...base, lastHumanActivityMs: () => lastBySid[sid] ?? nowMs };
    });
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 2,
      graceMs: 300_000,
      queueGraceMs: 15_000,
      idlePressureMs: 120_000,
      now: () => nowMs,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    reg.handleConnection(new FakeWs(), 'sid-a');   // idle since 0
    reg.handleConnection(new FakeWs(), 'sid-b');   // idle since 50s
    reg.handleConnection(new FakeWs(), 'sid-c');   // ONE waiter
    await tick();

    nowMs = 200_000;                               // both a (200s) and b (150s) idle
    await clock.fire();
    await tick();

    // Only ONE seat was needed — the longest-silent session paid for it.
    expect(sessions.get('sid-a')!.abort).toHaveBeenCalledTimes(1);
    expect(sessions.get('sid-b')!.abort).not.toHaveBeenCalled();
    expect(reg.activeSids().sort()).toEqual(['sid-b', 'sid-c']);
  });

  it('sessions WITHOUT the activity hook are exempt from idle reaping', async () => {
    const { reg, sessions, clock, setNow } = makeIdleRig();
    // no activity entry for sid-a → created session exposes no hook
    reg.handleConnection(new FakeWs(), 'sid-a');
    reg.handleConnection(new FakeWs(), 'sid-b');
    await tick();

    setNow(10_000_000);                            // arbitrarily late
    await clock.fire();
    await tick();

    expect(sessions.get('sid-a')!.abort).not.toHaveBeenCalled();
    expect(reg.activeSids()).toEqual(['sid-a']);
  });
});

describe('SessionRegistry — reattach-only connects', () => {
  it('refuses a reattach-only connect for an UNKNOWN sid (no new game)', async () => {
    const create = vi.fn(async () => makeSession());
    const onRefused = vi.fn((_ws: FakeWs, _sid: string) => {});
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      onRefused,
    });

    const ws = new FakeWs();
    reg.handleConnection(ws, 'ghost-sid', { reattachOnly: true });
    await tick();

    expect(create).not.toHaveBeenCalled();         // crucially: no fresh game
    expect(reg.size).toBe(0);
    expect(reg.queueLength).toBe(0);
    expect(onRefused).toHaveBeenCalledWith(ws, 'ghost-sid');
  });

  it('reattach-only with a KNOWN sid reattaches normally', async () => {
    const session = makeSession();
    const onRefused = vi.fn();
    const reg = new SessionRegistry<FakeWs>({
      create: async () => session,
      onClose: (ws, l) => ws.on('close', l),
      onRefused,
    });

    reg.handleConnection(new FakeWs(), 'sid-a');
    await tick();
    const ws2 = new FakeWs();
    reg.handleConnection(ws2, 'sid-a', { reattachOnly: true });
    await tick();

    expect(session.reattach).toHaveBeenCalledWith(ws2);
    expect(onRefused).not.toHaveBeenCalled();
    expect(reg.size).toBe(1);
  });

  it('a refused ghost does not consume a slot others are waiting for', async () => {
    const create = vi.fn(async () => makeSession());
    const onRefused = vi.fn();
    const reg = new SessionRegistry<FakeWs>({
      create,
      onClose: (ws, l) => ws.on('close', l),
      maxSessions: 1,
      onRefused,
    });

    reg.handleConnection(new FakeWs(), 'ghost-1', { reattachOnly: true });  // refused
    reg.handleConnection(new FakeWs(), 'sid-a');                            // real player
    await tick();

    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reg.activeSids()).toEqual(['sid-a']);   // the slot went to the player
  });
});
