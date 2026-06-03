import { describe, it, expect } from 'vitest';
import { encodeServerEnvelope, parseClientEnvelope, parseServerEnvelope } from '../../../src/runtime/ws/protocol.js';
import { asCharacterId } from '../../../src/engine/ids.js';

describe('WS protocol', () => {
  it('encodes and decodes a snapshot envelope', () => {
    const env = encodeServerEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {}, tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {} },
      state: {
        viewer: { kind: 'human' },
        scene: null, characters: [], props: [], activeActor: null, recentChat: [],
      },
    });
    expect(typeof env).toBe('string');
    const back = parseServerEnvelope(env);
    expect(back?.kind).toBe('snapshot');
  });

  it('encodes and decodes turn_started / turn_ended', () => {
    for (const k of ['turn_started', 'turn_ended'] as const) {
      const e = encodeServerEnvelope({ kind: k, actorId: asCharacterId('h1') });
      expect(parseServerEnvelope(e)?.kind).toBe(k);
    }
  });

  it('encodes and decodes thinking / thinking_done', () => {
    for (const k of ['thinking', 'thinking_done'] as const) {
      const e = encodeServerEnvelope({ kind: k, actorId: asCharacterId('h1') });
      expect(parseServerEnvelope(e)?.kind).toBe(k);
    }
  });

  it('encodes and decodes thinking_delta with its text payload', () => {
    const e = encodeServerEnvelope({ kind: 'thinking_delta', actorId: asCharacterId('h1'), text: 'flank the rat' });
    const parsed = parseServerEnvelope(e);
    expect(parsed).toMatchObject({ kind: 'thinking_delta', actorId: 'h1', text: 'flank the rat' });
  });

  it('encodes and decodes end and rejected', () => {
    expect(parseServerEnvelope(encodeServerEnvelope({ kind: 'end', outcome: 'success' }))?.kind).toBe('end');
    expect(parseServerEnvelope(encodeServerEnvelope({ kind: 'rejected', reason: 'session_in_use' }))?.kind).toBe('rejected');
  });

  it('encodes and decodes input_required / input_done', () => {
    expect(parseServerEnvelope(encodeServerEnvelope({ kind: 'input_required' }))?.kind).toBe('input_required');
    expect(parseServerEnvelope(encodeServerEnvelope({ kind: 'input_done' }))?.kind).toBe('input_done');
  });

  it('round-trips a queued envelope (session-cap wait line)', () => {
    const e = encodeServerEnvelope({ kind: 'queued', position: 2, capacity: 3 });
    expect(parseServerEnvelope(e)).toMatchObject({ kind: 'queued', position: 2, capacity: 3 });
  });

  it('parseClientEnvelope accepts human_input and skip_turn', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'hi' }))?.kind).toBe('human_input');
    expect(parseClientEnvelope(JSON.stringify({ kind: 'skip_turn' }))?.kind).toBe('skip_turn');
  });

  it('parseClientEnvelope returns null on malformed JSON', () => {
    expect(parseClientEnvelope('{not json')).toBeNull();
  });

  it('parseClientEnvelope returns null on unknown kinds', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'launch_missiles' }))).toBeNull();
  });

  it('parseClientEnvelope returns null when human_input has non-string text', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 42 }))).toBeNull();
  });

  it('parseClientEnvelope accepts structured_action with a valid action shape', () => {
    const env = parseClientEnvelope(JSON.stringify({
      kind: 'structured_action',
      action: { kind: 'normal_attack', targetId: 'r1' },
    }));
    expect(env?.kind).toBe('structured_action');
  });

  it('parseClientEnvelope rejects structured_action without an action object', () => {
    expect(parseClientEnvelope(JSON.stringify({ kind: 'structured_action' }))).toBeNull();
    expect(parseClientEnvelope(JSON.stringify({ kind: 'structured_action', action: 'attack' }))).toBeNull();
    expect(parseClientEnvelope(JSON.stringify({ kind: 'structured_action', action: {} }))).toBeNull();
  });

  describe('physics-as-truth roll messages', () => {
    const rollRequest = {
      kind: 'roll_request' as const,
      requestId: 'roll-run1-3',
      rollKind: 'attack' as const,
      attacker: { actorId: asCharacterId('h1'), poolSize: 2, name: 'Bran', characterKind: 'hero' as const, archetype: 'warrior', sprite: null },
      defender: { actorId: asCharacterId('r1'), poolSize: 1, name: 'Rat', characterKind: 'monster' as const, archetype: null, sprite: 'giant-rat' },
    };

    it('round-trips a roll_request server envelope', () => {
      const back = parseServerEnvelope(encodeServerEnvelope(rollRequest));
      expect(back?.kind).toBe('roll_request');
      expect((back as typeof rollRequest).requestId).toBe('roll-run1-3');
      expect((back as typeof rollRequest).attacker.poolSize).toBe(2);
    });

    it('parseClientEnvelope accepts a well-formed roll_response', () => {
      const env = parseClientEnvelope(JSON.stringify({
        kind: 'roll_response', requestId: 'roll-run1-3', attackerFaces: [4, 2], defenderFaces: [6],
      }));
      expect(env?.kind).toBe('roll_response');
      expect((env as { attackerFaces: number[] }).attackerFaces).toEqual([4, 2]);
    });

    it('parseClientEnvelope rejects a roll_response with non-numeric faces or missing id', () => {
      expect(parseClientEnvelope(JSON.stringify({ kind: 'roll_response', requestId: 'x', attackerFaces: ['a'], defenderFaces: [1] }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'roll_response', attackerFaces: [1], defenderFaces: [1] }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'roll_response', requestId: 'x', attackerFaces: [1] }))).toBeNull();
    });
  });

  describe('initiative-reveal gate messages', () => {
    it('round-trips a reveal_request server envelope', () => {
      const back = parseServerEnvelope(encodeServerEnvelope({ kind: 'reveal_request', requestId: 'reveal-run1-1' }));
      expect(back?.kind).toBe('reveal_request');
      expect((back as { requestId: string }).requestId).toBe('reveal-run1-1');
    });

    it('parseClientEnvelope accepts a well-formed reveal_ack', () => {
      const env = parseClientEnvelope(JSON.stringify({ kind: 'reveal_ack', requestId: 'reveal-run1-1' }));
      expect(env?.kind).toBe('reveal_ack');
      expect((env as { requestId: string }).requestId).toBe('reveal-run1-1');
    });

    it('parseClientEnvelope rejects a reveal_ack with a missing / non-string id', () => {
      expect(parseClientEnvelope(JSON.stringify({ kind: 'reveal_ack' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'reveal_ack', requestId: 42 }))).toBeNull();
    });
  });

  describe('opening-splash gate messages', () => {
    it('round-trips an opening_request server envelope', () => {
      const back = parseServerEnvelope(encodeServerEnvelope({ kind: 'opening_request', requestId: 'opening-run1' }));
      expect(back?.kind).toBe('opening_request');
      expect((back as { requestId: string }).requestId).toBe('opening-run1');
    });

    it('parseClientEnvelope accepts a well-formed opening_ack', () => {
      const env = parseClientEnvelope(JSON.stringify({ kind: 'opening_ack', requestId: 'opening-run1' }));
      expect(env?.kind).toBe('opening_ack');
      expect((env as { requestId: string }).requestId).toBe('opening-run1');
    });

    it('parseClientEnvelope rejects an opening_ack with a missing / non-string id', () => {
      expect(parseClientEnvelope(JSON.stringify({ kind: 'opening_ack' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'opening_ack', requestId: 42 }))).toBeNull();
    });
  });

  describe('hero-selection gate messages', () => {
    const heroOption = {
      characterId: asCharacterId('p1_warrior'),
      name: 'Anwen',
      archetype: 'warrior',
      spritePath: 'heroes/warrior/south.png',
      blurb: 'A brave front-line fighter.',
      health: 3,
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      dex: 0,
      normalAttack: { name: 'Slashing Strike', kind: 'melee', range: 1 },
      specialAction: { name: 'Whirlwind Attack', description: 'Split your melee dice.' },
      bonusAbility: { name: 'Teamwork', description: 'Extra die on engaged targets.' },
    };

    it('round-trips a hero_select_request server envelope', () => {
      const back = parseServerEnvelope(encodeServerEnvelope({
        kind: 'hero_select_request', requestId: 'hero-select-run1', options: [heroOption],
      }));
      expect(back?.kind).toBe('hero_select_request');
      expect((back as { requestId: string }).requestId).toBe('hero-select-run1');
      expect((back as { options: typeof heroOption[] }).options[0]?.name).toBe('Anwen');
    });

    it('parseClientEnvelope accepts a well-formed hero_select_response', () => {
      const env = parseClientEnvelope(JSON.stringify({
        kind: 'hero_select_response', requestId: 'hero-select-run1', characterId: 'p2_warlock',
      }));
      expect(env?.kind).toBe('hero_select_response');
      expect((env as { characterId: string }).characterId).toBe('p2_warlock');
    });

    it('parseClientEnvelope rejects a hero_select_response with a missing id / characterId', () => {
      expect(parseClientEnvelope(JSON.stringify({ kind: 'hero_select_response', characterId: 'x' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'hero_select_response', requestId: 'r' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'hero_select_response', requestId: 'r', characterId: '' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'hero_select_response', requestId: 42, characterId: 'x' }))).toBeNull();
    });

    it('accepts a hero_select_response carrying a valid language pick', () => {
      const env = parseClientEnvelope(JSON.stringify({
        kind: 'hero_select_response', requestId: 'r', characterId: 'p2_warlock', language: 'pt',
      }));
      expect(env?.kind).toBe('hero_select_response');
      expect((env as { language?: string }).language).toBe('pt');
      // Absent language stays valid (pre-i18n clients).
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'hero_select_response', requestId: 'r', characterId: 'p2_warlock',
      }))).not.toBeNull();
    });

    it('rejects a hero_select_response with an unknown language', () => {
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'hero_select_response', requestId: 'r', characterId: 'p2_warlock', language: 'klingon',
      }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'hero_select_response', requestId: 'r', characterId: 'p2_warlock', language: 42,
      }))).toBeNull();
    });
  });

  describe('human_input target field', () => {
    it('accepts target=game and target=dm', () => {
      const game = parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'I charge.', target: 'game' }));
      expect(game?.kind).toBe('human_input');
      expect((game as { target?: string }).target).toBe('game');

      const dm = parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'Can I see the door?', target: 'dm' }));
      expect(dm?.kind).toBe('human_input');
      expect((dm as { target?: string }).target).toBe('dm');
    });

    it('accepts human_input without target (legacy form)', () => {
      const env = parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'hi' }));
      expect(env?.kind).toBe('human_input');
      expect((env as { target?: string }).target).toBeUndefined();
    });

    it('rejects unknown target values', () => {
      expect(parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'hi', target: 'npc' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'human_input', text: 'hi', target: 42 }))).toBeNull();
    });
  });

  describe('playtest survey messages', () => {
    const survey = { scores: { coordination: 4, trust: null }, moment: 'the breach' };

    it('parseClientEnvelope accepts a well-formed survey_response', () => {
      const env = parseClientEnvelope(JSON.stringify({ kind: 'survey_response', survey }));
      expect(env).toMatchObject({ kind: 'survey_response', survey });
    });

    it('accepts an all-null / empty-moment survey (partial submissions stay honest)', () => {
      const env = parseClientEnvelope(JSON.stringify({
        kind: 'survey_response',
        survey: { scores: { coordination: null }, moment: '' },
      }));
      expect(env?.kind).toBe('survey_response');
    });

    it('rejects out-of-range / non-integer scores and a missing survey object', () => {
      for (const bad of [0, 6, 3.5, '4', true]) {
        expect(parseClientEnvelope(JSON.stringify({
          kind: 'survey_response',
          survey: { scores: { coordination: bad }, moment: '' },
        }))).toBeNull();
      }
      expect(parseClientEnvelope(JSON.stringify({ kind: 'survey_response' }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'survey_response', survey: { scores: [4], moment: '' } }))).toBeNull();
      expect(parseClientEnvelope(JSON.stringify({ kind: 'survey_response', survey: { scores: {}, moment: 42 } }))).toBeNull();
    });

    it('rejects a moment longer than the cap', () => {
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'survey_response',
        survey: { scores: {}, moment: 'x'.repeat(4001) },
      }))).toBeNull();
    });

    it('accepts a valid survey language and rejects an unknown one', () => {
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'survey_response',
        survey: { scores: { coordination: 4 }, moment: '', language: 'pt' },
      }))?.kind).toBe('survey_response');
      expect(parseClientEnvelope(JSON.stringify({
        kind: 'survey_response',
        survey: { scores: { coordination: 4 }, moment: '', language: 'xx' },
      }))).toBeNull();
    });

    it('round-trips a survey_ack server envelope', () => {
      const e = encodeServerEnvelope({ kind: 'survey_ack', ok: true, destination: 'cloud' });
      expect(parseServerEnvelope(e)).toMatchObject({ kind: 'survey_ack', ok: true, destination: 'cloud' });
      const fail = encodeServerEnvelope({ kind: 'survey_ack', ok: false, detail: 'no survey handler registered' });
      expect(parseServerEnvelope(fail)).toMatchObject({ kind: 'survey_ack', ok: false });
    });
  });
});
