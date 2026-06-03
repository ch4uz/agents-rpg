/**
 * Beat-pacing gate: hold the start of the next turn until the player has read
 * (and dismissed) every narration / hero-speech beat the previous turn(s)
 * published.
 *
 * This is what makes the in-narrator Skip button actually pace the game.
 * Without it the orchestrator's main loop runs AI / monster / DM turns
 * back-to-back as fast as the LLM answers, streaming their events to the
 * browser while the player is still reading an earlier beat — so the board
 * and turn-order appear to advance "on their own". The gate closes that race:
 * before dispatching each turn the orchestrator awaits this provider, and a
 * browser-backed implementation (`WsAdapter`) blocks until its playback queue
 * has fully drained (Skip clicks, or the auto-skip timer).
 *
 * Mirrors {@link RevealProvider}: honoured per `requestId` so a stale ack
 * never releases a fresh gate, and with no wall-clock timeout while a browser
 * is attached (the player gets as long as they want to read). A missing /
 * disconnected / aborted client resolves immediately, so headless, CLI, and
 * AI-only runs (which configure no `BeatGate`) never pause.
 */
export interface BeatGate {
  /** Resolve once the player has dismissed every queued narration / hero-
   *  speech beat, or immediately if no browser is attached / on disconnect /
   *  on abort. */
  awaitBeatsDrained(requestId: string): Promise<void>;
}
