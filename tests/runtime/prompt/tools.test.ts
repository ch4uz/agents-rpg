import { describe, it, expect } from 'vitest';
import {
  PLAYER_TOOLS,
  DM_TOOLS,
  MONSTER_REACT_TOOLS,
  decodePlayerToolUse,
  decodeDmToolUse,
} from '../../../src/runtime/prompt/tools.js';
import type { PlayerAction, DmAction } from '../../../src/engine/action.js';
import { asCharacterId, asItemId, asSkillId } from '../../../src/engine/ids.js';

describe('Anthropic tool schemas', () => {
  it('PLAYER_TOOLS covers every PlayerAction kind except skip_turn', () => {
    const names = PLAYER_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ['ability_test', 'attack_object', 'emote', 'end_turn', 'equip', 'free_ally', 'move', 'normal_attack', 'open_chest', 'push_object', 'say', 'special_action', 'throw_item', 'use_boon', 'use_item'].sort(),
    );
  });

  it('DM_TOOLS covers every DmAction kind', () => {
    const names = DM_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      ['end_adventure', 'end_combat', 'environmental', 'monster_action', 'narrate', 'npc_action', 'offer_rest', 'remove_prop', 'request_action', 'reveal_monster', 'reveal_npc', 'set_scene', 'spawn_prop', 'start_combat'].sort(),
    );
  });

  it('decodePlayerToolUse roundtrips move', () => {
    const a: PlayerAction = { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] };
    const decoded = decodePlayerToolUse({ name: 'move', input: { path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } });
    expect(decoded).toEqual(a);
  });

  it('decodePlayerToolUse roundtrips normal_attack', () => {
    const decoded = decodePlayerToolUse({ name: 'normal_attack', input: { targetId: 'rat-1' } });
    expect(decoded).toEqual({ kind: 'normal_attack', targetId: asCharacterId('rat-1') });
  });

  it('decodePlayerToolUse roundtrips use_item with target', () => {
    const decoded = decodePlayerToolUse({ name: 'use_item', input: { itemId: 'potion', targetId: 'h-ally' } });
    expect(decoded).toEqual({ kind: 'use_item', itemId: asItemId('potion'), targetId: asCharacterId('h-ally') });
  });

  it('decodePlayerToolUse roundtrips ability_test', () => {
    const decoded = decodePlayerToolUse({
      name: 'ability_test',
      input: { characteristic: 'magic', difficulty: 5, describe: 'recall lore', skillId: 'knowledge' },
    });
    expect(decoded).toEqual({
      kind: 'ability_test', characteristic: 'magic', difficulty: 5, describe: 'recall lore',
      skillId: asSkillId('knowledge'),
    });
  });

  it('decodePlayerToolUse roundtrips end_turn and say', () => {
    expect(decodePlayerToolUse({ name: 'end_turn', input: {} })).toEqual({ kind: 'end_turn' });
    expect(decodePlayerToolUse({ name: 'say', input: { text: 'Flank left!' } })).toEqual({
      kind: 'say', text: 'Flank left!',
    });
  });

  it('decodePlayerToolUse roundtrips emote', () => {
    expect(decodePlayerToolUse({ name: 'emote', input: { emoji: '🙀' } })).toEqual({
      kind: 'emote', emoji: '🙀',
    });
  });

  it('decodePlayerToolUse rejects emote without a string emoji', () => {
    expect(() => decodePlayerToolUse({ name: 'emote', input: {} })).toThrow(/emoji/);
  });

  it('decodeDmToolUse roundtrips narrate, request_action, start_combat, end_adventure', () => {
    expect(decodeDmToolUse({ name: 'narrate', input: { text: '...' } }))
      .toEqual<DmAction>({ kind: 'narrate', text: '...' });
    expect(decodeDmToolUse({ name: 'request_action', input: { actorId: 'p1' } }))
      .toEqual<DmAction>({ kind: 'request_action', actorId: asCharacterId('p1') });
    expect(decodeDmToolUse({ name: 'start_combat', input: { heroSide: ['h1','h2'], monsterSide: ['m1'] } }))
      .toEqual<DmAction>({
        kind: 'start_combat',
        heroSide: [asCharacterId('h1'), asCharacterId('h2')],
        monsterSide: [asCharacterId('m1')],
      });
    expect(decodeDmToolUse({ name: 'end_adventure', input: { outcome: 'success' } }))
      .toEqual<DmAction>({ kind: 'end_adventure', outcome: 'success' });
  });

  it('decode throws on unknown tool name', () => {
    expect(() => decodePlayerToolUse({ name: 'bogus', input: {} })).toThrow(/unknown player tool/i);
    expect(() => decodeDmToolUse({ name: 'bogus', input: {} })).toThrow(/unknown dm tool/i);
  });

  it('special_action schema accepts a diceSplit object in params', () => {
    const tool = PLAYER_TOOLS.find((t) => t.name === 'special_action');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties: { params: { properties: Record<string, unknown> } };
    };
    expect(schema.properties.params.properties).toHaveProperty('diceSplit');
  });

  it('round-trips a special_action with diceSplit through decodePlayerToolUse', () => {
    const action = decodePlayerToolUse({
      name: 'special_action',
      input: {
        targetIds: ['rat-1', 'rat-2'],
        params: { diceSplit: { 'rat-1': 1, 'rat-2': 1 } },
      },
    });
    expect(action.kind).toBe('special_action');
    if (action.kind === 'special_action') {
      expect(action.targetIds).toEqual([asCharacterId('rat-1'), asCharacterId('rat-2')]);
      expect(action.params).toEqual({ diceSplit: { 'rat-1': 1, 'rat-2': 1 } });
    }
  });
});

describe('spawn_prop / remove_prop decoders', () => {
  it('decodes spawn_prop into the DmAction shape (with description)', () => {
    const a = decodeDmToolUse({
      name: 'spawn_prop',
      input: {
        id: 'cheese-1', emoji: '🧀', name: 'Wheel of cheese',
        pos: { x: 2, y: 3 }, description: 'half-nibbled',
      },
    });
    const expected: DmAction = {
      kind: 'spawn_prop', id: 'cheese-1', emoji: '🧀', name: 'Wheel of cheese',
      pos: { x: 2, y: 3 }, description: 'half-nibbled',
    };
    expect(a).toEqual(expected);
  });

  it('decodes spawn_prop without description (omits the field)', () => {
    const a = decodeDmToolUse({
      name: 'spawn_prop',
      input: { id: 'torch-1', emoji: '🔥', name: 'Lit torch', pos: { x: 0, y: 0 } },
    });
    if (a.kind === 'spawn_prop') {
      expect(a.description).toBeUndefined();
    }
  });

  it('decodes remove_prop', () => {
    const a = decodeDmToolUse({ name: 'remove_prop', input: { id: 'cheese-1' } });
    expect(a).toEqual({ kind: 'remove_prop', id: 'cheese-1' });
  });
});

describe('open_chest / throw_item decoders', () => {
  it('decodes open_chest', () => {
    const a = decodePlayerToolUse({ name: 'open_chest', input: { chestId: 'supply-chest' } });
    expect(a).toEqual({ kind: 'open_chest', chestId: 'supply-chest' });
  });

  it('decodes throw_item', () => {
    const a = decodePlayerToolUse({ name: 'throw_item', input: { itemId: 'cheese', pos: { x: 8, y: 5 } } });
    expect(a).toEqual({ kind: 'throw_item', itemId: asItemId('cheese'), pos: { x: 8, y: 5 } });
  });

  it('open_chest requires a string chestId', () => {
    expect(() => decodePlayerToolUse({ name: 'open_chest', input: {} })).toThrow(/chestId/);
  });

  it('throw_item requires a string itemId', () => {
    expect(() => decodePlayerToolUse({ name: 'throw_item', input: { pos: { x: 1, y: 1 } } })).toThrow(/itemId/);
  });
});

describe('attack_object decoder', () => {
  it('decodes attack_object with explicit difficulty', () => {
    const a = decodePlayerToolUse({
      name: 'attack_object',
      input: { pos: { x: 3, y: 4 }, difficulty: 6 },
    });
    expect(a).toEqual({ kind: 'attack_object', pos: { x: 3, y: 4 }, difficulty: 6 });
  });

  it('omits difficulty when absent', () => {
    const a = decodePlayerToolUse({
      name: 'attack_object',
      input: { pos: { x: 1, y: 2 } },
    });
    if (a.kind === 'attack_object') {
      expect(a.difficulty).toBeUndefined();
      expect(a.pos).toEqual({ x: 1, y: 2 });
    }
  });
});

describe('voice_monster tool prompt', () => {
  // A monster reaction is rendered as the foe's OWN first-person speech bubble,
  // so the tool must steer the DM to a first-person utterance — not third-person
  // narration ("The King Rat squeaks…"), which reads wrong attributed to the rat.
  const voice = MONSTER_REACT_TOOLS.find((t) => t.name === 'voice_monster')!;

  it('asks for a first-person utterance and forbids third-person narration', () => {
    const desc = voice.description.toLowerCase();
    expect(desc).toContain('first person');
    // explicitly calls out the broken third-person shape as a non-example
    expect(voice.description).toContain('The King Rat squeaks');
    expect(desc).toMatch(/never|not/);
  });

  it('the text field describes a first-person utterance', () => {
    const textDesc = (voice.input_schema.properties as { text: { description: string } }).text.description.toLowerCase();
    expect(textDesc).toContain('first-person');
  });
});
