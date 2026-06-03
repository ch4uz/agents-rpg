// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import { matchQueueItems, type QueueItem } from '../../web/components/Layout.js';
import { selectEventLog } from '../../web/components/EventLog.js';
import {
  initiativePanel,
  initiativeSummaryAt,
} from '../../web/components/InitiativePanel.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const hero = (id: string, name: string, archetype = 'warrior', dex = 0): RedactedCharacter => ({
  id: id as never, name, kind: 'hero', archetype, dex,
  pos: { x: 0, y: 0 }, health: { total: 3, damage: 0, status: 'normal' },
  pools: { melee: 2, ranged: 0, magic: 0, armor: 1 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});
const monster = (id: string, name = 'giant-rat', dex = 0): RedactedCharacter => ({
  id: id as never, name, kind: 'monster', sprite: name, dex,
  pos: { x: 1, y: 1 }, health: { total: 1, damage: 0, status: 'normal' },
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  inventory: [], boons: [],
  normalAttack: { kind: 'melee', range: 1 },
  specialAction: { name: '', description: '' },
  bonusAbility: { name: '', description: '' },
});

const heroes = [hero('h1', 'Bran'), hero('h2', 'Anwen', 'healer', 1)];
const monsters = [monster('r1', 'giant-rat', 1), monster('r2', 'giant-rat', 1)];
const cast = [...heroes, ...monsters];

/** Build the engine's combat_started event payload with d6/dex/total + order. */
const combatStartedEvent = (
  heroRolls: Record<string, { d6: number; dex: number }>,
  monsterRolls: Record<string, { d6: number; dex: number }>,
  t = 1,
): { event: unknown } => {
  const heroFull: Record<string, { d6: number; dex: number; total: number }> = {};
  const monsterFull: Record<string, { d6: number; dex: number; total: number }> = {};
  for (const [id, r] of Object.entries(heroRolls)) heroFull[id] = { ...r, total: r.d6 + r.dex };
  for (const [id, r] of Object.entries(monsterRolls)) monsterFull[id] = { ...r, total: r.d6 + r.dex };
  // Build engine-style order: total desc, heroes break ties.
  type Entry = { id: string; kind: 'hero' | 'monster'; total: number };
  const entries: Entry[] = [
    ...Object.entries(heroFull).map(([id, r]) => ({ id, kind: 'hero' as const, total: r.total })),
    ...Object.entries(monsterFull).map(([id, r]) => ({ id, kind: 'monster' as const, total: r.total })),
  ];
  entries.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.kind !== b.kind) return a.kind === 'hero' ? -1 : 1;
    return 0;
  });
  return {
    event: {
      type: 'combat_started',
      heroSide: Object.keys(heroRolls),
      monsterSide: Object.keys(monsterRolls),
      order: entries.map((e) => e.id),
      rolls: { hero: heroFull, monster: monsterFull },
      t,
    },
  };
};

describe('initiativeSummaryAt', () => {
  it('builds a per-character summary with d6/dex/total for each roll', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 5, dex: 0 }, h2: { d6: 3, dex: 1 } },
      { r1: { d6: 4, dex: 1 }, r2: { d6: 2, dex: 1 } },
      7,
    )];

    const summary = initiativeSummaryAt(chat, 0, cast);
    expect(summary).not.toBeNull();
    expect(summary!.heroes.map((h) => h.characterId).sort()).toEqual(['h1', 'h2']);
    expect(summary!.monsters.map((m) => m.characterId).sort()).toEqual(['r1', 'r2']);
    expect(summary!.t).toBe(7);

    const bran = summary!.heroes.find((h) => h.characterId === 'h1')!;
    expect(bran.name).toBe('Bran');
    expect(bran.archetype).toBe('warrior');
    expect(bran.d6).toBe(5);
    expect(bran.dex).toBe(0);
    expect(bran.total).toBe(5);

    const anwen = summary!.heroes.find((h) => h.characterId === 'h2')!;
    expect(anwen.d6).toBe(3);
    expect(anwen.dex).toBe(1);
    expect(anwen.total).toBe(4);
  });

  it('sorts each side by total descending (best roll first per side)', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 2, dex: 0 }, h2: { d6: 5, dex: 1 } }, // totals: 2, 6 → h2 first
      { r1: { d6: 4, dex: 1 }, r2: { d6: 1, dex: 0 } }, // totals: 5, 1 → r1 first
    )];
    const s = initiativeSummaryAt(chat, 0, cast)!;
    expect(s.heroes.map((h) => h.characterId)).toEqual(['h2', 'h1']);
    expect(s.monsters.map((m) => m.characterId)).toEqual(['r1', 'r2']);
  });

  it('builds a combined per-character turn order interleaving sides by total', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 2, dex: 0 } },                    // total 2
      { r1: { d6: 4, dex: 0 }, r2: { d6: 6, dex: 1 } }, // totals 4, 7
    )];
    const s = initiativeSummaryAt(chat, 0, cast)!;
    expect(s.order.map((e) => e.characterId)).toEqual(['r2', 'r1', 'h1']);
  });

  it('heroes break ties on equal totals', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 4, dex: 0 } }, // 4
      { r1: { d6: 4, dex: 0 } }, // 4 — tie → hero first
    )];
    const s = initiativeSummaryAt(chat, 0, cast)!;
    expect(s.order.map((e) => e.characterId)).toEqual(['h1', 'r1']);
  });

  it('returns null for non-combat events and malformed payloads', () => {
    expect(initiativeSummaryAt([{ event: { type: 'narrate', text: 'x', t: 1 } }], 0, cast)).toBeNull();
    expect(initiativeSummaryAt(
      [{ event: { type: 'combat_started', heroSide: ['h1'], monsterSide: ['r1'], t: 1 } }],
      0,
      cast,
    )).toBeNull();
  });
});

describe('matchQueueItems returns initiative queue items', () => {
  it('emits an initiative queue item with the full per-character summary', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 5, dex: 0 }, h2: { d6: 3, dex: 1 } },
      { r1: { d6: 4, dex: 1 } },
      9,
    )];
    const items: QueueItem[] = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('initiative');
    if (items[0]!.kind === 'initiative') {
      expect(items[0]!.summary.heroes).toHaveLength(2);
      expect(items[0]!.summary.monsters).toHaveLength(1);
      // Combined order populated: h1 (5), r1 (5), h2 (4) — heroes win ties.
      expect(items[0]!.summary.order.map((e) => e.characterId)).toEqual(['h1', 'r1', 'h2']);
    }
  });
});

describe('initiativePanel rendering', () => {
  const renderToText = (summary: ReturnType<typeof initiativeSummaryAt>): string => {
    const div = document.createElement('div');
    render(initiativePanel(summary), div);
    return div.textContent ?? '';
  };
  const renderToHtml = (summary: ReturnType<typeof initiativeSummaryAt>): string => {
    const div = document.createElement('div');
    render(initiativePanel(summary), div);
    return div.innerHTML;
  };

  const summary = initiativeSummaryAt([combatStartedEvent(
    { h1: { d6: 5, dex: 0 }, h2: { d6: 3, dex: 1 } },
    { r1: { d6: 4, dex: 1 }, r2: { d6: 2, dex: 1 } },
  )], 0, cast);

  it('renders every character name and d6 value', () => {
    const text = renderToText(summary);
    expect(text).toContain('Bran');
    expect(text).toContain('Anwen');
    // d6 values: 5, 3, 4, 2
    expect(text).toContain('5');
    expect(text).toContain('3');
    expect(text).toContain('4');
    expect(text).toContain('2');
  });

  it('shows the dex modifier inline for non-zero dex', () => {
    const text = renderToText(summary);
    // Anwen +1, Rat1 +1, Rat2 +1 all show their modifier
    expect(text).toContain('+1');
    // h2 total = 3 + 1 = 4; r1 total = 4 + 1 = 5; r2 total = 2 + 1 = 3
    expect(text).toContain('= 4');
    expect(text).toContain('= 5');
  });

  it('does NOT include any "acts first" / "goes first" verdict line', () => {
    const text = renderToText(summary).toLowerCase();
    expect(text).not.toContain('acts first');
    expect(text).not.toContain('act first');
    expect(text).not.toContain('goes first');
    expect(text).not.toContain('go first');
  });

  it('does NOT include a "VS" / "Versus" divider between sides', () => {
    const text = renderToText(summary);
    const html = renderToHtml(summary);
    // No visible "VS" text in the panel.
    expect(text).not.toContain('VS');
    expect(text.toLowerCase()).not.toContain('versus');
    // And no DOM hook for the old divider element.
    expect(html).not.toContain('roll-vs');
  });

  it('does NOT render the combined turn order chain', () => {
    const html = renderToHtml(summary);
    expect(html).not.toContain('initiative-order-chip');
    expect(html).not.toContain('initiative-order-arrow');
    expect(html).not.toContain('class="initiative-order"');
  });

  it('does NOT highlight any top die', () => {
    const html = renderToHtml(summary);
    expect(html).not.toContain('roll-die--top');
  });

  it('returns empty template when summary is null', () => {
    const div = document.createElement('div');
    render(initiativePanel(null), div);
    expect(div.textContent ?? '').toBe('');
  });
});

describe('matchQueueItems emits DM narration as a single beat', () => {
  it('keeps multi-line narration as one queue item with line breaks preserved', () => {
    const chat = [
      {
        event: {
          type: 'narrate',
          actorId: 'dm',
          text: 'Rats scuttle in the shadows.\nThe air smells of damp stone.\nA torch flickers.',
          t: 1,
        },
      },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe(
      'Rats scuttle in the shadows.\nThe air smells of damp stone.\nA torch flickers.',
    );
  });

  it('trims outer whitespace but preserves internal blank lines', () => {
    const chat = [
      {
        event: {
          type: 'action',
          actorId: 'dm',
          action: { kind: 'narrate', text: '\n\n  First.  \n\n\nSecond.\n' },
          t: 1,
        },
      },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe('First.  \n\n\nSecond.');
  });

  it('keeps a single-paragraph narration as one item', () => {
    const chat = [
      { event: { type: 'narrate', actorId: 'dm', text: 'A whisper.', t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe('A whisper.');
  });
});

describe('matchQueueItems hero-speech portrait crop', () => {
  it('flags a monster say with isMonster (full-sprite crop, not the humanoid head-crop)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'r1', action: { kind: 'say', text: 'Screee!' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'hero-speech' });
    expect((items[0] as { speech: { isMonster?: boolean } }).speech.isMonster).toBe(true);
  });

  it('does NOT flag a hero say as isMonster', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'For the party!' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect((items[0] as { speech: { isMonster?: boolean } }).speech.isMonster).toBeUndefined();
  });
});

describe('matchQueueItems monster-say narration fallback', () => {
  // A monster `say` is rendered as that foe's first-person speech bubble. When
  // the DM writes the reaction as third-person narration about the creature
  // ("The giant rat squeaks…"), it reads wrong attributed to the monster as the
  // speaker — so it falls back to a DM-narration caption instead of a bubble.
  it('reclassifies a third-person "The <monster>…" say as a narration beat', () => {
    const chat = [
      { event: { type: 'action', actorId: 'r1', action: { kind: 'say', text: 'The giant rat squeaks and licks its whiskers!' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'narration', text: 'The giant rat squeaks and licks its whiskers!' });
  });

  it('keeps a first-person monster utterance as a speech bubble', () => {
    const chat = [
      { event: { type: 'action', actorId: 'r1', action: { kind: 'say', text: 'Screee! Your warlock falls!' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'hero-speech' });
    expect((items[0] as { speech: { isMonster?: boolean } }).speech.isMonster).toBe(true);
  });

  it('does not apply the narration fallback to a hero say that opens with "The"', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'say', text: 'The door is barred — we hold here!' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'hero-speech' });
  });
});

describe('matchQueueItems sequences emote reactions as queue beats', () => {
  it('produces an emote queue item for a non-DM emote (board balloon spawns in dialogue order)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'emote', emoji: '😱' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'emote', actorId: 'h1', emoji: '😱' });
  });

  it('reacts for a monster emote too (DM voices a foe off-turn)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'm1', action: { kind: 'emote', emoji: '😾' }, t: 1 } },
    ];
    const items = matchQueueItems(chat, 0, cast);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'emote', actorId: 'm1', emoji: '😾' });
  });

  it('ignores a DM emote (the DM has no board token to anchor a balloon)', () => {
    const chat = [
      { event: { type: 'action', actorId: 'dm', action: { kind: 'emote', emoji: '🎲' }, t: 1 } },
    ];
    expect(matchQueueItems(chat, 0, cast)).toHaveLength(0);
  });

  it('ignores an empty emoji', () => {
    const chat = [
      { event: { type: 'action', actorId: 'h1', action: { kind: 'emote', emoji: '' }, t: 1 } },
    ];
    expect(matchQueueItems(chat, 0, cast)).toHaveLength(0);
  });
});

describe('event log drawer surfaces per-character initiative', () => {
  it('emits one initiative entry per combat_started carrying the combined turn order', () => {
    const chat = [combatStartedEvent(
      { h1: { d6: 5, dex: 0 }, h2: { d6: 3, dex: 1 } },
      { r1: { d6: 4, dex: 1 }, r2: { d6: 2, dex: 1 } },
    )];
    const entries = selectEventLog(chat, cast);
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe('initiative');
    if (entries[0]!.kind === 'initiative') {
      // Order: h1(5), r1(5), h2(4), r2(3) — heroes win ties.
      expect(entries[0]!.order.map((r) => r.characterId)).toEqual(['h1', 'r1', 'h2', 'r2']);
      expect(entries[0]!.order.map((r) => r.total)).toEqual([5, 5, 4, 3]);
    }
  });
});
