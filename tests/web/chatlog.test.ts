// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { chatLog, type ActorMap, type ActorInfo } from '../../web/components/ChatLog.js';
import { render } from 'lit-html';

const renderToText = (
  entries: { event: unknown }[],
  actors: ActorMap = new Map<string, ActorInfo>(),
): string => {
  const div = document.createElement('div');
  render(chatLog(entries, actors), div);
  return div.textContent ?? '';
};

const renderToHtml = (
  entries: { event: unknown }[],
  actors: ActorMap,
): string => {
  const div = document.createElement('div');
  render(chatLog(entries, actors), div);
  return div.innerHTML;
};

describe('ChatLog formatter', () => {
  it('formats state_change with KO status', () => {
    const text = renderToText([{ event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'rat-1', damage: 1, status: 'KO' }],
    } }]);
    expect(text).toContain('rat-1');
    expect(text).toContain('KO');
    expect(text).not.toContain('"type"');  // no JSON dump
  });

  it('formats state_change with pos updates', () => {
    const text = renderToText([{ event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'h1', pos: { x: 3, y: 2 } }],
    } }]);
    expect(text).toContain('h1');
    expect(text).toContain('3');
    expect(text).toContain('2');
    expect(text).not.toContain('"type"');
  });

  it('formats skip_turn action', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'rat-1',
      action: { kind: 'skip_turn' }, t: 1,
    } }]);
    expect(text).toContain('rat-1');
    expect(text).toContain('skip');
    expect(text).not.toContain('"kind"');
  });

  it('hides end_turn action (structural, not narrative)', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'end_turn' }, t: 1,
    } }]);
    expect(text.trim()).toBe('');
  });

  it('formats reveal_monster action', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'dm',
      action: { kind: 'reveal_monster', monsterTypeId: 'giant-rat',
                characterId: 'giant-rat-1', pos: { x: 7, y: 1 } }, t: 1,
    } }]);
    expect(text).toContain('giant-rat');
    expect(text).not.toContain('"monsterTypeId"');
  });

  it('formats normal_attack action', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'normal_attack', targetId: 'rat-1' }, t: 1,
    } }]);
    expect(text).toContain('h1');
    expect(text).toContain('rat-1');
    expect(text).not.toContain('"kind"');
  });

  it('formats move action with path', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }, t: 1,
    } }]);
    expect(text).toContain('h1');
    expect(text).toContain('2');
    expect(text).not.toContain('"path"');
  });

  it('renders DM narrate text in the chat log (also shown in narrator window)', () => {
    const text = renderToText([{ event: {
      type: 'narrate', actorId: 'dm', text: 'The rats hiss.', t: 1,
    } }]);
    expect(text).toContain('The rats hiss.');
  });

  it('renders **bold** markdown inside DM narrate as <strong>', () => {
    const div = document.createElement('div');
    render(chatLog([{ event: {
      type: 'narrate', actorId: 'dm', text: 'The **king-rat** glares.', t: 1,
    } }], new Map()), div);
    expect(div.innerHTML).toMatch(/<strong>king-rat<\/strong>/);
    // Plain text reads naturally: no asterisks left behind.
    expect(div.textContent).toContain('The king-rat glares.');
    expect(div.textContent).not.toContain('**');
  });

  it('renders *italic* markdown inside hero say as <em>', () => {
    const div = document.createElement('div');
    render(chatLog([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'say', text: 'I move *very* quietly.' }, t: 1,
    } }], new Map()), div);
    expect(div.innerHTML).toMatch(/<em>very<\/em>/);
    expect(div.textContent).toContain('I move very quietly.');
  });

  it('renders markdown inside human_input', () => {
    const div = document.createElement('div');
    render(chatLog([{ event: {
      type: 'human_input', actorId: 'h1', text: 'I cast **fireball**!', t: 1,
    } }], new Map()), div);
    expect(div.innerHTML).toMatch(/<strong>fireball<\/strong>/);
  });

  it('escapes raw HTML in dialog text (no XSS)', () => {
    const div = document.createElement('div');
    render(chatLog([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'say', text: 'oops <script>x</script>' }, t: 1,
    } }], new Map()), div);
    expect(div.innerHTML).not.toContain('<script>');
    expect(div.textContent).toContain('oops <script>x</script>');
  });

  it('renders hero say text in the chat log (also floats over the map)', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'say', text: 'Hello!' }, t: 1,
    } }]);
    expect(text).toContain('Hello!');
  });

  it('formats scene_enter', () => {
    const text = renderToText([{ event: {
      type: 'scene_enter', sceneId: 'tavern-basement', t: 1,
    } }]);
    expect(text).toContain('tavern-basement');
    expect(text).not.toContain('"sceneId"');
  });

  it('hides request_action (structural DM prompt)', () => {
    const text = renderToText([{ event: {
      type: 'request_action', actorId: 'dm', targetId: 'h1', t: 1,
    } }]);
    expect(text.trim()).toBe('');
  });

  it('formats combat_started', () => {
    const text = renderToText([{ event: {
      type: 'combat_started',
      heroSide: ['h1', 'h2'],
      monsterSide: ['rat-1'],
      rolls: {
        hero: { h1: { d6: 5, dex: 0, total: 5 }, h2: { d6: 4, dex: 0, total: 4 } },
        monster: { 'rat-1': { d6: 3, dex: 0, total: 3 } },
      },
      order: ['h1', 'h2', 'rat-1'],
      t: 1,
    } }]);
    expect(text.toLowerCase()).toContain('combat');
    expect(text).not.toContain('"rolls"');
  });

  it('chat line for combat_started carries the rosters but no "first" verdict', () => {
    const actors: ActorMap = new Map<string, ActorInfo>([
      ['h1', { name: 'Bran', kind: 'hero' }],
      ['rat-1', { name: 'Giant Rat', kind: 'monster' }],
    ]);
    const text = renderToText([{ event: {
      type: 'combat_started',
      heroSide: ['h1'],
      monsterSide: ['rat-1'],
      rolls: {
        hero: { h1: { d6: 5, dex: 0, total: 5 } },
        monster: { 'rat-1': { d6: 3, dex: 0, total: 3 } },
      },
      order: ['h1', 'rat-1'],
      t: 1,
    } }], actors);
    expect(text.toLowerCase()).toContain('combat begins');
    expect(text).toContain('Bran');
    expect(text).toContain('Giant Rat');
    // No "X first" verdict in any form — the panel/drawer show it instead.
    expect(text.toLowerCase()).not.toContain('acts first');
    expect(text.toLowerCase()).not.toContain('goes first');
    expect(text.toLowerCase()).not.toContain('go first');
  });

  it('formats combat_ended', () => {
    const text = renderToText([{ event: { type: 'combat_ended', t: 1 } }]);
    expect(text.toLowerCase()).toContain('combat');
  });

  it('renders human_input text in the chat log (also floats over the map)', () => {
    const text = renderToText([{ event: {
      type: 'human_input', actorId: 'h1', text: 'I attack!', t: 1,
    } }]);
    expect(text).toContain('I attack!');
  });

  it('hides step_budget_exhausted (debug noise)', () => {
    const text = renderToText([{ event: {
      type: 'step_budget_exhausted', actorId: 'h1', forced: 'end_turn', t: 1,
    } }]);
    expect(text.trim()).toBe('');
  });

  it('formats adventure_ended', () => {
    const text = renderToText([{ event: {
      type: 'adventure_ended', outcome: 'success', t: 1,
    } }]);
    expect(text).toContain('success');
  });

  it('renders nothing visible for thought (private)', () => {
    const text = renderToText([{ event: {
      type: 'thought', actorId: 'h1', text: 'I should attack', t: 1,
    } }]);
    expect(text).not.toContain('I should attack');
    expect(text).not.toContain('"thought"');
  });

  it('falls back gracefully on unknown event type', () => {
    const text = renderToText([{ event: { type: 'unknown-future-event', t: 1 } }]);
    // Acceptable: short labelled fallback. NOT acceptable: full JSON dump.
    expect(text).not.toContain('"t":');
  });

  it('preserves existing rule_violation formatting', () => {
    const text = renderToText([{ event: {
      type: 'rule_violation', actorId: 'h1',
      violation: { reason: 'out-of-range' }, t: 1,
    } }]);
    expect(text).toContain('h1');
  });

  it('preserves existing resolution formatting', () => {
    const text = renderToText([{ event: {
      type: 'resolution', actorId: 'h1',
      public: { hit: true }, t: 1,
    } }]);
    expect(text).toContain('h1');
  });
});

describe('ChatLog renders character names instead of ids', () => {
  const actors: ActorMap = new Map<string, ActorInfo>([
    ['dm', { name: 'DM', kind: 'dm' }],
    ['p2_warlock', { name: 'Kael', kind: 'hero' }],
    ['giant-rat-1', { name: 'Giant Rat #1', kind: 'monster' }],
  ]);

  it('replaces actorId in skip_turn with the hero name', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'p2_warlock',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(text).toContain('Kael');
    expect(text).not.toContain('p2_warlock');
  });

  it('replaces ids in state_change with character names', () => {
    const text = renderToText([{ event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'giant-rat-1', damage: 1, status: 'KO' }],
    } }], actors);
    expect(text).toContain('Giant Rat #1');
    expect(text).not.toContain('giant-rat-1');
  });

  it('falls back to the raw id if no name is mapped', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'unknown-actor',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(text).toContain('unknown-actor');
  });
});

describe('ChatLog wraps names in styled spans by actor kind', () => {
  const actors: ActorMap = new Map<string, ActorInfo>([
    ['dm', { name: 'DM', kind: 'dm' }],
    ['p2_warlock', { name: 'Kael', kind: 'hero' }],
    ['giant-rat-1', { name: 'Giant Rat #1', kind: 'monster' }],
  ]);

  // lit-html sprinkles marker comments inside elements (e.g. between the
  // opening tag and the text node), so we match on tag + class + content
  // structurally rather than via a brittle exact-string assertion.
  const matchTag = (html: string, tag: string, cls: string, content: string): boolean => {
    const re = new RegExp(
      `<${tag}\\s+class="${cls}">[\\s\\S]*?${content.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[\\s\\S]*?</${tag}>`,
    );
    return re.test(html);
  };

  it('wraps a hero name in <span class="hero">', () => {
    const html = renderToHtml([{ event: {
      type: 'action', actorId: 'p2_warlock',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(matchTag(html, 'span', 'hero', 'Kael')).toBe(true);
  });

  it('wraps an enemy name in <span class="enemy">', () => {
    const html = renderToHtml([{ event: {
      type: 'state_change', t: 1,
      changes: [{ id: 'giant-rat-1', damage: 1, status: 'KO' }],
    } }], actors);
    expect(matchTag(html, 'span', 'enemy', 'Giant Rat #1')).toBe(true);
  });

  it('renders DM narrate in the corner log with the dm-text italic class', () => {
    const html = renderToHtml([{ event: {
      type: 'narrate', actorId: 'dm', text: 'The rats hiss.', t: 1,
    } }], actors);
    expect(html).toContain('The rats hiss.');
    expect(html).toContain('dm-text');
  });
});

describe('ChatLog renders dialogue events that are also surfaced elsewhere', () => {
  it('renders DM narrate so the chat log keeps a historical record', () => {
    const text = renderToText([{ event: {
      type: 'narrate', actorId: 'dm', text: 'The rats hiss.', t: 1,
    } }]);
    expect(text).toContain('The rats hiss.');
  });

  it('renders DM say so the chat log keeps a historical record', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'dm',
      action: { kind: 'say', text: 'Hello, hero.' }, t: 1,
    } }]);
    expect(text).toContain('Hello, hero.');
  });

  it('renders hero say so the chat log keeps a historical record', () => {
    const text = renderToText([{ event: {
      type: 'action', actorId: 'h1',
      action: { kind: 'say', text: 'For glory!' }, t: 1,
    } }]);
    expect(text).toContain('For glory!');
  });

  it('renders human_input so the chat log keeps a historical record', () => {
    const text = renderToText([{ event: {
      type: 'human_input', actorId: 'h1', text: 'I cast fireball!', t: 1,
    } }]);
    expect(text).toContain('I cast fireball!');
  });
});

describe('ChatLog applies per-archetype color class to heroes', () => {
  const actors: ActorMap = new Map<string, ActorInfo>([
    ['p1_warrior',  { name: 'Anwen', kind: 'hero', archetype: 'warrior' }],
    ['p2_warlock',   { name: 'Kael',  kind: 'hero', archetype: 'warlock' }],
    ['human_hunter',{ name: 'Bran',  kind: 'hero', archetype: 'hunter' }],
  ]);

  it('warrior gets class="hero warrior"', () => {
    const html = renderToHtml([{ event: {
      type: 'action', actorId: 'p1_warrior',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(html).toMatch(/class="hero warrior"[^>]*>\s*(?:<!--[^-]*-->)?Anwen/);
  });

  it('warlock gets class="hero warlock"', () => {
    const html = renderToHtml([{ event: {
      type: 'action', actorId: 'p2_warlock',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(html).toMatch(/class="hero warlock"[^>]*>\s*(?:<!--[^-]*-->)?Kael/);
  });

  it('hunter gets class="hero hunter"', () => {
    const html = renderToHtml([{ event: {
      type: 'action', actorId: 'human_hunter',
      action: { kind: 'skip_turn' }, t: 1,
    } }], actors);
    expect(html).toMatch(/class="hero hunter"[^>]*>\s*(?:<!--[^-]*-->)?Bran/);
  });
});
