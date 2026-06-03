import { describe, it, expect } from 'vitest';
import { parseLine } from '../../../src/runtime/cli/slash-parser.js';

describe('slash parser', () => {
  it('non-slash → free_text', () => {
    expect(parseLine('I rush in')).toEqual({ kind: 'free_text', text: 'I rush in' });
    expect(parseLine('   ')).toEqual({ kind: 'free_text', text: '' });
  });

  it('/skip and /end', () => {
    expect(parseLine('/skip')).toEqual({ kind: 'skip' });
    expect(parseLine('/end')).toEqual({ kind: 'structured_action', action: { kind: 'end_turn' } });
  });

  it('/attack <id>', () => {
    expect(parseLine('/attack rat-1')).toEqual({
      kind: 'structured_action',
      action: { kind: 'normal_attack', targetId: 'rat-1' },
    });
  });

  it('/move single-square shorthand', () => {
    const r = parseLine('/move 4,5');
    expect(r).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 4, y: 5 }] },
    });
  });

  it('/move with via path', () => {
    const r = parseLine('/move 1,1 via 2,1; 3,1');
    expect(r).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }] },
    });
  });

  it('/use with target', () => {
    expect(parseLine('/use potion h-ally')).toEqual({
      kind: 'structured_action',
      action: { kind: 'use_item', itemId: 'potion', targetId: 'h-ally' },
    });
  });

  it('/test parses', () => {
    const r = parseLine('/test ranged 5 skill=tracking -- spot the rat');
    expect(r).toEqual({
      kind: 'structured_action',
      action: {
        kind: 'ability_test', characteristic: 'ranged', difficulty: 5,
        describe: 'spot the rat', skillId: 'tracking',
      },
    });
  });

  it('parse_error on unknown command', () => {
    expect(parseLine('/teleport')).toEqual({ kind: 'parse_error', message: 'unknown command: /teleport' });
  });

  it('parse_error on bad /move', () => {
    expect(parseLine('/move not-a-square')).toEqual({
      kind: 'parse_error',
      message: '/move requires "x,y[ via x,y; ...]"',
    });
  });

  it('/say preserves text including spaces', () => {
    expect(parseLine('/say flank left now!')).toEqual({
      kind: 'structured_action',
      action: { kind: 'say', text: 'flank left now!' },
    });
  });
});
