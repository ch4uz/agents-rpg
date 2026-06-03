// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createStore } from '../../web/store.js';

describe('browser store', () => {
  it('applies a snapshot envelope', () => {
    const s = createStore();
    s.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} },
      state: {
        viewer: { kind: 'human' },
        scene: { id: 'tavern-basement', assetId: 'tavern-basement', gridW: 5, gridH: 8 },
        characters: [
          { id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 }, inventory: [], boons: [],
            specialAction: { name: 'Whirlwind', description: '' },
            bonusAbility:  { name: 'Teamwork',  description: '' } },
        ],
        activeActor: 'h1' as never,
        recentChat: [],
      },
    } as never);
    const snap = s.getSnapshot();
    expect(snap.scene?.id).toBe('tavern-basement');
    expect(snap.characters).toHaveLength(1);
    expect(snap.activeActor).toBe('h1');
  });

  it('appends to chat on event envelope', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'event', event: { type: 'narration', actorId: 'dm', text: 'Hello' } as never });
    expect(s.getSnapshot().chat).toHaveLength(1);
  });

  it('subscribers fire on every mutation', () => {
    const s = createStore();
    let fires = 0;
    s.subscribe(() => { fires += 1; });
    s.applyEnvelope({ kind: 'event', event: { type: 'narration', actorId: 'dm', text: 'a' } as never });
    s.applyEnvelope({ kind: 'event', event: { type: 'narration', actorId: 'dm', text: 'b' } as never });
    expect(fires).toBe(2);
  });

  it('turn_started sets activeActor; turn_ended clears it', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    expect(s.getSnapshot().activeActor).toBe('h1');
    s.applyEnvelope({ kind: 'turn_ended', actorId: 'h1' as never });
    expect(s.getSnapshot().activeActor).toBeNull();
  });

  it('thinking / thinking_done toggles the thinking set', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'thinking', actorId: 'h1' as never });
    expect(s.getSnapshot().thinking.has('h1' as never)).toBe(true);
    s.applyEnvelope({ kind: 'thinking_done', actorId: 'h1' as never });
    expect(s.getSnapshot().thinking.has('h1' as never)).toBe(false);
  });

  it('end envelope sets the ended field and locks input', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'end', outcome: 'success' });
    const snap = s.getSnapshot();
    expect(snap.ended).toEqual({ outcome: 'success' });
    expect(snap.inputUnlocked).toBe(false);
  });

  it('setInputUnlocked is a no-op when value is unchanged (prevents subscribe re-entry recursion)', () => {
    const s = createStore();
    let fires = 0;
    s.subscribe(() => {
      fires += 1;
      // Mirrors web/main.ts: re-derive input lock on every store change.
      s.setInputUnlocked(s.getSnapshot().activeActor !== null);
    });
    // turn_started is the trigger that, before the fix, recursed via setInputUnlocked → notify → subscriber → setInputUnlocked.
    s.applyEnvelope({ kind: 'turn_started', actorId: 'h1' as never });
    // One fire from turn_started, one from setInputUnlocked(true). Subsequent setInputUnlocked(true) calls are no-ops.
    expect(fires).toBe(2);
    expect(s.getSnapshot().inputUnlocked).toBe(true);
  });
});
