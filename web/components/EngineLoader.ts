import { html, type TemplateResult } from 'lit-html';
import type { StoreState } from '../store.js';
import type { ActorMap, ActorInfo } from './ChatLog.js';
import { displayName } from './names.js';
import { t } from '../i18n.js';

/** Activity derived purely from the store state. Exposed for unit tests.
 *  (The live streamed thinking text is NOT shown here — it renders as the
 *  in-world thought balloon over the actor's head; see ThoughtBalloon.ts.) */
export interface EngineActivity {
  /** Whether the engine is doing work (drives the spinner animation). */
  busy: boolean;
  /** Primary status line. Always populated, plain text (no emoji). */
  status: string;
}

/** Derive engine activity from the current store state. Pure. */
export const deriveActivity = (
  state: StoreState,
  actors: ActorMap,
): EngineActivity => {
  if (state.ended) {
    const status =
      state.ended.outcome === 'success' ? t('status.endSuccess')
      : state.ended.outcome === 'failure' ? t('status.endFailure')
      : t('status.endAborted');
    return { busy: false, status };
  }

  // This tab's game no longer exists on the server (restart / idle reap) and
  // the client has stopped reconnecting — only a reload makes a fresh claim.
  if (state.sessionGone) {
    return { busy: false, status: t('status.sessionGone') };
  }

  // Waiting in line for a free game slot — the server is hosting its maximum
  // number of concurrent games. The centered queue window (QueueWindow.ts)
  // owns the full story (position, capacity); the banner itself is hidden via
  // `.app[data-queued]` CSS, so this short line only serves screen readers /
  // any surface without that rule.
  if (state.queued) {
    return { busy: true, status: t('status.queued') };
  }

  // Thinking signals take priority — they tell the user a remote LLM call is in flight.
  if (state.thinking.has('dm')) {
    return { busy: true, status: t('status.dmComposing') };
  }
  for (const id of state.thinking) {
    if (id === 'dm') continue;
    const info: ActorInfo | undefined = actors.get(String(id));
    const who = info?.name ?? displayName(String(id));
    const status = info?.kind === 'monster'
      ? t('status.monsterPlanning', { who })
      : t('status.heroChoosing', { who });
    return { busy: true, status };
  }

  // No-one thinking — describe the current turn slot.
  if (state.activeActor === 'dm') {
    return { busy: true, status: t('status.dmPreparing') };
  }
  if (state.activeActor != null) {
    const info = actors.get(String(state.activeActor));
    const who = info?.name ?? displayName(String(state.activeActor));
    if (info?.kind === 'monster') {
      return { busy: true, status: t('status.monsterActing', { who }) };
    }
    if (state.inputUnlocked) {
      return { busy: false, status: t('status.yourTurn', { who }) };
    }
    return { busy: true, status: t('status.resolving', { who }) };
  }

  // No active actor and nothing thinking — engine is between turns.
  if (state.scene) {
    return { busy: true, status: t('status.engineResolving') };
  }
  return { busy: true, status: t('status.connecting') };
};

export interface EngineLoaderProps {
  activity: EngineActivity;
}

/** Top-centre status banner: a pulsing state dot + the current engine status. */
export const engineLoader = (props: EngineLoaderProps): TemplateResult => {
  const { activity } = props;
  const spinnerCls = activity.busy ? 'loader-spinner busy' : 'loader-spinner idle';
  return html`
    <header class="engine-loader" role="status" aria-live="polite" aria-label=${t('status.aria')}>
      <div class="loader-row loader-row-top">
        <span class="loader-spinner-wrap"><span class=${spinnerCls} aria-hidden="true"></span></span>
        <span class="loader-status">${activity.status}</span>
      </div>
    </header>
  `;
};
