// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  spawnEmojiBalloon,
  EMOTE_BALLOON_HOLD_MS,
  EMOTE_BALLOON_LIFETIME_MS,
} from '../../web/components/EmojiBalloon.js';

describe('spawnEmojiBalloon', () => {
  let overlay: HTMLDivElement;
  // Stub positionAt: writes the grid coords onto the element as data attrs so
  // we can assert that the balloon was positioned without depending on the
  // canvas-scale math from Board.ts.
  const positionAt = (el: HTMLDivElement, gx: number, gy: number): void => {
    el.dataset['gx'] = String(gx);
    el.dataset['gy'] = String(gy);
  };

  beforeEach(() => {
    overlay = document.createElement('div');
    document.body.appendChild(overlay);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    overlay.remove();
  });

  it('mounts a balloon with the emoji glyph and placard SVG into the overlay', () => {
    spawnEmojiBalloon({
      overlayLayer: overlay,
      emoji: '🙀',
      gridX: 2,
      gridY: 3,
      positionAt,
      stackIndex: 0,
    });
    const el = overlay.querySelector('.emote-balloon') as HTMLDivElement;
    expect(el).not.toBeNull();
    expect(el.querySelector('.emote-glyph')!.textContent).toBe('🙀');
    // The placard chrome (body, frame, rivets, tail) lives in an inline
    // SVG mounted as the balloon div's first child.
    expect(el.querySelector('svg.emote-svg')).not.toBeNull();
    expect(el.dataset['gx']).toBe('2');
    expect(el.dataset['gy']).toBe('3');
    expect(el.style.getPropertyValue('--stack-x')).toBe('0px');
    expect(el.style.getPropertyValue('--stack-y')).toBe('0px');
  });

  it('adds the fading class at the hold boundary and removes the node at lifetime', () => {
    spawnEmojiBalloon({
      overlayLayer: overlay,
      emoji: '✨',
      gridX: 0,
      gridY: 0,
      positionAt,
      stackIndex: 0,
    });
    const el = overlay.querySelector('.emote-balloon') as HTMLDivElement;
    expect(el.classList.contains('emote-balloon--fading')).toBe(false);

    vi.advanceTimersByTime(EMOTE_BALLOON_HOLD_MS);
    expect(el.classList.contains('emote-balloon--fading')).toBe(true);
    expect(overlay.contains(el)).toBe(true);

    vi.advanceTimersByTime(EMOTE_BALLOON_LIFETIME_MS - EMOTE_BALLOON_HOLD_MS);
    expect(overlay.contains(el)).toBe(false);
  });

  it('honors the stackIndex by setting per-balloon CSS offsets', () => {
    spawnEmojiBalloon({ overlayLayer: overlay, emoji: '😨', gridX: 0, gridY: 0, positionAt, stackIndex: 0 });
    spawnEmojiBalloon({ overlayLayer: overlay, emoji: '🤔', gridX: 0, gridY: 0, positionAt, stackIndex: 1 });
    const els = overlay.querySelectorAll('.emote-balloon');
    expect(els).toHaveLength(2);
    expect((els[0] as HTMLElement).style.getPropertyValue('--stack-x')).toBe('0px');
    expect((els[1] as HTMLElement).style.getPropertyValue('--stack-x')).toBe('14px');
    expect((els[1] as HTMLElement).style.getPropertyValue('--stack-y')).toBe('-10px');
  });

  it('dispose() force-removes the element and cancels pending timers', () => {
    const handle = spawnEmojiBalloon({
      overlayLayer: overlay,
      emoji: '🎉',
      gridX: 1,
      gridY: 1,
      positionAt,
      stackIndex: 0,
    });
    expect(overlay.querySelector('.emote-balloon')).not.toBeNull();
    handle.dispose();
    expect(overlay.querySelector('.emote-balloon')).toBeNull();
    // Advancing past lifetime must not throw or attempt a double-remove.
    expect(() => vi.advanceTimersByTime(EMOTE_BALLOON_LIFETIME_MS + 100)).not.toThrow();
  });
});
