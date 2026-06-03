// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import { selectEventLog, eventLog } from '../../web/components/EventLog.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const hero = (id: string, name: string, archetype = 'warrior'): RedactedCharacter => ({
  id: id as never, name, kind: 'hero', archetype,
  pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
  pools: { melee: 2, ranged: 0, magic: 0, armor: 1 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});

const monster = (id: string, name = 'giant-rat'): RedactedCharacter => ({
  id: id as never, name, kind: 'monster', sprite: name,
  pos: { x: 1, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});

describe('selectEventLog', () => {
  const heroes = [hero('h1', 'Bran', 'warrior'), hero('h2', 'Lyra', 'hunter')];
  const monsters = [monster('r1', 'giant-rat')];

  const say = (actorId: string, text: string, t: number) => ({
    event: { type: 'action', actorId, action: { kind: 'say', text }, t },
  });
  const resolution = (
    actorId: string,
    targetId: string,
    opts: { hit: boolean; damage: number; attackKind?: string; t: number },
  ) => ({
    event: {
      type: 'resolution',
      actorId,
      public: {
        hit: opts.hit,
        damage: opts.damage,
        targetId,
        attackerTop: 5,
        defenderTop: 3,
        ...(opts.attackKind !== undefined ? { attackKind: opts.attackKind } : {}),
      },
      t: opts.t,
    },
  });
  const attackAction = (actorId: string, targetId: string, t: number, kind = 'normal_attack') => ({
    event: { type: 'action', actorId, action: { kind, targetId }, t },
  });

  it('is empty when chat has no qualifying events', () => {
    expect(selectEventLog([], [...heroes, ...monsters])).toEqual([]);
    expect(selectEventLog([
      { event: { type: 'state_change', changes: [{ id: 'h1', damage: 0 }], t: 1 } },
      { event: { type: 'action', actorId: 'h1', action: { kind: 'move', to: { x: 0, y: 0 } }, t: 2 } },
    ], [...heroes, ...monsters])).toEqual([]);
  });

  it('interleaves hero say lines with DM narration entries in chronological order', () => {
    const chat = [
      say('h1', 'first', 1),
      { event: { type: 'narrate', actorId: 'dm', text: 'mid', t: 2 } },
      say('h2', 'second', 3),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries.map((e) => e.kind)).toEqual(['say', 'narrate', 'say']);
    expect(entries[0]).toMatchObject({
      kind: 'say', actorId: 'h1', text: 'first',
      avatar: { kind: 'hero', archetype: 'warrior' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'narrate', text: 'mid', avatar: { kind: 'dm' },
    });
  });

  it('skips DM and monster say (only hero dialogue lands in the log)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'dm', action: { kind: 'say', text: 'A voice booms.' }, t: 1 } },
      { event: { type: 'action', actorId: 'r1', action: { kind: 'say', text: 'Squeak!' }, t: 2 } },
      say('h1', 'real', 3),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries).toHaveLength(1);
    const only = entries[0]!;
    expect(only.kind).toBe('say');
    if (only.kind === 'say') expect(only.actorId).toBe('h1');
  });

  it('emits attack entries from resolution events with hit/damage', () => {
    const chat = [
      attackAction('h1', 'r1', 1),
      resolution('h1', 'r1', { hit: true, damage: 2, attackKind: 'melee', t: 2 }),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'attack',
      actorId: 'h1',
      actorName: 'Bran',
      targetName: 'Giant Rat',
      hit: true,
      damage: 2,
      attackKind: 'melee',
      avatar: { kind: 'hero', archetype: 'warrior' },
    });
  });

  it('includes miss resolutions', () => {
    const chat = [
      attackAction('h2', 'r1', 1),
      resolution('h2', 'r1', { hit: false, damage: 0, attackKind: 'ranged', t: 2 }),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'attack', hit: false, damage: 0, attackKind: 'ranged',
    });
  });

  it('tags special_action resolutions with attackKind=special', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'special_action', targetIds: ['r1'] }, t: 1 } },
      resolution('h1', 'r1', { hit: true, damage: 3, t: 2 }),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries[0]).toMatchObject({ kind: 'attack', attackKind: 'special' });
  });

  it('includes monster-on-hero attacks too', () => {
    const chat = [
      attackAction('r1', 'h1', 1),
      resolution('r1', 'h1', { hit: true, damage: 1, attackKind: 'melee', t: 2 }),
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'attack',
      actorName: 'Giant Rat',
      targetName: 'Bran',
      hit: true,
      damage: 1,
      avatar: { kind: 'monster', sprite: 'giant-rat' },
    });
  });

  it('preserves chronological order across mixed say + attack events', () => {
    const chat = [
      say('h1', 'For glory!', 1),
      attackAction('h1', 'r1', 2),
      resolution('h1', 'r1', { hit: true, damage: 2, attackKind: 'melee', t: 3 }),
      say('h2', 'I shoot!', 4),
      attackAction('r1', 'h2', 5),
      resolution('r1', 'h2', { hit: false, damage: 0, t: 6 }),
    ];
    const kinds = selectEventLog(chat, [...heroes, ...monsters]).map((e) => e.kind);
    expect(kinds).toEqual(['say', 'attack', 'say', 'attack']);
  });

  it('emits emote entries for hero emote actions, skips non-heroes', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'emote', emoji: '🙀' }, t: 1 } },
      { event: { type: 'action', actorId: 'r1', action: { kind: 'emote', emoji: '😤' }, t: 2 } },
      { event: { type: 'action', actorId: 'h2', action: { kind: 'emote', emoji: '' },    t: 3 } },
    ];
    const entries = selectEventLog(chat, [...heroes, ...monsters]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'emote',
      actorId: 'h1',
      actorName: 'Bran',
      emoji: '🙀',
      avatar: { kind: 'hero', archetype: 'warrior' },
    });
  });

  it('skips resolutions for unknown actors or targets', () => {
    const chat = [
      resolution('ghost', 'r1', { hit: true, damage: 1, t: 1 }),
      resolution('h1', 'phantom', { hit: true, damage: 1, t: 2 }),
    ];
    expect(selectEventLog(chat, [...heroes, ...monsters])).toEqual([]);
  });
});

describe('eventLog render', () => {
  const heroes = [hero('h1', 'Bran', 'warrior'), hero('h2', 'Lyra', 'hunter')];
  const monsters = [monster('r1', 'giant-rat')];

  it('renders an empty-state hint when there are no entries', () => {
    const div = document.createElement('div');
    render(eventLog([]), div);
    expect(div.querySelector('.event-log-empty')).not.toBeNull();
    expect(div.querySelectorAll('.event-line')).toHaveLength(0);
  });

  it('renders one .event-line per entry with avatar + body', () => {
    const entries = selectEventLog([
      { event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'For glory!' }, t: 1 } },
      { event: { type: 'action', actorId: 'h1', action: { kind: 'normal_attack', targetId: 'r1' }, t: 2 } },
      { event: {
        type: 'resolution', actorId: 'h1',
        public: { hit: true, damage: 1, targetId: 'r1', attackKind: 'melee', attackerTop: 5, defenderTop: 2 },
        t: 3,
      } },
    ], [...heroes, ...monsters]);
    const div = document.createElement('div');
    render(eventLog(entries), div);
    const lines = div.querySelectorAll('.event-line');
    expect(lines).toHaveLength(2);

    const sayLine = lines[0]!;
    expect(sayLine.classList.contains('event-line--say')).toBe(true);
    const sayAvatar = sayLine.querySelector('.event-avatar') as HTMLElement;
    expect(sayAvatar.getAttribute('style')).toMatch(/heroes\/warrior\/south\.png/);
    expect(sayLine.querySelector('.event-actor')!.textContent).toBe('Bran');
    expect(sayLine.querySelector('.event-quote')!.textContent).toBe('For glory!');

    const atkLine = lines[1]!;
    expect(atkLine.classList.contains('event-line--attack')).toBe(true);
    expect(atkLine.querySelector('.event-actor')!.textContent).toBe('Bran');
    expect(atkLine.querySelector('.event-target')!.textContent).toBe('Giant Rat');
    expect(atkLine.querySelector('.event-damage')).not.toBeNull();
    expect(atkLine.querySelector('.event-damage')!.textContent).toMatch(/1.*damage/);
  });

  it('renders a miss verdict when the attack missed', () => {
    const entries = selectEventLog([
      { event: { type: 'action', actorId: 'h2', action: { kind: 'normal_attack', targetId: 'r1' }, t: 1 } },
      { event: {
        type: 'resolution', actorId: 'h2',
        public: { hit: false, damage: 0, targetId: 'r1', attackKind: 'ranged', attackerTop: 1, defenderTop: 5 },
        t: 2,
      } },
    ], [...heroes, ...monsters]);
    const div = document.createElement('div');
    render(eventLog(entries), div);
    const line = div.querySelector('.event-line')!;
    expect(line.querySelector('.event-miss')).not.toBeNull();
    expect(line.querySelector('.event-damage')).toBeNull();
  });

  it('uses the monster avatar path for monster attackers', () => {
    const entries = selectEventLog([
      { event: { type: 'action', actorId: 'r1', action: { kind: 'normal_attack', targetId: 'h1' }, t: 1 } },
      { event: {
        type: 'resolution', actorId: 'r1',
        public: { hit: true, damage: 1, targetId: 'h1', attackKind: 'melee', attackerTop: 4, defenderTop: 2 },
        t: 2,
      } },
    ], [...heroes, ...monsters]);
    const div = document.createElement('div');
    render(eventLog(entries), div);
    const avatar = div.querySelector('.event-avatar') as HTMLElement;
    expect(avatar.getAttribute('style')).toMatch(/monsters\/giant-rat\/south\.png/);
    expect(avatar.classList.contains('event-avatar-monster')).toBe(true);
  });
});
