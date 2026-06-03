import { describe, it, expect, vi } from 'vitest';
import { WsAdapter } from '../../../src/runtime/ws/adapter.js';
import { asCharacterId } from '../../../src/engine/ids.js';

class FakeWs {
  readyState = 1;
  static OPEN = 1;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  on(_event: string, _handler: unknown) {}
}

const fakeManifest = { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {}, tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {} };

const fakeSnapshot = (humanId: string) => ({
  viewer: { kind: 'human' as const },
  scene: null, characters: [], props: [], activeActor: asCharacterId(humanId), recentChat: [],
});

describe('WsAdapter — Subscriber', () => {
  it('emits snapshot first, then event envelope per onEvent', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.onEvent({ type: 'action', actorId: asCharacterId('h1'), action: { kind: 'say', text: 'hi' } } as never);
    const sent = ws.sent.map((s) => JSON.parse(s));
    expect(sent[0].kind).toBe('snapshot');
    expect(sent[1].kind).toBe('event');
  });

  it('ships emote actions as event envelopes with the emoji payload intact', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.onEvent({
      type: 'action',
      actorId: asCharacterId('h1'),
      action: { kind: 'emote', emoji: '🙀' },
    } as never);
    const events = ws.sent
      .map((s) => JSON.parse(s) as { kind: string; event?: { type?: string; action?: { kind?: string; emoji?: string } } })
      .filter((e) => e.kind === 'event' && e.event?.type === 'action' && e.event.action?.kind === 'emote');
    expect(events).toHaveLength(1);
    expect(events[0]!.event!.action!.emoji).toBe('🙀');
  });

  it('emits turn_started / turn_ended on lifecycle hooks', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.onTurnStarted?.(asCharacterId('h1'));
    a.onTurnEnded?.(asCharacterId('h1'));
    const kinds = ws.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('turn_started');
    expect(kinds).toContain('turn_ended');
  });

  it('emits end envelope on onEnd', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.onEnd?.('success');
    const kinds = ws.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('end');
  });

  it('detach causes subsequent emits to no-op (no throw)', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.detach();
    expect(() => a.onEvent({ type: 'action', actorId: asCharacterId('h1'), action: { kind: 'say', text: 'x' } } as never)).not.toThrow();
  });

  it('viewer is exposed via the Subscriber interface', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    expect(a.viewer).toEqual({ kind: 'human' });
  });

  it('forwards onThinking / onThinkingDone as protocol envelopes', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    a.onThinking?.('dm');
    a.onThinkingDone?.('dm');
    const kinds = ws.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('thinking_done');
  });

  it('re-sends input_required when a fresh socket attaches mid-request', () => {
    // Simulates newest-wins: the orchestrator awaited requestInput() on the
    // old socket, then a new tab kicked it. The new tab needs to know "the
    // engine is waiting on you" — otherwise the snapshot resets inputUnlocked
    // and the user can't act.
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws1 = new FakeWs();
    a.attach(ws1 as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    void a.requestInput();
    const ws2 = new FakeWs();
    a.attach(ws2 as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const ws2Kinds = ws2.sent.map((s) => JSON.parse(s).kind);
    // Snapshot first, then input_required because a request is pending.
    expect(ws2Kinds).toEqual(['snapshot', 'input_required']);
  });
});

describe('WsAdapter — HumanInputProvider', () => {
  it('requestInput resolves to free_text on a human_input envelope', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (_s: string) => {},
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'I draw my sword' }));
    const resolved = await promise;
    expect(resolved).toEqual({ kind: 'free_text', text: 'I draw my sword' });
  });

  it('requestInput resolves to skip on a skip_turn envelope', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (_s: string) => {},
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'skip_turn' }));
    const resolved = await promise;
    expect(resolved).toEqual({ kind: 'skip' });
  });

  it('throws when called twice without resolution', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    void a.requestInput();
    expect(() => a.requestInput()).toThrow(/one pending request/i);
  });

  it('client message before requestInput is rejected with not_your_turn', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'pre-emptive' }));
    const kinds = sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('rejected');
  });

  /** Test seam: attach an adapter to a ws that captures its message handler so a
   *  test can feed it raw client envelopes, and collect everything it sends. */
  const withMessagePump = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, send: (env: unknown) => messageHandler(JSON.stringify(env)) };
  };

  it('off-turn human_input is forwarded to the interjection handler (not rejected) when one is registered', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const seen: Array<{ kind: string; text?: string }> = [];
    a.onInterject((input) => seen.push(input as never));
    const { sent, send } = withMessagePump(a);

    // No requestInput() pending → off-turn. "to Game" becomes free_text.
    send({ kind: 'human_input', text: 'I shove the door!' });
    // "to DM" becomes an ooc_query.
    send({ kind: 'human_input', text: 'how many rats?', target: 'dm' });

    expect(seen).toEqual([
      { kind: 'free_text', text: 'I shove the door!' },
      { kind: 'ooc_query', text: 'how many rats?' },
    ]);
    // No rejection was sent — the messages were accepted as interjections.
    expect(sent.map((s) => JSON.parse(s).kind)).not.toContain('rejected');
  });

  it('off-turn turn-structured input (skip / structured_action) is still rejected even with a handler', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const seen: unknown[] = [];
    a.onInterject((input) => seen.push(input));
    const { sent, send } = withMessagePump(a);

    send({ kind: 'skip_turn' });
    send({ kind: 'structured_action', action: { kind: 'end_turn' } });

    // Neither reached the interjection handler; both were rejected (need the turn).
    expect(seen).toEqual([]);
    expect(sent.filter((s) => JSON.parse(s).kind === 'rejected')).toHaveLength(2);
  });

  it('an interjection resolves a pending beat gate so the orchestrator wakes from between-turns', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    a.onInterject(() => {});
    const { send } = withMessagePump(a);

    // Orchestrator is parked on the beat gate (reading-pacing between turns).
    let gateResolved = false;
    const gate = a.awaitBeatsDrained('beat-1').then(() => { gateResolved = true; });

    // Human types instead of clicking Skip → the gate releases.
    send({ kind: 'human_input', text: 'wait, I want to say something' });
    await gate;
    expect(gateResolved).toBe(true);
  });

  it('detach KEEPS pending requestInput so the orchestrator survives WS drops', async () => {
    // A natural close (tab refresh, idle TCP timeout) must NOT crash the
    // orchestrator's awaited requestInput. The pending promise is preserved;
    // the next attach() re-sends input_required so the new client can fulfill
    // it. Verifies the fix for "run dies whenever the browser tab disconnects".
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws1 = new FakeWs();
    a.attach(ws1 as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const promise = a.requestInput();
    a.detach();

    // Promise must still be pending, not rejected.
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    // Reconnect: a fresh socket attaches and gets input_required re-sent.
    let messageHandler: (raw: string) => void = () => {};
    const ws2 = {
      readyState: 1,
      sent: [] as string[],
      send(s: string) { this.sent.push(s); },
      on(event: string, h: unknown) {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
      close() {},
    };
    a.attach(ws2 as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    expect(ws2.sent.map((s) => JSON.parse(s).kind)).toContain('input_required');

    // New client fulfills the original pending request.
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'finally' }));
    await expect(promise).resolves.toEqual({ kind: 'free_text', text: 'finally' });
  });

  it('requestInput sends an input_required envelope before awaiting', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws = new FakeWs();
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    void a.requestInput();
    const kinds = ws.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('input_required');
  });

  it('sends input_done after a human_input envelope resolves the request', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'human_input', text: 'I parry' }));
    await promise;
    const kinds = sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('input_required');
    expect(kinds).toContain('input_done');
    // Order: input_required must precede input_done.
    expect(kinds.indexOf('input_required')).toBeLessThan(kinds.indexOf('input_done'));
  });

  it('sends input_done after a skip_turn envelope resolves the request', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    const promise = a.requestInput();
    messageHandler(JSON.stringify({ kind: 'skip_turn' }));
    await promise;
    const kinds = sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain('input_done');
  });
});

describe('WsAdapter — RollProvider', () => {
  const spec = (requestId: string) => ({
    requestId,
    attacker: { actorId: asCharacterId('h1'), poolSize: 2, name: 'Bran', characterKind: 'hero' as const, archetype: 'warrior', sprite: null },
    defender: { actorId: asCharacterId('r1'), poolSize: 1, name: 'Rat', characterKind: 'monster' as const, archetype: null, sprite: 'giant-rat' },
  });

  const attachWithMessageHandler = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  it('sends a roll_request and resolves with the matching roll_response faces', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const promise = a.requestAttackRoll(spec('roll-1'));
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'roll_request');
    expect(req?.requestId).toBe('roll-1');
    fire({ kind: 'roll_response', requestId: 'roll-1', attackerFaces: [4, 2], defenderFaces: [6] });
    await expect(promise).resolves.toEqual({ attackerFaces: [4, 2], defenderFaces: [6] });
  });

  it('sends a CHECK roll_request (rollKind=check + difficulty, 0-die defender) for ability tests', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const checkSpec = {
      requestId: 'roll-c1',
      attacker: { actorId: asCharacterId('h1'), poolSize: 3, name: 'Bran', characterKind: 'hero' as const, archetype: 'warrior', sprite: null },
      defender: { actorId: asCharacterId('h1'), poolSize: 0, name: 'DC 5', characterKind: 'dm' as const, archetype: null, sprite: null },
      check: { difficulty: 5, describe: 'squeeze through' },
    };
    const promise = a.requestAttackRoll(checkSpec);
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'roll_request');
    expect(req?.rollKind).toBe('check');
    expect(req?.difficulty).toBe(5);
    expect(req?.defender.poolSize).toBe(0);
    fire({ kind: 'roll_response', requestId: 'roll-c1', attackerFaces: [5, 2, 1], defenderFaces: [] });
    await expect(promise).resolves.toEqual({ attackerFaces: [5, 2, 1], defenderFaces: [] });
  });

  it('ignores a roll_response with a mismatched requestId (stale reply)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.requestAttackRoll(spec('roll-2'));
    fire({ kind: 'roll_response', requestId: 'WRONG', attackerFaces: [1, 1], defenderFaces: [1] });
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('resolves null when no socket is attached (so the engine falls back to seeded dice)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    await expect(a.requestAttackRoll(spec('roll-3'))).resolves.toBeNull();
  });

  it('resolves pending rolls to null on detach (disconnect mid-roll)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.requestAttackRoll(spec('roll-4'));
    a.detach();
    await expect(promise).resolves.toBeNull();
  });

  it('resolves pending rolls to null on abort', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.requestAttackRoll(spec('roll-5'));
    a.abort();
    await expect(promise).resolves.toBeNull();
  });
});

describe('WsAdapter — RevealProvider (initiative-reveal gate)', () => {
  const attachWithMessageHandler = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  it('sends a reveal_request and blocks until the matching reveal_ack arrives', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const promise = a.awaitInitiativeReveal('reveal-1');

    // The gate must NOT be open before the player acks.
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'reveal_request');
    expect(req?.requestId).toBe('reveal-1');

    fire({ kind: 'reveal_ack', requestId: 'reveal-1' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores a reveal_ack with a mismatched requestId (stale ack)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.awaitInitiativeReveal('reveal-2');
    fire({ kind: 'reveal_ack', requestId: 'WRONG' });
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('resolves immediately when no socket is attached (headless / AI-only falls through)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    await expect(a.awaitInitiativeReveal('reveal-3')).resolves.toBeUndefined();
  });

  it('resolves the gate on detach so a dropped tab cannot hang the run', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitInitiativeReveal('reveal-4');
    a.detach();
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves the gate on abort', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitInitiativeReveal('reveal-5');
    a.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('force-releases after the backstop timeout if a wedged tab never acks', async () => {
    // A still-attached but wedged browser (e.g. backgrounded tab: the
    // initiative dice overlay never settles, so reveal_ack never fires) would
    // otherwise hang the run forever. The backstop must release the gate.
    vi.useFakeTimers();
    try {
      const a = new WsAdapter({ kind: 'human' }, fakeManifest);
      attachWithMessageHandler(a);
      const promise = a.awaitInitiativeReveal('reveal-timeout');
      let settled = false;
      void promise.then(() => { settled = true; });

      // Not before the backstop elapses.
      await vi.advanceTimersByTimeAsync(119_000);
      expect(settled).toBe(false);

      // Released after it.
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real reveal_ack cancels the backstop timer (no late double-resolve fallout)', async () => {
    vi.useFakeTimers();
    try {
      const a = new WsAdapter({ kind: 'human' }, fakeManifest);
      const { fire } = attachWithMessageHandler(a);
      const promise = a.awaitInitiativeReveal('reveal-ack-cancels');
      fire({ kind: 'reveal_ack', requestId: 'reveal-ack-cancels' });
      await expect(promise).resolves.toBeUndefined();
      // Advancing past the backstop must not throw (timer was cleared).
      await vi.advanceTimersByTimeAsync(200_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsAdapter — OpeningProvider (opening-splash gate)', () => {
  const attachWithMessageHandler = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  it('sends an opening_request and blocks until the matching opening_ack arrives', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const promise = a.awaitOpeningDismissed('opening-1');

    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'opening_request');
    expect(req?.requestId).toBe('opening-1');

    fire({ kind: 'opening_ack', requestId: 'opening-1' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores an opening_ack with a mismatched requestId (stale ack)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.awaitOpeningDismissed('opening-2');
    fire({ kind: 'opening_ack', requestId: 'WRONG' });
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('PARKS when no socket is attached — re-sent and answerable after attach', async () => {
    // A game-START gate must not auto-pass while nobody is watching (a closed
    // tab "beginning" the adventure let sessions free-run unattended).
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const promise = a.awaitOpeningDismissed('opening-3');
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);                     // parked, not auto-passed

    const { sent, fire } = attachWithMessageHandler(a);
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'opening_request');
    expect(req?.requestId).toBe('opening-3');        // re-sent on attach
    fire({ kind: 'opening_ack', requestId: 'opening-3' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('HOLDS the gate across a detach and re-prompts the reconnecting tab', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitOpeningDismissed('opening-4');
    a.detach();
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);                     // still parked

    const { sent, fire } = attachWithMessageHandler(a);  // tab comes back
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'opening_request');
    expect(req?.requestId).toBe('opening-4');
    fire({ kind: 'opening_ack', requestId: 'opening-4' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves the gate on abort', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitOpeningDismissed('opening-5');
    a.abort();
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('WsAdapter — BeatGate (beat-pacing gate)', () => {
  const attachWithMessageHandler = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  it('sends a beat_gate and blocks until the matching beat_gate_ack arrives', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const promise = a.awaitBeatsDrained('beat-1');

    // The gate must NOT open before the player has drained the queue.
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'beat_gate');
    expect(req?.requestId).toBe('beat-1');

    fire({ kind: 'beat_gate_ack', requestId: 'beat-1' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores a beat_gate_ack with a mismatched requestId (stale ack)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.awaitBeatsDrained('beat-2');
    fire({ kind: 'beat_gate_ack', requestId: 'WRONG' });
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('resolves immediately when no socket is attached (headless / AI-only falls through)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    await expect(a.awaitBeatsDrained('beat-3')).resolves.toBeUndefined();
  });

  it('resolves the gate on detach so a dropped tab cannot hang the run', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitBeatsDrained('beat-4');
    a.detach();
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves the gate on abort', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitBeatsDrained('beat-5');
    a.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('force-releases after the backstop timeout if a wedged tab never acks', async () => {
    // The rat-tunnel freeze: a seeded-fallback dice beat never drains on the
    // browser, so beat_gate_ack never fires and the orchestrator hangs right
    // before the human's turn. The server-side backstop must release it.
    vi.useFakeTimers();
    try {
      const a = new WsAdapter({ kind: 'human' }, fakeManifest);
      attachWithMessageHandler(a);
      const promise = a.awaitBeatsDrained('beat-timeout');
      let settled = false;
      void promise.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(119_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real beat_gate_ack cancels the backstop timer', async () => {
    vi.useFakeTimers();
    try {
      const a = new WsAdapter({ kind: 'human' }, fakeManifest);
      const { fire } = attachWithMessageHandler(a);
      const promise = a.awaitBeatsDrained('beat-ack-cancels');
      fire({ kind: 'beat_gate_ack', requestId: 'beat-ack-cancels' });
      await expect(promise).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(200_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WsAdapter — HeroSelectProvider (game-start hero-select gate)', () => {
  const attachWithMessageHandler = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  const opt = (characterId: string, name: string) => ({
    characterId: asCharacterId(characterId), name, archetype: 'warrior',
    spritePath: 'heroes/warrior/south.png', blurb: 'b', health: 3,
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, dex: 0,
    normalAttack: { name: 'Slash', kind: 'melee', range: 1 },
    specialAction: { name: 'Whirl', description: 'd' },
    bonusAbility: { name: 'Teamwork', description: 'd' },
  });

  it('sends a hero_select_request and resolves with the chosen characterId', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attachWithMessageHandler(a);
    const promise = a.awaitHeroSelection('hero-1', [opt('p1_warrior', 'Anwen'), opt('p2_warlock', 'Kael')]);

    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'hero_select_request');
    expect(req?.requestId).toBe('hero-1');
    expect(req?.options).toHaveLength(2);

    fire({ kind: 'hero_select_response', requestId: 'hero-1', characterId: 'p2_warlock' });
    await expect(promise).resolves.toEqual({ characterId: 'p2_warlock' });
  });

  it('carries the language pick through to the resolved selection', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.awaitHeroSelection('hero-lang', [opt('p1_warrior', 'Anwen')]);
    fire({ kind: 'hero_select_response', requestId: 'hero-lang', characterId: 'p1_warrior', language: 'pt' });
    await expect(promise).resolves.toEqual({ characterId: 'p1_warrior', language: 'pt' });
  });

  it('ignores a hero_select_response with a mismatched requestId (stale)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { fire } = attachWithMessageHandler(a);
    const promise = a.awaitHeroSelection('hero-2', [opt('p1_warrior', 'Anwen')]);
    fire({ kind: 'hero_select_response', requestId: 'WRONG', characterId: 'p1_warrior' });
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  });

  it('PARKS when no socket is attached — re-sent (with options) and answerable after attach', async () => {
    // The game-start chooser must not silently fall back to the default hero
    // while nobody is watching (a refreshed tab "picking" the default let
    // sessions free-run unattended — observed live 2026-06-03).
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const promise = a.awaitHeroSelection('hero-3', [opt('p1_warrior', 'Anwen'), opt('p2_warlock', 'Kael')]);
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);                     // parked, no default fallback

    const { sent, fire } = attachWithMessageHandler(a);
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'hero_select_request');
    expect(req?.requestId).toBe('hero-3');
    expect(req?.options).toHaveLength(2);            // full request re-sent
    fire({ kind: 'hero_select_response', requestId: 'hero-3', characterId: 'p2_warlock' });
    await expect(promise).resolves.toEqual({ characterId: 'p2_warlock' });
  });

  it('HOLDS the choice across a detach and re-prompts the reconnecting tab', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitHeroSelection('hero-4', [opt('p1_warrior', 'Anwen')]);
    a.detach();                                      // tab refreshes / closes
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);                     // NOT resolved to default

    const { sent, fire } = attachWithMessageHandler(a);  // tab comes back
    const req = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'hero_select_request');
    expect(req?.requestId).toBe('hero-4');
    fire({ kind: 'hero_select_response', requestId: 'hero-4', characterId: 'p1_warrior' });
    await expect(promise).resolves.toEqual({ characterId: 'p1_warrior' });
  });

  it('resolves to null on abort', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    attachWithMessageHandler(a);
    const promise = a.awaitHeroSelection('hero-5', [opt('p1_warrior', 'Anwen')]);
    a.abort();
    await expect(promise).resolves.toBeNull();
  });

  it('stamps awaitingHeroSelect on snapshots while the gate is pending, clears it once answered', async () => {
    // The attach snapshot (carrying scene.opening) arrives BEFORE the
    // hero_select_request; the flag lets the browser hold the opening splash so
    // it never flashes in that window. With expectsHeroSelect the attach
    // snapshot must advertise the pending gate.
    const a = new WsAdapter({ kind: 'human' }, fakeManifest, { expectsHeroSelect: true });
    const { sent, fire } = attachWithMessageHandler(a);
    const attachSnap = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'snapshot');
    expect(attachSnap?.awaitingHeroSelect).toBe(true);

    // Answer the gate → a later snapshot (e.g. the localized-name re-publish or
    // a scene change) must no longer advertise it.
    const promise = a.awaitHeroSelection('hero-flag', [opt('p1_warrior', 'Anwen')]);
    fire({ kind: 'hero_select_response', requestId: 'hero-flag', characterId: 'p1_warrior' });
    await promise;
    a.onSnapshot(fakeSnapshot('h1') as never);
    const afterSnap = sent.map((s) => JSON.parse(s)).filter((e) => e.kind === 'snapshot').at(-1);
    expect(afterSnap?.awaitingHeroSelect).toBe(false);
  });

  it('never advertises awaitingHeroSelect when no hero-select is expected (stub/preview/scripted)', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);  // default: expectsHeroSelect false
    const { sent } = attachWithMessageHandler(a);
    const attachSnap = sent.map((s) => JSON.parse(s)).find((e) => e.kind === 'snapshot');
    expect(attachSnap?.awaitingHeroSelect).toBe(false);
  });
});

describe('WsAdapter — survey persistence', () => {
  const attach = (a: WsAdapter) => {
    const sent: string[] = [];
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: (s: string) => { sent.push(s); },
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { sent, fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };
  const acksOf = (sent: string[]) =>
    sent.map((s) => JSON.parse(s)).filter((e) => e.kind === 'survey_ack');
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const submission = { scores: { coordination: 5, trust: 4 }, moment: 'the breach' };

  it('routes a survey_response to the registered handler and acks its result', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attach(a);
    const seen: unknown[] = [];
    a.onSurvey(async (survey) => { seen.push(survey); return { ok: true, destination: 'cloud' }; });
    fire({ kind: 'survey_response', survey: submission });
    await flush();
    expect(seen).toEqual([submission]);
    expect(acksOf(sent)).toEqual([{ kind: 'survey_ack', ok: true, destination: 'cloud' }]);
  });

  it('acks ok:false when no handler is registered (stub/preview servers)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attach(a);
    fire({ kind: 'survey_response', survey: submission });
    await flush();
    const acks = acksOf(sent);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ ok: false });
  });

  it('acks ok:false when the handler rejects — persistence failures never go silent', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attach(a);
    a.onSurvey(async () => { throw new Error('disk full'); });
    fire({ kind: 'survey_response', survey: submission });
    await flush();
    const acks = acksOf(sent);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ ok: false });
    expect(String((acks[0] as { detail?: string }).detail)).toContain('disk full');
  });

  it('handles a survey while a human-input request is pending (side-channel, not a turn input)', async () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const { sent, fire } = attach(a);
    a.onSurvey(async () => ({ ok: true, destination: 'local' }));
    const pending = a.requestInput();  // human's turn: input outstanding
    fire({ kind: 'survey_response', survey: submission });
    await flush();
    expect(acksOf(sent)).toHaveLength(1);
    // The turn input is still pending — the survey didn't consume it.
    fire({ kind: 'skip_turn' });
    await expect(pending).resolves.toEqual({ kind: 'skip' });
  });
});

describe('WsAdapter — human-activity stamp (registry idle-sweep input)', () => {
  const attach = (a: WsAdapter) => {
    let messageHandler: (raw: string) => void = () => {};
    const ws = {
      readyState: 1,
      send: () => {},
      on: (event: string, h: unknown) => {
        if (event === 'message') messageHandler = (raw: string | Buffer) => (h as (b: Buffer | string) => void)(raw);
      },
    };
    a.attach(ws as unknown as import('ws').WebSocket, fakeSnapshot('h1'));
    return { fire: (msg: unknown) => messageHandler(JSON.stringify(msg)) };
  };

  it('refreshes on human-initiated messages but NOT on automatic acks', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const a = new WsAdapter({ kind: 'human' }, fakeManifest);
      const { fire } = attach(a);
      expect(a.lastHumanActivityMs()).toBe(1_000_000);   // construction stamp

      vi.setSystemTime(1_060_000);
      // Automatic page traffic — the auto-skip's gate acks and the physics
      // dice relay — must NOT make an abandoned tab look attended.
      fire({ kind: 'beat_gate_ack', requestId: 'r1' });
      fire({ kind: 'reveal_ack', requestId: 'r2' });
      fire({ kind: 'roll_response', requestId: 'r3', attackerFaces: [4], defenderFaces: [2] });
      expect(a.lastHumanActivityMs()).toBe(1_000_000);

      // A typed message is a person at the table.
      fire({ kind: 'human_input', text: 'attack the rat' });
      expect(a.lastHumanActivityMs()).toBe(1_060_000);

      // So is a structured action click.
      vi.setSystemTime(1_090_000);
      fire({ kind: 'structured_action', action: { kind: 'end_turn' } });
      expect(a.lastHumanActivityMs()).toBe(1_090_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
