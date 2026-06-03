import type { CharacterId } from '../engine/ids.js';
import type { RedactedEvent, Viewer } from './visibility/types.js';
import type { RedactedSnapshot } from '../engine/snapshot.js';

/**
 * A perspective-keyed observer. The orchestrator runs the visibility filter
 * once per (event × subscriber) before invoking onEvent. Subscribers never
 * see raw events; the EventLog is the unredacted source of truth.
 */
export interface Subscriber {
  readonly viewer: Viewer;
  onEvent(event: RedactedEvent): void;
  onTurnStarted?(actorId: CharacterId | 'dm'): void;
  onTurnEnded?(actorId: CharacterId | 'dm'): void;
  /**
   * Optional hook: an LLM call is now in flight on behalf of this actor.
   * Fires AROUND the orchestrator's awaited calls to Agent.takeTurn / react /
   * answerOocQuery. Used by the browser to show "DM is composing the
   * scene…" instead of "Engine resolving turn" during the multi-second gap
   * between one turn's `turn_ended` and the next turn's `turn_started`.
   *
   * Idempotent on the receiver: redundant calls in a single turn (multi-step
   * ReACT loop) are fine — the WS adapter just resends the envelope.
   */
  onThinking?(actorId: CharacterId | 'dm'): void;
  onThinkingDone?(actorId: CharacterId | 'dm'): void;
  /**
   * Incremental thinking text while a streamed LLM turn call generates —
   * runtime display only (never logged; the atomic `thought` event still
   * arrives via onEvent). The browser appends it to the thinking banner so
   * the wait shows live content instead of a bare spinner. Only fires when
   * the LLM client streams; batch runs (tests, scripted) never call it.
   */
  onThinkingDelta?(actorId: CharacterId | 'dm', text: string): void;
  /** Optional async hook called once at orchestrator startup, after subscribers attach. */
  onStart?(): Promise<void> | void;
  /**
   * Optional async hook called when the run ends (success or failure).
   * `reason` distinguishes notable endings for the closing UI — currently
   * `'party_wipe'` (every hero KO'd); absent for ordinary endings.
   */
  onEnd?(outcome: 'success' | 'failure' | 'aborted', reason?: 'party_wipe'): Promise<void> | void;
  /**
   * Optional hook: a fresh full snapshot from the engine. Fires after every
   * scene transition (the engine's grid + obstacles + decorations changed,
   * incremental events alone cannot reproduce the new layout) and is the
   * subscriber's signal to re-render its full view from the snapshot rather
   * than continue applying incremental events on top of stale scene state.
   */
  onSnapshot?(state: RedactedSnapshot): void;
}
