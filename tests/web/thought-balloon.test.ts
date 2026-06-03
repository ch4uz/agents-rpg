// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  spawnThoughtBalloon,
  reconcileThoughtBalloons,
  THOUGHT_BALLOON_FADE_MS,
  type ThoughtBalloonHandle,
} from '../../web/components/ThoughtBalloon.js';

afterEach(() => { vi.useRealTimers(); });

describe('spawnThoughtBalloon', () => {
  it('mounts the cloud + dots + trail, toggles has-text with setText', () => {
    const layer = document.createElement('div');
    const h = spawnThoughtBalloon({ overlayLayer: layer });
    expect(layer.querySelector('.thought-balloon')).toBe(h.el);
    expect(h.el.querySelector('.thought-dots')?.children.length).toBe(3);
    expect(h.el.querySelectorAll('.thought-trail')).toHaveLength(2);
    expect(h.el.classList.contains('thought-balloon--has-text')).toBe(false);

    h.setText('flank the rat');
    expect(h.el.classList.contains('thought-balloon--has-text')).toBe(true);
    expect(h.el.querySelector('.thought-text')?.textContent).toBe('flank the rat');

    h.setText('   ');
    expect(h.el.classList.contains('thought-balloon--has-text')).toBe(false);
  });

  it('dispose() fades out, then removes after THOUGHT_BALLOON_FADE_MS', () => {
    vi.useFakeTimers();
    const layer = document.createElement('div');
    document.body.appendChild(layer);  // isConnected requires a documented tree
    const h = spawnThoughtBalloon({ overlayLayer: layer });
    h.dispose();
    // Still mounted, but fading.
    expect(h.el.isConnected).toBe(true);
    expect(h.el.classList.contains('thought-balloon--fading')).toBe(true);
    vi.advanceTimersByTime(THOUGHT_BALLOON_FADE_MS);
    expect(h.el.isConnected).toBe(false);
    // Idempotent.
    h.dispose();
  });
});

describe('reconcileThoughtBalloons', () => {
  const fakeHandle = (): ThoughtBalloonHandle & { texts: string[]; disposed: boolean } => {
    const f = {
      el: document.createElement('div'),
      texts: [] as string[],
      disposed: false,
      setText: (t: string) => { f.texts.push(t); },
      dispose: () => { f.disposed = true; },
    };
    return f;
  };

  it('spawns for thinking on-board actors, feeds text, skips dm/off-board, disposes the finished', () => {
    const balloons = new Map<string, ThoughtBalloonHandle>();
    const spawned: string[] = [];
    const handles = new Map<string, ReturnType<typeof fakeHandle>>();
    const spawn = (id: string) => {
      const h = fakeHandle();
      handles.set(id, h);
      spawned.push(id);
      return h;
    };
    const hasToken = (id: string) => id !== 'ghost';

    // Round 1: p1 thinking with streamed text; dm thinking (no token concept);
    // ghost thinking but off-board.
    reconcileThoughtBalloons({
      thinking: new Set(['p1', 'dm', 'ghost']),
      thinkingText: new Map([['p1', 'flank!']]),
      hasToken, balloons, spawn,
    });
    expect(spawned).toEqual(['p1']);
    expect(handles.get('p1')!.texts).toEqual(['flank!']);

    // Round 2: more text streams in — same balloon, no respawn.
    reconcileThoughtBalloons({
      thinking: new Set(['p1']),
      thinkingText: new Map([['p1', 'flank! now!']]),
      hasToken, balloons, spawn,
    });
    expect(spawned).toEqual(['p1']);
    expect(handles.get('p1')!.texts).toEqual(['flank!', 'flank! now!']);

    // Round 3: p1 done thinking → disposed (fade) and dropped from the map.
    reconcileThoughtBalloons({
      thinking: new Set<string>(),
      thinkingText: new Map<string, string>(),
      hasToken, balloons, spawn,
    });
    expect(handles.get('p1')!.disposed).toBe(true);
    expect(balloons.size).toBe(0);
  });
});
