import { describe, it, expect } from 'vitest';
import { filter } from '../../src/runtime/visibility/filter.js';
import type { Viewer } from '../../src/runtime/visibility/types.js';
import type { Event } from '../../src/log/events.js';
import { asCharacterId } from '../../src/engine/ids.js';

describe('visibility filter', () => {
  it('thought is visible only to self and to revealing researchers', () => {
    const ev = { t: 1, type: 'thought', actorId: asCharacterId('p1'), text: 'plan' } as Event;

    expect(filter(ev, { kind: 'self', actorId: asCharacterId('p1') })).toEqual(ev);
    expect(filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') })).toBeNull();
    expect(filter(ev, { kind: 'human' })).toBeNull();
    expect(filter(ev, { kind: 'dm' })).toBeNull();
    expect(filter(ev, { kind: 'researcher', revealThoughts: true })).toEqual(ev);
    expect(filter(ev, { kind: 'researcher', revealThoughts: false })).toBeNull();
  });

  it('say is visible to everyone', () => {
    const ev = { t: 1, type: 'action', actorId: asCharacterId('p1'),
      action: { kind: 'say', text: 'flank!' } } as Event;
    const viewers: Viewer[] = [
      { kind: 'self', actorId: asCharacterId('p1') },
      { kind: 'other_player', actorId: asCharacterId('p2') },
      { kind: 'dm' },
      { kind: 'human' },
      { kind: 'researcher', revealThoughts: false },
    ];
    for (const v of viewers) expect(filter(ev, v)).toEqual(ev);
  });

  it('resolution strips private dice rolls for non-self viewers', () => {
    const ev = {
      t: 1,
      type: 'resolution',
      actorId: asCharacterId('p1'),
      public: { hit: true, damage: 1 },
      private: { attackRoll: [5, 3], armorRoll: [4] },
    } as Event;

    const self = filter(ev, { kind: 'self', actorId: asCharacterId('p1') });
    expect(self).not.toBeNull();
    expect(self!).toHaveProperty('private');

    const other = filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') });
    expect(other).not.toBeNull();
    expect(other && 'private' in other).toBe(false);

    const human = filter(ev, { kind: 'human' });
    expect(human && 'private' in human).toBe(false);

    const researcher = filter(ev, { kind: 'researcher', revealThoughts: false });
    expect(researcher && 'private' in researcher).toBe(true);
  });

  it('rule_violation is visible only to the offender and researchers', () => {
    const ev = {
      t: 1,
      type: 'rule_violation',
      actorId: asCharacterId('p1'),
      violation: { reason: 'out-of-range' },
    } as Event;

    expect(filter(ev, { kind: 'self', actorId: asCharacterId('p1') })).toEqual(ev);
    expect(filter(ev, { kind: 'other_player', actorId: asCharacterId('p2') })).toBeNull();
    expect(filter(ev, { kind: 'human' })).toBeNull();
    expect(filter(ev, { kind: 'dm' })).toBeNull();
    expect(filter(ev, { kind: 'researcher', revealThoughts: false })).toEqual(ev);
  });

  it('action, narrate, state_change, request_action, combat events pass through to all viewers', () => {
    const events: Event[] = [
      { t: 1, type: 'action', actorId: asCharacterId('p1'), action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } } as Event,
      { t: 2, type: 'narrate', actorId: 'dm', text: 'A door creaks open.' } as Event,
      { t: 3, type: 'state_change', changes: [{ id: asCharacterId('p1'), pos: { x: 2, y: 1 } }] } as Event,
      { t: 4, type: 'request_action', actorId: 'dm', targetId: asCharacterId('p1') } as Event,
      {
        t: 5,
        type: 'combat_started',
        heroSide: [asCharacterId('p1')],
        monsterSide: [asCharacterId('m1')],
        order: [asCharacterId('p1'), asCharacterId('m1')],
        rolls: {
          hero: { p1: { d6: 4, dex: 0, total: 4 } },
          monster: { m1: { d6: 3, dex: 0, total: 3 } },
        },
      } as Event,
      { t: 6, type: 'combat_ended' } as Event,
      { t: 7, type: 'rest_offered' } as Event,
      { t: 8, type: 'adventure_ended', outcome: 'success' } as Event,
      { t: 9, type: 'scene_enter', sceneId: 'stub-cell' as never } as Event,
      { t: 10, type: 'human_input', actorId: asCharacterId('h1'), text: 'I rush in' } as Event,
      { t: 11, type: 'step_budget_exhausted', actorId: asCharacterId('p1'), forced: 'end_turn' } as Event,
    ];
    const v: Viewer = { kind: 'human' };
    for (const ev of events) expect(filter(ev, v)).toEqual(ev);
  });

  describe('OOC events (player_ooc_query / dm_ooc_reply)', () => {
    it('player_ooc_query is visible to: asking player, DM, human, researcher — NOT other players', () => {
      const ev = {
        t: 1, type: 'player_ooc_query',
        actorId: asCharacterId('h1'), text: 'Can I see the door?',
      } as Event;

      expect(filter(ev, { kind: 'self',          actorId: asCharacterId('h1') })).toEqual(ev);
      expect(filter(ev, { kind: 'self',          actorId: 'dm' })).toEqual(ev);
      expect(filter(ev, { kind: 'dm' })).toEqual(ev);
      expect(filter(ev, { kind: 'human' })).toEqual(ev);
      expect(filter(ev, { kind: 'researcher',    revealThoughts: false })).toEqual(ev);

      // Other AI party-mates must NOT see OOC chatter — it would pollute
      // their decision context.
      expect(filter(ev, { kind: 'other_player',  actorId: asCharacterId('p2') })).toBeNull();
      expect(filter(ev, { kind: 'self',          actorId: asCharacterId('p2') })).toBeNull();
    });

    it('dm_ooc_reply is visible to: addressed player, DM, human, researcher — NOT other players', () => {
      const ev = {
        t: 2, type: 'dm_ooc_reply',
        toActorId: asCharacterId('h1'), text: 'Yes, it is 3 squares to the north.',
      } as Event;

      expect(filter(ev, { kind: 'self',          actorId: asCharacterId('h1') })).toEqual(ev);
      expect(filter(ev, { kind: 'self',          actorId: 'dm' })).toEqual(ev);
      expect(filter(ev, { kind: 'dm' })).toEqual(ev);
      expect(filter(ev, { kind: 'human' })).toEqual(ev);
      expect(filter(ev, { kind: 'researcher',    revealThoughts: false })).toEqual(ev);

      expect(filter(ev, { kind: 'other_player',  actorId: asCharacterId('p2') })).toBeNull();
      expect(filter(ev, { kind: 'self',          actorId: asCharacterId('p2') })).toBeNull();
    });
  });
});
