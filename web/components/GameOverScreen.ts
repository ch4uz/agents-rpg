import { html, type TemplateResult } from 'lit-html';
import { t } from '../i18n.js';

/**
 * Dedicated GAME OVER screen — shown when the run ends because every hero was
 * KO'd (the server's `end` envelope with `reason: 'party_wipe'`, emitted by the
 * orchestrator's maybeDetectPartyWipe, the defeat analog of the all-monsters-ko
 * victory). Distinct from the gentle gold "The Heroes Fall" ending banner used
 * for ordinary failures: a party wipe is the classic arcade game-over, so it
 * gets the punchier treatment — the Jersey 10 combat font (same family as the
 * HIT!/MISS callouts and the "To Arms!" splash) in defeat embers, over a darker
 * board takeover, naming the heroes who fell.
 *
 * Mounted into `.board-stage` over the faded-out board canvas (Layout.ts), with
 * the narrator window dropped, so this is the entire closing screen — no
 * leftover DM narration beneath it. There is intentionally no functional
 * "restart" affordance: the WS-driven session has ended server-side, so the
 * screen only points the player at reloading to begin a fresh tale.
 *
 * @param fallen display names of the heroes who fell, in party order.
 */
export const gameOverScreen = (fallen: readonly string[]): TemplateResult => html`
  <div class="game-over" role="status" aria-live="polite">
    <div class="game-over-skull" aria-hidden="true">☠</div>
    <h2 class="game-over-title">${t('gameOver.title')}</h2>
    <p class="game-over-sub">${t('gameOver.sub')}</p>
    ${fallen.length > 0
      ? html`<ul class="game-over-fallen" aria-label=${t('gameOver.fallenAria')}>
          ${fallen.map((name) => html`<li class="game-over-fallen-name">${name}</li>`)}
        </ul>`
      : ''}
    <div class="game-over-rule" aria-hidden="true">
      <span class="rule-line"></span>
      <span class="rule-pip">◆</span>
      <span class="rule-line"></span>
    </div>
    <p class="game-over-hint">${t('gameOver.hint')}</p>
  </div>
`;
