/**
 * Sprite-animation state machine. Keeps the per-character animation pure +
 * stateless so the Pixi renderer just maps (anim, frame) → texture.
 *
 * Animation classes:
 *  - walk:  loops while the character is moving along a path.
 *  - attack: one-shot; played when a resolution event lands. Timed to align
 *            with projectile flight + impact label.
 *  - death: one-shot; played when a character transitions to KO. Final
 *           frame holds (no auto-cleanup) so the corpse stays visible.
 *  - spawn: one-shot; played on first sight (hero start, monster reveal).
 */

import type { Facing } from './Facing.js';

export type AnimKind = 'idle' | 'walk' | 'attack' | 'death' | 'spawn';

export interface AnimationSpec {
  frames: number;
  fps: number;
}

/**
 * In-flight animation for one character.
 *  - kind: which animation is playing,
 *  - facing: which directional strip to sample,
 *  - startMs: performance.now() when the animation began,
 *  - loop: true → modular wrap; false → clamp on last frame.
 *  - holdLastFrame: when loop=false, freeze on the last frame instead of
 *    returning to idle. Used for death so the corpse stays visible.
 */
export interface ActiveAnimation {
  kind: AnimKind;
  facing: Facing;
  startMs: number;
  spec: AnimationSpec;
  loop: boolean;
  holdLastFrame: boolean;
}

/**
 * Pure: compute the frame index to render at `nowMs`. Loops modularly when
 * `loop=true`. When `loop=false`, clamps at the last frame, returning a
 * sentinel `done=true` on the frame after the last so callers can drop the
 * animation (or hold it if `holdLastFrame`).
 */
export const computeFrameIndex = (
  anim: ActiveAnimation,
  nowMs: number,
): { frame: number; done: boolean } => {
  const elapsedMs = Math.max(0, nowMs - anim.startMs);
  const totalFrames = anim.spec.frames;
  if (totalFrames <= 0) return { frame: 0, done: true };
  const frameMs = 1000 / Math.max(1, anim.spec.fps);
  const rawFrame = Math.floor(elapsedMs / frameMs);
  if (anim.loop) {
    return { frame: rawFrame % totalFrames, done: false };
  }
  if (rawFrame >= totalFrames) {
    return { frame: totalFrames - 1, done: true };
  }
  return { frame: rawFrame, done: false };
};

/**
 * Pure: how long a one-shot animation takes to finish at its native fps.
 * Used by the renderer to schedule attack timing against projectile flight.
 */
export const animationDurationMs = (spec: AnimationSpec): number => {
  if (spec.frames <= 0 || spec.fps <= 0) return 0;
  return Math.ceil((spec.frames / spec.fps) * 1000);
};

/** Default fps for each animation kind when no per-character override exists. */
export const DEFAULT_FPS: Record<Exclude<AnimKind, 'idle'>, number> = {
  walk: 8,
  attack: 10,
  death: 8,
  spawn: 6,
};
