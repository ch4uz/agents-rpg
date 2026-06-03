import { html, render, type TemplateResult } from 'lit-html';
import type { HeroChoice } from '../../src/runtime/ws/protocol.js';
import { t, getLanguage, setLanguage, translateArchetype, UI_LANGUAGES, LANGUAGE_LABELS, type UiLanguage } from '../i18n.js';

const ASSETS_BASE = '/assets';
/** Hand-built pixel-art stat icons (see assets/ui/icon-*.svg). */
const ICON = `${ASSETS_BASE}/ui`;

const statIcon = (name: string, alt: string, cls = 'hero-stat-icon'): TemplateResult =>
  html`<img class=${cls} src=${`${ICON}/icon-${name}.svg`} alt=${alt} />`;

/** Which pool backs a hero's normal attack — the number shown on the attack row. */
const attackPool = (h: HeroChoice): number => {
  switch (h.normalAttack.kind) {
    case 'ranged': return h.pools.ranged;
    case 'magic': return h.pools.magic;
    default: return h.pools.melee;
  }
};

/** The hero's display name in the chooser's CURRENT language — the variant
 *  the scenario declared for it (keyed by language code), falling back to the
 *  canonical name. Mirrors the engine-side rename that fires once the
 *  language pick lands. */
const heroName = (h: HeroChoice): string =>
  h.names?.[getLanguage()] ?? h.name;

/** The attack-type pixel icon (melee → sword, ranged → arrow, magic → crystal). */
const attackIconName = (h: HeroChoice): string => {
  switch (h.normalAttack.kind) {
    case 'ranged': return 'ranged';
    case 'magic': return 'magic';
    default: return 'melee';
  }
};

/** Localized display word for the attack kind ("melee" → "corpo a corpo"). */
const attackKindWord = (h: HeroChoice): string => {
  switch (h.normalAttack.kind) {
    case 'ranged': return t('stat.ranged');
    case 'magic': return t('stat.magic');
    default: return t('stat.melee');
  }
};

/** Stacked stat block — ONE row per attribute (health · attack · defense), each
 *  led by its pixel-art icon. No prose; the hero's combat identity at a glance. */
const statRow = (h: HeroChoice): TemplateResult => {
  const atk = attackPool(h);
  const hearts = Math.max(1, h.health);
  const kind = attackKindWord(h);
  return html`
    <ul
      class="hero-card-stats"
      aria-label=${t('heroSelect.statsAria', { health: h.health, kind, atk, armor: h.pools.armor })}
    >
      <li class="hero-stat-row hero-hearts" title=${t('heroSelect.healthTitle', { n: h.health })}>
        ${Array.from({ length: hearts }, () => statIcon('heart', ''))}
      </li>
      <li class="hero-stat-row" title=${t('heroSelect.attackTitle', { kind, n: atk })}>
        ${statIcon(attackIconName(h), '')}<span class="hero-stat-val">${atk}</span><span class="hero-stat-kind">${kind}</span>
      </li>
      <li class="hero-stat-row" title=${t('heroSelect.armorTitle', { n: h.pools.armor })}>
        ${statIcon('shield', '')}<span class="hero-stat-val">${h.pools.armor}</span><span class="hero-stat-kind">${t('stat.armor')}</span>
      </li>
    </ul>
  `;
};

const card = (
  h: HeroChoice,
  selected: boolean,
  onSelect: () => void,
  onConfirm: () => void,
): TemplateResult => html`
  <div
    class=${selected ? 'hero-card hero-card--selected' : 'hero-card'}
    role="button"
    tabindex="0"
    aria-pressed=${selected ? 'true' : 'false'}
    aria-label=${t('heroSelect.cardAria', { name: heroName(h), archetype: translateArchetype(h.archetype) })}
    @click=${onSelect}
    @dblclick=${onConfirm}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected ? onConfirm() : onSelect(); }
    }}
  >
    <div class="hero-card-name">${heroName(h)}</div>
    <!-- Static south-facing idle sprite — no animation. -->
    <div class="hero-card-portrait" aria-hidden="true">
      <img class="hero-card-frame" data-active src=${`${ASSETS_BASE}/${h.spritePath}`} alt="" />
    </div>
    ${statRow(h)}
  </div>
`;

/** What the player picked on the select screen: the hero AND the game
 *  language (shipped to the server inside `hero_select_response`, where it
 *  reroutes the agents' LANGUAGE directive before the first LLM call). */
export interface HeroSelectResult {
  characterId: string;
  language: UiLanguage;
}

const LANGUAGES: ReadonlyArray<{ id: UiLanguage; label: string }> =
  UI_LANGUAGES.map((id) => ({ id, label: LANGUAGE_LABELS[id] }));

/**
 * Game-start "Choose your hero" screen — a pixel-art character select. Mounts a
 * full-screen overlay (above the board + opening splash) showing one card per
 * offered {@link HeroChoice}, and resolves with the chosen hero's `characterId`
 * plus the picked game language once the player confirms. The overlay removes
 * itself on resolution.
 *
 * Each card shows the hero's full-body portrait, name, class, and a pixel-icon
 * stat line (health / attack / armor) — no special-action or passive details.
 * The portrait is a static south-facing idle sprite (no animation).
 * Click a card to select (highlight); click the footer button — or double-click
 * / Enter on the focused card — to confirm. The two heroes NOT chosen are played
 * by their AI agents.
 *
 * The titlebar carries the EN/PT language toggle: switching re-renders this
 * screen immediately (and, via i18n's listener, the rest of the UI chrome);
 * the final value rides along with the hero pick.
 */
export const mountHeroSelect = (parent: HTMLElement, options: HeroChoice[]): Promise<HeroSelectResult> =>
  new Promise<HeroSelectResult>((resolve) => {
    const host = document.createElement('div');
    host.className = 'hero-select-host';
    parent.appendChild(host);

    let selected: string | null = options[0]?.characterId ?? null;
    let done = false;

    const langToggle = (): TemplateResult => html`
      <div class="hero-select-lang" role="radiogroup" aria-label=${t('lang.aria')}>
        ${LANGUAGES.map((l) => html`
          <button
            class=${getLanguage() === l.id ? 'hero-select-lang-btn hero-select-lang-btn--active' : 'hero-select-lang-btn'}
            type="button"
            role="radio"
            aria-checked=${getLanguage() === l.id ? 'true' : 'false'}
            @click=${() => { setLanguage(l.id); draw(); }}
          >${l.label}</button>
        `)}
      </div>
    `;

    const draw = (): void => {
      render(
        html`
          <div class="hero-select" role="dialog" aria-modal="true" aria-label=${t('heroSelect.aria')}>
            <!-- Tibia/UO-style beveled "character window": gold title bar, recessed
                 body of hero plates, and a footer with the enter button. -->
            <div class="hero-select-window">
              <div class="hero-select-titlebar">
                <h1 class="hero-select-title">${t('heroSelect.title')}</h1>
                ${langToggle()}
              </div>
              <div class="hero-select-body">
                <div class="hero-select-row">
                  ${options.map((h) =>
                    card(
                      h,
                      h.characterId === selected,
                      () => { selected = h.characterId; draw(); },
                      () => finish(h.characterId),
                    ),
                  )}
                </div>
              </div>
              <div class="hero-select-footer">
                <button
                  class="hero-select-confirm"
                  type="button"
                  ?disabled=${selected === null}
                  @click=${() => { if (selected) finish(selected); }}
                >${t('heroSelect.playAs', { name: selectedName() })}</button>
              </div>
            </div>
          </div>
        `,
        host,
      );
    };

    const finish = (characterId: string): void => {
      if (done) return;
      done = true;
      host.remove();
      resolve({ characterId, language: getLanguage() });
    };

    const selectedName = (): string => {
      const chosen = options.find((o) => o.characterId === selected);
      return chosen ? heroName(chosen) : '';
    };

    draw();
  });
