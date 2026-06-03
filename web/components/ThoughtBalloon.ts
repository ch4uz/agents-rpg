/**
 * Persistent in-world THOUGHT balloon: a small pixel-art cloud with three
 * pulsing dots that floats above a hero's head while their LLM call streams.
 * Hovering the cloud expands it to reveal the hero's live internal thoughts
 * (the streamed `thinking_delta` text); un-hovering collapses it back to dots.
 *
 * Comic-strip convention: a thought balloon trails small circles toward the
 * thinker's head (vs the speech bubble's pointed tail), so it reads as
 * "thinking" at a glance even while collapsed.
 *
 * Like EmojiBalloon, the component only builds DOM — positioning is the
 * caller's job (Board mounts it into the `.mini-bar-layer` overlay and
 * repositions on move/resize; the preview page positions it manually).
 * Unlike EmojiBalloon it is NOT timer-driven: it lives for as long as the
 * actor is thinking (caller disposes on `thinking_done`).
 *
 * Styles live in `web/styles/thought-balloon.css` (imported by the game
 * shell and by the standalone preview `/thought-test.html`).
 */

/** Fade-out duration (ms) — dispose() removes the element after this. Kept in
 *  sync with the `thought-fade` animation in thought-balloon.css. */
export const THOUGHT_BALLOON_FADE_MS = 240;

export interface ThoughtBalloonHandle {
  /** The mounted root element. Position/reposition via the caller. */
  el: HTMLDivElement;
  /**
   * Replace the balloon's accumulated thought text (the caller passes the
   * FULL streamed text so far, not a delta — matches the store's
   * `thinkingText` map). Keeps the expanded view scrolled to the newest
   * words while the stream grows.
   */
  setText(text: string): void;
  /**
   * Fade out (a chunky stepped fade, ~{@link THOUGHT_BALLOON_FADE_MS}ms) and
   * remove from the DOM. The caller invokes this when the actor's thinking
   * ends (`thinking_done`) — the balloon does not outlive the thought.
   * Safe to call twice.
   */
  dispose(): void;
}

/**
 * Reconcile the set of live thought balloons against the store's thinking
 * state — the Board calls this synchronously on every store notification:
 *   - every thinking actor WITH a board token gets a balloon (spawned via the
 *     injected `spawn`, which also positions it) fed the live streamed text;
 *   - the DM (no token) and off-board actors are skipped;
 *   - an actor that stopped thinking has its balloon disposed (fade-out).
 * DOM-free except through the injected callbacks, so it unit-tests with fakes.
 */
export const reconcileThoughtBalloons = (args: {
  /** Actors with an LLM call in flight (store `thinking`). */
  thinking: ReadonlySet<string>;
  /** Live streamed text per actor (store `thinkingText`). */
  thinkingText: ReadonlyMap<string, string>;
  /** Whether this actor has a positionable board token. */
  hasToken: (actorId: string) => boolean;
  /** Live balloons, keyed by actorId. Mutated in place. */
  balloons: Map<string, ThoughtBalloonHandle>;
  /** Spawn (and position) a balloon for this actor. */
  spawn: (actorId: string) => ThoughtBalloonHandle;
}): void => {
  const { thinking, thinkingText, hasToken, balloons, spawn } = args;
  for (const actorId of thinking) {
    if (actorId === 'dm' || !hasToken(actorId)) continue;
    let handle = balloons.get(actorId);
    if (!handle) {
      handle = spawn(actorId);
      balloons.set(actorId, handle);
    }
    handle.setText(thinkingText.get(actorId) ?? '');
  }
  for (const [actorId, handle] of balloons) {
    if (!thinking.has(actorId)) {
      handle.dispose();
      balloons.delete(actorId);
    }
  }
};

export const spawnThoughtBalloon = (opts: {
  /** Overlay element the balloon mounts into. */
  overlayLayer: HTMLElement;
}): ThoughtBalloonHandle => {
  const el = document.createElement('div');
  el.className = 'thought-balloon';

  // Cloud body: dots (collapsed state) + the streamed text (expanded state).
  const cloud = document.createElement('div');
  cloud.className = 'thought-cloud';

  const dots = document.createElement('span');
  dots.className = 'thought-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement('i'));
  cloud.appendChild(dots);

  const text = document.createElement('div');
  text.className = 'thought-text';
  cloud.appendChild(text);

  el.appendChild(cloud);

  // Trailing thought circles, descending toward the thinker's head.
  const trailBig = document.createElement('span');
  trailBig.className = 'thought-trail thought-trail--big';
  const trailSmall = document.createElement('span');
  trailSmall.className = 'thought-trail thought-trail--small';
  el.appendChild(trailBig);
  el.appendChild(trailSmall);

  opts.overlayLayer.appendChild(el);

  let disposed = false;
  return {
    el,
    setText: (t: string): void => {
      if (disposed) return;
      text.textContent = t;
      el.classList.toggle('thought-balloon--has-text', t.trim().length > 0);
      // Follow the stream: keep the newest words in view while expanded.
      text.scrollTop = text.scrollHeight;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      // Swap the entry/bob animation for the reversed fade, then remove once
      // it has played out.
      el.classList.add('thought-balloon--fading');
      window.setTimeout(() => el.remove(), THOUGHT_BALLOON_FADE_MS);
    },
  };
};
