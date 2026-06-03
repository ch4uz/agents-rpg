import { html, type TemplateResult } from 'lit-html';
import { t, type MessageKey } from '../i18n.js';

/** Outcome carried by the server's `end` envelope (see ws/protocol.ts). */
export type EndOutcome = 'success' | 'failure' | 'aborted';

/** Dramatic title per outcome. Kept kid-friendly (HeroKids is for 9-year-olds)
 *  and mirrors the engine-loader's end-of-run status copy without repeating it
 *  verbatim — the loader header states the facts, this banner is the flourish. */
const TITLE_KEY: Record<EndOutcome, MessageKey> = {
  success: 'end.success',
  failure: 'end.failure',
  aborted: 'end.aborted',
};

/**
 * Closing "The End" card. Mounted into `.board-stage` (over the faded-out board
 * canvas) when the adventure ends — i.e. the server has sent the `end` envelope
 * after the last scene's `all-monsters-ko → END` transition (the king rat
 * dies). The board hides and the narrator window is dropped (Layout.ts), so this
 * banner is the entire closing screen — no leftover DM narration or hero speech
 * text beneath it.
 *
 * Visual language matches the "Summoning the Tale" loading panel: gold pixel
 * title (Jersey 10) flanked by hairline gold rules with a diamond pip — so the
 * run opens and closes on the same wood-and-gold note.
 */
export const endingBanner = (outcome: EndOutcome): TemplateResult => html`
  <div class="ending-banner" data-outcome=${outcome} role="status" aria-live="polite">
    <div class="ending-rule" aria-hidden="true">
      <span class="rule-line"></span>
      <span class="rule-pip">◆</span>
      <span class="rule-line"></span>
    </div>
    <h2 class="ending-title">${t(TITLE_KEY[outcome])}</h2>
    <p class="ending-subtitle">${t('end.theEnd')}</p>
    <div class="ending-rule" aria-hidden="true">
      <span class="rule-line"></span>
      <span class="rule-pip">◆</span>
      <span class="rule-line"></span>
    </div>
  </div>
`;
