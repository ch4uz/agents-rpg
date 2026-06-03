/**
 * Game-language support. The language shapes (a) the LANGUAGE directive
 * injected into every agent's system prompt — so the DM narrates and the AI
 * heroes speak Brazilian Portuguese when `'pt'` — and (b) which string table
 * the browser UI renders from (see `web/i18n.ts`, which keeps its own copy of
 * this union because the web bundle must not import server modules).
 *
 * The language is per-SESSION and fixed before the first LLM call: the
 * scenario file sets the default (`'en'` when absent) and the player's pick on
 * the hero-select screen — which fires before the opening splash and any
 * turn — overrides it. Stable-per-run is what keeps the system band byte-
 * identical across calls, so prompt caching is unaffected.
 */
export const GAME_LANGUAGES = ['en', 'pt'] as const;

export type GameLanguage = (typeof GAME_LANGUAGES)[number];

export const isGameLanguage = (v: unknown): v is GameLanguage =>
  typeof v === 'string' && (GAME_LANGUAGES as readonly string[]).includes(v);

/** The non-English game languages — the ones content may carry variants for. */
export const NON_EN_LANGUAGES: readonly GameLanguage[] =
  GAME_LANGUAGES.filter((l) => l !== 'en');

/**
 * A text value that may carry per-language variants, keyed by language code.
 * A plain string is the common monolingual case (English); `{ en, pt: … }`
 * carries variants so the consumer can pick at RENDER time — necessary for
 * content loaded before the hero-select gate where the session language is
 * chosen (personas, party rosters). Keys beyond the current GAME_LANGUAGES
 * are tolerated and simply never resolve — content can ship a language ahead
 * of the code supporting it.
 */
export type Localized = string | ({ en: string } & Partial<Record<string, string>>);

/** Resolve a {@link Localized} value for a language, falling back to English. */
export const resolveLocalized = (value: Localized, language: GameLanguage): string => {
  if (typeof value === 'string') return value;
  return value[language] ?? value.en;
};
