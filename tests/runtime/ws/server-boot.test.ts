import { describe, it, expect, afterAll } from 'vitest';
import { bootWsServer } from '../../../src/runtime/ws/server.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const tmp = mkdtempSync(join(tmpdir(), 'ws-boot-'));
mkdirSync(join(tmp, 'assets'));
writeFileSync(join(tmp, 'assets', 'manifest.json'), JSON.stringify({
  heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
}));
mkdirSync(join(tmp, 'web'));
writeFileSync(join(tmp, 'web', 'index.html'), '<html><body>hi</body></html>');

describe('bootWsServer', () => {
  it('binds to a random port and serves index.html on /', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('hi');
    await s.shutdown();
  });

  it('serves assets under /assets/<path>', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    const res = await fetch(`http://127.0.0.1:${s.port}/assets/manifest.json`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toHaveProperty('heroes');
    await s.shutdown();
  });

  it('returns 404 for assets that do not exist', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    const res = await fetch(`http://127.0.0.1:${s.port}/assets/nope.png`);
    expect(res.status).toBe(404);
    await s.shutdown();
  });

  it('rejects a manifest with missing files at boot', async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'ws-boot-bad-'));
    try {
      mkdirSync(join(tmp2, 'assets'));
      writeFileSync(join(tmp2, 'assets', 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      mkdirSync(join(tmp2, 'web'));
      writeFileSync(join(tmp2, 'web', 'index.html'), '<html></html>');
      await expect(bootWsServer({ webRoot: join(tmp2, 'web'), assetsRoot: join(tmp2, 'assets'), port: 0 })).rejects.toThrow(/heroes\/warrior\.png/);
    } finally { rmSync(tmp2, { recursive: true, force: true }); }
  });

  it('newest WS wins: a second connection kicks the first with session_in_use', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    // Track which sockets the server attaches per `onConnect`. The test
    // doesn't drive a real adapter — we just need to observe that the server
    // accepts both connections (instead of rejecting the second one).
    const attached: WebSocket[] = [];
    s.onConnect((ws) => { attached.push(ws as unknown as WebSocket); });

    const waitForMessage = (ws: WebSocket): Promise<unknown> =>
      new Promise((resolve, reject) => {
        ws.once('message', (raw: Buffer) => { try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); } });
        ws.once('error', reject);
      });
    const waitForClose = (ws: WebSocket): Promise<void> =>
      new Promise((resolve) => { ws.once('close', () => resolve()); });
    const waitForOpen = (ws: WebSocket): Promise<void> =>
      new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    const a = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    await waitForOpen(a);
    // Wait for the server to invoke its connect handler before we open the
    // second socket so we deterministically exercise the kick path.
    await new Promise<void>((r) => setImmediate(r));

    const b = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const msgFromA = waitForMessage(a);
    await waitForOpen(b);

    // Socket A (the older one) is the one that should be kicked: it receives
    // a `rejected: session_in_use` envelope and then a close.
    const kickEnv = await msgFromA;
    expect(kickEnv).toMatchObject({ kind: 'rejected', reason: 'session_in_use' });
    await waitForClose(a);

    // Both connections went through the server's connect path (newest wins,
    // not first wins).
    expect(attached.length).toBe(2);

    b.close();
    await s.shutdown();
  });

  it('different sids COEXIST: a second connection with a NEW sid does not kick the first', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    const attached: WebSocket[] = [];
    s.onConnect((ws) => { attached.push(ws as unknown as WebSocket); });

    const waitForOpen = (ws: WebSocket): Promise<void> =>
      new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    const a = new WebSocket(`ws://127.0.0.1:${s.port}/ws?sid=alpha`);
    await waitForOpen(a);
    await new Promise<void>((r) => setImmediate(r));

    // Watch socket A for any kick (a message or a close).
    let aDisturbed = false;
    a.on('message', () => { aDisturbed = true; });
    a.on('close', () => { aDisturbed = true; });

    const b = new WebSocket(`ws://127.0.0.1:${s.port}/ws?sid=beta`);
    await waitForOpen(b);
    // Give the server a beat to (not) kick A.
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(aDisturbed).toBe(false);
    expect(a.readyState).toBe(WebSocket.OPEN);
    // Both went through the connect path — two independent sessions.
    expect(attached.length).toBe(2);

    a.close(); b.close();
    await s.shutdown();
  });

  it('same sid still wins newest: a reconnect with the SAME sid kicks the prior socket', async () => {
    const s = await bootWsServer({ webRoot: join(tmp, 'web'), assetsRoot: join(tmp, 'assets'), port: 0 });
    s.onConnect(() => { /* no adapter needed for this assertion */ });

    const waitForOpen = (ws: WebSocket): Promise<void> =>
      new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const waitForMessage = (ws: WebSocket): Promise<unknown> =>
      new Promise((resolve, reject) => {
        ws.once('message', (raw: Buffer) => { try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); } });
        ws.once('error', reject);
      });
    const waitForClose = (ws: WebSocket): Promise<void> =>
      new Promise((resolve) => { ws.once('close', () => resolve()); });

    const a = new WebSocket(`ws://127.0.0.1:${s.port}/ws?sid=same`);
    await waitForOpen(a);
    await new Promise<void>((r) => setImmediate(r));

    const b = new WebSocket(`ws://127.0.0.1:${s.port}/ws?sid=same`);
    const msgFromA = waitForMessage(a);
    await waitForOpen(b);

    expect(await msgFromA).toMatchObject({ kind: 'rejected', reason: 'session_in_use' });
    await waitForClose(a);

    b.close();
    await s.shutdown();
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});
