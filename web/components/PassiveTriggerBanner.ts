/**
 * "Bonus ability triggered" banner — a transient card that pops in the top
 * section of the board whenever a hero's passive (Teamwork / Power Surge /
 * Tangled / Hunter) fires during action resolution. Mirrors the avatar-coin +
 * name visual language of the turn-order slots / battle-order badges: a dark
 * iron card with a gold-trimmed circular portrait coin and the line
 * "{name} triggered {ability}" (plus the short effect, e.g. "+1 attack die").
 *
 * Driven entirely by the `passive_triggered` engine event (surfaced via the
 * store's chat feed); Layout owns the show/auto-dismiss timing and feeds this a
 * resolved {@link PassiveBannerData} (the event carries only ids, so Layout
 * looks the hero up in the live roster for the portrait).
 */
import { html, type TemplateResult } from 'lit-html';
import { keyed } from 'lit-html/directives/keyed.js';

const ASSETS_BASE = '/assets';

export interface PassiveBannerData {
  /** Unique per trigger (the chat index) — keys the DOM so each fresh trigger
   *  replays the pop-in from frame 0. */
  key: string;
  /** Hero display name. */
  name: string;
  archetype: string | null;
  sprite: string | null;
  /** Bonus ability display name, e.g. "Teamwork". */
  abilityName: string;
  /** Short effect phrase, e.g. "+1 attack die". Optional. */
  effect?: string;
}

const avatarUrl = (archetype: string | null, sprite: string | null): string | null => {
  if (archetype) return `${ASSETS_BASE}/heroes/${archetype}/south.png`;
  if (sprite) return `${ASSETS_BASE}/heroes/${sprite}/south.png`;
  return null;
};

export const passiveTriggerBanner = (
  data: PassiveBannerData,
  dismissing: boolean,
): TemplateResult => {
  const bg = avatarUrl(data.archetype, data.sprite);
  const cls = `passive-banner${dismissing ? ' passive-banner--out' : ''}`;
  // `keyed` on the trigger key tears down + replays the pop-in for each fresh
  // trigger; wrapped in an outer html template so the return stays a TemplateResult.
  return html`${keyed(
    data.key,
    html`
      <div class=${cls} role="status" aria-live="polite">
        ${bg
          ? html`<span
              class="passive-banner-avatar"
              role="img"
              aria-label=${data.name}
              style="background-image: url('${bg}')"
            ></span>`
          : html`<span class="passive-banner-avatar passive-banner-avatar--placeholder" aria-hidden="true"></span>`}
        <span class="passive-banner-text">
          <span class="passive-banner-name">${data.name}</span>
          <span class="passive-banner-verb">triggered</span>
          <span class="passive-banner-ability">${data.abilityName}</span>
          ${data.effect ? html`<span class="passive-banner-effect">${data.effect}</span>` : ''}
        </span>
      </div>
    `,
  )}`;
};
