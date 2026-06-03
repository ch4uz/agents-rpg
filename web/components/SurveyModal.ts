import { html, type TemplateResult } from 'lit-html';
import type { SurveySubmission } from '../../src/runtime/ws/protocol.js';
import { t, getLanguage, hasMessage } from '../i18n.js';

/**
 * Playtest survey modal — the in-game rendering of `docs/tester-survey.md`.
 *
 * Opened from the floating Survey button (below the Log toggle). The tester
 * scores the five teaming statements (1–5 Likert), optionally rates mental
 * effort and describes one coordination moment, then hits "Submit" — which
 * ships the answers to the server as a `survey_response` (persisted into the
 * run dir + the project's GCS bucket; the `survey_ack` reply drives the
 * Saved ✓ / failed status via {@link applySurveyAck}). "Copy" remains as the
 * clipboard fallback: it serializes the filled survey to markdown (stamped
 * with the session id and date, so a pasted reply can be matched to its run).
 * The form state lives in a {@link SurveyForm} owned by the caller (Layout),
 * so a closed-and-reopened modal keeps its half-filled answers.
 */

export interface SurveyQuestion {
  /** Stable key into {@link SurveyForm.scores}. */
  id: string;
  /** Short label, e.g. "AI–AI coordination". */
  title: string;
  /** The full statement the tester scores. */
  text: string;
}

/** The five core statements, verbatim from docs/tester-survey.md. */
export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    id: 'coordination',
    title: 'AI–AI coordination',
    text: 'The two AI heroes worked together as a team — they set up and built on each other’s moves instead of acting solo.',
  },
  {
    id: 'responsiveness',
    title: 'Responsiveness to me',
    text: 'The AI heroes noticed what I did and said, and adjusted their actions to it within a turn or two.',
  },
  {
    id: 'communication',
    title: 'Communication usefulness',
    text: 'What the heroes said was actually helpful for coordinating (calling plays, answering mine) — not just flavor chatter.',
  },
  {
    id: 'persona',
    title: 'Persona distinctiveness',
    text: 'Each hero felt like a distinct, consistent character — I could tell them apart by how they spoke and fought.',
  },
  {
    id: 'trust',
    title: 'Teaming & trust (overall)',
    text: 'Overall, the AI heroes felt like real teammates I could rely on; I’d happily play with them again.',
  },
];

/** The optional mental-effort score (its scale is inverted vs the core five). */
export const EFFORT_QUESTION: SurveyQuestion = {
  id: 'effort',
  title: 'Mental effort',
  text: 'How mentally demanding was it to coordinate with the AI heroes? (1 = effortless · 5 = very demanding)',
};

/** Localized question title/text, keyed by the question's stable id (the
 *  i18n catalogue mirrors docs/tester-survey.md in both languages). Unknown
 *  ids fall back to the English constants above, so the canonical EN render
 *  is byte-identical to the original instrument. */
const qTitle = (q: SurveyQuestion): string => {
  const key = `survey.q.${q.id}.title`;
  return hasMessage(key) ? t(key) : q.title;
};
const qText = (q: SurveyQuestion): string => {
  const key = `survey.q.${q.id}.text`;
  return hasMessage(key) ? t(key) : q.text;
};

const SCORES = [1, 2, 3, 4, 5] as const;

export interface SurveyForm {
  /** Picked score per question id (core five + effort); null = unanswered. */
  scores: Record<string, number | null>;
  /** Free-text "one moment" answer. */
  moment: string;
  /** Feedback state of the Copy answers button. */
  copyState: 'idle' | 'copied' | 'failed';
  /** Lifecycle of the Submit-to-server flow. `saved` = persisted to the GCS
   *  bucket; `saved-local` = only the server's run dir (cloud unavailable);
   *  `failed` steers the tester to the clipboard fallback. */
  submitState: 'idle' | 'sending' | 'saved' | 'saved-local' | 'failed';
  /** Highest store `surveyAck.seq` already consumed (see applySurveyAck). */
  lastAckSeq: number;
}

/** A blank survey. Owned by the caller so answers survive close/reopen. */
export const createSurveyForm = (): SurveyForm => ({
  scores: Object.fromEntries(
    [...SURVEY_QUESTIONS, EFFORT_QUESTION].map((q) => [q.id, null]),
  ),
  moment: '',
  copyState: 'idle',
  submitState: 'idle',
  lastAckSeq: 0,
});

/** The store's `surveyAck` shape (see web/store.ts). */
export interface SurveyAck {
  seq: number;
  ok: boolean;
  destination?: 'cloud' | 'local';
  detail?: string;
}

/**
 * Reconcile the server's latest `survey_ack` into the form. Called by Layout
 * on every render (the ack may arrive while the modal is closed). An ack is
 * consumed at most once (`lastAckSeq`), and only resolves an in-flight
 * submit — a stale ack from before this form's submit can't flip its state.
 */
export const applySurveyAck = (form: SurveyForm, ack: SurveyAck | null | undefined): void => {
  if (!ack || ack.seq <= form.lastAckSeq) return;
  form.lastAckSeq = ack.seq;
  if (form.submitState !== 'sending') return;
  form.submitState = ack.ok
    ? (ack.destination === 'cloud' ? 'saved' : 'saved-local')
    : 'failed';
};

/** The wire payload for a Submit click — answers only; the server stamps
 *  run id / sid / time itself. `language` records which wording of the
 *  instrument the tester actually read (research-record integrity). */
export const surveySubmission = (form: SurveyForm): SurveySubmission => ({
  scores: { ...form.scores },
  moment: form.moment.trim(),
  language: getLanguage(),
});

/** Serialize the (possibly partial) answers to a paste-ready markdown block.
 *  Unanswered scores render as an em-dash so partial submissions stay honest. */
export const surveyMarkdown = (
  form: SurveyForm,
  opts: { sessionId?: string; date: string },
): string => {
  const score = (id: string): string => {
    const v = form.scores[id];
    return `${v ?? '—'} / 5`;
  };
  const lines = [
    t('survey.mdHeader'),
    '',
    ...SURVEY_QUESTIONS.map((q, i) => `${i + 1}. **${qTitle(q)}** — ${score(q.id)}`),
    '',
    `**${qTitle(EFFORT_QUESTION)}** ${t('survey.mdOptional')} — ${score(EFFORT_QUESTION.id)}`,
  ];
  if (form.moment.trim().length > 0) {
    lines.push('', `**${t('survey.oneMoment')}:**`, `> ${form.moment.trim().replace(/\n/g, '\n> ')}`);
  }
  lines.push('', t('survey.mdFooter', { id: opts.sessionId ?? '—', date: opts.date }));
  return lines.join('\n');
};

export interface SurveyModalCallbacks {
  /** Dismiss the modal (✕ button or backdrop click). Answers are kept. */
  onClose(): void;
  /** Re-render the host after a form mutation. */
  requestRender(): void;
  /** Ship the answers to the server (`survey_response`). Absent (no WS host
   *  wired) → the Submit button is not rendered; clipboard-only mode. */
  onSubmit?(submission: SurveySubmission): void;
  /** Stamped into the copied markdown so the reply can be matched to its run. */
  sessionId?: string;
  /** Injectable clipboard write (tests). Default: navigator.clipboard. */
  writeClipboard?(text: string): Promise<void>;
  /** Injectable date stamp (tests). Default: today as YYYY-MM-DD. */
  today?(): string;
}

const defaultWriteClipboard = (text: string): Promise<void> => {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip || typeof clip.writeText !== 'function') {
    return Promise.reject(new Error('clipboard unavailable'));
  }
  return clip.writeText(text);
};

/** Clipboard-less fallback: offer the markdown as a downloaded .md file so a
 *  filled survey is never lost to a denied clipboard permission. */
const downloadMarkdown = (text: string): void => {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'playtest-survey.md';
  a.click();
  URL.revokeObjectURL(url);
};

/** Submit needs a host to send to, no in-flight send, an un-saved edit, and
 *  at least one core statement answered (an all-blank survey says nothing). */
const submittable = (form: SurveyForm): boolean =>
  form.submitState !== 'sending' &&
  form.submitState !== 'saved' &&
  form.submitState !== 'saved-local' &&
  SURVEY_QUESTIONS.some((q) => form.scores[q.id] !== null);

const submitLabel = (form: SurveyForm): string => {
  switch (form.submitState) {
    case 'sending': return t('survey.saving');
    case 'saved':
    case 'saved-local': return t('survey.savedBtn');
    default: return t('survey.submit');
  }
};

/** One status line; the Submit lifecycle outranks the clipboard one. */
const footerStatus = (form: SurveyForm): string => {
  switch (form.submitState) {
    case 'sending': return t('survey.saving');
    case 'saved': return t('survey.savedThanks');
    case 'saved-local': return t('survey.savedLocal');
    case 'failed': return t('survey.failed');
    default: break;
  }
  if (form.copyState === 'copied') return t('survey.copied');
  if (form.copyState === 'failed') return t('survey.clipboardBlocked');
  return '';
};

const scoreRow = (
  form: SurveyForm,
  q: SurveyQuestion,
  cb: SurveyModalCallbacks,
): TemplateResult => html`
  <div class="survey-score-row" role="radiogroup" aria-label=${t('survey.scoreAria', { title: qTitle(q) })}>
    ${SCORES.map((n) => {
      const selected = form.scores[q.id] === n;
      return html`
        <button
          class=${selected ? 'survey-score-btn survey-score-btn--selected' : 'survey-score-btn'}
          type="button"
          role="radio"
          aria-checked=${selected ? 'true' : 'false'}
          @click=${() => {
            // Click the picked score again to clear it back to unanswered.
            form.scores[q.id] = selected ? null : n;
            form.copyState = 'idle';
            // An edited answer invalidates a previous Saved ✓ — allow
            // re-submitting (an in-flight send keeps its state).
            if (form.submitState !== 'sending') form.submitState = 'idle';
            cb.requestRender();
          }}
        >${n}</button>
      `;
    })}
  </div>
`;

const question = (
  form: SurveyForm,
  q: SurveyQuestion,
  index: number | null,
  cb: SurveyModalCallbacks,
): TemplateResult => html`
  <div class="survey-q">
    <div class="survey-q-title">${index === null ? '' : `${index}. `}${qTitle(q)}</div>
    <div class="survey-q-text">${qText(q)}</div>
    ${scoreRow(form, q, cb)}
  </div>
`;

export const surveyModal = (
  form: SurveyForm,
  cb: SurveyModalCallbacks,
): TemplateResult => {
  const onCopy = async (): Promise<void> => {
    const md = surveyMarkdown(form, {
      ...(cb.sessionId !== undefined ? { sessionId: cb.sessionId } : {}),
      date: (cb.today ?? (() => new Date().toISOString().slice(0, 10)))(),
    });
    try {
      await (cb.writeClipboard ?? defaultWriteClipboard)(md);
      form.copyState = 'copied';
    } catch {
      form.copyState = 'failed';
      downloadMarkdown(md);
    }
    cb.requestRender();
  };

  return html`
    <div
      class="survey-overlay"
      @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) cb.onClose(); }}
    >
      <div class="survey-window" role="dialog" aria-modal="true" aria-label=${t('survey.aria')}>
        <div class="survey-titlebar">
          <h2 class="survey-title">${t('survey.title')}</h2>
          <button
            class="survey-close"
            type="button"
            aria-label=${t('survey.closeAria')}
            @click=${() => cb.onClose()}
          >✕</button>
        </div>
        <div class="survey-body">
          <p class="survey-intro">
            ${t('survey.intro')}
          </p>
          <p class="survey-legend">${t('survey.legend')}</p>
          ${SURVEY_QUESTIONS.map((q, i) => question(form, q, i + 1, cb))}
          <div class="survey-divider">${t('survey.optional')}</div>
          ${question(form, EFFORT_QUESTION, null, cb)}
          <div class="survey-q">
            <div class="survey-q-title">${t('survey.oneMoment')}</div>
            <div class="survey-q-text">
              ${t('survey.momentText')}
            </div>
            <textarea
              class="survey-moment"
              rows="3"
              placeholder=${t('survey.momentPlaceholder')}
              .value=${form.moment}
              @input=${(e: Event) => {
                form.moment = (e.target as HTMLTextAreaElement).value;
                form.copyState = 'idle';
                if (form.submitState !== 'sending') form.submitState = 'idle';
              }}
            ></textarea>
          </div>
        </div>
        <div class="survey-footer">
          <span class="survey-run-id">${cb.sessionId ? t('survey.run', { id: cb.sessionId }) : ''}</span>
          <span class="survey-copy-status" aria-live="polite">${footerStatus(form)}</span>
          <button
            class="survey-copy survey-copy--secondary"
            type="button"
            title=${t('survey.copyTitle')}
            @click=${() => { void onCopy(); }}
          >${t('survey.copy')}</button>
          ${cb.onSubmit
            ? html`
                <button
                  class="survey-submit"
                  type="button"
                  ?disabled=${!submittable(form)}
                  @click=${() => {
                    if (!submittable(form)) return;
                    form.submitState = 'sending';
                    cb.onSubmit!(surveySubmission(form));
                    cb.requestRender();
                  }}
                >${submitLabel(form)}</button>
              `
            : ''}
        </div>
      </div>
    </div>
  `;
};
