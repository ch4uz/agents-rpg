import { describe, it, expect } from 'vitest';
import { WsAdapter } from '../../../src/runtime/ws/adapter.js';
import { asCharacterId } from '../../../src/engine/ids.js';

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  on(_e: string, _h: unknown) {}
}

const fakeManifest = { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {}, tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {} };

describe('reconnect (snapshot+tail)', () => {
  it('a fresh attach sends a snapshot envelope reflecting the supplied state', () => {
    const a = new WsAdapter({ kind: 'human' }, fakeManifest);
    const ws1 = new FakeWs();
    a.attach(ws1 as unknown as import('ws').WebSocket, {
      viewer: { kind: 'human' },
      scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8, obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [] },
      characters: [],
      props: [],
      activeActor: asCharacterId('h1'),
      recentChat: [],
    });
    a.detach();
    const ws2 = new FakeWs();
    a.attach(ws2 as unknown as import('ws').WebSocket, {
      viewer: { kind: 'human' },
      scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8, obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [] },
      characters: [],
      props: [],
      activeActor: asCharacterId('h1'),
      recentChat: [{ type: 'narration', actorId: 'dm', text: 'A door creaks.' } as never],
    });
    const second = ws2.sent.map((s) => JSON.parse(s));
    expect(second[0].kind).toBe('snapshot');
    expect(second[0].state.recentChat).toHaveLength(1);
  });
});
