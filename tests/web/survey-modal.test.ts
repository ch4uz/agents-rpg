// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'lit-html';
import {
  surveyModal,
  surveyMarkdown,
  createSurveyForm,
  applySurveyAck,
  surveySubmission,
  SURVEY_QUESTIONS,
  EFFORT_QUESTION,
  type SurveyForm,
  type SurveyModalCallbacks,
} from '../../web/components/SurveyModal.js';
import { createStore } from '../../web/store.js';
import { mountLayout } from '../../web/components/Layout.js';

/**
 * Pins the playtest survey (docs/tester-survey.md rendered in-game):
 *   1. The modal shows the five core 1–5 statements, the optional mental-effort
 *      score and "one moment" free text, and the Likert legend.
 *   2. Score buttons select (and re-click to clear) into the caller-owned form.
 *   3. surveyMarkdown serializes answers — em-dash for unanswered, moment as a
 *      blockquote only when filled, run id + date stamped at the bottom.
 *   4. Copy Answers puts that markdown on the clipboard; failure flips to the
 *      "downloaded instead" status rather than losing the answers.
 *   5. Layout renders the floating Survey button BELOW the Log toggle (same
 *      stamped-iron card), opens/closes the modal, and hides the button while
 *      the event-log drawer is open.
 */
describe('SurveyModal', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => { root.remove(); });

  const mount = (
    form: SurveyForm,
    over: Partial<SurveyModalCallbacks> = {},
  ): SurveyModalCallbacks => {
    const cbs: SurveyModalCallbacks = {
      onClose: vi.fn(),
      requestRender: () => render(surveyModal(form, cbs), root),
      ...over,
    } as SurveyModalCallbacks;
    render(surveyModal(form, cbs), root);
    return cbs;
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('starts blank: every score null, empty moment', () => {
    const form = createSurveyForm();
    for (const q of [...SURVEY_QUESTIONS, EFFORT_QUESTION]) {
      expect(form.scores[q.id]).toBeNull();
    }
    expect(form.moment).toBe('');
    expect(form.copyState).toBe('idle');
  });

  it('renders the 5 core questions, the optional section, and the legend', () => {
    mount(createSurveyForm());
    const text = root.textContent ?? '';
    for (const q of SURVEY_QUESTIONS) {
      expect(text).toContain(q.title);
      expect(text).toContain(q.text);
    }
    expect(text).toContain('Optional');
    expect(text).toContain(EFFORT_QUESTION.title);
    expect(text).toContain('One moment');
    expect(text).toContain('1 = Strongly disagree · 3 = Neutral · 5 = Strongly agree');
    expect(root.querySelector('textarea.survey-moment')).not.toBeNull();
    // 6 score rows (5 core + effort), 5 buttons each.
    expect(root.querySelectorAll('.survey-score-row')).toHaveLength(6);
    expect(root.querySelectorAll('.survey-score-btn')).toHaveLength(30);
  });

  it('clicking a score selects it into the form; re-clicking clears it', () => {
    const form = createSurveyForm();
    mount(form);
    const firstRow = root.querySelector('.survey-score-row')!;
    const four = firstRow.querySelectorAll<HTMLButtonElement>('.survey-score-btn')[3]!;
    four.click();
    expect(form.scores[SURVEY_QUESTIONS[0]!.id]).toBe(4);
    expect(four.getAttribute('aria-checked')).toBe('true');
    expect(four.classList.contains('survey-score-btn--selected')).toBe(true);
    four.click();
    expect(form.scores[SURVEY_QUESTIONS[0]!.id]).toBeNull();
    expect(four.getAttribute('aria-checked')).toBe('false');
  });

  it('typing in the moment textarea updates the form', () => {
    const form = createSurveyForm();
    mount(form);
    const ta = root.querySelector<HTMLTextAreaElement>('.survey-moment')!;
    ta.value = 'Kael covered my retreat.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.moment).toBe('Kael covered my retreat.');
  });

  it('surveyMarkdown serializes answers, em-dash for unanswered, stamped footer', () => {
    const form = createSurveyForm();
    form.scores['coordination'] = 4;
    form.scores['trust'] = 5;
    form.scores[EFFORT_QUESTION.id] = 2;
    form.moment = 'Best: the breach\nWorst: nothing';
    const md = surveyMarkdown(form, { sessionId: 'sid-abc', date: '2026-06-03' });
    expect(md).toContain('# Playtest Survey — Hero Kids with AI Teammates');
    expect(md).toContain('1. **AI–AI coordination** — 4 / 5');
    expect(md).toContain('2. **Responsiveness to me** — — / 5');
    expect(md).toContain('5. **Teaming & trust (overall)** — 5 / 5');
    expect(md).toContain('**Mental effort** (optional) — 2 / 5');
    expect(md).toContain('**One moment:**\n> Best: the breach\n> Worst: nothing');
    expect(md).toContain('*Run ID: sid-abc · Date: 2026-06-03*');
  });

  it('surveyMarkdown omits the moment block when empty and dashes a missing run id', () => {
    const md = surveyMarkdown(createSurveyForm(), { date: '2026-06-03' });
    expect(md).not.toContain('One moment');
    expect(md).toContain('*Run ID: — · Date: 2026-06-03*');
  });

  it('Copy Answers writes the serialized markdown to the clipboard', async () => {
    const form = createSurveyForm();
    form.scores['coordination'] = 3;
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    mount(form, {
      writeClipboard,
      sessionId: 'sid-xyz',
      today: () => '2026-06-03',
    });
    root.querySelector<HTMLButtonElement>('.survey-copy')!.click();
    await tick();
    expect(writeClipboard).toHaveBeenCalledWith(
      surveyMarkdown(form, { sessionId: 'sid-xyz', date: '2026-06-03' }),
    );
    expect(form.copyState).toBe('copied');
    expect(root.textContent).toContain('Copied');
  });

  it('a failed clipboard write flips to the downloaded-instead status', async () => {
    const form = createSurveyForm();
    mount(form, { writeClipboard: vi.fn().mockRejectedValue(new Error('denied')) });
    root.querySelector<HTMLButtonElement>('.survey-copy')!.click();
    await tick();
    expect(form.copyState).toBe('failed');
    expect(root.textContent).toContain('downloaded instead');
  });

  it('✕ and backdrop click close; a click inside the window does not', () => {
    const onClose = vi.fn();
    mount(createSurveyForm(), { onClose });
    root.querySelector<HTMLElement>('.survey-window')!.click();
    expect(onClose).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.survey-close')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    root.querySelector<HTMLElement>('.survey-overlay')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders Submit only when an onSubmit host is wired (clipboard-only otherwise)', () => {
    mount(createSurveyForm());
    expect(root.querySelector('.survey-submit')).toBeNull();
    mount(createSurveyForm(), { onSubmit: vi.fn() });
    expect(root.querySelector('.survey-submit')).not.toBeNull();
  });

  it('Submit is disabled until a core score is answered, then ships the payload and flips to sending', () => {
    const form = createSurveyForm();
    const onSubmit = vi.fn();
    mount(form, { onSubmit });
    const submit = root.querySelector<HTMLButtonElement>('.survey-submit')!;
    expect(submit.disabled).toBe(true);
    submit.click();
    expect(onSubmit).not.toHaveBeenCalled();

    // Only the optional effort score → still not submittable.
    form.scores[EFFORT_QUESTION.id] = 3;
    mount(form, { onSubmit });
    expect(root.querySelector<HTMLButtonElement>('.survey-submit')!.disabled).toBe(true);

    form.scores[SURVEY_QUESTIONS[0]!.id] = 4;
    form.moment = '  the breach  ';
    mount(form, { onSubmit });
    const enabled = root.querySelector<HTMLButtonElement>('.survey-submit')!;
    expect(enabled.disabled).toBe(false);
    enabled.click();
    expect(onSubmit).toHaveBeenCalledWith({
      scores: { ...form.scores },
      moment: 'the breach',                     // trimmed (see surveySubmission)
      language: 'en',                           // instrument language (research record)
    });
    expect(form.submitState).toBe('sending');
    expect(root.textContent).toContain('Saving…');
  });

  it('applySurveyAck resolves an in-flight submit by destination and ignores stale acks', () => {
    const form = createSurveyForm();
    form.submitState = 'sending';
    applySurveyAck(form, { seq: 1, ok: true, destination: 'cloud' });
    expect(form.submitState).toBe('saved');
    expect(form.lastAckSeq).toBe(1);

    // The SAME ack again (already consumed) cannot flip a later state.
    form.submitState = 'sending';
    applySurveyAck(form, { seq: 1, ok: false });
    expect(form.submitState).toBe('sending');

    // local destination → saved-local; failure → failed.
    applySurveyAck(form, { seq: 2, ok: true, destination: 'local' });
    expect(form.submitState).toBe('saved-local');
    form.submitState = 'sending';
    applySurveyAck(form, { seq: 3, ok: false, detail: 'no survey handler registered' });
    expect(form.submitState).toBe('failed');

    // An ack with no submit in flight is consumed but changes nothing.
    form.submitState = 'idle';
    applySurveyAck(form, { seq: 4, ok: true, destination: 'cloud' });
    expect(form.submitState).toBe('idle');
    expect(form.lastAckSeq).toBe(4);
    applySurveyAck(form, null);
    expect(form.lastAckSeq).toBe(4);
  });

  it('a saved survey shows Saved ✓ and re-enables Submit only after an edit', () => {
    const form = createSurveyForm();
    form.scores[SURVEY_QUESTIONS[0]!.id] = 5;
    form.submitState = 'saved';
    mount(form, { onSubmit: vi.fn() });
    const submit = root.querySelector<HTMLButtonElement>('.survey-submit')!;
    expect(submit.textContent).toContain('Saved ✓');
    expect(submit.disabled).toBe(true);
    expect(root.textContent).toContain('Saved — thank you!');
    // Editing an answer invalidates the Saved state → submittable again.
    root.querySelector<HTMLButtonElement>('.survey-score-btn')!.click();
    expect(form.submitState).toBe('idle');
  });

  it('surveySubmission copies scores (later form edits cannot mutate the sent payload)', () => {
    const form = createSurveyForm();
    form.scores[SURVEY_QUESTIONS[0]!.id] = 2;
    const payload = surveySubmission(form);
    form.scores[SURVEY_QUESTIONS[0]!.id] = 5;
    expect(payload.scores[SURVEY_QUESTIONS[0]!.id]).toBe(2);
  });
});

describe('Layout — floating Survey button', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => { root.remove(); });

  const seedSnapshot = (store: ReturnType<typeof createStore>) => {
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 's', assetId: 's', gridW: 5, gridH: 5 } as never,
        characters: [
          {
            id: 'h1' as never, name: 'Bran', kind: 'hero', archetype: 'warrior',
            pos: { x: 0, y: 0 },
            health: { total: 3, damage: 0, status: 'normal' },
            pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
            inventory: [], boons: [],
            specialAction: { name: '', description: '' },
            bonusAbility:  { name: '', description: '' },
          },
        ],
        activeActor: 'h1' as never,
        recentChat: [],
      } as never,
    } as never);
  };

  const mountWithSnapshot = () => {
    const store = createStore();
    mountLayout(root, store, { onAction: vi.fn(), onSubmit: vi.fn() }, { sessionId: 'sid-run-1' });
    seedSnapshot(store);
    return store;
  };

  it('renders the Survey button below the Log toggle, sharing its card style', () => {
    mountWithSnapshot();
    const log = root.querySelector('.event-log-toggle:not(.survey-toggle)');
    const survey = root.querySelector<HTMLButtonElement>('.survey-toggle');
    expect(log).not.toBeNull();
    expect(survey).not.toBeNull();
    // Same stamped-iron card class as the Log toggle + its own position class.
    expect(survey!.classList.contains('event-log-toggle')).toBe(true);
    expect(survey!.textContent).toContain('Survey');
    // Rendered as the Log button's sibling, directly after it in DOM order.
    expect(log!.nextElementSibling).toBe(survey);
  });

  it('opens the survey modal on click and closes it again via ✕', () => {
    mountWithSnapshot();
    expect(root.querySelector('.survey-overlay')).toBeNull();
    root.querySelector<HTMLButtonElement>('.survey-toggle')!.click();
    expect(root.querySelector('.survey-overlay')).not.toBeNull();
    // The session id is threaded through for the run-id stamp.
    expect(root.querySelector('.survey-run-id')!.textContent).toContain('sid-run-1');
    root.querySelector<HTMLButtonElement>('.survey-close')!.click();
    expect(root.querySelector('.survey-overlay')).toBeNull();
  });

  it('keeps half-filled answers across close and reopen', () => {
    mountWithSnapshot();
    root.querySelector<HTMLButtonElement>('.survey-toggle')!.click();
    root.querySelector<HTMLButtonElement>('.survey-score-btn')!.click(); // q1 = 1
    root.querySelector<HTMLButtonElement>('.survey-close')!.click();
    root.querySelector<HTMLButtonElement>('.survey-toggle')!.click();
    const first = root.querySelector<HTMLButtonElement>('.survey-score-btn')!;
    expect(first.getAttribute('aria-checked')).toBe('true');
  });

  it('hides the Survey button (with the Log button) while the drawer is open', () => {
    mountWithSnapshot();
    root.querySelector<HTMLButtonElement>('.event-log-toggle:not(.survey-toggle)')!.click();
    expect(root.querySelector('.survey-toggle')).toBeNull();
    root.querySelector<HTMLButtonElement>('.event-log-close')!.click();
    expect(root.querySelector('.survey-toggle')).not.toBeNull();
  });

  it('Submit ships a survey_response payload and the survey_ack flips the modal to Saved ✓', () => {
    const store = createStore();
    const sent: unknown[] = [];
    mountLayout(root, store, {
      onAction: vi.fn(),
      onSubmit: vi.fn(),
      onSurveySubmit: (survey) => sent.push(survey),
    }, { sessionId: 'sid-run-2' });
    // seedSnapshot equivalent (reuse the helper through a fresh store call).
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: { heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {} } as never,
      state: {
        viewer: { kind: 'human' },
        scene: { id: 's', assetId: 's', gridW: 5, gridH: 5 } as never,
        characters: [], activeActor: null, recentChat: [],
      } as never,
    } as never);

    root.querySelector<HTMLButtonElement>('.survey-toggle')!.click();
    root.querySelector<HTMLButtonElement>('.survey-score-btn')!.click(); // q1 = 1
    root.querySelector<HTMLButtonElement>('.survey-submit')!.click();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { scores: Record<string, number | null> }).scores[SURVEY_QUESTIONS[0]!.id]).toBe(1);
    expect(root.textContent).toContain('Saving…');

    // The server's ack arrives through the store → modal shows Saved ✓.
    store.applyEnvelope({ kind: 'survey_ack', ok: true, destination: 'cloud' });
    expect(root.textContent).toContain('Saved — thank you!');
    expect(root.querySelector<HTMLButtonElement>('.survey-submit')!.textContent).toContain('Saved ✓');
  });

  it('store: survey_ack seq increments per ack and survives a reconnect snapshot reset', () => {
    const store = createStore();
    expect(store.getSnapshot().surveyAck).toBeNull();
    store.applyEnvelope({ kind: 'survey_ack', ok: true, destination: 'cloud' });
    expect(store.getSnapshot().surveyAck).toMatchObject({ seq: 1, ok: true, destination: 'cloud' });
    store.applyEnvelope({ kind: 'survey_ack', ok: false, detail: 'nope' });
    expect(store.getSnapshot().surveyAck).toMatchObject({ seq: 2, ok: false, detail: 'nope' });
    // Full attach reset must NOT forget the ack (meta-UI, not engine state).
    store.applyEnvelope({
      kind: 'snapshot',
      viewer: { kind: 'human' },
      manifest: {} as never,
      state: { viewer: { kind: 'human' }, scene: null, characters: [], activeActor: null, recentChat: [] } as never,
    } as never);
    expect(store.getSnapshot().surveyAck).toMatchObject({ seq: 2, ok: false });
  });
});
