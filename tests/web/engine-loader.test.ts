// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import {
  deriveActivity,
  engineLoader,
} from '../../web/components/EngineLoader.js';
import type { StoreState } from '../../web/store.js';
import type { ActorMap, ActorInfo } from '../../web/components/ChatLog.js';
import type { CharacterId } from '../../src/engine/ids.js';

const baseState = (over: Partial<StoreState> = {}): StoreState => ({
  scene: null,
  characters: [],
  props: [],
  activeActor: null,
  chat: [],
  thinking: new Set(),
  thinkingText: new Map(),
  inputUnlocked: false,
  hasMoved: false,
  hasActed: false,
  inCombat: false,
  pendingBeatGate: null,
  queued: null,
  sessionGone: false,
  awaitingHeroSelect: false,
  surveyAck: null,
  physicsActive: false,
  ...over,
});

const actorsOf = (entries: Array<[string, ActorInfo]>): ActorMap =>
  new Map<string, ActorInfo>([['dm', { name: 'DM', kind: 'dm' }], ...entries]);

/** Matches any emoji / pictographic glyph — the status line must stay plain text. */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('deriveActivity', () => {
  it('reports busy while DM is thinking', () => {
    const s = baseState({ thinking: new Set<CharacterId | 'dm'>(['dm']) });
    const a = deriveActivity(s, actorsOf([]));
    expect(a.busy).toBe(true);
    expect(a.status).toMatch(/DM is composing/i);
  });

  it('reports busy while a hero agent is thinking', () => {
    const s = baseState({ thinking: new Set<CharacterId | 'dm'>(['h1' as CharacterId]) });
    const actors = actorsOf([['h1', { name: 'Bran', kind: 'hero', archetype: 'warrior' }]]);
    const a = deriveActivity(s, actors);
    expect(a.busy).toBe(true);
    expect(a.status).toContain('Bran');
    expect(a.status).toMatch(/choosing an action/i);
  });

  it('reports busy while a monster is acting', () => {
    const s = baseState({
      activeActor: 'rat-1' as CharacterId,
      thinking: new Set(),
    });
    const actors = actorsOf([['rat-1', { name: 'Giant Rat', kind: 'monster' }]]);
    const a = deriveActivity(s, actors);
    expect(a.busy).toBe(true);
    expect(a.status).toContain('Giant Rat');
  });

  it('reports idle and awaits player when input is unlocked for a hero', () => {
    const s = baseState({
      activeActor: 'h1' as CharacterId,
      inputUnlocked: true,
    });
    const actors = actorsOf([['h1', { name: 'Bran', kind: 'hero', archetype: 'warrior' }]]);
    const a = deriveActivity(s, actors);
    expect(a.busy).toBe(false);
    expect(a.status).toContain('Bran');
    expect(a.status).toMatch(/awaiting your move/i);
  });

  it('shows a short waiting line while queued (the queue WINDOW owns the details)', () => {
    const s = baseState({ queued: { position: 2, capacity: 3 } });
    const a = deriveActivity(s, actorsOf([]));
    expect(a.busy).toBe(true);
    expect(a.status).toMatch(/waiting for a free game slot/i);
    // The position/capacity story lives in the centered QueueWindow, not here —
    // the long banner line truncated on narrow screens.
    expect(a.status).not.toContain('#2');
  });

  it('asks for a reload when the session is gone (server restart / idle reap)', () => {
    const s = baseState({ sessionGone: true });
    const a = deriveActivity(s, actorsOf([]));
    expect(a.busy).toBe(false);
    expect(a.status).toMatch(/reload the page/i);
  });

  it('renders the encounter-complete status when ended=success', () => {
    const s = baseState({ ended: { outcome: 'success' } });
    const a = deriveActivity(s, actorsOf([]));
    expect(a.busy).toBe(false);
    expect(a.status).toMatch(/heroes prevail/i);
  });

  it('never decorates the status with emoji', () => {
    const actors = actorsOf([
      ['h1', { name: 'Bran', kind: 'hero', archetype: 'warrior' }],
      ['rat-1', { name: 'Giant Rat', kind: 'monster' }],
    ]);
    const cases: StoreState[] = [
      baseState({ thinking: new Set<CharacterId | 'dm'>(['dm']) }),
      baseState({ thinking: new Set<CharacterId | 'dm'>(['h1' as CharacterId]) }),
      baseState({ activeActor: 'dm' }),
      baseState({ activeActor: 'rat-1' as CharacterId }),
      baseState({ activeActor: 'h1' as CharacterId, inputUnlocked: true }),
      baseState({ activeActor: 'h1' as CharacterId }),
      baseState({ ended: { outcome: 'success' } }),
      baseState({ ended: { outcome: 'failure' } }),
      baseState({ ended: { outcome: 'aborted' } }),
      baseState(),
    ];
    for (const s of cases) {
      expect(deriveActivity(s, actors).status).not.toMatch(EMOJI_RE);
    }
  });
});

describe('engineLoader template', () => {
  const renderLoader = (props: Parameters<typeof engineLoader>[0]): HTMLElement => {
    const div = document.createElement('div');
    render(engineLoader(props), div);
    return div;
  };

  it('renders the spinner with busy class when activity.busy is true', () => {
    const el = renderLoader({
      activity: { busy: true, status: 'DM is composing the scene…' },
    });
    expect(el.querySelector('.loader-spinner.busy')).not.toBeNull();
    expect(el.querySelector('.loader-spinner.idle')).toBeNull();
  });

  it('renders the spinner with idle class when activity.busy is false', () => {
    const el = renderLoader({
      activity: { busy: false, status: "Bran's turn — awaiting your move" },
    });
    expect(el.querySelector('.loader-spinner.idle')).not.toBeNull();
    expect(el.querySelector('.loader-spinner.busy')).toBeNull();
  });

  it('renders the current status text', () => {
    const el = renderLoader({
      activity: { busy: true, status: 'DM is preparing…' },
    });
    expect(el.querySelector('.loader-status')?.textContent).toContain('DM is preparing');
  });

  it('does not render a last-event row', () => {
    const el = renderLoader({
      activity: { busy: true, status: 'Connecting to engine…' },
    });
    expect(el.querySelector('.loader-row-bottom')).toBeNull();
  });

  it('has role="status" with aria-live="polite" for screen readers', () => {
    const el = renderLoader({
      activity: { busy: false, status: 'idle' },
    });
    const header = el.querySelector('.engine-loader');
    expect(header?.getAttribute('role')).toBe('status');
    expect(header?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('deriveActivity — streamed thinking does NOT render in the banner', () => {
  it('keeps the status line plain while a hero streams (the thought balloon owns the text)', () => {
    const actors: ActorMap = new Map<string, ActorInfo>([
      ['p1', { name: 'Gareth', kind: 'hero' } as ActorInfo],
    ]);
    const state = baseState({
      thinking: new Set(['p1' as CharacterId]),
      thinkingText: new Map([['p1' as CharacterId, 'The king rat is at 2 HP — flank and strike.']]),
    });
    const a = deriveActivity(state, actors);
    expect(a.status).toMatch(/Gareth is choosing an action/);
    expect(a.status).not.toMatch(/king rat/);
    expect('liveThought' in a).toBe(false);
  });
});
