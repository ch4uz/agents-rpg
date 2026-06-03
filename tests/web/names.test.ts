import { describe, it, expect, afterEach } from 'vitest';
import { displayName, monsterSayReadsAsNarration } from '../../web/components/names.js';
import { setLanguage, __resetLanguageForTest } from '../../web/i18n.js';

describe('displayName', () => {
  it('title-cases hyphen/underscore stubs and round-trips proper names', () => {
    expect(displayName('giant-rat')).toBe('Giant Rat');
    expect(displayName('king_rat')).toBe('King Rat');
    expect(displayName('Giant Rat')).toBe('Giant Rat');
    expect(displayName('Anwen Greythorn')).toBe('Anwen Greythorn');
  });
});

describe('monsterSayReadsAsNarration', () => {
  // The bug: the DM writes a monster reaction as third-person narration and it
  // gets rendered as the monster's own first-person speech bubble.
  it('flags a third-person line that names the creature', () => {
    expect(monsterSayReadsAsNarration('The King Rat squeaks in triumph, pointing his bone scepter at the fallen warlock!', 'King Rat')).toBe(true);
    expect(monsterSayReadsAsNarration('The giant rat squeaks and licks its whiskers!', 'Giant Rat')).toBe(true);
    // species word alone ("The rat …")
    expect(monsterSayReadsAsNarration('The rat lunges with a hungry screech!', 'Giant Rat 1')).toBe(true);
    // stub name carrying the bare monsterTypeId
    expect(monsterSayReadsAsNarration('The giant rat hisses!', 'giant-rat')).toBe(true);
    // numbered name still normalises
    expect(monsterSayReadsAsNarration('The King Rat sneers.', 'King Rat 1')).toBe(true);
  });

  it('does NOT flag a genuine first-person utterance', () => {
    expect(monsterSayReadsAsNarration('SKREEE!', 'King Rat')).toBe(false);
    expect(monsterSayReadsAsNarration('Your warlock falls, little heroes!', 'King Rat')).toBe(false);
    // opens with "The" but is the creature speaking, not described
    expect(monsterSayReadsAsNarration('The throne is MINE!', 'King Rat')).toBe(false);
    // names a DIFFERENT creature / object, not the speaker
    expect(monsterSayReadsAsNarration('The door will not hold!', 'King Rat')).toBe(false);
  });

  it('returns false for an empty name', () => {
    expect(monsterSayReadsAsNarration('The rat squeaks.', '')).toBe(false);
  });
});

describe('pt display translation', () => {
  afterEach(() => {
    setLanguage('en');
    __resetLanguageForTest();
  });

  it('displayName translates known catalog creatures in pt and passes others through', () => {
    setLanguage('pt');
    expect(displayName('Giant Rat')).toBe('Rato Gigante');
    expect(displayName('giant-rat')).toBe('Rato Gigante');   // store stub form
    expect(displayName('King Rat')).toBe('Rato Rei');
    expect(displayName('Gareth')).toBe('Gareth');             // proper noun untouched
    expect(displayName('Anwen Greythorn')).toBe('Anwen Greythorn');
  });

  it('displayName stays English in en', () => {
    expect(displayName('Giant Rat')).toBe('Giant Rat');
    expect(displayName('giant-rat')).toBe('Giant Rat');
  });

  it('monsterSayReadsAsNarration recognises pt articles + translated species', () => {
    setLanguage('pt');
    expect(monsterSayReadsAsNarration('O Rato Rei guincha em triunfo…', 'King Rat')).toBe(true);
    expect(monsterSayReadsAsNarration('O rato gigante fareja o queijo.', 'giant-rat 2')).toBe(true);
    // Genuine first-person utterances still pass as speech.
    expect(monsterSayReadsAsNarration('Skreee! Meu trono!', 'King Rat')).toBe(false);
    expect(monsterSayReadsAsNarration('Vocês nunca vão passar!', 'King Rat')).toBe(false);
    // The English shape keeps matching too (mixed-language DM output).
    expect(monsterSayReadsAsNarration('The King Rat squeaks in triumph.', 'King Rat')).toBe(true);
  });

  it('pt articles are NOT matched while the UI is English', () => {
    expect(monsterSayReadsAsNarration('O Rato Rei guincha…', 'King Rat')).toBe(false);
  });
});
