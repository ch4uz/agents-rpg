// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mountHeroSelect } from '../../web/components/HeroSelect.js';
import { setLanguage, getLanguage, __resetLanguageForTest } from '../../web/i18n.js';
import type { HeroChoice } from '../../src/runtime/ws/protocol.js';
import { asCharacterId } from '../../src/engine/ids.js';

/**
 * Pins the game-start "Choose your hero" screen (pixel-art character select):
 *   1. Renders one card per hero (name, class, stats) — pixel-art stat icons
 *      (not emoji). The hero blurb, the special action, and the passive ability
 *      all stay off the card.
 *   2. Clicking a card selects it and the footer confirm resolves with its id
 *      plus the picked game language.
 *   3. The first option is pre-selected, so confirming without clicking works.
 *   4. Double-clicking a card resolves immediately with that hero.
 *   5. The overlay removes itself once a hero is chosen.
 *   6. The EN/PT toggle switches the screen's language and rides along in the
 *      resolution.
 */
type Kind = 'melee' | 'ranged' | 'magic';
const choice = (id: string, name: string, archetype: string, blurb: string, kind: Kind): HeroChoice => ({
  characterId: asCharacterId(id),
  name, archetype,
  spritePath: `heroes/${archetype}/south.png`,
  blurb, health: 3,
  pools: { melee: kind === 'melee' ? 2 : 0, ranged: kind === 'ranged' ? 2 : 0, magic: kind === 'magic' ? 2 : 0, armor: 2 },
  dex: 0,
  normalAttack: { name: 'Strike', kind, range: 1 },
  specialAction: { name: 'Whirlwind', description: 'Split your dice.' },
  bonusAbility: { name: 'Teamwork', description: 'Extra die when ganging up.' },
});

const OPTIONS: HeroChoice[] = [
  choice('p1_warrior', 'Anwen', 'warrior', 'A brave fighter.', 'melee'),
  choice('p2_warlock', 'Kael', 'warlock', 'A reckless mage.', 'magic'),
  choice('human_hunter', 'Bran', 'hunter', 'A sharp-eyed archer.', 'ranged'),
];

describe('HeroSelect — choose your hero screen', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    setLanguage('en');
    __resetLanguageForTest();
  });

  it('renders one card per hero with name + stats but NO special-action or passive ledger', () => {
    void mountHeroSelect(root, OPTIONS);
    const cards = root.querySelectorAll('.hero-card');
    expect(cards).toHaveLength(3);
    const text = root.textContent ?? '';
    for (const o of OPTIONS) {
      expect(text).toContain(o.name);          // identity kept
      expect(text).not.toContain(o.blurb);     // hero blurb stays off the card
    }
    // The Special action and Passive ability are gone from the card entirely.
    expect(text).not.toContain('Whirlwind');                   // special name
    expect(text).not.toContain('Split your dice.');            // special description
    expect(text).not.toContain('Teamwork');                    // passive name
    expect(text).not.toContain('Extra die when ganging up.');  // passive description
    expect(root.querySelectorAll('.hero-ability').length).toBe(0);
    expect(root.querySelectorAll('.hero-card-abilities').length).toBe(0);
  });

  it('uses pixel-art SVG icons for the stats — heart, shield, attack-type; no dice; no emoji', () => {
    void mountHeroSelect(root, OPTIONS);
    expect(root.querySelector('img[src*="icon-heart"]')).not.toBeNull();
    expect(root.querySelector('img[src*="icon-shield"]')).not.toBeNull();
    // The generic dice icon is gone — the attack row shows the attack-TYPE icon.
    expect(root.querySelector('img[src*="icon-die"]')).toBeNull();
    expect(root.querySelector('img[src*="icon-melee"]')).not.toBeNull();   // Anwen (melee)
    expect(root.querySelector('img[src*="icon-magic"]')).not.toBeNull();   // Kael (magic)
    expect(root.querySelector('img[src*="icon-ranged"]')).not.toBeNull();  // Bran (ranged)
    // A 3-health hero shows three heart icons.
    expect(root.querySelectorAll('.hero-hearts img').length).toBeGreaterThanOrEqual(3);
    // No emoji glyphs left in the rendered text.
    const text = root.textContent ?? '';
    for (const emoji of ['❤', '🎲', '🛡', '⚔', '✨', '★']) {
      expect(text).not.toContain(emoji);
    }
  });

  it('stacks each attribute (health / attack / defense) on its own row', () => {
    void mountHeroSelect(root, [OPTIONS[0]!]);
    const rows = root.querySelectorAll('.hero-card-stats .hero-stat-row');
    expect(rows).toHaveLength(3);  // one row per attribute
  });

  it('resolves with the chosen hero when a card is clicked then confirmed', async () => {
    const p = mountHeroSelect(root, OPTIONS);
    // Click Kael's card (index 1), then the footer confirm.
    const cards = root.querySelectorAll<HTMLElement>('.hero-card');
    cards[1]!.click();
    const confirm = root.querySelector<HTMLButtonElement>('.hero-select-confirm')!;
    expect(confirm.textContent).toContain('Kael');
    confirm.click();
    await expect(p).resolves.toEqual({ characterId: 'p2_warlock', language: 'en' });
    // Overlay removed after resolution.
    expect(root.querySelector('.hero-select')).toBeNull();
  });

  it('pre-selects the first option so confirming immediately picks it', async () => {
    const p = mountHeroSelect(root, OPTIONS);
    const confirm = root.querySelector<HTMLButtonElement>('.hero-select-confirm')!;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toContain('Anwen');
    confirm.click();
    await expect(p).resolves.toEqual({ characterId: 'p1_warrior', language: 'en' });
  });

  it('double-clicking a card resolves immediately with that hero', async () => {
    const p = mountHeroSelect(root, OPTIONS);
    const cards = root.querySelectorAll<HTMLElement>('.hero-card');
    cards[2]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await expect(p).resolves.toEqual({ characterId: 'human_hunter', language: 'en' });
    expect(root.querySelector('.hero-select')).toBeNull();
  });

  it('renders an EN/PT language toggle; switching re-renders in Portuguese', () => {
    void mountHeroSelect(root, OPTIONS);
    const buttons = root.querySelectorAll<HTMLButtonElement>('.hero-select-lang-btn');
    expect(buttons).toHaveLength(2);
    expect(root.textContent).toContain('Choose Your Hero');

    const pt = Array.from(buttons).find((b) => b.textContent === 'Português')!;
    pt.click();
    expect(getLanguage()).toBe('pt');
    expect(root.textContent).toContain('Escolha Seu Herói');
    expect(root.textContent).not.toContain('Choose Your Hero');
    // Active state follows the pick.
    const active = root.querySelector('.hero-select-lang-btn--active');
    expect(active?.textContent).toBe('Português');
  });

  it('the language pick rides along in the resolution', async () => {
    const p = mountHeroSelect(root, OPTIONS);
    const buttons = root.querySelectorAll<HTMLButtonElement>('.hero-select-lang-btn');
    Array.from(buttons).find((b) => b.textContent === 'Português')!.click();
    const confirm = root.querySelector<HTMLButtonElement>('.hero-select-confirm')!;
    confirm.click();
    await expect(p).resolves.toEqual({ characterId: 'p1_warrior', language: 'pt' });
  });
});

describe('HeroSelect — localized hero names (names record)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    setLanguage('en');
    __resetLanguageForTest();
  });

  const withPt: HeroChoice[] = [
    { ...choice('p1_warrior', 'Gareth', 'warrior', 'b', 'melee'), names: { pt: 'Heitor' } },
    choice('p2_warlock', 'Kael', 'warlock', 'b', 'magic'),  // no names record — unchanged in pt
  ];

  it('cards and the confirm button switch to the pt names under the toggle', () => {
    void mountHeroSelect(root, withPt);
    expect(root.textContent).toContain('Gareth');
    expect(root.textContent).not.toContain('Heitor');

    const buttons = root.querySelectorAll<HTMLButtonElement>('.hero-select-lang-btn');
    Array.from(buttons).find((b) => b.textContent === 'Português')!.click();
    expect(root.textContent).toContain('Heitor');
    expect(root.textContent).not.toContain('Gareth');
    // A hero without a names record keeps its name.
    expect(root.textContent).toContain('Kael');
    // The confirm button names the selected hero in pt.
    expect(root.querySelector('.hero-select-confirm')!.textContent).toContain('Heitor');
  });

  it('the resolution still carries the characterId, never the display name', async () => {
    const p = mountHeroSelect(root, withPt);
    const buttons = root.querySelectorAll<HTMLButtonElement>('.hero-select-lang-btn');
    Array.from(buttons).find((b) => b.textContent === 'Português')!.click();
    root.querySelector<HTMLButtonElement>('.hero-select-confirm')!.click();
    await expect(p).resolves.toEqual({ characterId: 'p1_warrior', language: 'pt' });
  });
});
