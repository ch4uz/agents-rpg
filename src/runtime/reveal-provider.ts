/**
 * Gate the start of combat's first turn on the player acknowledging the
 * on-screen initiative ("Order of Battle") reveal.
 *
 * Mirrors {@link RollProvider}: the orchestrator drains `combat_started`,
 * parks the turn cursor on the first combatant, then awaits this provider
 * before dispatching that turn. A browser-backed implementation
 * (`WsAdapter`) ships a `reveal_request` and blocks until the player
 * dismisses the reveal — a Skip click, or the auto-skip timer firing. A
 * missing / disconnected / aborted client resolves immediately so headless,
 * CLI, and AI-only runs proceed without a human in the loop (those paths
 * fall back to the fixed `initiativeRevealDelayMs` sleep instead).
 *
 * Like the roll handshake, the wait is honoured per `requestId` so a stale
 * ack from a prior combat / session never releases a fresh gate. Unlike a
 * roll, there is no wall-clock timeout while a browser is attached: per the
 * spec's "human turn blocks indefinitely" rule, the player is given as long
 * as they want to read the order of battle. Disconnect / abort resolves the
 * wait so a closed tab can't hang the run forever.
 */
export interface RevealProvider {
  /** Resolve once the player has dismissed the initiative reveal, or
   *  immediately if no browser is attached / on disconnect / on abort. */
  awaitInitiativeReveal(requestId: string): Promise<void>;
}
