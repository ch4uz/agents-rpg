import { html, type TemplateResult } from 'lit-html';
import { markdownInline } from './markdown.js';
import { t } from '../i18n.js';

/**
 * "DM's Aside" — the out-of-character question→answer thread, rendered as a
 * parchment margin note pinned to the LEFT edge of the viewport (the OOC
 * mirror of the right-side Event Log drawer).
 *
 * It lives entirely OFF the in-fiction narrator stage below the board: an OOC
 * question and the DM's reply used to hijack `.narrator-text`, overwriting the
 * story narration until a fresh `narrate` event arrived. By giving the meta
 * channel its own surface, the in-character narration is never displaced.
 *
 * Layout.ts owns the lifecycle (mirrors the old `lastPrompt` echo):
 *   - mounts on a DM-target ("Ask the DM") submit with `reply: null`
 *   - flips to the answered state when the matching `dm_ooc_reply` lands
 *   - unmounts (payload → null) once the DM moves on with fresh narration
 *
 * The full Q&A is also persisted in the Event Log (`player_ooc_query` /
 * `dm_ooc_reply`), so this panel is purely a foreground spotlight — losing it
 * on the next beat costs nothing.
 */
export interface DmAsidePayload {
  /** The player's out-of-character question. */
  question: string;
  /** The DM's answer, or null while the DM is still considering. */
  reply: string | null;
}

/** Render the aside, or '' when there's no active OOC thread. The returned
 *  node is `position: fixed` (see `.dm-aside` in main.css), so its placement
 *  in the host template's DOM order is irrelevant to layout — only to
 *  stacking + reading order.
 *
 *  `onDismiss` (optional) wires the header's "×" close button. The player can
 *  retire the thread early — before the auto-clear on the next narration —
 *  e.g. once they've read the answer and want the board edge clear. The Q&A
 *  stays in the Event Log either way, so dismissing only hides the
 *  foreground spotlight. Omitted → no dismiss button (tests / static
 *  rendering). */
export const dmAside = (
  payload: DmAsidePayload | null,
  onDismiss?: () => void,
): TemplateResult | '' => {
  if (payload === null) return '';
  const { question, reply } = payload;
  const answered = reply !== null;
  return html`
    <aside
      class="dm-aside"
      role="note"
      aria-label=${t('aside.aria')}
      data-state=${answered ? 'answered' : 'pending'}
    >
      <header class="dm-aside-header">
        <span class="dm-aside-rune" aria-hidden="true">🎲</span>
        <span class="dm-aside-title">${t('aside.title')}</span>
        ${onDismiss
          ? html`<button
              class="dm-aside-dismiss"
              type="button"
              aria-label=${t('aside.dismissAria')}
              title=${t('aside.dismiss')}
              @click=${onDismiss}
            >&times;</button>`
          : ''}
      </header>
      <div class="dm-aside-rule" aria-hidden="true">
        <span class="dm-aside-rule-line"></span>
        <span class="dm-aside-rule-pip">◆</span>
        <span class="dm-aside-rule-line"></span>
      </div>
      <div class="dm-aside-thread">
        <div class="dm-aside-turn dm-aside-turn--you" data-role="question">
          <span class="dm-aside-speaker">${t('aside.youAsked')}</span>
          <p class="dm-aside-text dm-aside-text--question">${markdownInline(question)}</p>
        </div>
        ${answered
          ? html`
            <div class="dm-aside-turn dm-aside-turn--dm" data-role="reply">
              <span class="dm-aside-speaker">${t('aside.dm')}</span>
              <p class="dm-aside-text dm-aside-text--reply">${markdownInline(reply)}</p>
            </div>
          `
          : html`
            <div class="dm-aside-turn dm-aside-turn--dm dm-aside-turn--pending" data-role="pending">
              <span class="dm-aside-speaker">${t('aside.dm')}</span>
              <p class="dm-aside-pending">
                ${t('aside.consulting')}<span class="dm-aside-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
              </p>
            </div>
          `}
      </div>
    </aside>
  `;
};
