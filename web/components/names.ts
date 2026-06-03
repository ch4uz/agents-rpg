import { translateGameTerm, getLanguage, type UiLanguage } from '../i18n.js';

/**
 * Pure: turn a raw actor name into something readable for the UI.
 *
 * Engine-side, monsters that get auto-spawned go through the catalog and
 * receive a friendly name like "Giant Rat". But the browser store also
 * synthesises stub characters in response to `reveal_monster` events, and
 * those stubs carry the bare `monsterTypeId` (e.g. "giant-rat") as `name`.
 *
 * Title-casing splits on '-' and '_' only (NOT whitespace), so multi-word
 * hero names like "Anwen Greythorn" pass through unchanged. Already-proper
 * names round-trip: "Giant Rat" → "Giant Rat", "Bran" → "Bran".
 *
 * When the UI language is Portuguese, known catalog creature names are
 * translated at this display boundary ("Giant Rat" → "Rato Gigante") — the
 * engine/wire name stays English (it's LLM context and the stable research
 * record); hero/NPC proper nouns pass through untouched.
 */
export const displayName = (raw: string): string => {
  if (!raw) return raw;
  const titled = raw
    .split(/[-_]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
  return translateGameTerm(titled);
};

/**
 * Pure: does a monster's reaction `text` read as third-person NARRATION about
 * the creature rather than the creature's own utterance?
 *
 * A monster `say` is rendered as that foe's first-person speech bubble (name +
 * portrait as the speaker). The DM, voicing off-turn enemy reactions, sometimes
 * writes the line as third-person narration instead ("The King Rat squeaks in
 * triumph, pointing his bone scepter…") — which reads wrong attributed to the
 * monster AS the speaker. This detects that shape so the renderer can fall back
 * to a DM-narration caption instead of a misattributed quote.
 *
 * Heuristic, deliberately narrow to avoid eating genuine utterances: the line
 * opens with a definite article immediately naming the creature — its full
 * name/species (number stripped, hyphens normalised, so both "King Rat" and
 * the stub "giant-rat" match) or its species word ("rat"). In a Portuguese
 * session the DM narrates in pt-BR ("O Rato Rei guincha…"), so the article set
 * gains o/a/os/as and the species candidates include the TRANSLATED display
 * name (the engine-side `actorName` stays English). A first-person cry or
 * taunt ("Skreee!", "Your warlock falls!", "The throne is mine!") never
 * matches.
 *
 * This is a defensive backstop: the primary fix is the `voice_monster` prompt
 * now asking the DM for a first-person utterance in the first place.
 */
export const monsterSayReadsAsNarration = (text: string, actorName: string): boolean => {
  const species = actorName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+\d+$/, '')
    .trim()
    .toLowerCase();
  if (species.length === 0) return false;

  const candidates = new Set<string>([species, species.split(/\s+/).pop()!]);
  if (getLanguage() !== 'en') {
    // The engine name is English — add the translated display form so
    // localized narration ("O Rato Gigante fareja…") is recognised too.
    const translated = displayName(actorName.replace(/\s+\d+$/, '')).toLowerCase();
    if (translated !== species) {
      candidates.add(translated);
      candidates.add(translated.split(/\s+/).pop()!);
    }
  }

  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = Array.from(candidates).filter((c) => c.length > 0).map(esc).join('|');
  const articles = `the${NARRATION_ARTICLES[getLanguage()] ?? ''}`;
  return new RegExp(`^\\s*(${articles})\\s+(${alternatives})\\b`, 'i').test(text);
};

/** Extra definite-article alternatives per language (appended to English
 *  "the", regex-alternation syntax) for the narration-shape heuristic above. */
const NARRATION_ARTICLES: Partial<Record<UiLanguage, string>> = {
  pt: '|o|a|os|as',
};
