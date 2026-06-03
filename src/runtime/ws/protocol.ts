import type { CharacterId } from '../../engine/ids.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { RedactedSnapshot } from '../../engine/snapshot.js';
import type { AssetManifest } from './manifest.js';
import type { PlayerAction } from '../../engine/action.js';
import { isGameLanguage, type GameLanguage } from '../language.js';

/**
 * One selectable hero on the game-start "Choose your hero" screen. Carries
 * everything a card needs to render (portrait, name, archetype, flavor blurb,
 * stats, and the signature attack / special / bonus) so the browser does not
 * have to cross-reference the snapshot or a catalog. Built server-side in
 * `bin/play.ts` from the scenario's starting party + the hero catalog.
 */
export interface HeroChoice {
  characterId: CharacterId;
  /** Display name (e.g. "Gareth") — the in-fiction identity the player adopts. */
  name: string;
  /** Per-language display names keyed by language code (e.g.
   *  `{ "pt": "Heitor" }`), when the scenario declares them. The chooser
   *  renders the active language's name; the ENGINE name flips to it once
   *  the language pick lands (see `OrchestratorConfig.nameOverrides`). */
  names?: Record<string, string>;
  archetype: string;
  /** Assets-relative south-facing portrait path, e.g. "heroes/warrior/south.png". */
  spritePath: string;
  blurb: string;
  health: number;
  pools: { melee: number; ranged: number; magic: number; armor: number };
  dex: number;
  normalAttack: { name: string; kind: string; range: number };
  specialAction: { name: string; description: string };
  bonusAbility: { name: string; description: string };
}

/**
 * A filled (possibly partial) playtest survey from the browser's Survey modal
 * (docs/tester-survey.md). `scores` is keyed by question id (the five core
 * teaming statements + the optional mental-effort score); `null` = unanswered.
 * The server stamps run id / sid / time itself — the client only ships answers.
 */
export interface SurveySubmission {
  scores: Record<string, number | null>;
  /** Free-text "one moment" answer; may be empty. */
  moment: string;
  /**
   * UI language the survey was RENDERED in when answered ('en' | 'pt') — the
   * research record needs to know which wording of the instrument the tester
   * actually read. Optional: pre-i18n clients omit it (→ English).
   */
  language?: GameLanguage;
}

/** Longest accepted `moment` text — anything beyond this is an invalid envelope. */
export const SURVEY_MOMENT_MAX_CHARS = 4000;

/** Result of persisting a survey, echoed to the browser as `survey_ack`. */
export interface SurveyPersistResult {
  ok: boolean;
  /** Where the survey landed: GCS (`cloud`) or only the run directory (`local`). */
  destination?: 'cloud' | 'local';
  detail?: string;
}

export type ServerEnvelope =
  /**
   * Full state push from the engine. Two contexts:
   *  - `reason: 'attach'` (default) — fresh WS connection or reconnect. The
   *    client should reset all derived UI state (chat, thinking, input lock).
   *  - `reason: 'scene_change'` — mid-run scene transition. The client
   *    should swap scene + characters + props but PRESERVE chat history and
   *    other derived UI state so the prior scene's narration isn't lost.
   *
   * `awaitingHeroSelect` is true while a hero-selection gate is still pending
   * for this session (a human persona is present and the run isn't scripted).
   * The first snapshot is sent on `attach()` — BEFORE the orchestrator reaches
   * the gate and ships the `hero_select_request` — and it already carries
   * `scene.opening`. Without this flag the browser would render the opening
   * splash from that snapshot in the window before the chooser mounts; the
   * client uses it to hold ALL pre-game presentation until the chooser is up.
   * Absent / false everywhere a hero select isn't expected (stub / preview /
   * scripted), so the legacy "splash rides the snapshot" behaviour stands.
   */
  | { kind: 'snapshot'; viewer: Viewer; manifest: AssetManifest; state: RedactedSnapshot; reason?: 'attach' | 'scene_change'; awaitingHeroSelect?: boolean }
  | { kind: 'event'; event: RedactedEvent }
  | { kind: 'turn_started'; actorId: CharacterId | 'dm' }
  | { kind: 'turn_ended';   actorId: CharacterId | 'dm' }
  | { kind: 'thinking';      actorId: CharacterId | 'dm' }
  | { kind: 'thinking_done'; actorId: CharacterId | 'dm' }
  /** Incremental thinking text from a STREAMED turn call — live banner
   *  content only, never logged (the atomic `thought` event still arrives
   *  via `event`). Sent 0+ times between `thinking` and `thinking_done`. */
  | { kind: 'thinking_delta'; actorId: CharacterId | 'dm'; text: string }
  | { kind: 'end'; outcome: 'success' | 'failure' | 'aborted'; reason?: 'party_wipe' }
  /**
   * `session_gone`: a reattach-only reconnect named a sid this server doesn't
   * know (process restarted, or the session was reaped/ended) — the tab's
   * game no longer exists, so it must stop reconnecting and ask the user to
   * reload. Sent by bin/play.ts via the registry's `onRefused` hook.
   */
  | { kind: 'rejected'; reason: 'not_your_turn' | 'session_in_use' | 'invalid_envelope' | 'session_gone' }
  /**
   * The server is at its concurrent-session capacity (`MAX_SESSIONS`) and this
   * connection is waiting in a FIFO line for a free slot. Sent when the tab
   * joins the line and again whenever the line moves; `position` is 1-based.
   * The wait ends when the server admits the session — the regular attach
   * `snapshot` then arrives and the game starts (no separate "admitted"
   * message). See `SessionRegistry.maxSessions`.
   */
  | { kind: 'queued'; position: number; capacity: number }
  | { kind: 'input_required' }
  | { kind: 'input_done' }
  /**
   * Ask the browser to physically roll the dice for an attack and report
   * the settled faces. The engine awaits the matching `roll_response`
   * before computing hit/damage — when the browser is authoritative the
   * deterministic mulberry32 is bypassed entirely. See `RollProvider`
   * for the server-side handshake.
   *
   * `attackerPool` / `defenderArmorPool` include any pool modifiers (e.g.
   * engagement bonus dice) — the client should drop exactly that many
   * dice in each lane. Names/skins are passed through so the HUD can
   * label the duel header without a second snapshot lookup.
   */
  | {
      kind: 'roll_request';
      requestId: string;
      /**
       * `attack` = opposed roll (attacker pool vs defender armor pool, verdict
       * attackerTop ≥ defenderTop). `check` = single-pool ability test / object
       * smash: the attacker rolls against the fixed `difficulty` (the defender
       * block carries poolSize 0 and renders as a "skill check" frame).
       */
      rollKind: 'attack' | 'check';
      /** DC for a `check` roll — the attacker's top die must meet it. */
      difficulty?: number;
      attacker: {
        actorId: CharacterId;
        poolSize: number;
        name: string;
        characterKind: 'hero' | 'monster' | 'npc' | 'dm';
        archetype: string | null;
        sprite: string | null;
      };
      defender: {
        actorId: CharacterId;
        poolSize: number;
        name: string;
        characterKind: 'hero' | 'monster' | 'npc' | 'dm';
        archetype: string | null;
        sprite: string | null;
      };
    }
  /**
   * Combat has begun and initiative is rolled; the engine's turn cursor is
   * already parked on the first combatant. Before dispatching that first
   * turn the orchestrator ships this and BLOCKS on the matching `reveal_ack`
   * so the browser's "Order of Battle" reveal stays on screen until the
   * player dismisses it (Skip click, or the auto-skip timer). See
   * `RevealProvider` for the server-side handshake. Headless / CLI / AI-only
   * runs (no provider) fall back to a fixed `initiativeRevealDelayMs` sleep
   * instead — they never receive this envelope.
   */
  | { kind: 'reveal_request'; requestId: string }
  /**
   * Beat-pacing gate. The orchestrator ships this before starting the next
   * turn and BLOCKS on the matching `beat_gate_ack`, so AI / monster / DM
   * turns do not race ahead while the player is still reading the previous
   * turn's narration / hero-speech beats. The browser acks once its playback
   * queue has fully drained — i.e. the player dismissed every beat (Skip
   * click, or the auto-skip timer). Mirrors `reveal_request`. Headless / CLI /
   * AI-only runs (no `BeatGate`) never receive this envelope and never pause.
   *
   * Routed THROUGH the client's deferred dispatcher (not handled out-of-band
   * like roll/reveal) so it is ordered behind any narration still parked
   * behind an in-flight projectile defer — otherwise it could ack before the
   * deferred beat reaches the queue.
   */
  | { kind: 'beat_gate'; requestId: string }
  /**
   * Opening-splash gate. At game start, if the initial scene has an `opening`,
   * the orchestrator ships this AFTER publishing the first snapshot (which
   * carries `scene.opening`) and BLOCKS on the matching `opening_ack` — so the
   * DM's first turn (and therefore combat) does not begin until the player
   * dismisses the title splash ("Begin"). See `OpeningProvider`. Headless /
   * CLI / AI-only runs (no provider) never receive this and proceed straight
   * to the DM, which reads the intro itself.
   */
  | { kind: 'opening_request'; requestId: string }
  /**
   * Hero-selection gate. At game start — BEFORE the opening splash — the
   * orchestrator ships this and BLOCKS on the matching `hero_select_response`
   * so the player can choose which of the starting party heroes they control.
   * The two heroes NOT chosen are driven by their AI agents. The browser shows
   * a "Choose your hero" screen built from `options`. Like the opening/reveal
   * gates there is NO wall-clock timeout while a browser is attached, and a
   * disconnect / abort resolves the gate to the scenario default. Headless /
   * CLI / scripted / AI-only runs (no provider) never receive this and keep
   * the scenario's default human hero. See `HeroSelectProvider`.
   */
  | { kind: 'hero_select_request'; requestId: string; options: HeroChoice[] }
  /**
   * Reply to a `survey_response`: whether (and where) the survey was
   * persisted. `ok: false` tells the modal to steer the tester to the
   * clipboard fallback instead of silently losing the answers.
   */
  | { kind: 'survey_ack'; ok: boolean; destination?: 'cloud' | 'local'; detail?: string };

export type ClientEnvelope =
  /**
   * Free-text input from the human. `target` selects who the message is for:
   *   - 'game' (default, omitted): in-character — flows through the DM
   *     interpreter and becomes one or more player actions on this turn.
   *   - 'dm': out-of-character — answered by the DM directly without
   *     consuming the turn or mutating engine state.
   */
  | { kind: 'human_input'; text: string; target?: 'game' | 'dm' }
  | { kind: 'skip_turn' }
  | { kind: 'structured_action'; action: PlayerAction }
  /**
   * Reply to a `roll_request` carrying the face values that the browser's
   * 3D physics settled on. `requestId` MUST echo the request; mismatched
   * IDs are ignored. Faces are integers in 1..6; lengths MUST match the
   * pool sizes the server asked for.
   */
  | {
      kind: 'roll_response';
      requestId: string;
      attackerFaces: number[];
      defenderFaces: number[];
    }
  /**
   * Acknowledge a `reveal_request`: the player has dismissed the on-screen
   * "Order of Battle" reveal (Skip click, or the auto-skip timer fired), so
   * the orchestrator may dispatch the first combatant's turn. `requestId`
   * MUST echo the request; a mismatched / unknown id is ignored.
   */
  | { kind: 'reveal_ack'; requestId: string }
  /**
   * Acknowledge a `beat_gate`: the player has dismissed every queued
   * narration / hero-speech beat (Skip clicks, or auto-skip), so the
   * orchestrator may start the next turn. `requestId` MUST echo the request;
   * a mismatched / unknown id is ignored.
   */
  | { kind: 'beat_gate_ack'; requestId: string }
  /**
   * Acknowledge an `opening_request`: the player clicked "Begin" on the title
   * splash, so the orchestrator may run the DM's first turn. `requestId` MUST
   * echo the request; a mismatched / unknown id is ignored.
   */
  | { kind: 'opening_ack'; requestId: string }
  /**
   * Reply to a `hero_select_request`: the characterId of the hero the player
   * chose to control. `requestId` MUST echo the request; `characterId` MUST be
   * one of the offered options (the server re-validates and ignores an unknown
   * id, falling back to the scenario default). A mismatched / unknown request
   * id is ignored. `language` is the game language the player picked on the
   * same screen ('en' | 'pt') — it reroutes every agent's LANGUAGE directive
   * before the first LLM call. Optional: absent keeps the scenario default.
   */
  | { kind: 'hero_select_response'; requestId: string; characterId: string; language?: GameLanguage }
  /**
   * The tester submitted the playtest survey. Fire-and-forget from the turn
   * lifecycle's point of view (handled like roll/ack messages, before the
   * "is anyone awaiting input?" check); the server persists it and replies
   * with a `survey_ack`. Scores must be integers 1..5 or null.
   */
  | { kind: 'survey_response'; survey: SurveySubmission };

export const encodeServerEnvelope = (env: ServerEnvelope): string => JSON.stringify(env);

const SERVER_KINDS = new Set<ServerEnvelope['kind']>([
  'snapshot', 'event', 'turn_started', 'turn_ended', 'thinking', 'thinking_done', 'thinking_delta',
  'end', 'rejected', 'input_required', 'input_done', 'roll_request', 'reveal_request', 'beat_gate',
  'opening_request', 'hero_select_request', 'survey_ack', 'queued',
]);

export const parseServerEnvelope = (raw: string): ServerEnvelope | null => {
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && 'kind' in v && typeof (v as { kind: unknown }).kind === 'string') {
      const kind = (v as { kind: string }).kind as ServerEnvelope['kind'];
      if (SERVER_KINDS.has(kind)) return v as ServerEnvelope;
    }
    return null;
  } catch { return null; }
};

export const parseClientEnvelope = (raw: string): ClientEnvelope | null => {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const obj = v as { kind?: unknown; text?: unknown };
    if (obj.kind === 'human_input' && typeof obj.text === 'string') {
      const tgt = (obj as { target?: unknown }).target;
      if (tgt === undefined || tgt === 'game' || tgt === 'dm') return v as ClientEnvelope;
      return null;
    }
    if (obj.kind === 'skip_turn') return v as ClientEnvelope;
    if (obj.kind === 'structured_action') {
      const a = (obj as { action?: unknown }).action;
      if (a && typeof a === 'object' && typeof (a as { kind?: unknown }).kind === 'string') {
        // Trust the action shape — the engine validates and returns rule_violation
        // on bad inputs, which the server already surfaces back to the browser.
        return v as ClientEnvelope;
      }
      return null;
    }
    if (obj.kind === 'roll_response') {
      const o = obj as { requestId?: unknown; attackerFaces?: unknown; defenderFaces?: unknown };
      if (
        typeof o.requestId === 'string' &&
        Array.isArray(o.attackerFaces) && o.attackerFaces.every((f) => typeof f === 'number') &&
        Array.isArray(o.defenderFaces) && o.defenderFaces.every((f) => typeof f === 'number')
      ) {
        return v as ClientEnvelope;
      }
      return null;
    }
    if (obj.kind === 'reveal_ack' || obj.kind === 'beat_gate_ack' || obj.kind === 'opening_ack') {
      const o = obj as { requestId?: unknown };
      if (typeof o.requestId === 'string') return v as ClientEnvelope;
      return null;
    }
    if (obj.kind === 'hero_select_response') {
      const o = obj as { requestId?: unknown; characterId?: unknown; language?: unknown };
      if (typeof o.requestId === 'string' && typeof o.characterId === 'string' && o.characterId.length > 0) {
        // `language` is optional but, when present, must be a known game
        // language — a garbage value rejects the envelope rather than slipping
        // an arbitrary string into the prompt-language plumbing.
        if (o.language !== undefined && !isGameLanguage(o.language)) return null;
        return v as ClientEnvelope;
      }
      return null;
    }
    if (obj.kind === 'survey_response') {
      const s = (obj as { survey?: unknown }).survey;
      if (!s || typeof s !== 'object') return null;
      const { scores, moment, language } = s as { scores?: unknown; moment?: unknown; language?: unknown };
      if (typeof moment !== 'string' || moment.length > SURVEY_MOMENT_MAX_CHARS) return null;
      if (language !== undefined && !isGameLanguage(language)) return null;
      if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;
      const valid = Object.values(scores as Record<string, unknown>).every(
        (n) => n === null || (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5),
      );
      return valid ? (v as ClientEnvelope) : null;
    }
    return null;
  } catch { return null; }
};
