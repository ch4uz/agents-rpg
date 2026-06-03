// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createStore } from '../../web/store.js';
import type { ServerEnvelope } from '../../src/runtime/ws/protocol.js';

const baseManifest = {
  heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
  tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {},
};

const initialSnapshot = (chars: unknown[] = []): ServerEnvelope => ({
  kind: 'snapshot', viewer: { kind: 'human' } as never, manifest: baseManifest,
  state: {
    viewer: { kind: 'human' } as never,
    scene: { id: 's', assetId: 'bg', gridW: 5, gridH: 5,
             obstacles: [], decorations: [], exits: [], walls: true, destroyedObstacles: [] },
    characters: chars as never,
    props: [],
    activeActor: null,
    recentChat: [],
  },
});

describe('store applies state_change events to characters[]', () => {
  it('updates pos when state_change carries a pos', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([{
      id: 'h1', name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [], boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility: { name: '', description: '' },
    }]));
    s.applyEnvelope({ kind: 'event', event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'h1', pos: { x: 3, y: 2 } }],
    } as never });
    expect(s.getSnapshot().characters[0]!.pos).toEqual({ x: 3, y: 2 });
  });

  it('updates damage and status when state_change carries them', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([{
      id: 'r1', name: 'Rat', kind: 'monster',
      pos: { x: 1, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [], boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility: { name: '', description: '' },
    }]));
    s.applyEnvelope({ kind: 'event', event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'r1', damage: 1, status: 'KO' }],
    } as never });
    const c = s.getSnapshot().characters[0]!;
    expect(c.health.damage).toBe(1);
    expect(c.health.status).toBe('KO');
  });

  it('silently skips state_change for unknown ids', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    expect(() => s.applyEnvelope({ kind: 'event', event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'ghost', damage: 5 }],
    } as never })).not.toThrow();
    expect(s.getSnapshot().characters).toEqual([]);
  });

  it('does not mutate the previous characters array (immutable update)', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([{
      id: 'h1', name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [], boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility: { name: '', description: '' },
    }]));
    const prevChars = s.getSnapshot().characters;
    const prevFirst = prevChars[0];
    s.applyEnvelope({ kind: 'event', event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'h1', pos: { x: 3, y: 2 } }],
    } as never });
    // Previous reference was not mutated in-place.
    expect(prevFirst!.pos).toEqual({ x: 0, y: 0 });
    expect(s.getSnapshot().characters).not.toBe(prevChars);
  });
});

describe('store applies reveal_monster action events to characters[]', () => {
  it('appends a monster stub with sprite=monsterTypeId', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    s.applyEnvelope({ kind: 'event', event: {
      type: 'action', t: 1, actorId: 'dm',
      action: { kind: 'reveal_monster', monsterTypeId: 'giant-rat',
                characterId: 'giant-rat-1', pos: { x: 7, y: 1 } },
    } as never });
    const chars = s.getSnapshot().characters;
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({
      id: 'giant-rat-1',
      kind: 'monster',
      sprite: 'giant-rat',
      pos: { x: 7, y: 1 },
    });
  });

  it('is idempotent — second reveal with same id is a no-op', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    const ev = { kind: 'event', event: {
      type: 'action', t: 1, actorId: 'dm',
      action: { kind: 'reveal_monster', monsterTypeId: 'giant-rat',
                characterId: 'giant-rat-1', pos: { x: 7, y: 1 } },
    } } as never;
    s.applyEnvelope(ev);
    s.applyEnvelope(ev);
    expect(s.getSnapshot().characters).toHaveLength(1);
  });

  it('does NOT touch characters for unrelated action events (e.g. skip_turn)', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([{
      id: 'h1', name: 'Bran', kind: 'hero', archetype: 'warrior',
      pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
      pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
      inventory: [], boons: [],
      specialAction: { name: '', description: '' },
      bonusAbility: { name: '', description: '' },
    }]));
    s.applyEnvelope({ kind: 'event', event: {
      type: 'action', t: 1, actorId: 'h1',
      action: { kind: 'skip_turn' },
    } as never });
    expect(s.getSnapshot().characters).toHaveLength(1);
  });

  it('still appends to chat for state_change and reveal_monster events', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    s.applyEnvelope({ kind: 'event', event: {
      type: 'action', t: 1, actorId: 'dm',
      action: { kind: 'reveal_monster', monsterTypeId: 'giant-rat',
                characterId: 'giant-rat-1', pos: { x: 7, y: 1 } },
    } as never });
    s.applyEnvelope({ kind: 'event', event: {
      type: 'state_change', t: 2,
      changes: [{ id: 'giant-rat-1', damage: 1, status: 'KO' }],
    } as never });
    expect(s.getSnapshot().chat).toHaveLength(2);
  });
});

describe('store applies input_required and input_done envelopes', () => {
  it('input_required sets inputUnlocked to true', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    expect(s.getSnapshot().inputUnlocked).toBe(false);
    s.applyEnvelope({ kind: 'input_required' } as never);
    expect(s.getSnapshot().inputUnlocked).toBe(true);
  });

  it('input_done sets inputUnlocked to false', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    s.applyEnvelope({ kind: 'input_required' } as never);
    expect(s.getSnapshot().inputUnlocked).toBe(true);
    s.applyEnvelope({ kind: 'input_done' } as never);
    expect(s.getSnapshot().inputUnlocked).toBe(false);
  });

  it('notifies subscribers on input_required and input_done', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot([]));
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    s.applyEnvelope({ kind: 'input_required' } as never);
    s.applyEnvelope({ kind: 'input_done' } as never);
    expect(calls).toBe(2);
  });
});

describe('attack_object resolution events', () => {
  it('obstacleDestroyed appends to scene.destroyedObstacles', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot());
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'resolution', actorId: 'h1',
        public: { success: true, top: 6, difficulty: 5, targetKind: 'obstacle',
                  pos: { x: 2, y: 2 }, obstacleDestroyed: { x: 2, y: 2 } },
      } as never,
    });
    const snap = s.getSnapshot();
    expect(snap.scene?.destroyedObstacles).toEqual([{ x: 2, y: 2 }]);
  });

  it('propRemoved drops the prop from props[]', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot());
    // First spawn a prop via the action event.
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'action', actorId: 'dm',
        action: { kind: 'spawn_prop', id: 'cheese-1', emoji: '🧀', name: 'Cheese', pos: { x: 1, y: 1 } },
      } as never,
    });
    expect(s.getSnapshot().props).toHaveLength(1);
    // Then destroy it via resolution.propRemoved.
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'resolution', actorId: 'h1',
        public: { success: true, top: 6, difficulty: 5, targetKind: 'prop',
                  pos: { x: 1, y: 1 }, propRemoved: 'cheese-1' },
      } as never,
    });
    expect(s.getSnapshot().props).toHaveLength(0);
  });

  it('spawn_prop carrying a spriteId stores it (chest renders as a sprite, not the emoji)', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot());
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'action', actorId: 'dm',
        action: { kind: 'spawn_prop', id: 'supply-chest', emoji: '📦', name: 'Chest', pos: { x: 3, y: 3 }, spriteId: 'chest' },
      } as never,
    });
    const props = s.getSnapshot().props;
    expect(props).toHaveLength(1);
    expect(props[0]!.spriteId).toBe('chest');
  });

  it('failed attack (no destruction keys) leaves state intact', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot());
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'resolution', actorId: 'h1',
        public: { success: false, top: 3, difficulty: 6, targetKind: 'obstacle',
                  pos: { x: 2, y: 2 } },
      } as never,
    });
    expect(s.getSnapshot().scene?.destroyedObstacles).toEqual([]);
  });
});

describe('push_object resolution events', () => {
  const snapWithCask = (): ServerEnvelope => ({
    kind: 'snapshot', viewer: { kind: 'human' } as never, manifest: baseManifest,
    state: {
      viewer: { kind: 'human' } as never,
      scene: {
        id: 's', assetId: 'bg', gridW: 8, gridH: 8,
        obstacles: [
          { type: 'oil-cask', x: 4, y: 5, explosive: true, pushable: true },
          { type: 'stalagmite', x: 6, y: 5, attackProof: true },
        ],
        decorations: [], exits: [], walls: true, destroyedObstacles: [],
      },
      characters: [], props: [], activeActor: null, recentChat: [],
    } as never,
  });

  // Regression: a push must relocate the obstacle in the store, or the cask
  // stays at its old cell for BOTH the Board render and the Layout targeting —
  // so a detonation aimed where the cask appears hits empty floor
  // (no-such-object). Observed live in run 2026-06-01T11-15-55.
  it('objectPushed relocates the matching obstacle from→to', () => {
    const s = createStore();
    s.applyEnvelope(snapWithCask());
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'resolution', actorId: 'p2_warlock',
        public: { objectPushed: { from: { x: 4, y: 5 }, to: { x: 5, y: 5 }, type: 'oil-cask' } },
      } as never,
    });
    const obstacles = s.getSnapshot().scene!.obstacles;
    expect(obstacles.find((o) => o.type === 'oil-cask')).toMatchObject({ x: 5, y: 5 });
    expect(obstacles.some((o) => o.x === 4 && o.y === 5)).toBe(false); // nothing left behind
    expect(obstacles.find((o) => o.type === 'stalagmite')).toMatchObject({ x: 6, y: 5 }); // untouched
  });

  // An EXPLOSION resolution (carries `blast`) must DEFER its obstacle removal:
  // the store leaves the cask AND the demolished stalagmites standing, so the
  // Board can remove them in sync with the fireball (markDestroyed) rather than
  // the instant the resolution arrives — otherwise the wall vanishes before the
  // boom, especially for a ranged detonation delayed by projectile flight.
  it('an explosion resolution does NOT remove obstacles immediately (deferred to the Board)', () => {
    const s = createStore();
    s.applyEnvelope(snapWithCask());
    s.applyEnvelope({
      kind: 'event',
      event: {
        type: 'resolution', actorId: 'p2_warlock',
        public: {
          success: true, targetKind: 'obstacle', pos: { x: 5, y: 5 },
          obstacleDestroyed: { x: 5, y: 5 },
          blast: { pos: { x: 5, y: 5 }, radius: 1, victimIds: [],
                   demolished: [{ x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 }] },
        },
      } as never,
    });
    // Nothing destroyed yet — the cask + stalagmites still stand until the Board lands the blast.
    expect(s.getSnapshot().scene!.destroyedObstacles).toEqual([]);
  });

  // markDestroyed is the Board's hook to remove the cleared cells when the
  // fireball lands. Regression for run 2026-06-01T11-29-11 (stalagmites stayed).
  it('markDestroyed appends the cask + demolished cells (deduped)', () => {
    const s = createStore();
    s.applyEnvelope(snapWithCask());
    s.markDestroyed([{ x: 5, y: 5 }, { x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 }]);
    expect(s.getSnapshot().scene!.destroyedObstacles).toEqual([
      { x: 5, y: 5 }, { x: 6, y: 4 }, { x: 6, y: 5 }, { x: 6, y: 6 },
    ]);
    // Idempotent — re-marking the same cells adds nothing.
    s.markDestroyed([{ x: 6, y: 5 }]);
    expect(s.getSnapshot().scene!.destroyedObstacles).toHaveLength(4);
  });
});

describe('store queued — session-cap wait line', () => {
  it('records the queue standing and updates it as the line moves', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'queued', position: 2, capacity: 3 });
    expect(s.getSnapshot().queued).toEqual({ position: 2, capacity: 3 });

    s.applyEnvelope({ kind: 'queued', position: 1, capacity: 3 });
    expect(s.getSnapshot().queued).toEqual({ position: 1, capacity: 3 });
  });

  it('the attach snapshot (session admitted) clears the queued state', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'queued', position: 1, capacity: 3 });
    s.applyEnvelope(initialSnapshot());
    expect(s.getSnapshot().queued).toBeNull();
  });
});

describe('store rejected: session_gone — the tab\'s game no longer exists', () => {
  it('sets sessionGone and clears any stale queue standing', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'queued', position: 1, capacity: 3 });
    s.applyEnvelope({ kind: 'rejected', reason: 'session_gone' });
    expect(s.getSnapshot().sessionGone).toBe(true);
    expect(s.getSnapshot().queued).toBeNull();
  });

  it('other rejected reasons leave state untouched', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'rejected', reason: 'not_your_turn' });
    expect(s.getSnapshot().sessionGone).toBe(false);
  });

  it('an attach snapshot (fresh claim after reload) clears it', () => {
    const s = createStore();
    s.applyEnvelope({ kind: 'rejected', reason: 'session_gone' });
    s.applyEnvelope(initialSnapshot());
    expect(s.getSnapshot().sessionGone).toBe(false);
  });
});

describe('store thinking_delta — live streamed thought text', () => {
  it('accumulates deltas per actor, resets on a fresh thinking, clears on thinking_done', () => {
    const s = createStore();
    s.applyEnvelope(initialSnapshot());
    s.applyEnvelope({ kind: 'thinking', actorId: 'p1' as never });
    s.applyEnvelope({ kind: 'thinking_delta', actorId: 'p1' as never, text: 'flank ' });
    s.applyEnvelope({ kind: 'thinking_delta', actorId: 'p1' as never, text: 'the rat' });
    expect(s.getSnapshot().thinkingText.get('p1' as never)).toBe('flank the rat');

    // A fresh LLM call for the same actor resets its streamed text.
    s.applyEnvelope({ kind: 'thinking', actorId: 'p1' as never });
    expect(s.getSnapshot().thinkingText.get('p1' as never)).toBeUndefined();

    s.applyEnvelope({ kind: 'thinking_delta', actorId: 'p1' as never, text: 'retreat' });
    s.applyEnvelope({ kind: 'thinking_done', actorId: 'p1' as never });
    expect(s.getSnapshot().thinkingText.has('p1' as never)).toBe(false);
  });
});
