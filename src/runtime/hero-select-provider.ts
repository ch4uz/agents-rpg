import type { CharacterId } from '../engine/ids.js';
import type { HeroChoice } from './ws/protocol.js';
import type { GameLanguage } from './language.js';

/**
 * What the player picked on the game-start screen: which hero they control,
 * and (optionally) which game language the run should use. The language pick
 * arrives with the hero pick because both live on the same screen and both
 * must land BEFORE the first LLM call (the LANGUAGE directive sits in the
 * cacheable system band, so it has to be final before any prompt is built).
 */
export interface HeroSelection {
  characterId: CharacterId;
  /** Game language chosen on the select screen; absent = keep the scenario default. */
  language?: GameLanguage;
}

/**
 * Gate the game on the player choosing which of the starting party heroes they
 * control. Fires once, at the very start of the run — before the opening
 * splash and before any turn is dispatched.
 *
 * Mirrors {@link OpeningProvider} / {@link RevealProvider}: a browser-backed
 * implementation (`WsAdapter`) ships a `hero_select_request` carrying the
 * offered {@link HeroChoice}s and blocks until the player picks one (→
 * `hero_select_response`). A missing / disconnected / aborted client resolves
 * to `null`, so the orchestrator keeps the scenario's default human hero and
 * headless / CLI / scripted / AI-only runs proceed with no human in the loop.
 *
 * Like the other game-start gates the wait is honoured per `requestId` and has
 * NO wall-clock timeout while a browser is attached — per the spec's "human
 * turn blocks indefinitely" rule, the player gets as long as they want to
 * choose. Disconnect / abort resolves the wait (to `null`) so a closed tab
 * can't hang the run forever.
 */
export interface HeroSelectProvider {
  /**
   * Resolve with the player's {@link HeroSelection}, or `null` if no browser
   * is attached / on disconnect / on abort (→ caller keeps the scenario
   * defaults). The caller re-validates the returned characterId against the
   * offered options.
   */
  awaitHeroSelection(requestId: string, options: HeroChoice[]): Promise<HeroSelection | null>;
}
