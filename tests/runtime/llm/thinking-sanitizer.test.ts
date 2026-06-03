import { describe, it, expect } from 'vitest';
import { sanitizeThinking } from '../../../src/runtime/llm/thinking-sanitizer.js';

describe('sanitizeThinking', () => {
  it('leaves a clean thought untouched (modulo trim)', () => {
    const t = "Let me assess. Two rats adjacent — I'll Whirlwind them both.";
    expect(sanitizeThinking(`  ${t}  `)).toBe(t);
  });

  it('strips the trailing summarizer leak observed live (run 2026-05-29 t=87)', () => {
    const raw =
      "Let me assess the situation. Only giant-rat-3 is left, at (6,1). I'm at (4,4). " +
      'I could move closer to get a clearer angle, but honestly, I\'m well within range and should just attempt the attack now. ' +
      'I need to see the next thinking to rewrite it. Could you provide the next thinking chunk that follows the current rewritten thinking about moving to (4,2) and firing at giant-rat-3?';
    const cleaned = sanitizeThinking(raw);
    expect(cleaned).toContain('Only giant-rat-3 is left');
    expect(cleaned).toContain('should just attempt the attack now.');
    expect(cleaned).not.toMatch(/next thinking/i);
    expect(cleaned).not.toMatch(/rewritten thinking/i);
    expect(cleaned).not.toMatch(/thinking chunk/i);
    // Cut at the sentence boundary, keeping the terminating period.
    expect(cleaned.endsWith('attempt the attack now.')).toBe(true);
  });

  it('returns empty when the block is nothing but a leak', () => {
    expect(sanitizeThinking('Could you provide the next thinking chunk?')).toBe('');
    expect(sanitizeThinking('Please continue the rewritten thinking.')).toBe('');
  });

  it('cuts at a newline boundary when the leak follows a line break', () => {
    const raw = 'I move to (4,2) and fire.\nNow rewrite the thinking to continue.';
    expect(sanitizeThinking(raw)).toBe('I move to (4,2) and fire.');
  });

  it('does not trip on in-character use of the word "thinking"', () => {
    const t = "I'm thinking the warlock should blast the king-rat first.";
    expect(sanitizeThinking(t)).toBe(t);
  });

  it('catches each marker variant', () => {
    for (const tail of [
      'Give me the next thinking.',
      'See the thinking chunk above.',
      'This is the rewritten thinking.',
      'Let me rewrite the thinking.',
    ]) {
      expect(sanitizeThinking(`Good reasoning here. ${tail}`)).toBe('Good reasoning here.');
    }
  });
});
