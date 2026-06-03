import { describe, it, expect } from 'vitest';
import {
  computeFrameIndex,
  animationDurationMs,
  DEFAULT_FPS,
  type ActiveAnimation,
} from '../../web/components/Animation.js';

const makeAnim = (overrides: Partial<ActiveAnimation> = {}): ActiveAnimation => ({
  kind: 'walk',
  facing: 'south',
  startMs: 0,
  spec: { frames: 4, fps: 8 },
  loop: false,
  holdLastFrame: false,
  ...overrides,
});

describe('Animation.computeFrameIndex', () => {
  it('returns frame 0, not done, at start', () => {
    const anim = makeAnim();
    expect(computeFrameIndex(anim, 0)).toEqual({ frame: 0, done: false });
  });

  it('advances at the spec fps (frame = floor(elapsed / frameMs))', () => {
    // 8 fps → 125ms per frame. At 130ms → frame 1.
    const anim = makeAnim();
    expect(computeFrameIndex(anim, 130).frame).toBe(1);
    expect(computeFrameIndex(anim, 260).frame).toBe(2);
    expect(computeFrameIndex(anim, 390).frame).toBe(3);
  });

  it('clamps to last frame and reports done=true past the end (non-looping)', () => {
    const anim = makeAnim();  // 4 frames at 8 fps = 500ms total
    expect(computeFrameIndex(anim, 600)).toEqual({ frame: 3, done: true });
    expect(computeFrameIndex(anim, 10_000)).toEqual({ frame: 3, done: true });
  });

  it('wraps modularly when loop=true', () => {
    const anim = makeAnim({ loop: true });
    // After 4 full cycles + frame 2:
    expect(computeFrameIndex(anim, 4 * 500 + 2 * 125).frame).toBe(2);
    expect(computeFrameIndex(anim, 4 * 500 + 2 * 125).done).toBe(false);
  });

  it('treats elapsed before startMs as zero', () => {
    const anim = makeAnim({ startMs: 1000 });
    expect(computeFrameIndex(anim, 500)).toEqual({ frame: 0, done: false });
  });

  it('degenerate 0-frame spec returns done immediately', () => {
    const anim = makeAnim({ spec: { frames: 0, fps: 8 } });
    expect(computeFrameIndex(anim, 0).done).toBe(true);
  });
});

describe('Animation.animationDurationMs', () => {
  it('returns ceil(frames/fps * 1000)', () => {
    expect(animationDurationMs({ frames: 4, fps: 8 })).toBe(500);
    expect(animationDurationMs({ frames: 6, fps: 10 })).toBe(600);
    expect(animationDurationMs({ frames: 7, fps: 8 })).toBe(875);
  });
  it('returns 0 for degenerate specs', () => {
    expect(animationDurationMs({ frames: 0, fps: 8 })).toBe(0);
    expect(animationDurationMs({ frames: 4, fps: 0 })).toBe(0);
  });
});

describe('Animation.DEFAULT_FPS', () => {
  it('defines sensible defaults for every non-idle anim kind', () => {
    expect(DEFAULT_FPS.walk).toBeGreaterThan(0);
    expect(DEFAULT_FPS.attack).toBeGreaterThan(0);
    expect(DEFAULT_FPS.death).toBeGreaterThan(0);
    expect(DEFAULT_FPS.spawn).toBeGreaterThan(0);
  });
});
