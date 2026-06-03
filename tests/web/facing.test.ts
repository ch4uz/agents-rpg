import { describe, it, expect } from 'vitest';
import {
  facingFromDelta,
  facingFromMovePath,
  facingFromAttack,
  facingChangeFromEvent,
  DEFAULT_FACING,
} from '../../web/components/Facing.js';

describe('Facing.facingFromDelta', () => {
  it('returns null for zero delta', () => {
    expect(facingFromDelta(0, 0)).toBeNull();
  });
  it('east for +x dominant', () => {
    expect(facingFromDelta(3, 1)).toBe('east');
    expect(facingFromDelta(1, 0)).toBe('east');
  });
  it('west for -x dominant', () => {
    expect(facingFromDelta(-3, 1)).toBe('west');
    expect(facingFromDelta(-1, 0)).toBe('west');
  });
  it('south for +y dominant', () => {
    expect(facingFromDelta(0, 3)).toBe('south');
    expect(facingFromDelta(-1, 2)).toBe('south');
  });
  it('north for -y dominant', () => {
    expect(facingFromDelta(0, -1)).toBe('north');
    expect(facingFromDelta(1, -2)).toBe('north');
  });
  it('ties (|dx| == |dy|) prefer horizontal — easier-to-read profile sprites', () => {
    expect(facingFromDelta(2, 2)).toBe('east');
    expect(facingFromDelta(-2, 2)).toBe('west');
    expect(facingFromDelta(2, -2)).toBe('east');
  });
});

describe('Facing.facingFromMovePath', () => {
  it('returns null for paths shorter than 2 points', () => {
    expect(facingFromMovePath([])).toBeNull();
    expect(facingFromMovePath([{ x: 0, y: 0 }])).toBeNull();
  });
  it('uses the last step of the path', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    // Last step: (1,0) → (1,1) = +y dominant.
    expect(facingFromMovePath(path)).toBe('south');
  });
  it('returns null when path tail is a no-op', () => {
    expect(facingFromMovePath([{ x: 2, y: 2 }, { x: 2, y: 2 }])).toBeNull();
  });
});

describe('Facing.facingFromAttack', () => {
  it('returns null when either position is missing', () => {
    expect(facingFromAttack(null, { x: 1, y: 1 })).toBeNull();
    expect(facingFromAttack({ x: 1, y: 1 }, null)).toBeNull();
  });
  it('east when target is to the right', () => {
    expect(facingFromAttack({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe('east');
  });
  it('north when target is above', () => {
    expect(facingFromAttack({ x: 0, y: 5 }, { x: 0, y: 0 })).toBe('north');
  });
});

describe('Facing.facingChangeFromEvent', () => {
  const posLookup = (positions: Record<string, { x: number; y: number }>) =>
    (id: string) => positions[id] ?? null;

  it('extracts facing from a move action', () => {
    const event = {
      type: 'action',
      actorId: 'hero-1',
      action: {
        kind: 'move',
        path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
      },
    };
    expect(facingChangeFromEvent(event, posLookup({}))).toEqual({
      actorId: 'hero-1',
      facing: 'east',
    });
  });

  it('extracts facing from a resolution event (attacker → target)', () => {
    const event = {
      type: 'resolution',
      actorId: 'hero-1',
      public: { targetId: 'rat-1', hit: true },
    };
    const positions = { 'hero-1': { x: 0, y: 0 }, 'rat-1': { x: 0, y: 4 } };
    expect(facingChangeFromEvent(event, posLookup(positions))).toEqual({
      actorId: 'hero-1',
      facing: 'south',
    });
  });

  it('extracts facing from a normal_attack action', () => {
    const event = {
      type: 'action',
      actorId: 'hero-1',
      action: { kind: 'normal_attack', targetId: 'rat-1' },
    };
    const positions = { 'hero-1': { x: 2, y: 2 }, 'rat-1': { x: 0, y: 2 } };
    expect(facingChangeFromEvent(event, posLookup(positions))).toEqual({
      actorId: 'hero-1',
      facing: 'west',
    });
  });

  it('extracts facing from a special_action with targetIds', () => {
    const event = {
      type: 'action',
      actorId: 'h1',
      action: { kind: 'special_action', targetIds: ['t1'] },
    };
    const positions = { h1: { x: 0, y: 0 }, t1: { x: 3, y: 0 } };
    expect(facingChangeFromEvent(event, posLookup(positions))).toEqual({
      actorId: 'h1',
      facing: 'east',
    });
  });

  it('extracts facing from an attack_object action', () => {
    const event = {
      type: 'action',
      actorId: 'h1',
      action: { kind: 'attack_object', pos: { x: 0, y: 5 } },
    };
    const positions = { h1: { x: 0, y: 0 } };
    expect(facingChangeFromEvent(event, posLookup(positions))).toEqual({
      actorId: 'h1',
      facing: 'south',
    });
  });

  it('returns null for non-spatial events (say, narrate, end_turn)', () => {
    const sayEvent = {
      type: 'action',
      actorId: 'h1',
      action: { kind: 'say', text: 'hello' },
    };
    expect(facingChangeFromEvent(sayEvent, posLookup({}))).toBeNull();

    const narrateEvent = { type: 'narrate', actorId: 'dm' };
    expect(facingChangeFromEvent(narrateEvent, posLookup({}))).toBeNull();
  });

  it('returns null when position lookup fails for either side', () => {
    const event = {
      type: 'resolution',
      actorId: 'h1',
      public: { targetId: 'missing', hit: true },
    };
    expect(facingChangeFromEvent(event, posLookup({ h1: { x: 0, y: 0 } }))).toBeNull();
  });

  it('DEFAULT_FACING is south', () => {
    expect(DEFAULT_FACING).toBe('south');
  });
});
