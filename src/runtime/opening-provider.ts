/**
 * Gate the very first DM turn on the player dismissing the adventure's opening
 * splash.
 *
 * Mirrors {@link RevealProvider}: at game start the orchestrator enters the
 * initial scene, publishes the snapshot (which carries `scene.opening`), then —
 * if that scene has an `opening` AND a browser is attached — awaits this
 * provider before letting the DM act. A browser-backed implementation
 * (`WsAdapter`) ships an `opening_request` and blocks until the player clicks
 * "Begin" (→ `opening_ack`). A missing / disconnected / aborted client resolves
 * immediately so headless, CLI, and AI-only runs proceed with no human in the
 * loop (those paths show no splash and let the DM read the intro instead).
 *
 * Like the reveal handshake, the wait is honoured per `requestId` and has NO
 * wall-clock timeout while a browser is attached — per the spec's "human turn
 * blocks indefinitely" rule, the player gets as long as they want on the
 * opening. Disconnect / abort resolves the wait so a closed tab can't hang the
 * run forever.
 */
export interface OpeningProvider {
  /** Resolve once the player has dismissed the opening splash, or immediately
   *  if no browser is attached / on disconnect / on abort. */
  awaitOpeningDismissed(requestId: string): Promise<void>;
}
