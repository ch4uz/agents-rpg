import { html, type TemplateResult } from 'lit-html';
import { t } from '../i18n.js';

/**
 * Centered "waiting for a free game slot" window, shown while the server
 * holds this tab in the session-cap wait line (store.queued — see the
 * `queued` envelope in src/runtime/ws/protocol.ts).
 *
 * It REPLACES the boot stage's other chrome for the duration of the wait:
 * Layout sets `data-queued` on `.app`, which CSS uses to hide both the
 * top status banner (.engine-loader) and the "Summoning the Tale" boot
 * loader — this window is the whole story until the slot frees. When the
 * session is admitted the attach snapshot clears store.queued and the
 * normal boot loader / opening flow takes over.
 *
 * Purely informational: no controls, nothing to dismiss (the wait can only
 * be ended by the server admitting the session or the player leaving), so
 * the overlay keeps pointer-events off. Frame matches the carved-wood +
 * hard-pixel-bevel window language of the survey modal / hero select.
 */
export const queueWindow = (q: { position: number; capacity: number }): TemplateResult => html`
  <div
    class="queue-overlay"
    role="status"
    aria-live="polite"
    aria-label=${t('queue.aria')}
  >
    <div class="queue-window">
      <div class="queue-titlebar">
        <h2 class="queue-title">${t('queue.title')}</h2>
      </div>
      <div class="queue-body">
        <p class="queue-line">
          ${q.capacity === 1
            ? t('queue.lineBefore.one', { capacity: q.capacity })
            : t('queue.lineBefore.many', { capacity: q.capacity })}<strong class="queue-pos">#${q.position}</strong>${t('queue.lineAfter')}
        </p>
        <p class="queue-sub">
          ${t('queue.sub')}<span class="game-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        </p>
      </div>
    </div>
  </div>
`;

/**
 * Centered "this game no longer exists" window, shown when the server refuses
 * a reattach (`rejected: session_gone` → store.sessionGone): the process
 * restarted or the session was reaped/ended while the tab was away. Unlike
 * the queue window it sits ABOVE every other screen (a stale hero select /
 * opening splash / mid-game board may still be on display underneath) and IS
 * interactive — its one button reloads the page, which makes a fresh claim.
 */
export const sessionGoneWindow = (): TemplateResult => html`
  <div
    class="queue-overlay queue-overlay--gone"
    role="alert"
    aria-label=${t('gone.aria')}
  >
    <div class="queue-window">
      <div class="queue-titlebar">
        <h2 class="queue-title">${t('gone.title')}</h2>
      </div>
      <div class="queue-body">
        <p class="queue-line">${t('gone.line')}</p>
        <p class="queue-sub">${t('gone.sub')}</p>
        <button
          class="queue-reload"
          type="button"
          @click=${() => window.location.reload()}
        >${t('gone.reload')}</button>
      </div>
    </div>
  </div>
`;
