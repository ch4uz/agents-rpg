import { describe, it, expect } from 'vitest';
import {
  GAME_LANGUAGES,
  NON_EN_LANGUAGES,
  isGameLanguage,
  resolveLocalized,
  type GameLanguage,
  type Localized,
} from '../../src/runtime/language.js';

/**
 * Pins the generic language plumbing: every shape is keyed by LANGUAGE CODE,
 * so adding a future language means extending GAME_LANGUAGES (+ UI tables and
 * content) — no schema or resolver changes.
 */
describe('language module', () => {
  it('GAME_LANGUAGES is the master list; NON_EN_LANGUAGES derives from it', () => {
    expect(GAME_LANGUAGES).toContain('en');
    expect(NON_EN_LANGUAGES).toEqual(GAME_LANGUAGES.filter((l) => l !== 'en'));
    expect(NON_EN_LANGUAGES).not.toContain('en');
  });

  it('isGameLanguage accepts exactly the listed codes', () => {
    for (const l of GAME_LANGUAGES) expect(isGameLanguage(l)).toBe(true);
    expect(isGameLanguage('fr')).toBe(false);
    expect(isGameLanguage(42)).toBe(false);
    expect(isGameLanguage(undefined)).toBe(false);
  });

  it('resolveLocalized looks up by language code with English fallback', () => {
    expect(resolveLocalized('plain', 'pt')).toBe('plain');
    expect(resolveLocalized({ en: 'E', pt: 'P' }, 'pt')).toBe('P');
    expect(resolveLocalized({ en: 'E', pt: 'P' }, 'en')).toBe('E');
    expect(resolveLocalized({ en: 'E' }, 'pt')).toBe('E');
  });

  it('the lookup is key-generic: a future language code resolves once the union includes it', () => {
    // Content may carry keys ahead of the code (tolerated by every schema);
    // the resolver is a plain record lookup, so the day 'fr' joins
    // GAME_LANGUAGES this value resolves with no resolver change.
    const value = { en: 'E', fr: 'F' } as Localized;
    expect(resolveLocalized(value, 'fr' as GameLanguage)).toBe('F');
    expect(resolveLocalized(value, 'pt')).toBe('E'); // no pt variant → fallback
  });
});
