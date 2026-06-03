// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  t,
  getLanguage,
  setLanguage,
  onLanguageChange,
  hasMessage,
  translateArchetype,
  __resetLanguageForTest,
} from '../../web/i18n.js';

/**
 * Pins the browser i18n module:
 *   1. t() looks up the current language with English fallback + {var}
 *      interpolation.
 *   2. setLanguage persists to localStorage and notifies listeners.
 *   3. Every EN key has a PT translation (the tables can't drift apart —
 *      enforced by the Record<MessageKey, string> type, smoke-checked here).
 */
describe('web i18n', () => {
  afterEach(() => {
    setLanguage('en');
    try { localStorage.removeItem('agents-rpg-lang'); } catch { /* jsdom */ }
    __resetLanguageForTest();
  });

  it('defaults to English and translates after setLanguage', () => {
    expect(getLanguage()).toBe('en');
    expect(t('queue.title')).toBe('The Tavern Is Full');
    setLanguage('pt');
    expect(getLanguage()).toBe('pt');
    expect(t('queue.title')).toBe('A Taverna Está Cheia');
  });

  it('interpolates {var} placeholders and leaves unknown ones visible', () => {
    expect(t('status.heroChoosing', { who: 'Gareth' })).toBe('Gareth is choosing an action…');
    setLanguage('pt');
    expect(t('status.heroChoosing', { who: 'Gareth' })).toBe('Gareth está escolhendo uma ação…');
    // A missing var stays as the literal placeholder, so it's visible in dev.
    expect(t('status.heroChoosing')).toContain('{who}');
  });

  it('persists the choice to localStorage (stubbed — this jsdom ships none)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    try {
      setLanguage('pt');
      expect(store.get('agents-rpg-lang')).toBe('pt');
      setLanguage('en');
      expect(store.get('agents-rpg-lang')).toBe('en');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('notifies listeners on change (once per actual switch)', () => {
    const seen: string[] = [];
    const off = onLanguageChange((l) => seen.push(l));
    setLanguage('pt');
    setLanguage('pt');           // no-op: same language
    setLanguage('en');
    off();
    setLanguage('pt');           // after unsubscribe — not seen
    expect(seen).toEqual(['pt', 'en']);
  });

  it('hasMessage guards dynamic keys', () => {
    expect(hasMessage('survey.q.coordination.title')).toBe(true);
    expect(hasMessage('survey.q.nonsense.title')).toBe(false);
  });

  it('translates the fixed archetype set in pt and passes unknowns through', () => {
    expect(translateArchetype('warrior')).toBe('warrior');  // en: untouched
    setLanguage('pt');
    expect(translateArchetype('warrior')).toBe('guerreiro');
    expect(translateArchetype('hunter')).toBe('caçador');
    expect(translateArchetype('dragon-knight')).toBe('dragon-knight');
  });
});
