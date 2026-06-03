import type { GameEngine, SubAttackSpec } from '../engine/game-engine.js';
import { sceneOpeningText, type Adventure } from '../engine/adventure.js';
import type { Character } from '../engine/character.js';
import type { ProvidedAttackRolls } from '../engine/resolution.js';
import type { CharacterId } from '../engine/ids.js';
import { asSceneId } from '../engine/ids.js';
import type { Event } from '../log/events.js';
import type { PlayerAction } from '../engine/action.js';
import type { Viewer } from './visibility/types.js';
import { EventLog } from '../log/event-log.js';
import { writeManifest, type RunManifest } from '../log/manifest.js';
import path from 'node:path';
import type { Subscriber } from './subscriber.js';
import type { Agent, HumanTurnInterpretation } from './agent.js';
import { summarizeHpOutcome } from './agent.js';
import { filter } from './visibility/filter.js';
import { chooseMonsterActions, MONSTER_MOVE_BUDGET } from '../engine/monster-ai.js';
import type { RollProvider, AttackRollSpec } from './roll-provider.js';
import type { RevealProvider } from './reveal-provider.js';
import type { OpeningProvider } from './opening-provider.js';
import type { HeroSelectProvider } from './hero-select-provider.js';
import type { GameLanguage } from './language.js';
import type { HeroChoice } from './ws/protocol.js';
import type { BeatGate } from './beat-gate.js';
import type { Result } from '../engine/primitives.js';
import type { RuleViolation, DmAction } from '../engine/action.js';
import type { ActionOk } from '../engine/game-engine.js';

/** Promise-based sleep used to pace monster turns for the browser viewer. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Does this event become a beat in the browser's playback queue that the loop
 * must pause for? Mirrors the queue-producing branches of the browser's
 * `matchQueueItems`: a DM `narrate` event, a DM `say`/`narrate` action, a
 * hero/NPC `say` action (each with non-empty text), or a non-DM `emote` action
 * (a non-empty emoji). Dice / initiative panels are driven by the roll-resolved
 * signal (not the beat gate), so they are NOT beats.
 *
 * `emote` is included so an emote-ONLY off-turn reaction (a teammate or foe
 * answering an action with just an emoji, no spoken line) still pauses the
 * loop until the browser has played the balloon — without this, the orchestrator
 * raced straight to the next turn and the 1.5s balloon was easily missed.
 *
 * Used only to decide whether the main loop pauses on the beat gate; being
 * liberal is safe (the browser acks instantly when its queue is empty).
 */
export const isGatingBeat = (ev: Event): boolean => {
  if (ev.type === 'narrate') return ev.text.trim().length > 0;
  if (ev.type === 'action') {
    const a = ev.action as { kind?: string; text?: unknown; emoji?: unknown };
    if ((a.kind === 'say' || a.kind === 'narrate') && typeof a.text === 'string') {
      return a.text.trim().length > 0;
    }
    // A non-DM emote renders as a queued board balloon (matchQueueItems excludes
    // DM emotes — the DM has no board token). Gate on it so emote-only reactions
    // are paced like spoken ones.
    if (a.kind === 'emote' && ev.actorId !== 'dm' && typeof a.emoji === 'string') {
      return a.emoji.trim().length > 0;
    }
  }
  return false;
};

/**
 * Action kinds that open an OFF-TURN reaction round (see
 * `maybeReactToResolvedActions`):
 * the meaningful "combat actions" a hero or monster takes that another agent
 * might react to — an attack, an object smash (the oil-cask self-blast), a
 * special, freeing a bound ally, or quaffing a boon. Pure-flavour or
 * turn-plumbing actions (move / say / emote / ability_test / end_turn /
 * skip_turn) are deliberately excluded: `say` already has its own reaction
 * round, and reacting to every shuffle would be noise (and an LLM call per
 * other agent). Used by `summarizeReactableAction` to detect the trigger.
 */
const REACTABLE_ACTION_KINDS: ReadonlySet<string> = new Set([
  'normal_attack', 'attack_object', 'special_action', 'free_ally', 'use_boon',
]);

export interface HumanInputProvider {
  /** Block until the human supplies input. Resolved input goes through the orchestrator. */
  requestInput(): Promise<HumanInput>;
  /**
   * Register a handler for OFF-TURN human input ("interjections"): free-text
   * lines the human sends "to Game" / "to DM" while it is NOT their turn. The
   * provider invokes the handler the moment such a message arrives (instead of
   * rejecting it), so the orchestrator can abort whatever is generating and
   * process the message. Optional — scripted / headless providers that never
   * interject simply omit it, preserving the turn-locked behaviour.
   */
  onInterject?(handler: (input: HumanInput) => void): void;
}

export type HumanInput =
  | { kind: 'free_text'; text: string }
  | { kind: 'structured_action'; action: PlayerAction }
  | { kind: 'skip' }
  /**
   * Out-of-character question to the DM. Does NOT consume the human's turn —
   * after the DM answers, runHumanTurn loops back to requestInput() and the
   * human can continue (more OOC, an in-character action, or skip).
   */
  | { kind: 'ooc_query'; text: string };

export interface OrchestratorConfig {
  engine: GameEngine;
  adventure: Adventure;
  agents: { dm: Agent; players: Map<CharacterId, Agent> };
  human: { characterId: CharacterId; provider: HumanInputProvider } | null;
  subscribers: Subscriber[];
  stepBudget: { player: number; dm: number };
  runDir: string;
  seed: string;
  runId: string;
  /**
   * Scene id to start the run from. The orchestrator auto-enters this scene
   * (instead of `adventure.scenes[0]`) before the DM's first turn, so its
   * monsters/NPCs materialize and its grid loads. When unset — or set to an id
   * the adventure doesn't contain — falls back to the first scene. bin/play.ts
   * wires this from the `--start-scene <id>` flag, useful for jumping straight
   * to a later encounter when iterating on it. (Hero spawn positions are
   * resolved separately in bin/play.ts against the same starting scene.)
   */
  startSceneId?: string;
  /** Per-agent prompt-hash + model + persona name, for the manifest. */
  agentRecords?: RunManifest['agents'];
  /** Wall-clock pause between two CONSECUTIVE monster turns. Lets browser
   *  animations (move tween + HIT/MISS flash + roll panel) finish before the
   *  next monster starts, so the user perceives monster turns as sequential
   *  instead of a confused burst. Only sleeps when the next actor is also a
   *  monster — hero/human turns naturally pace themselves. Default 0 (off)
   *  so the test suite runs at full speed; bin/play.ts sets it for live runs. */
  monsterTurnDelayMs?: number;
  /** Wall-clock pause between actions WITHIN one monster's turn (e.g. between
   *  a `move` and the follow-up `normal_attack`). Default 0. */
  monsterActionDelayMs?: number;
  /**
   * Wall-clock pause between two CHAINED player actions from one LLM reply
   * (and between the DM-interpreted actions of a human's free-text turn).
   * Multi-action replies apply at engine speed, so without this the browser
   * gets the speech bubble, the move tween, and the attack dice in a single
   * burst. A chained `say`/`emote` additionally awaits the beat gate FIRST
   * (the player reads the line before the hero acts on it) — see `chainGap`.
   * Default 0 (tests/headless run at full speed); bin/play.ts sets the live
   * value, mirroring `monsterActionDelayMs`.
   */
  playerActionDelayMs?: number;
  /**
   * When true, a message the human sends TO THE PARTY (free-text "to Game",
   * on- or off-turn) opens a reaction round: every OTHER on-board AI hero may
   * optionally reply with a short line and/or an emoji, off-turn (see
   * `runPartyReactions`). Each reaction is an extra LLM call, so this defaults
   * to OFF — the scripted test suite stays deterministic and doesn't need
   * `:party-react` fixtures — and `bin/play.ts` opts in for live play. */
  partyReactions?: boolean;
  /**
   * Who controls monsters on their combat turns.
   *   - `'deterministic'` (default): the pure planner in `monster-ai.ts`.
   *   - `'dm'`: the DM agent puppets each monster (`runDmDrivenMonsterTurn`),
   *     with the deterministic planner kept as a safety fallback when the DM
   *     produces no legal/terminal action. Monster attacks still roll the
   *     physics dice (via the `applyDmAction` hook → `applyActionWithRolls`).
   * Defaulting to `'deterministic'` keeps the test suite reproducible; only
   * `bin/play.ts` (live play) opts into `'dm'`. */
  monsterControl?: 'dm' | 'deterministic';
  /** Wall-clock pause AFTER a `combat_started` event is published, before the
   *  first combatant's turn is dispatched. Gives the browser's initiative
   *  panel time to play out — without it, the engine's cursor already points
   *  at order[0] the instant `start_combat` resolves, so a monster-first
   *  combat would visibly move tokens on the board behind the reveal panel.
   *  Default 0 (tests run at full speed); bin/play.ts sets it to match the
   *  panel's animation duration.
   *
   *  Used ONLY when no `revealProvider` is configured (headless / CLI /
   *  AI-only). When a `revealProvider` is present the gate is player-driven
   *  instead — the orchestrator blocks until the browser acks the reveal —
   *  and this fixed delay is bypassed entirely. */
  initiativeRevealDelayMs?: number;
  /** Wall-clock pause AFTER a `resolution` event drains, before the next turn
   *  is dispatched. Gives the browser time to absorb the dice landing + the
   *  KO/damage animation (which the client defers until dice settle) before
   *  the next monster's resolution arrives with its own roll. Without it, a
   *  killing blow's death animation gets stepped on by the next enemy's
   *  turn starting. Default 0 (tests run at full speed); bin/play.ts sets
   *  the live value. */
  postResolutionDelayMs?: number;
  /**
   * Optional cancellation signal. Checked between every turn dispatch — once
   * fired the run unwinds with `outcome: 'aborted'`. The session manager in
   * bin/play.ts fires this when the browser opens a new game session so the
   * previous orchestrator tears down cleanly instead of running until the
   * adventure naturally ends.
   *
   * In-flight LLM calls are NOT cancelled (we don't thread a signal into the
   * SDK) — they finish naturally and their results are discarded on the next
   * loop iteration. Human-input waits ARE cancellable via WsAdapter.abort(),
   * which rejects the pending requestInput() promise.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional dice roll provider. When set, normal attacks consult the
   * provider for face values BEFORE the engine resolves, so the browser's
   * 3D physics simulation can drive the visible dice (and therefore the
   * hit/miss verdict). When unset, the engine's seeded `Dice` rolls
   * internally — keeps headless / CLI / AI-only paths deterministic. Per-
   * provider null returns also fall back to seeded dice so a disconnected
   * client doesn't hang the run.
   */
  rollProvider?: RollProvider;
  /**
   * Optional initiative-reveal gate. When set, the orchestrator blocks after
   * `combat_started` until the provider resolves — i.e. the player dismissed
   * the on-screen "Order of Battle" reveal (Skip click, or auto-skip). This
   * REPLACES the fixed `initiativeRevealDelayMs` sleep: instead of racing a
   * wall-clock timer, the first combatant's turn waits for the human. When
   * unset (headless / CLI / AI-only) the fixed delay is used instead. See
   * `RevealProvider`.
   */
  revealProvider?: RevealProvider;
  /**
   * Optional beat-pacing gate. When set, the orchestrator blocks before
   * starting each turn until the provider resolves — i.e. the player has
   * dismissed every narration / hero-speech beat published by the previous
   * turn(s) (Skip clicks, or auto-skip). This is what keeps AI / monster / DM
   * turns from racing ahead while the human is still reading. A no-op turn
   * (one that published no gating beat) does not pause. When unset (headless
   * / CLI / AI-only) turns run back-to-back as before. See `BeatGate`.
   */
  beatGate?: BeatGate;
  /**
   * Optional opening-splash gate. When set AND the initial scene has an
   * `opening`, the orchestrator publishes the first snapshot and then blocks
   * BEFORE the DM's first turn until the provider resolves — i.e. the player
   * dismissed the title splash ("Begin"). After it resolves the orchestrator
   * emits the opening's `after` text as a narration beat (revealing the board
   * and landing in the narrator) so the DM never has to read the intro. When
   * unset (headless / CLI / AI-only) there is no splash and the DM reads the
   * intro itself. See `OpeningProvider`.
   */
  openingProvider?: OpeningProvider;
  /**
   * Optional hero-selection gate. When set AND `heroChoices` is non-empty, the
   * orchestrator blocks once at game start — BEFORE the opening splash and any
   * turn — until the player picks which of the offered heroes they control. The
   * chosen hero's `characterId` becomes the human (see `humanCharacterId`); the
   * others are driven by their AI agents (which MUST therefore exist in
   * `agents.players`). When unset / empty / on disconnect, the scenario's
   * default `human.characterId` stands. See `HeroSelectProvider`.
   */
  heroSelectProvider?: HeroSelectProvider;
  /**
   * The heroes offered on the game-start "Choose your hero" screen. Built by
   * the launcher from the starting party + hero catalog. Every option's
   * `characterId` MUST have an agent in `agents.players` so it can be
   * AI-driven when NOT chosen. Empty / unset → the gate is a no-op.
   */
  heroChoices?: HeroChoice[];
  /**
   * Initial game language (from the scenario; default 'en'). The player's
   * pick on the hero-select screen overrides it; the EFFECTIVE language is
   * recorded in the run manifest. The orchestrator itself never renders
   * prompts — `onLanguageSelected` is how the launcher reroutes them.
   */
  language?: GameLanguage;
  /**
   * Fired when the hero-select gate resolves with a language DIFFERENT from
   * the configured one — i.e. the player switched the game to Portuguese (or
   * back). The launcher wires this to `PromptBuilder.setLanguage` so every
   * agent's next system prompt carries the right LANGUAGE directive. The gate
   * runs BEFORE the first LLM call, so the system band stays byte-stable
   * across the whole run and prompt caching is unaffected.
   */
  onLanguageSelected?: (language: GameLanguage) => void;
  /**
   * Per-language display names: language code → characterId → name (from the
   * scenario's `names` records, e.g. `{ pt: { p1_warrior: 'Heitor' } }`). When
   * the session's EFFECTIVE language has an entry here, the orchestrator
   * applies that language's map to the engine right after the hero-select
   * gate (the last place the language can change, still before any turn or
   * LLM call) and re-publishes snapshots so every surface shows the localized
   * names. Unset / no entry for the session language → names untouched
   * (English sessions never rename — `name` IS the English name).
   */
  nameOverrides?: Record<string, Record<string, string>>;
  /**
   * Optional per-LLM-call observer, invoked after every recorded call with the
   * role tag (dm, p1, dm:react, p2:party-react, …), token usage, and measured
   * wall-clock duration. bin/play.ts wires it to a `[llm]` console line so a
   * live run shows where the time goes call-by-call; absent in tests/headless.
   * Observer errors are swallowed — logging must never break the run.
   */
  onLlmCall?: (info: {
    role: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    /** Widened to include `undefined` so recordUsage can forward its optional
     *  arg directly under `exactOptionalPropertyTypes`. */
    durationMs: number | undefined;
  }) => void;
  /**
   * When true, every events.jsonl line is stamped with `wallMs` (epoch ms at
   * write time — see EventLogOptions.stampWallClock) so post-hoc analysis can
   * reconstruct turn pacing. Off by default so test logs stay byte-stable;
   * bin/play.ts opts in for live runs.
   */
  stampWallClock?: boolean;
}

export interface OrchestratorResult {
  outcome: 'success' | 'failure' | 'aborted';
  manifestPath: string;
  totalEvents: number;
}

export class Orchestrator {
  private currentTurnIdx = 0;
  /** Visibility-filtered history per perspective; rebuilt lazily as agents take turns. */
  private allEvents: Event[] = [];
  /** Accumulated LLM usage per agent role (dm/p1/p2…) for the manifest. */
  private llmCalls: Record<string, number> = {};
  /** Accumulated per-role wall-clock LLM latency (manifest `llmLatencyMs`). */
  private llmDurations: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
  private totalIn = 0;
  private totalOut = 0;
  private totalCacheRead = 0;
  private totalCacheWrite = 0;
  private startedAt = '';
  private endedAt = '';

  /** Monotonic counter for `roll_request` IDs scoped to this run. Combined with
   *  `runId` to form a globally unique requestId so a stale reply from a prior
   *  session never resolves a fresh request. */
  private rollRequestSeq = 0;

  /** Monotonic counter for `reveal_request` IDs (one per combat start), scoped
   *  to this run the same way as `rollRequestSeq` so a stale ack from a prior
   *  combat never releases a fresh initiative-reveal gate. */
  private revealRequestSeq = 0;

  /** Monotonic counter for `beat_gate` request IDs, scoped to this run like
   *  `revealRequestSeq` so a stale ack never releases a fresh gate. */
  private beatGateSeq = 0;

  /** True once the opening-splash gate has been awaited (or skipped). The gate
   *  fires at most once, before the DM's first turn — never on later scene
   *  transitions. */
  private openingGateDone = false;

  /** True once the hero-selection gate has been awaited (or skipped). Fires at
   *  most once, at game start before the opening gate. */
  private heroSelectGateDone = false;

  /** The hero the player chose to control on the game-start screen, or null
   *  until/unless they choose (or the gate is skipped). When set it overrides
   *  the scenario's default `human.characterId` everywhere via the
   *  `humanCharacterId` getter. */
  private selectedHumanId: CharacterId | null = null;
  /** Effective game language: scenario default until the hero-select gate
   *  resolves with a player pick. Recorded in the run manifest. */
  private selectedLanguage: GameLanguage | null = null;

  /** Game-start watermark: true once the run has passed BOTH game-start gates
   *  (hero select + opening splash) un-aborted — i.e. the player picked a hero
   *  and the game actually began (on runs that offer no gates — CLI / scripted /
   *  AI-only — it flips on the first loop iteration, since those start
   *  unconditionally). Stays false for sessions reaped/aborted while still
   *  parked at a start gate, which `bin/play.ts` uses to SKIP the GCS run
   *  archive for games that never started. */
  private gameHasStarted = false;

  /** Set whenever a narration / hero-speech beat is published (in
   *  `drainAndReturn`); cleared each time the beat gate closes. The main loop
   *  only pauses on the gate when this is true, so turns that produced no
   *  readable beat (e.g. a silent monster move) don't cost a round-trip. A
   *  liberal over-set is harmless: the browser acks immediately when its
   *  queue is already drained, so it can never hang the run. */
  private beatsPendingSinceGate = false;

  /** Off-turn human messages waiting to be processed. Pushed by `interject`
   *  (called from the human provider when the player sends text while it is not
   *  their turn), drained by `drainInterjections` at the top of the main loop. */
  private interjections: HumanInput[] = [];

  /** AbortController scoped to the turn / OOC answer / DM react currently
   *  generating. `interject` fires it so an in-flight LLM call is cancelled and
   *  the human's message is handled promptly. Recreated per LLM-bearing
   *  operation; null between them. Distinct from `cfg.abortSignal`, which tears
   *  the whole run down. */
  private turnAbort: AbortController | null = null;

  constructor(private readonly cfg: OrchestratorConfig) {}

  /** The signal threaded into agents' hooks for the current operation, so an
   *  interjection can cancel the in-flight LLM call. */
  private get turnSignal(): AbortSignal | undefined {
    return this.turnAbort?.signal;
  }

  /** The characterId the human controls: the hero they picked on the game-start
   *  screen if any, else the scenario default. Null when there's no human in the
   *  loop (AI-only / headless). Single source of truth for the human↔AI turn
   *  routing, party-reaction skip, interjection attribution, and manifest. */
  private get humanCharacterId(): CharacterId | null {
    return this.selectedHumanId ?? this.cfg.human?.characterId ?? null;
  }

  /** Whether the game ever actually began (see `gameHasStarted`). Read by
   *  `bin/play.ts` at teardown to decide if the run's artifacts are worth
   *  archiving to GCS: a session that died parked at the hero-select / opening
   *  gate produced only setup events — no game, no research record. */
  get gameStarted(): boolean {
    return this.gameHasStarted;
  }

  /**
   * Queue an off-turn human message and cancel whatever is generating right now
   * so the main loop can process it. Registered with the human provider in
   * `run()`. Only free-text / OOC lines reach here (the provider filters out
   * turn-structured inputs); they're processed in `drainInterjections`.
   */
  private interject(input: HumanInput): void {
    this.interjections.push(input);
    this.turnAbort?.abort();
  }

  /**
   * Process every queued off-turn interjection, in arrival order:
   *   - `ooc_query` → the DM answers (side-channel, no turn consumed), exactly
   *     like the on-turn OOC path.
   *   - `free_text` → broadcast the human's literal in-character line as a public
   *     `say` event (recorded in history, rendered as a speech bubble, seen by
   *     every agent + the DM). In the narrative phase the DM then reacts to it —
   *     mirroring the on-turn free-text path; in combat we stay silent (matches
   *     on-turn `say`).
   * Each LLM-bearing step runs under a fresh `turnAbort` so a still-newer
   * interjection can cancel it too. Called at the top of the main loop, so the
   * actor whose turn was interrupted is re-dispatched afterwards — now with the
   * human's words in history.
   */
  private async drainInterjections(log: EventLog): Promise<void> {
    if (!this.cfg.human) { this.interjections.length = 0; return; }
    const actorId = this.humanCharacterId!;
    while (this.interjections.length > 0) {
      const input = this.interjections.shift()!;
      if (input.kind === 'ooc_query') {
        this.cfg.engine.emitRuntime({
          type: 'player_ooc_query', actorId, text: input.text,
        } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
        this.signalThinking('dm');
        this.turnAbort = new AbortController();
        let reply = '';
        try {
          reply = await this.cfg.agents.dm.answerOocQuery(
            input.text, actorId, this.historyFor({ kind: 'dm' }), this.currentTurnIdx,
            {
              emitThought: (t) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: 'dm', text: t } as Omit<Event, 't'>),
              signal: this.turnSignal,
            },
          );
        } finally {
          this.signalThinkingDone('dm');
          this.turnAbort = null;
        }
        // Empty reply == a newer interjection cancelled the answer; skip the
        // blank bubble (the queued message is handled on the next loop pass).
        if (reply.length > 0) {
          this.cfg.engine.emitRuntime({
            type: 'dm_ooc_reply', toActorId: actorId, text: reply,
          } as Omit<Event, 't'>);
          await this.drainAndPublish(log);
        }
        continue;
      }
      if (input.kind === 'free_text') {
        const trimmed = input.text.trim();
        if (trimmed.length === 0) continue;
        // The human's hero isn't the active actor, so engine.applyAction(say)
        // would reject (not-actors-turn). Emit the SAME public `say` action
        // event the engine would — a pure broadcast (say mutates no rule state),
        // so every agent + the DM see it in history and the browser renders a
        // speech bubble. Interjections only occur in live browser play, so this
        // synthetic action event never reaches the fixture-based replay harness
        // (which re-applies actions through the engine).
        this.cfg.engine.emitRuntime({
          type: 'action', actorId, action: { kind: 'say', text: trimmed },
        } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
        // A message TO THE PARTY: give every other AI hero a chance to react
        // (banter / emoji), off-turn — see runPartyReactions. Works in any phase.
        await this.runPartyReactions(actorId, trimmed, log);
        // Narrative phase: the DM also responds to the spoken line (mirrors the
        // on-turn free-text path). In combat we leave narration to the
        // resolution-driven react so we don't step on a mid-fight beat.
        if (this.cfg.engine.turn.phase === 'narrative') {
          this.turnAbort = new AbortController();
          try {
            await this.runDmReact(log);
          } finally {
            this.turnAbort = null;
          }
        }
        continue;
      }
      // skip / structured_action are never delivered as interjections (the
      // provider only forwards free-text / OOC off-turn input).
    }
  }

  /**
   * Party-message reaction round. When a hero says something TO THE PARTY —
   * whether the human (free-text "to Game") or an AI hero on its own turn — give
   * every OTHER on-board AI hero a chance to react OFF-TURN with a short line
   * and/or a face emoji, or stay silent. Each reaction is broadcast via
   * `emitRuntime` (a `say` / `emote` is a pure broadcast that mutates no rule
   * state and consumes no turn), so it renders as a speech bubble / emoji
   * balloon and lands in every agent's history. Reactors run CONCURRENTLY
   * (latency: the round costs max(call), not sum(call)); each reacts to the
   * speaker's line only — the round's lines are broadcast after every call
   * settles, in stable party order. Skips the speaker, the human seat, and
   * KO'd heroes. Bails early if a newer interjection has queued, so the human
   * stays heard promptly.
   *
   * Cascade-free: reaction lines are emitted directly here, NOT through any
   * hero's `takeTurn`, so they never trigger another round — a round fires only
   * for a PRIMARY say (a human message or a hero's turn-say). No-op unless
   * `partyReactions` is enabled, and when there are no other AI heroes.
   */
  private async runPartyReactions(speakerId: CharacterId, message: string, log: EventLog): Promise<void> {
    if (!this.cfg.partyReactions) return;  // opt-in; off for the deterministic test suite
    // A newer message is already waiting — skip the round and let the main
    // loop process it first.
    if (this.interjections.length > 0) return;
    const fromName = this.cfg.engine.charactersById().get(speakerId)?.name ?? 'A teammate';
    const humanId = this.humanCharacterId;
    const byId = this.cfg.engine.charactersById();
    const reactors = [...this.cfg.agents.players.entries()].filter(([actorId]) => {
      if (actorId === speakerId || actorId === humanId) return false;
      const ch = byId.get(actorId);
      return !!ch && ch.health.status !== 'KO';  // KO'd heroes can't pipe up
    });
    if (reactors.length === 0) return;
    // LATENCY: all reactors are consulted CONCURRENTLY, so the round costs
    // max(call) wall-clock, not sum(call). Trade-off: a reactor reacts to the
    // SPEAKER's line only, not to the other reactions of this round (they're
    // broadcast after every call settles, in stable party order). One abort
    // scope covers the whole round so an interjection cancels every in-flight
    // reaction at once.
    this.turnAbort = new AbortController();
    let results: Array<[CharacterId, { says: string[]; emojis: string[] }]>;
    try {
      results = await Promise.all(reactors.map(async ([actorId, agent]) => {
        this.signalThinking(actorId);
        try {
          const reaction = await agent.reactToPartyMessage(
            message, fromName, this.historyFor({ kind: 'self', actorId }), this.currentTurnIdx,
            {
              emitThought: (text) => this.cfg.engine.emitRuntime({ type: 'thought', actorId, text } as Omit<Event, 't'>),
              onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
              signal: this.turnSignal,
            },
          );
          return [actorId, reaction] as [CharacterId, { says: string[]; emojis: string[] }];
        } finally {
          this.signalThinkingDone(actorId);
        }
      }));
    } finally {
      this.turnAbort = null;
    }
    // Broadcast the reactions off-turn: spoken lines render as speech bubbles,
    // emojis as balloons over the hero. No turn consumed, no state mutated.
    await this.broadcastReactions(results, [], speakerId, log);
  }

  /** Re-entrancy guard so a reaction round (whose broadcasts drain again)
   *  cannot trigger another reaction round. Set while an action-reaction round
   *  runs (in `maybeReactToResolvedActions` and the concurrent round in
   *  `drainAndReactOnResolution`). */
  private inActionReact = false;

  /**
   * Look at the events that just drained for a SIGNIFICANT reactable action (an
   * attack, object smash, special, free_ally, use_boon — see
   * `REACTABLE_ACTION_KINDS` — whose outcome cleared the significance gate in
   * `summarizeReactableAction`) by ANY agent (hero or monster) and, if found,
   * open an off-turn reaction round so the OTHER agents can comment on it.
   * No-op when `partyReactions` is off, when re-entered, when a human
   * interjection is already waiting, or when nothing significant happened. The
   * reaction round itself emits only `say`/`emote` broadcasts (not reactable
   * kinds), so it never cascades.
   *
   * LATENCY: the hero reactors and the DM's enemy-voicing run CONCURRENTLY
   * (every participant reacts to the same engine-truth summary), so the round
   * costs max(call) wall-clock instead of one serial call per reactor.
   */
  private async maybeReactToResolvedActions(events: Event[], log: EventLog): Promise<void> {
    if (!this.cfg.partyReactions || this.inActionReact) return;
    if (this.interjections.length > 0) return;  // human first — skip the round
    const trigger = this.summarizeReactableAction(events);
    if (!trigger) return;
    this.inActionReact = true;
    try {
      const [heroReactions, voicings] = await Promise.all([
        this.collectHeroReactions(trigger.actorId, trigger.summary),
        this.collectMonsterVoicings(trigger.actorId, trigger.summary),
      ]);
      await this.broadcastReactions(heroReactions, voicings, trigger.actorId, log);
    } finally {
      this.inActionReact = false;
    }
  }

  /**
   * Find the (last) reactable action in a freshly-drained event batch and build
   * a one-line human-readable summary of what happened + its outcome — actor,
   * verb, target, HIT/MISS, and resulting HP read from post-apply engine truth.
   * Returns the acting agent's id (so it's excluded as a reactor) and the
   * summary, or null when the batch holds no reactable action.
   *
   * SIGNIFICANCE GATE (latency): a reaction round costs an LLM call per other
   * agent, and most routine outcomes (a 1-damage chip, a miss, a failed check)
   * drew silence anyway — the agents' own prompt says "most routine actions
   * don't need a comment". So the round only opens when the outcome is a real
   * beat, decided deterministically here: a status change (a KO, a rescue —
   * the freed captive, prone), damage >= 2, the actor hurting THEMSELVES (the
   * motivating oil-cask self-blast), an obstacle shattering (the breach!), or
   * someone left clinging to their last HP. Everything else returns null.
   */
  private summarizeReactableAction(events: Event[]): { actorId: CharacterId; summary: string } | null {
    let actionEv: (Event & { type: 'action' }) | null = null;
    for (const e of events) {
      if (e.type === 'action' && REACTABLE_ACTION_KINDS.has((e.action as { kind: string }).kind)) {
        actionEv = e as Event & { type: 'action' };
      }
    }
    if (!actionEv) return null;

    const byId = this.cfg.engine.charactersById();
    const nameOf = (id: unknown): string =>
      (typeof id === 'string' ? byId.get(id as CharacterId)?.name : undefined) ?? String(id);
    const actorId = actionEv.actorId as CharacterId;
    const actorName = nameOf(actorId);
    const act = actionEv.action as {
      kind: string; targetId?: unknown; targetIds?: unknown; pos?: { x: number; y: number };
    };

    let verb: string;
    switch (act.kind) {
      case 'normal_attack': verb = `attacked ${nameOf(act.targetId)}`; break;
      case 'special_action':
        verb = Array.isArray(act.targetIds) && act.targetIds.length > 0
          ? `unleashed a special attack on ${act.targetIds.map(nameOf).join(', ')}`
          : 'used a special ability';
        break;
      case 'attack_object': verb = `smashed the object at (${act.pos?.x}, ${act.pos?.y})`; break;
      case 'free_ally': verb = `moved to free ${nameOf(act.targetId)}`; break;
      case 'use_boon': verb = 'used an item'; break;
      default: verb = 'acted';
    }

    // Outcome from the resolution(s): HIT/MISS for opposed attacks, success for
    // checks (ability/object/free), plus "destroyed" when an obstacle broke.
    // `significant` accumulates the gate verdict alongside (see doc comment).
    let significant = false;
    const parts: string[] = [];
    for (const e of events) {
      if (e.type !== 'resolution') continue;
      const p = e.public as {
        hit?: unknown; damage?: unknown; targetId?: unknown; success?: unknown;
        obstacleDestroyed?: unknown;
      };
      if (typeof p.hit === 'boolean' && typeof p.targetId === 'string') {
        parts.push(p.hit
          ? `HIT ${nameOf(p.targetId)} for ${typeof p.damage === 'number' ? p.damage : 0}`
          : `MISSED ${nameOf(p.targetId)}`);
        if (p.hit && typeof p.damage === 'number' && p.damage >= 2) significant = true;
      } else if (typeof p.success === 'boolean' && act.kind !== 'normal_attack') {
        parts.push(p.success ? 'it worked' : "it didn't work");
        // A successful rescue is always a beat — the captive's status flips
        // back to 'normal', which the status check below can't distinguish
        // from a routine damage entry (those always carry status: 'normal').
        if (p.success && act.kind === 'free_ally') significant = true;
      }
      if (p.obstacleDestroyed) { parts.push('the object shattered'); significant = true; }
    }
    // Resulting HP for anyone whose HP/status changed (damage, KO, heal, freed).
    const affected: CharacterId[] = [];
    for (const e of events) {
      if (e.type !== 'state_change') continue;
      for (const ch of e.changes) {
        // Entering an ABNORMAL state (KO, prone, newly bound) is always a beat.
        // Damage entries always carry `status` (usually 'normal'), so presence
        // alone means nothing — only a non-normal value signals a real flip.
        // (The rescue flip TO normal is caught via free_ally success above.)
        if ('status' in ch && (ch as { status?: string }).status !== 'normal') significant = true;
        if (('damage' in ch || 'status' in ch) && !affected.includes(ch.id)) affected.push(ch.id);
      }
    }
    for (const id of affected) {
      const c = byId.get(id);
      if (!c) continue;
      parts.push(`${nameOf(id)} is now ${c.health.total - c.health.damage}/${c.health.total} HP (${c.health.status})`);
      // Someone left clinging to their last HP (but alive) is a beat too.
      if (c.health.status !== 'KO' && c.health.total - c.health.damage <= 1) significant = true;
    }
    // The actor hurting THEMSELVES (the motivating oil-cask self-blast).
    if (affected.includes(actorId)) significant = true;

    if (!significant) return null;  // routine outcome — not worth an LLM call per agent
    const summary = `${actorName} ${verb}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}.`;
    return { actorId, summary };
  }

  /**
   * Hero half of the off-turn reaction round: ask every eligible AI hero (not
   * the actor, not the human seat, not KO'd) for an optional reaction to
   * `summary` — CONCURRENTLY, so the half costs max(call), not sum(call). Each
   * reactor reacts to the same engine-truth summary (not to each other's
   * lines, which don't exist yet). Returns `[reactorId, reaction]` pairs in
   * stable party order; broadcasts NOTHING — see `broadcastReactions`. Uses
   * the current turn's abort signal (does NOT reassign `turnAbort`, since this
   * runs mid-turn inside the acting agent's runner).
   */
  private collectHeroReactions(
    actorId: CharacterId,
    summary: string,
  ): Promise<Array<[CharacterId, { says: string[]; emojis: string[] }]>> {
    const humanId = this.humanCharacterId;
    const byId = this.cfg.engine.charactersById();
    const reactors = [...this.cfg.agents.players.entries()].filter(([reactorId]) => {
      if (reactorId === actorId || reactorId === humanId) return false;
      const ch = byId.get(reactorId);
      return !!ch && ch.health.status !== 'KO';  // KO'd heroes can't pipe up
    });
    return Promise.all(reactors.map(async ([reactorId, agent]) => {
      this.signalThinking(reactorId);
      try {
        const reaction = await agent.reactToPartyAction(
          summary, this.historyFor({ kind: 'self', actorId: reactorId }), this.currentTurnIdx,
          {
            emitThought: (text) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: reactorId, text } as Omit<Event, 't'>),
            onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
            signal: this.turnSignal,
          },
        );
        return [reactorId, reaction] as [CharacterId, { says: string[]; emojis: string[] }];
      } finally {
        this.signalThinkingDone(reactorId);
      }
    }));
  }

  /**
   * Enemy half of the reaction round: the DM voices any living monsters that
   * react to the resolved action (a hiss, a screech, a taunt), in ONE
   * `reactAsMonsters` call — composable concurrently with the hero half.
   * Returns the raw voicings (validated at broadcast time against live board
   * state); broadcasts nothing. Resolves [] when no foe is eligible, without
   * burning an LLM call. Like the hero half: pure banter, no turn consumed,
   * uses the current turn's abort signal.
   */
  private async collectMonsterVoicings(
    actorId: CharacterId,
    summary: string,
  ): Promise<Array<{ monsterId: string; say?: string; emoji?: string }>> {
    const byId = this.cfg.engine.charactersById();
    const eligible = (id: string): boolean => {
      const c = byId.get(id as CharacterId);
      return !!c && c.kind === 'monster' && c.health.status !== 'KO' && c.id !== actorId;
    };
    if (!Array.from(byId.values()).some((c) => eligible(String(c.id)))) return [];

    this.signalThinking('dm');
    try {
      return await this.cfg.agents.dm.reactAsMonsters(
        summary, this.historyFor({ kind: 'self', actorId: 'dm' }), this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: 'dm', text } as Omit<Event, 't'>),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          signal: this.turnSignal,
        },
      );
    } finally {
      this.signalThinkingDone('dm');
    }
  }

  /**
   * Broadcast a completed reaction round, hero lines first (stable party
   * order), then monster voicings — each as that actor's own off-turn `say` /
   * `emote` (pure banter; never re-scanned, so cascade-free). Voicings are
   * validated against LIVE board state: never a dead foe, the actor, or an
   * unknown id. Stops early if a human interjection queued so the human stays
   * heard — the un-broadcast banter is simply dropped.
   */
  private async broadcastReactions(
    heroReactions: Array<[CharacterId, { says: string[]; emojis: string[] }]>,
    voicings: Array<{ monsterId: string; say?: string; emoji?: string }>,
    actorId: CharacterId,
    log: EventLog,
  ): Promise<void> {
    for (const [reactorId, reaction] of heroReactions) {
      if (this.interjections.length > 0) return;
      for (const text of reaction.says) {
        this.cfg.engine.emitRuntime({ type: 'action', actorId: reactorId, action: { kind: 'say', text } } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
      }
      for (const emoji of reaction.emojis) {
        this.cfg.engine.emitRuntime({ type: 'action', actorId: reactorId, action: { kind: 'emote', emoji } } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
      }
    }
    const byId = this.cfg.engine.charactersById();
    const eligible = (id: string): boolean => {
      const c = byId.get(id as CharacterId);
      return !!c && c.kind === 'monster' && c.health.status !== 'KO' && c.id !== actorId;
    };
    for (const r of voicings) {
      if (this.interjections.length > 0) return;
      if (!eligible(r.monsterId)) continue;  // never voice a dead foe, the actor, or an unknown id
      const monsterId = r.monsterId as CharacterId;
      if (r.say) {
        this.cfg.engine.emitRuntime({ type: 'action', actorId: monsterId, action: { kind: 'say', text: r.say } } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
      }
      if (r.emoji) {
        this.cfg.engine.emitRuntime({ type: 'action', actorId: monsterId, action: { kind: 'emote', emoji: r.emoji } } as Omit<Event, 't'>);
        await this.drainAndPublish(log);
      }
    }
  }

  /** Predicate for `TurnTracker.advance` so the cursor rotates past KO'd actors. */
  private isAlive = (id: CharacterId): boolean => {
    const c = this.cfg.engine.charactersById().get(id);
    return c?.health.status !== 'KO';
  };

  /**
   * Apply an action via the engine, consulting the optional `rollProvider`
   * for normal-attack face values first. The provider lets the browser's
   * 3D physics drive the visible dice — when it returns a valid result the
   * engine resolves the attack against those exact faces. On any of:
   *   - no rollProvider configured
   *   - action isn't a normal_attack
   *   - preview already returned a rule_violation (action would fail anyway)
   *   - provider returned null / malformed / wrong-length faces
   * the call falls through to the engine's seeded `Dice` so the headless,
   * CLI, and AI-only paths keep working unchanged.
   *
   * All non-attack actions pass straight through with no extra latency.
   */
  private async applyActionWithRolls(
    actorId: CharacterId,
    action: PlayerAction,
    opts?: { interpretedBy?: 'dm' },
  ): Promise<Result<ActionOk, RuleViolation>> {
    const engine = this.cfg.engine;
    const provider = this.cfg.rollProvider;
    if (!provider) {
      return engine.applyAction(actorId, action, opts);
    }
    // ability_test and attack_object are single-pool CHECK rolls (one pool vs a
    // DC). Outsource their dice to the same browser physics overlay combat uses,
    // then resolve against the settled faces. Falls through to the seeded dice
    // on a failed preview (action would error anyway) or a missing/short reply.
    if (action.kind === 'ability_test') {
      const preview = engine.previewAbilityTest(actorId, action);
      if (!preview.ok) return engine.applyAction(actorId, action, opts);
      const rolled = await this.requestCheckRoll(actorId, preview.value.poolSize, preview.value.difficulty, action.describe);
      return rolled
        ? engine.applyAction(actorId, action, { ...opts, providedAbilityRoll: { roll: rolled.faces, requestId: rolled.requestId } })
        : engine.applyAction(actorId, action, opts);
    }
    if (action.kind === 'attack_object') {
      const preview = engine.previewAttackObject(actorId, action);
      if (!preview.ok) return engine.applyAction(actorId, action, opts);
      const rolled = await this.requestCheckRoll(
        actorId, preview.value.poolSize, preview.value.difficulty,
        `Smash the object at (${action.pos.x},${action.pos.y})`,
      );
      return rolled
        ? engine.applyAction(actorId, action, { ...opts, providedAbilityRoll: { roll: rolled.faces, requestId: rolled.requestId } })
        : engine.applyAction(actorId, action, opts);
    }
    // free_ally is a single-pool CHECK (rescuer's pool vs DC) — same physics
    // path as ability_test / attack_object: outsource the dice to the browser,
    // resolve against the settled faces.
    if (action.kind === 'free_ally') {
      const preview = engine.previewFreeAlly(actorId, action);
      if (!preview.ok) return engine.applyAction(actorId, action, opts);
      const target = engine.charactersById().get(action.targetId);
      const rolled = await this.requestCheckRoll(
        actorId, preview.value.poolSize, preview.value.difficulty,
        `Free ${target?.name ?? action.targetId} from the bindings`,
      );
      return rolled
        ? engine.applyAction(actorId, action, { ...opts, providedAbilityRoll: { roll: rolled.faces, requestId: rolled.requestId } })
        : engine.applyAction(actorId, action, opts);
    }
    // Multi-target special attacks (whirlwind / split-shot / flame-burst /
    // pack-attack) are a SEQUENCE of opposed sub-rolls. Outsource each to the
    // same physics overlay a normal attack uses — one roll_request per
    // sub-attack — then resolve all of them against the settled faces. The
    // single-effect path (healing) previews to zero sub-attacks and falls
    // through to the seeded engine unchanged.
    if (action.kind === 'special_action') {
      const preview = engine.previewSpecialAttacks(actorId, action);
      if (!preview.ok || preview.value.subAttacks.length === 0) {
        return engine.applyAction(actorId, action, opts);
      }
      const attacker = engine.charactersById().get(actorId)!;
      const providedSpecialRolls: Array<ProvidedAttackRolls | undefined> = [];
      for (const sub of preview.value.subAttacks) {
        providedSpecialRolls.push((await this.requestSubDuelRoll(attacker, sub)) ?? undefined);
      }
      return engine.applyAction(actorId, action, { ...opts, providedSpecialRolls });
    }
    if (action.kind !== 'normal_attack') {
      return engine.applyAction(actorId, action, opts);
    }
    const preview = engine.previewNormalAttackPools(actorId, action.targetId);
    if (!preview.ok) {
      // The same validation will fire inside applyAction; let it produce
      // the canonical rule_violation instead of duplicating the error here.
      return engine.applyAction(actorId, action, opts);
    }
    const { attackerPoolSize, defenderArmorPoolSize } = preview.value;
    const attacker = engine.charactersById().get(actorId)!;
    const defender = engine.charactersById().get(action.targetId)!;
    this.rollRequestSeq += 1;
    const spec: AttackRollSpec = {
      requestId: `roll-${this.cfg.runId}-${this.rollRequestSeq}`,
      attacker: {
        actorId,
        poolSize: attackerPoolSize,
        name: attacker.name,
        characterKind: attacker.kind,
        archetype: attacker.archetype ?? null,
        sprite: attacker.sprite ?? null,
      },
      defender: {
        actorId: action.targetId,
        poolSize: defenderArmorPoolSize,
        name: defender.name,
        characterKind: defender.kind,
        archetype: defender.archetype ?? null,
        sprite: defender.sprite ?? null,
      },
    };
    const reply = await provider.requestAttackRoll(spec);
    const valid =
      reply &&
      reply.attackerFaces.length === attackerPoolSize &&
      reply.defenderFaces.length === defenderArmorPoolSize &&
      reply.attackerFaces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6) &&
      reply.defenderFaces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6);
    if (valid) {
      return engine.applyAction(actorId, action, {
        ...opts,
        providedAttackRoll: {
          attackRoll: reply!.attackerFaces,
          armorRoll: reply!.defenderFaces,
          requestId: spec.requestId,
        },
      });
    }
    return engine.applyAction(actorId, action, opts);
  }

  /**
   * Ask the RollProvider for a single-pool CHECK roll (ability test / object
   * smash) of `poolSize` dice against `difficulty`. The actor rolls; there is
   * no opposing pool (the spec's `defender` is a 0-die "skill check" frame).
   * Returns the validated faces, or null to fall back to the seeded dice.
   */
  private async requestCheckRoll(
    actorId: CharacterId,
    poolSize: number,
    difficulty: number,
    describe: string,
  ): Promise<{ faces: number[]; requestId: string } | null> {
    const provider = this.cfg.rollProvider;
    if (!provider) return null;
    const actor = this.cfg.engine.charactersById().get(actorId)!;
    this.rollRequestSeq += 1;
    const spec: AttackRollSpec = {
      requestId: `roll-${this.cfg.runId}-${this.rollRequestSeq}`,
      attacker: {
        actorId,
        poolSize,
        name: actor.name,
        characterKind: actor.kind,
        archetype: actor.archetype ?? null,
        sprite: actor.sprite ?? null,
      },
      // No opposing roll — a 0-die placeholder the browser renders as the
      // "skill check" frame next to the attacker's dice. The DC value rides on
      // `check.difficulty`; the browser paints it as a die icon + number in the
      // frame's dice slot, so the nameplate is just the "DC" label.
      defender: {
        actorId,
        poolSize: 0,
        name: 'DC',
        characterKind: 'dm',
        archetype: null,
        sprite: null,
      },
      check: { difficulty, describe },
    };
    const reply = await provider.requestAttackRoll(spec);
    const valid =
      reply &&
      reply.attackerFaces.length === poolSize &&
      reply.attackerFaces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6);
    return valid ? { faces: reply!.attackerFaces, requestId: spec.requestId } : null;
  }

  /**
   * Ask the RollProvider for ONE opposed sub-roll of a multi-target special
   * action (attacker sub-pool vs that target's armor). Mirrors the normal-attack
   * spec so the browser renders the same VS duel frame. Returns the validated
   * faces tagged with the request id (echoed onto the resolution's
   * `rollRequestId`), or null to fall back to the seeded dice for this sub-attack.
   */
  private async requestSubDuelRoll(
    attacker: Character,
    sub: SubAttackSpec,
  ): Promise<ProvidedAttackRolls | null> {
    const provider = this.cfg.rollProvider;
    if (!provider) return null;
    const defender = this.cfg.engine.charactersById().get(sub.targetId);
    if (!defender) return null;
    this.rollRequestSeq += 1;
    const spec: AttackRollSpec = {
      requestId: `roll-${this.cfg.runId}-${this.rollRequestSeq}`,
      attacker: {
        actorId: attacker.id,
        poolSize: sub.attackerPoolSize,
        name: attacker.name,
        characterKind: attacker.kind,
        archetype: attacker.archetype ?? null,
        sprite: attacker.sprite ?? null,
      },
      defender: {
        actorId: sub.targetId,
        poolSize: sub.defenderArmorPoolSize,
        name: defender.name,
        characterKind: defender.kind,
        archetype: defender.archetype ?? null,
        sprite: defender.sprite ?? null,
      },
    };
    const reply = await provider.requestAttackRoll(spec);
    const valid =
      reply &&
      reply.attackerFaces.length === sub.attackerPoolSize &&
      reply.defenderFaces.length === sub.defenderArmorPoolSize &&
      reply.attackerFaces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6) &&
      reply.defenderFaces.every((f) => Number.isInteger(f) && f >= 1 && f <= 6);
    if (!valid) return null;
    return { attackRoll: reply!.attackerFaces, armorRoll: reply!.defenderFaces, requestId: spec.requestId };
  }

  async run(): Promise<OrchestratorResult> {
    const eventsPath = path.join(this.cfg.runDir, 'events.jsonl');
    const log = await EventLog.create(eventsPath, { stampWallClock: this.cfg.stampWallClock ?? false });

    this.startedAt = new Date().toISOString();
    let outcome: OrchestratorResult['outcome'] = 'aborted';
    // Why the run ended, carried to subscribers' onEnd so the browser can pick
    // the dedicated game-over screen for a party wipe (vs the ending banner).
    let endReason: 'party_wipe' | undefined;

    for (const sub of this.cfg.subscribers) await sub.onStart?.();

    // Let the human provider deliver OFF-TURN messages (interjections) straight
    // to the orchestrator instead of rejecting them. A live browser registers
    // this; scripted / headless providers don't implement it, so turn-locked
    // behaviour is preserved (the test suite never interjects).
    this.cfg.human?.provider.onInterject?.((input) => this.interject(input));

    // Materialize the starting scene's monsters BEFORE the DM's first turn.
    // The engine constructor only seats heroes — monsters enter via set_scene's
    // auto-reveal. Previously the DM had to call set_scene for the initial
    // scene itself, which depended on LLM sampling: some completions skipped
    // it and went straight to narration + request_action, leaving the board
    // empty of enemies. Engine-side set_scene is idempotent, so a DM that also
    // calls it sees a clean no-op.
    const initialScene =
      this.cfg.adventure.scenes.find((s) => s.id === this.cfg.startSceneId) ??
      this.cfg.adventure.scenes[0];
    if (initialScene) {
      const r = this.cfg.engine.applyDmAction({
        kind: 'set_scene',
        sceneId: asSceneId(initialScene.id),
      });
      if (!r.ok) {
        throw new Error(`failed to enter initial scene ${initialScene.id}: ${r.error.reason}`);
      }
    }

    let running = true;
    try {
      while (running) {
        if (this.cfg.abortSignal?.aborted) {
          outcome = 'aborted';
          running = false;
          break;
        }
        // Drain any pending engine events before deciding the next actor.
        await this.drainAndPublish(log);

        // Defeat condition: every hero is KO — the party has been wiped out.
        // The victory analog (maybeAutoEndCombat) ends the run when every
        // MONSTER is KO; without this the loop would keep running monster / DM
        // turns over a board of corpses forever. Emit adventure_ended(failure,
        // party_wipe) so the run ends and the browser shows the game-over
        // screen. A no-op while at least one hero is still standing.
        await this.maybeDetectPartyWipe(log);

        // End condition: an adventure_ended event has been written.
        const last = this.allEvents[this.allEvents.length - 1];
        if (last && last.type === 'adventure_ended') {
          outcome = last.outcome;
          endReason = last.reason;
          running = false;
          break;
        }

        // Hero-selection gate (once, at game start). BEFORE the opening splash
        // and any turn: let the player choose which starting hero they control
        // (the others stay AI-driven). The first snapshot — published above —
        // has already placed all heroes on the board behind the chooser. A
        // no-op without a heroSelectProvider / choices (CLI / scripted / AI-only).
        if (this.cfg.abortSignal?.aborted) { outcome = 'aborted'; running = false; break; }
        await this.awaitHeroSelectGate();
        // Localized hero names: once the language is final (the gate above is
        // the last place it can change), rename the heroes in the engine and
        // re-publish snapshots so the board, prompts, and narration all carry
        // the session language's names from the very first turn. A no-op for
        // English sessions, runs without overrides for the language, and on
        // every later loop iteration.
        this.maybeApplyLocalizedNames();

        // Opening-splash gate (once, at game start). The first snapshot —
        // carrying scene.opening — has just been published above, so the
        // browser can show the title splash. Block the DM's first turn until
        // the player clicks "Begin", then emit the opening's second half as a
        // narration beat. A no-op without an openingProvider or an opening.
        if (this.cfg.abortSignal?.aborted) { outcome = 'aborted'; running = false; break; }
        await this.awaitOpeningGate(log);

        // Game-start watermark: both start gates are behind us and the run
        // wasn't aborted while parked at either — the game is actually on.
        // (A reap at a gate resolves it via abort(), so the checks above/below
        // unwind BEFORE this line and the watermark stays false.)
        if (this.cfg.abortSignal?.aborted) { outcome = 'aborted'; running = false; break; }
        this.gameHasStarted = true;

        // Process any off-turn human interjections that have queued up — and
        // that may have just aborted the previous turn. Done BEFORE the beat
        // gate so the human's message is handled promptly rather than waiting
        // on narration they're clearly not reading (they typed instead).
        await this.drainInterjections(log);

        // Beat-pacing gate: do not start the next turn until the player has
        // read AND dismissed (Skip click, or auto-skip) every narration /
        // hero-speech beat the previous turn(s) published. Without this the
        // loop runs AI / monster / DM turns as fast as the LLM answers,
        // streaming their events while the human is still reading — which
        // looks like the game "taking turns on its own". A no-op when no
        // `beatGate` is configured (headless / CLI / AI-only) or when nothing
        // readable was published since the last gate. Mirrors the initiative
        // reveal_ack gate; bypassed cleanly when the player has auto-skip on.
        if (this.cfg.abortSignal?.aborted) { outcome = 'aborted'; running = false; break; }
        await this.awaitBeatGate();
        // An interjection can land DURING the beat gate (the provider resolves
        // the gate so we wake here); process it before dispatching the next turn.
        await this.drainInterjections(log);

        const actor = this.cfg.engine.turn.activeActorId;

        // Scope an AbortController to this turn so an interjection can cancel its
        // in-flight LLM call. The runners read `this.turnSignal` for their hooks.
        this.turnAbort = new AbortController();
        // Fresh turn → the DM hasn't reacted to it yet (see dmReactedThisTurn).
        this.dmReactedThisTurn = false;
        try {
          if (actor === null) {
            // DM acts.
            await this.runDmTurn(log);
          } else if (this.cfg.human && actor === this.humanCharacterId) {
            await this.runHumanTurn(actor, log);
          } else {
            const character = this.cfg.engine.charactersById().get(actor);
            if (character?.kind === 'monster') {
              // Deterministic monster AI (see monster-ai.ts). Charges and bites
              // when adjacent; otherwise closes distance. F24 is preserved: the
              // DM does NOT react after a monster turn — the action events are
              // already published to subscribers, and the next hero/DM turn
              // will see them in history.
              await this.runMonsterTurn(actor, log);
            } else if (character?.kind === 'npc') {
              // NPC turns are driven by the DM agent via the npc_action tool.
              await this.runNpcTurn(actor, log);
            } else if (character?.health.status === 'immobilized') {
              // A bound captive holds a turn slot (reserved at start_combat) but
              // can't act until an ally frees them — auto-skip without burning an
              // LLM call. Their AI agent takes over once free_ally clears the status.
              await this.runImmobilizedHeroTurn(actor, log);
            } else {
              await this.runAiTurn(actor, log);
            }
          }
        } finally {
          this.turnAbort = null;
        }
      }
    } finally {
      await log.close();
      for (const sub of this.cfg.subscribers) await sub.onEnd?.(outcome, endReason);
    }

    this.endedAt = new Date().toISOString();
    const manifestPath = path.join(this.cfg.runDir, 'manifest.json');
    await writeManifest(manifestPath, this.buildManifest(outcome));
    return { outcome, manifestPath, totalEvents: this.allEvents.length };
  }

  private recordUsage(
    role: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
    durationMs?: number,
  ): void {
    this.llmCalls[role] = (this.llmCalls[role] ?? 0) + 1;
    this.totalIn += usage.inputTokens;
    this.totalOut += usage.outputTokens;
    this.totalCacheRead += usage.cacheReadTokens;
    this.totalCacheWrite += usage.cacheWriteTokens;
    // Wall-clock latency per role (manifest `llmLatencyMs`) — measured by the
    // Agent around every llm.complete round-trip (Agent.completeTimed).
    if (durationMs !== undefined) {
      const d = (this.llmDurations[role] ??= { calls: 0, totalMs: 0, maxMs: 0 });
      d.calls += 1;
      d.totalMs += durationMs;
      d.maxMs = Math.max(d.maxMs, durationMs);
    }
    // Live observer (bin/play.ts logs a per-call line). Swallow observer
    // errors — a logging callback must never take down the run.
    try {
      this.cfg.onLlmCall?.({ role, usage, durationMs });
    } catch { /* ignore */ }
  }

  /**
   * After any combat-phase turn, if every monster is KO synthesize end_combat
   * so the DM regains narrative control. The engine's phase-gate (F18) ensures
   * end_combat fires at most once even if this is called repeatedly.
   */
  private async maybeAutoEndCombat(log: EventLog): Promise<void> {
    if (this.cfg.engine.turn.phase !== 'combat') return;
    const monsters = Array.from(this.cfg.engine.charactersById().values())
      .filter((c) => c.kind === 'monster');
    if (monsters.length === 0) return;
    if (!monsters.every((c) => c.health.status === 'KO')) return;
    const r = this.cfg.engine.applyDmAction({ kind: 'end_combat' });
    if (!r.ok && r.error.reason !== 'wrong-phase') {
      throw new Error(`auto end_combat rejected: ${r.error.reason}`);
    }
    await this.drainAndPublish(log);
  }

  /**
   * The defeat analog of maybeAutoEndCombat: if EVERY hero is KO the party has
   * been wiped out, so end the run as a failure (`reason: 'party_wipe'`) rather
   * than loop on monster / DM turns over a board of corpses. `immobilized` is a
   * living condition (a bound captive can still be freed / healed), so an
   * immobilized hero counts as alive and holds the run open. A no-op when no
   * heroes exist (pure-narration scene) or when at least one is still up; the
   * caller (main loop) sees the emitted adventure_ended on its next tick and
   * stops. Idempotent — bails if the run is already ending.
   */
  private async maybeDetectPartyWipe(log: EventLog): Promise<void> {
    const last = this.allEvents[this.allEvents.length - 1];
    if (last?.type === 'adventure_ended') return;
    const heroes = Array.from(this.cfg.engine.charactersById().values())
      .filter((c) => c.kind === 'hero');
    if (heroes.length === 0) return;
    if (!heroes.every((c) => c.health.status === 'KO')) return;
    this.cfg.engine.emitRuntime(
      { type: 'adventure_ended', outcome: 'failure', reason: 'party_wipe' } as Omit<Event, 't'>,
    );
    await this.drainAndPublish(log);
  }

  /**
   * The character the deterministic monster planner should fixate on this turn,
   * per the active scene's `monsterFocus` directive once the configured round
   * is reached — else `undefined` (normal nearest-reachable targeting). Reads
   * the live combat round (`engine.turn.roundNumber`); the planner itself
   * ignores the focus when the named target isn't a valid live enemy.
   */
  private monsterFocusTargetId(): CharacterId | undefined {
    const focus = this.cfg.engine.activeMonsterFocus();
    if (!focus) return undefined;
    return this.cfg.engine.turn.roundNumber >= focus.fromRound ? focus.characterId : undefined;
  }

  /** Dispatch a monster's combat turn to the configured controller (default
   *  deterministic; `'dm'` has the DM agent puppet the monster). */
  private async runMonsterTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    if (this.cfg.monsterControl === 'dm') {
      return this.runDmDrivenMonsterTurn(actorId, log);
    }
    return this.runDeterministicMonsterTurn(actorId, log);
  }

  /**
   * Drive a monster turn through the deterministic AI in `monster-ai.ts`.
   * The AI proposes an ordered list of actions (e.g. `[move, normal_attack]`
   * or `[end_turn]`); each is submitted to the engine in turn and we stop on
   * the first one that ends the turn.
   *
   * If the engine rejects an AI-proposed action (this would indicate an
   * AI/engine desync — the AI mirrors the engine's passability and range
   * rules, so it shouldn't), we fall back to `skip_turn` so the orchestrator
   * cannot hang waiting for an actor that won't end its turn.
   *
   * F24 (deterministic mode): this method does NOT call `runDmReact`. The
   * published action events show up in the chat log via subscribers; the DM
   * will see them in history on its next call. Re-narrating each monster step
   * is wasted token spend.
   */
  private async runDeterministicMonsterTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
    const reactFrom = this.allEvents.length;

    const monster = this.cfg.engine.charactersById().get(actorId);
    if (!monster) throw new Error(`monster ${actorId} not found`);
    const actions = chooseMonsterActions(
      monster,
      this.cfg.engine.charactersById(),
      this.cfg.engine.grid,
      MONSTER_MOVE_BUDGET,
      this.cfg.engine.activeBaitCells(),
      this.monsterFocusTargetId(),
    );

    const interActionDelay = this.cfg.monsterActionDelayMs ?? 0;
    let turnEnded = false;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const r = await this.applyActionWithRolls(actorId, action);
      if (!r.ok) {
        const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
        if (!skip.ok) {
          throw new Error(
            `monster fallback skip_turn rejected: ${skip.error.reason} ` +
            `(after AI action ${action.kind} rejected: ${r.error.reason})`,
          );
        }
        await this.drainAndPublish(log);
        turnEnded = true;
        break;
      }
      await this.drainAndPublish(log);
      if (r.value.turnEnded) { turnEnded = true; break; }
      // Inter-action breath: only when there's a NEXT action queued and the
      // caller wants the pause. Skipped for the last action so we don't
      // double up with the inter-turn delay below.
      if (interActionDelay > 0 && i < actions.length - 1) {
        await sleep(interActionDelay);
      }
    }
    if (!turnEnded) {
      // AI returned only non-terminal actions — defensively force end_turn.
      const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
      if (!force.ok) throw new Error(`monster forced end_turn rejected: ${force.error.reason}`);
      await this.drainAndPublish(log);
    }

    // Let the OTHER agents (heroes + DM-voiced foes) react to whatever this
    // monster just did this turn (e.g. biting a hero). No-op unless a reactable
    // action was logged and `partyReactions` is on.
    await this.maybeReactToResolvedActions(this.allEvents.slice(reactFrom), log);

    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);
    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);

    await this.maybeAutoEndCombat(log);

    this.currentTurnIdx += 1;

    // Inter-turn breath: pause only when the NEXT actor on the cursor is also
    // a monster. Hero/human/DM turns have natural latency (LLM call or user
    // input) so a delay there would just feel sluggish.
    const interTurnDelay = this.cfg.monsterTurnDelayMs ?? 0;
    if (interTurnDelay > 0 && this.nextActorIsMonster()) {
      await sleep(interTurnDelay);
    }
  }

  /**
   * Drive a monster's combat turn through the DM agent (`monsterControl: 'dm'`).
   * The DM narrates inline and acts for the monster via the `monster_action`
   * tool — attack-like actions route through the physics roll provider so
   * monster dice match hero dice. A deterministic-planner fallback guarantees
   * the monster acts and the turn ends even if the DM stalls or produces no
   * legal action. No separate `runDmReact`: the DM already had the floor (this
   * supersedes F24 in 'dm' mode, by user decision).
   */
  private async runDmDrivenMonsterTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
    this.signalThinking('dm');
    const reactFrom = this.allEvents.length;

    let turnEnded = false;
    let result;
    try {
      result = await this.cfg.agents.dm.takeTurn(
        { kind: 'control_combatant', actorId },
        this.historyFor({ kind: 'self', actorId: 'dm' }),
        this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({
            type: 'thought', actorId: 'dm', text,
          } as Omit<Event, 't'>),
          emitThinkingDelta: (text, who) => this.broadcastThinkingDelta(who, text),
          emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
            type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
          } as Omit<Event, 't'>),
          // No react during a monster turn — the DM is already acting.
          onEngineActed: async () => this.drainAndReturn(log),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          signal: this.turnSignal,
          applyDmAction: async (a) => {
            const r = await this.applyDmActionWithRolls(a);
            if (r.ok && a.kind === 'monster_action'
                && (a.action.kind === 'end_turn' || a.action.kind === 'skip_turn')) {
              turnEnded = true;
            }
            return r;
          },
        },
      );
    } finally {
      this.signalThinkingDone('dm');
    }
    await this.drainAndPublish(log);

    // A human interjection cancelled the DM mid-puppet: leave the monster's
    // turn open and bail. The main loop processes the message and re-dispatches
    // this monster turn (the engine already prevents a double main action).
    if (result.reason === 'interrupted') return;

    // Safety net: if the DM never ended the monster's turn, make sure it acts
    // and the turn closes so the loop can't hang. If the monster hasn't used
    // its main action yet, run the deterministic planner from its current cell
    // (it attacks if a hero is in reach, else steps closer); then force end_turn.
    if (!turnEnded) {
      if (!this.cfg.engine.turn.hasActed()) {
        const monster = this.cfg.engine.charactersById().get(actorId);
        if (monster) {
          const planned = chooseMonsterActions(monster, this.cfg.engine.charactersById(), this.cfg.engine.grid, MONSTER_MOVE_BUDGET, this.cfg.engine.activeBaitCells(), this.monsterFocusTargetId());
          for (const action of planned) {
            const r = await this.applyActionWithRolls(actorId, action);
            if (!r.ok) break;
            await this.drainAndPublish(log);
            if (r.value.turnEnded) { turnEnded = true; break; }
          }
        }
      }
      if (!turnEnded) {
        const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
        if (force.ok) await this.drainAndPublish(log);
      }
    }

    // Off-turn reaction round: let the heroes (and the DM's other foes) react to
    // what this monster just did — e.g. a hero firing back a taunt after a bite.
    // No-op unless a reactable action was logged and `partyReactions` is on.
    await this.maybeReactToResolvedActions(this.allEvents.slice(reactFrom), log);

    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);
    await this.maybeAutoEndCombat(log);
    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    this.currentTurnIdx += 1;

    const interTurnDelay = this.cfg.monsterTurnDelayMs ?? 0;
    if (interTurnDelay > 0 && this.nextActorIsMonster()) {
      await sleep(interTurnDelay);
    }
  }

  /**
   * `applyDmAction` hook for DM turns. Routes a DM-puppeted monster's
   * attack-like action (normal_attack / special_action / ability_test /
   * attack_object) through `applyActionWithRolls`, so its dice come from the
   * physics roll provider (parity with hero attacks). Validation happens inside
   * `applyActionWithRolls` → `applyAction`. Everything else — narrate, the
   * monster's move/end_turn, npc_action, and all non-monster DM actions — goes
   * through the synchronous `engine.applyDmAction`.
   */
  private async applyDmActionWithRolls(action: DmAction): Promise<Result<ActionOk, RuleViolation>> {
    if (action.kind === 'monster_action') {
      const inner = action.action;
      const physics = inner.kind === 'normal_attack' || inner.kind === 'special_action'
        || inner.kind === 'ability_test' || inner.kind === 'attack_object';
      const monster = this.cfg.engine.charactersById().get(action.monsterId);
      if (physics
          && monster?.kind === 'monster'
          && this.cfg.engine.turn.phase === 'combat'
          && this.cfg.engine.turn.activeActorId === action.monsterId) {
        return this.applyActionWithRolls(action.monsterId, inner, { interpretedBy: 'dm' });
      }
    }
    return this.cfg.engine.applyDmAction(action);
  }

  private nextActorIsMonster(): boolean {
    const next = this.cfg.engine.turn.activeActorId;
    if (next === null) return false;
    const character = this.cfg.engine.charactersById().get(next);
    return character?.kind === 'monster';
  }

  /**
   * Signal to subscribers that an actor is now waiting on an LLM call. The
   * browser uses this to show "DM is composing the scene…" / "Gareth is
   * choosing an action…" instead of the generic "Engine resolving turn"
   * spinner — without it, the gap between `turn_ended` and `turn_started`
   * feels indistinguishable from a hang.
   */
  private signalThinking(actorId: CharacterId | 'dm'): void {
    for (const sub of this.cfg.subscribers) sub.onThinking?.(actorId);
  }
  private signalThinkingDone(actorId: CharacterId | 'dm'): void {
    for (const sub of this.cfg.subscribers) sub.onThinkingDone?.(actorId);
  }
  /** Live streamed-thinking text → subscribers (browser banner). Runtime
   *  display only — never enters the engine queue or the event log. */
  private broadcastThinkingDelta(actorId: CharacterId | 'dm', text: string): void {
    for (const sub of this.cfg.subscribers) sub.onThinkingDelta?.(actorId, text);
  }

  /**
   * True once the DM has reacted (via `runDmReact`) since the current turn was
   * dispatched. The unconditional post-turn react is SKIPPED when set — a turn
   * whose attack already drew the DM's outcome narration was paying a second
   * full LLM call seconds later just to usually narrate nothing. Reset by the
   * main loop alongside each turn's `turnAbort`. Turns with no resolution (a
   * move-and-say turn) still get their post-turn react as before.
   */
  private dmReactedThisTurn = false;

  /**
   * F8 — invoke the DM agent with a single-step `react` hook between turns so
   * it can narrate outcomes (or call request_action / end_adventure). Skipped
   * when the adventure has already ended.
   */
  private async runDmReact(log: EventLog, outcomeSuffix = ''): Promise<void> {
    const last = this.allEvents[this.allEvents.length - 1];
    if (last?.type === 'adventure_ended') return;
    this.dmReactedThisTurn = true;
    this.signalThinking('dm');
    try {
      await this.cfg.agents.dm.react(
        this.historyFor({ kind: 'self', actorId: 'dm' }),
        this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({
            type: 'thought', actorId: 'dm', text,
          } as Omit<Event, 't'>),
          emitThinkingDelta: (text, who) => this.broadcastThinkingDelta(who, text),
          emitBudgetExhausted: () => {},
          onEngineActed: async () => this.drainAndReturn(log),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          signal: this.turnSignal,
        },
        outcomeSuffix,
      );
    } finally {
      this.signalThinkingDone('dm');
    }
    await this.drainAndPublish(log);
  }

  private async runDmTurn(log: EventLog): Promise<void> {
    this.signalThinking('dm');
    let result;
    try {
      result = await this.cfg.agents.dm.takeTurn(
        { kind: 'fresh_turn' },
        this.historyFor({ kind: 'self', actorId: 'dm' }),
        this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({
            type: 'thought', actorId: 'dm', text,
          } as Omit<Event, 't'>),
          emitThinkingDelta: (text, who) => this.broadcastThinkingDelta(who, text),
          emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
            type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
          } as Omit<Event, 't'>),
          onEngineActed: async () => this.drainAndReturn(log),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          signal: this.turnSignal,
        },
      );
    } finally {
      this.signalThinkingDone('dm');
    }
    await this.drainAndPublish(log);
    // Interjection cancelled the DM mid-turn: don't advance, don't end the run.
    // The main loop processes the human's message and re-runs the DM's turn.
    if (result.reason === 'interrupted') return;
    if (result.reason === 'budget_exhausted') {
      // Engine has not been told the DM is "done"; force a request_action(p1) as fallback.
      // For Layer B simplicity, a budget-exhausted DM aborts the run.
      this.cfg.engine.emitRuntime({ type: 'adventure_ended', outcome: 'failure' } as Omit<Event, 't'>);
      await this.drainAndPublish(log);
    }
    this.currentTurnIdx += 1;
  }

  /**
   * An immobilized hero's combat turn: they cannot move or act, so force
   * `skip_turn` (honest in the event log) and advance the cursor — no LLM call.
   * Once a teammate's `free_ally` clears the `immobilized` status, the cursor's
   * next visit to this hero routes through `runAiTurn` instead. Mirrors the
   * monster-turn tail (advance / auto-end-combat / inter-turn breath).
   */
  private async runImmobilizedHeroTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
    const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
    if (!skip.ok) throw new Error(`immobilized skip_turn rejected: ${skip.error.reason}`);
    await this.drainAndPublish(log);
    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);
    await this.maybeAutoEndCombat(log);
    // Clear the narrative actor so that, in the unlikely event the DM handed the
    // floor to a bound hero out of combat, the main loop returns to the DM
    // instead of re-dispatching the same immobilized actor forever. No-op in
    // combat (turn order is driven by the cursor, not the narrative actor).
    this.cfg.engine.turn.setNarrativeActor(null);
    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    this.currentTurnIdx += 1;
    const interTurnDelay = this.cfg.monsterTurnDelayMs ?? 0;
    if (interTurnDelay > 0 && this.nextActorIsMonster()) {
      await sleep(interTurnDelay);
    }
  }

  private async runAiTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    const agent = this.cfg.agents.players.get(actorId);
    if (!agent) throw new Error(`No agent for actor ${actorId}`);

    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
    this.signalThinking(actorId);

    let result;
    try {
      result = await agent.takeTurn(
        { kind: 'fresh_turn' },
        this.historyFor({ kind: 'self', actorId }),
        this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({
            type: 'thought', actorId, text,
          } as Omit<Event, 't'>),
          emitThinkingDelta: (text, who) => this.broadcastThinkingDelta(who, text),
          emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
            type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
          } as Omit<Event, 't'>),
          onEngineActed: async () => this.drainAndReactOnResolution(log),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          applyPlayerAction: (id, act) => this.applyActionWithRolls(id, act),
          onChainGap: (prev) => this.chainGap(prev),
          signal: this.turnSignal,
        },
      );
    } finally {
      this.signalThinkingDone(actorId);
    }
    await this.drainAndPublish(log);

    // Interjection cancelled this hero mid-turn: bail without ending the turn or
    // advancing the cursor. The main loop processes the human's message and
    // re-dispatches this same hero (the engine already tracks what it did, so a
    // partially-used turn resumes from its real state — no double move/attack).
    if (result.reason === 'interrupted') return;

    if (result.reason === 'budget_exhausted') {
      // Force end_turn through engine.
      const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
      if (!force.ok) throw new Error(`forced end_turn rejected: ${force.error.reason}`);
      await this.drainAndPublish(log);
    }

    // Combat cursor advance.
    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);

    // If this turn killed the last monster, end combat before the DM regains
    // control so the next turn starts fresh in narrative phase.
    await this.maybeAutoEndCombat(log);

    // Clear the narrative actor so the DM regains control after the player's turn.
    this.cfg.engine.turn.setNarrativeActor(null);

    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);

    // AI-to-AI chat: if this hero SPOKE on its turn, that line was heard by the
    // whole party — so give every OTHER AI hero a chance to react (banter /
    // emoji) before the DM narrates. Only the hero's own turn-says trigger this;
    // the reactions themselves are emitted off-turn and are never re-scanned, so
    // it's bounded to one round per turn-say (no cascade). No-op unless
    // `partyReactions` is enabled (see runPartyReactions).
    const saidThisTurn = result.steps
      .filter((s) => s.toolName === 'say' && typeof s.toolInput['text'] === 'string')
      .map((s) => (s.toolInput['text'] as string).trim())
      .filter((t) => t.length > 0);
    if (saidThisTurn.length > 0) {
      await this.runPartyReactions(actorId, saidThisTurn.join(' '), log);
    }

    // Post-turn DM react — skipped when the DM already reacted mid-turn (the
    // resolution-driven react in drainAndReactOnResolution), so a typical
    // attack turn costs ONE DM react, not two (see dmReactedThisTurn).
    if (!this.dmReactedThisTurn) await this.runDmReact(log);
    this.currentTurnIdx += 1;
  }

  /**
   * Testing seam: drive a single human turn against a fresh event log without
   * starting the full `run()` loop. Used by orchestrator tests that exercise
   * the human-turn branches in isolation.
   */
  async runOneHumanTurn(actorId: CharacterId): Promise<void> {
    const log = await EventLog.create(path.join(this.cfg.runDir, 'events.jsonl'));
    try {
      await this.runHumanTurn(actorId, log);
    } finally {
      await log.close();
    }
  }

  /**
   * Testing seam: drive a single monster turn (through the configured
   * `monsterControl`) against a fresh event log, without the full `run()` loop.
   * The engine must already be in combat with `actorId` as the active actor.
   */
  async runOneMonsterTurn(actorId: CharacterId): Promise<void> {
    const log = await EventLog.create(path.join(this.cfg.runDir, 'events.jsonl'));
    try {
      await this.runMonsterTurn(actorId, log);
    } finally {
      await log.close();
    }
  }

  private async runNpcTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);
    this.signalThinking('dm');

    let result;
    try {
      result = await this.cfg.agents.dm.takeTurn(
        { kind: 'fresh_turn' },
        this.historyFor({ kind: 'self', actorId: 'dm' }),
        this.currentTurnIdx,
        {
          emitThought: (text) => this.cfg.engine.emitRuntime({
            type: 'thought', actorId: 'dm', text,
          } as Omit<Event, 't'>),
          emitThinkingDelta: (text, who) => this.broadcastThinkingDelta(who, text),
          emitBudgetExhausted: (id) => this.cfg.engine.emitRuntime({
            type: 'step_budget_exhausted', actorId: id, forced: 'end_turn',
          } as Omit<Event, 't'>),
          onEngineActed: async () => this.drainAndReactOnResolution(log),
          onLlmResponse: (role, usage, durationMs) => this.recordUsage(role, usage, durationMs),
          signal: this.turnSignal,
        },
      );
    } finally {
      this.signalThinkingDone('dm');
    }
    await this.drainAndPublish(log);

    // Interjection cancelled the NPC's DM-driven turn: bail without advancing.
    // The main loop processes the message and re-dispatches this NPC turn.
    if (result.reason === 'interrupted') return;

    if (result.reason === 'budget_exhausted') {
      const force = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
      if (!force.ok) throw new Error(`forced end_turn rejected: ${force.error.reason}`);
      await this.drainAndPublish(log);
    }

    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);
    await this.maybeAutoEndCombat(log);
    this.cfg.engine.turn.setNarrativeActor(null);

    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    this.currentTurnIdx += 1;

  }

  private async runHumanTurn(actorId: CharacterId, log: EventLog): Promise<void> {
    if (!this.cfg.human) throw new Error('runHumanTurn called without a human config');

    for (const sub of this.cfg.subscribers) sub.onTurnStarted?.(actorId);

    // HeroKids allows 1 move + 1 main action per turn (see TurnTracker). The
    // human submits one input at a time and the loop keeps asking for more
    // until they explicitly end the turn (end_turn / skip_turn button, or the
    // free-text path emits a terminal action). Each iteration consumes one
    // requestInput() and either applies a single structured action, runs the
    // full free-text interpretation pass, or skips.
    let turnEnded = false;
    while (!turnEnded) {
    let input: HumanInput;
    try {
      input = await this.cfg.human.provider.requestInput();
    } catch (e) {
      // Session aborted (or other provider failure) — unwind the human-turn
      // loop without consuming the turn. The orchestrator's main loop will
      // observe abortSignal on its next iteration and exit.
      if (this.cfg.abortSignal?.aborted) return;
      throw e;
    }

    // Messages the human directs at the DM ("ask the DM") on their own turn are
    // INTERPRETED: the DM classifies them. A question is answered as a Q&A
    // sidebar (turn NOT consumed, loop back); an action intent ("I run and jump
    // over the barrels") is translated into the human's own player actions and
    // applied through the same engine + physics-dice path a button press uses —
    // the DM owns intent, the engine still validates and rolls. Off-turn
    // messages can't reach here (the provider routes them to drainInterjections,
    // whose answerOocQuery has no player tools), so in combat this only ever
    // acts on the player's own turn.
    if (input.kind === 'ooc_query') {
      this.cfg.engine.emitRuntime({
        type: 'player_ooc_query', actorId, text: input.text,
      } as Omit<Event, 't'>);
      await this.drainAndPublish(log);
      this.signalThinking('dm');
      let interp: HumanTurnInterpretation;
      try {
        interp = await this.cfg.agents.dm.interpretHumanTurn(
          input.text, actorId,
          this.historyFor({ kind: 'dm' }),
          this.currentTurnIdx,
          {
            emitThought: (t) => this.cfg.engine.emitRuntime({ type: 'thought', actorId: 'dm', text: t } as Omit<Event, 't'>),
            signal: this.turnSignal,
          },
        );
      } finally {
        this.signalThinkingDone('dm');
      }

      if (interp.kind === 'reply') {
        // Empty reply == a concurrent interjection cancelled the answer; skip the
        // blank bubble rather than emitting an empty dm_ooc_reply. Turn stays open.
        if (interp.text.length > 0) {
          this.cfg.engine.emitRuntime({
            type: 'dm_ooc_reply', toActorId: actorId, text: interp.text,
          } as Omit<Event, 't'>);
          await this.drainAndPublish(log);
        }
        continue;
      }

      // interp.kind === 'act' — apply the DM's interpretation as the human's own
      // actions, in order. Each goes through applyActionWithRolls so ability_test
      // / attack_object / free_ally / attacks use the browser's 3D dice, and the
      // action is tagged interpretedBy:'dm' for the audit log. A rejected action
      // surfaces the reason and stops the sequence WITHOUT forcing skip — the
      // turn stays open so the human can rephrase or end it themselves.
      // Between two interpreted actions, the same chain pacing as an AI hero's
      // multi-tool reply (chainGap) so the sequence doesn't render as a burst.
      let prevInterpreted: PlayerAction | null = null;
      for (const action of interp.actions) {
        if (prevInterpreted) await this.chainGap(prevInterpreted);
        const r = await this.applyActionWithRolls(actorId, action, { interpretedBy: 'dm' });
        if (!r.ok) {
          this.cfg.engine.emitRuntime({
            type: 'rule_violation', actorId, violation: r.error, attempted: action,
          } as Omit<Event, 't'>);
          this.cfg.engine.emitRuntime({
            type: 'narrate', actorId: 'dm',
            text: `That doesn't work right now (${r.error.reason}). Try something else, or end your turn.`,
          } as Omit<Event, 't'>);
          await this.drainAndPublish(log);
          break;
        }
        await this.drainAndReactOnResolution(log);
        if (r.value.turnEnded) { turnEnded = true; break; }
        // Same main-action auto-end as the button path: if the DM's interpreted
        // sequence spent the main action (e.g. move → attack), end the turn.
        if (await this.autoEndSpentHumanTurn(actorId, log)) { turnEnded = true; break; }
        prevInterpreted = action;
      }
      continue;
    }

    // Free-text from the human is treated as LITERAL speech. The text becomes
    // a `say` action with the exact words — no DM interpretation, no
    // rephrasing, no LLM round-trip. `say` is a free action in HeroKids, so
    // the turn stays open; the player keeps speaking and explicitly ends the
    // turn via skip_turn (story mode) or end_turn (combat). All viewers see
    // the same broadcast text via the visibility filter.
    if (input.kind === 'free_text') {
      const trimmed = input.text.trim();
      if (trimmed.length === 0) continue;  // ignore empty submissions
      const r = this.cfg.engine.applyAction(actorId, { kind: 'say', text: trimmed });
      if (!r.ok) {
        this.cfg.engine.emitRuntime({
          type: 'rule_violation', actorId, violation: r.error,
          attempted: { kind: 'say', text: trimmed },
        } as Omit<Event, 't'>);
      }
      await this.drainAndPublish(log);
      // The human's spoken line is a message TO THE PARTY: give every other AI
      // hero a chance to react (banter / emoji) off-turn, in any phase. (Same
      // round used by the off-turn interjection path — see runPartyReactions.)
      if (r.ok) await this.runPartyReactions(actorId, trimmed, log);
      // Story mode: a spoken line is the player's whole interaction with the
      // scene, so the DM must respond to it — otherwise the narrative sits
      // silent until the player happens to click Skip. `say` stays a free
      // action (the turn is NOT consumed; the player can keep talking, then
      // skip), but each accepted line now elicits a single DM react. Scoped
      // to the narrative phase: in combat `say` remains a silent free action
      // so we don't burn an LLM call re-narrating every mid-fight quip or
      // step on the combat beat (the resolution-driven react already covers
      // combat — see F8/F24). If the react hands the floor off via
      // request_action or ends the adventure, the post-loop runDmReact is a
      // safe no-op / the main loop re-derives the next actor.
      if (r.ok && this.cfg.engine.turn.phase === 'narrative') {
        await this.runDmReact(log);
      }
      continue;
    }

    // Emit a human_input event for structured_action / skip so the log records
    // the human's intent for these turn-consuming inputs.
    const inputText = input.kind === 'structured_action' ? `/action:${input.action.kind}` : '/skip';
    this.cfg.engine.emitRuntime({ type: 'human_input', actorId, text: inputText } as Omit<Event, 't'>);
    await this.drainAndPublish(log);

    if (input.kind === 'structured_action') {
      const r = await this.applyActionWithRolls(actorId, input.action);
      if (!r.ok) {
        // Surface the rejection through DM narrate so the player sees feedback,
        // and emit a rule_violation event for the audit log.
        this.cfg.engine.emitRuntime({
          type: 'rule_violation', actorId, violation: r.error, attempted: input.action,
        } as Omit<Event, 't'>);
        this.cfg.engine.emitRuntime({
          type: 'narrate', actorId: 'dm',
          text: `That action can't be taken: ${r.error.reason}.`,
        } as Omit<Event, 't'>);
        const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
        if (!skip.ok) throw new Error(`fallback skip_turn rejected: ${skip.error.reason}`);
        await this.drainAndReactOnResolution(log);
        turnEnded = true;
      } else {
        // Drain with post-resolution DM react so a /attack <id> elicits immediate
        // DM narration of the dice roll outcome before further play.
        await this.drainAndReactOnResolution(log);
        // The engine reports whether this action consumed the turn (end_turn /
        // skip_turn). Anything else leaves the turn open so the loop re-prompts
        // for the next action (the human's main action after a move, etc.).
        turnEnded = r.value.turnEnded;
        // HeroKids: the main action concludes a hero's turn — once it is spent,
        // only free actions remain. Auto-end the turn here rather than leave a
        // lone "End Turn" button. (The browser also fires an optimistic end_turn,
        // but with physics dice it races the roll round-trip and is rejected as
        // not-your-turn; this server-side end is the authoritative one.) A move
        // alone does NOT end the turn — the player can still act.
        if (!turnEnded) turnEnded = await this.autoEndSpentHumanTurn(actorId, log);
      }
    } else {
      // skip
      const skip = this.cfg.engine.applyAction(actorId, { kind: 'skip_turn' });
      if (!skip.ok) throw new Error(`skip_turn rejected: ${skip.error.reason}`);
      await this.drainAndPublish(log);
      turnEnded = true;
    }
    }

    // Combat cursor advance.
    if (this.cfg.engine.turn.phase === 'combat') this.cfg.engine.turn.advance(this.isAlive);

    // If the human's turn killed the last monster, end combat before the DM
    // regains control.
    await this.maybeAutoEndCombat(log);

    // Return narrative control to the DM.
    this.cfg.engine.turn.setNarrativeActor(null);

    for (const sub of this.cfg.subscribers) sub.onTurnEnded?.(actorId);
    // Post-turn DM react — skipped when the DM already reacted during this
    // human turn (resolution-driven or say-driven), mirroring runAiTurn.
    if (!this.dmReactedThisTurn) await this.runDmReact(log);
    this.currentTurnIdx += 1;
  }

  /**
   * HeroKids: a hero's turn is 1 move + 1 main action. The main action is
   * terminal — once it is spent, only free actions (say / emote / boons) remain,
   * so the turn should end instead of presenting a lone "End Turn" button.
   * Called after a successful human action: if the main action is now used,
   * apply `end_turn` for the human and return true. A move-only turn (acted ==
   * false) stays open so the player can still take their action.
   *
   * `end_turn` requires the human to still be the active actor — true here,
   * because the cursor only advances after `runHumanTurn`'s loop exits. Returns
   * false (turn stays open) if the action wasn't spent or the engine rejects the
   * end for any reason.
   */
  private async autoEndSpentHumanTurn(actorId: CharacterId, log: EventLog): Promise<boolean> {
    if (!this.cfg.engine.turn.hasActed()) return false;
    const end = this.cfg.engine.applyAction(actorId, { kind: 'end_turn' });
    if (!end.ok) return false;
    await this.drainAndPublish(log);
    return true;
  }

  private async drainAndPublish(log: EventLog): Promise<void> {
    await this.drainAndReturn(log);
  }

  /**
   * Hero-selection gate. Fires at most once, at game start — BEFORE the opening
   * splash and any turn. When a `heroSelectProvider` is attached (a browser is
   * present) AND `heroChoices` is non-empty, block until the player picks a
   * hero, then route the human to that hero (the two NOT chosen keep their AI
   * agents). A returned id that isn't one of the offered choices (or null, on
   * disconnect / no provider) leaves the scenario default in place. A no-op on
   * headless / CLI / scripted / AI-only runs. Replay-safe: the choice only
   * picks WHO decides each hero's actions; the resulting `action` events are
   * logged and replayed regardless of decider.
   */
  private async awaitHeroSelectGate(): Promise<void> {
    if (this.heroSelectGateDone) return;
    this.heroSelectGateDone = true;
    const choices = this.cfg.heroChoices;
    if (!this.cfg.heroSelectProvider || !this.cfg.human || !choices || choices.length === 0) return;
    const chosen = await this.cfg.heroSelectProvider.awaitHeroSelection(
      `hero-select-${this.cfg.runId}`,
      choices,
    );
    if (chosen && choices.some((h) => h.characterId === chosen.characterId)) {
      this.selectedHumanId = chosen.characterId;
    }
    // The language pick is honoured even when the hero id failed validation —
    // it's an independent choice from the same screen. Applied BEFORE the
    // first LLM call (this gate precedes the opening splash and every turn),
    // so the system band is final from call one and caching is unaffected.
    if (chosen?.language && chosen.language !== (this.cfg.language ?? 'en')) {
      this.selectedLanguage = chosen.language;
      this.cfg.onLanguageSelected?.(chosen.language);
    }
  }

  /** Whether `nameOverrides` has already been applied (once per run). */
  private namesApplied = false;

  /**
   * Rename the heroes to the session language's localized names, when
   * `nameOverrides` carries a map for it. Runs right after the hero-select
   * gate — the last point the language can change, still before the opening
   * beat and every turn — and re-publishes per-viewer snapshots (same
   * mechanism as a scene_enter) so the browser store's characters pick up
   * the new names before the board reveals. The engine keeps the override
   * map for characters that materialize later (the bound captive).
   * Display-only: ids, rules, and replay are untouched. English sessions
   * never rename — `name` IS the English name.
   */
  private maybeApplyLocalizedNames(): void {
    if (this.namesApplied) return;
    const language = this.selectedLanguage ?? this.cfg.language ?? 'en';
    if (language === 'en') return;
    const overrides = this.cfg.nameOverrides?.[language];
    if (!overrides || Object.keys(overrides).length === 0) return;
    this.namesApplied = true;
    this.cfg.engine.setNameOverrides(overrides);
    for (const sub of this.cfg.subscribers) {
      sub.onSnapshot?.(this.cfg.engine.getRedactedSnapshot(sub.viewer));
    }
  }

  /**
   * Opening-splash gate. Fires at most once, before the DM's first turn. When
   * an `openingProvider` is attached (a browser is present) AND the initial
   * scene has an `opening`, block until the player dismisses the title splash,
   * then emit the opening's `after` half as a DM `narrate` event. That event is
   * engine-emitted box text — NOT an LLM call: it reveals the board (the web
   * UI's `gameLoaded` flips on the first narration) and lands in the narrator
   * window, while the LLM DM is told (uiShowsIntro) to stay quiet about the
   * intro. It is logged like any narration, so replay reproduces it. A no-op
   * on headless / CLI / AI-only runs and on scenes without an `opening`.
   */
  private async awaitOpeningGate(log: EventLog): Promise<void> {
    if (this.openingGateDone) return;
    this.openingGateDone = true;
    if (!this.cfg.openingProvider) return;
    const initialScene =
      this.cfg.adventure.scenes.find((s) => s.id === this.cfg.startSceneId) ??
      this.cfg.adventure.scenes[0];
    // The narration beat follows the session's EFFECTIVE language — this gate
    // runs AFTER the hero-select gate, so a player language pick is already
    // applied. Falls back to English when the scene has no translated opening.
    const opening = initialScene
      ? sceneOpeningText(initialScene, this.selectedLanguage ?? this.cfg.language ?? 'en')
      : undefined;
    if (!opening) return;
    await this.cfg.openingProvider.awaitOpeningDismissed(`opening-${this.cfg.runId}`);
    this.cfg.engine.emitRuntime({ type: 'narrate', actorId: 'dm', text: opening.after } as Omit<Event, 't'>);
    await this.drainAndPublish(log);
  }

  /**
   * Block until the player has dismissed every narration / hero-speech beat
   * published since the last gate. No-op when no `beatGate` is configured or
   * when nothing readable has been published (so silent turns don't pause).
   * The flag is cleared BEFORE awaiting: the orchestrator is the only writer
   * and it's blocked here, so no beat can be published during the wait — and
   * clearing first means a disconnect-resolved gate doesn't strand the flag.
   */
  private async awaitBeatGate(): Promise<void> {
    if (!this.cfg.beatGate || !this.beatsPendingSinceGate) return;
    // A pending interjection takes priority: don't park on the beat gate while
    // the human is waiting to be heard — return so the loop processes it.
    if (this.interjections.length > 0) return;
    this.beatsPendingSinceGate = false;
    this.beatGateSeq += 1;
    const requestId = `beat-${this.cfg.runId}-${this.beatGateSeq}`;
    await this.cfg.beatGate.awaitBeatsDrained(requestId);
  }

  /**
   * Pacing between two CHAINED player actions (one multi-tool LLM reply, or
   * the DM-interpreted sequence of a human's free-text turn). Implements
   * `AgentRunHooks.onChainGap`:
   *   - after a `say`/`emote`, await the beat gate first — the line is a
   *     playback-queue beat, so this holds the NEXT board action until the
   *     player has actually read it (otherwise the bubble queues while the
   *     token already moved and the dice already rolled);
   *   - then a short `playerActionDelayMs` stagger so back-to-back board
   *     actions (move → attack) read as distinct moments, mirroring the
   *     monster turns' `monsterActionDelayMs`.
   * Skipped entirely when a human interjection is queued (bail fast — the
   * chain finishes at engine speed and the message gets processed). A no-op
   * headless/CLI/tests (no beatGate, delay 0), so determinism is untouched.
   */
  private async chainGap(prevAction: PlayerAction): Promise<void> {
    if (this.interjections.length > 0) return;
    if (prevAction.kind === 'say' || prevAction.kind === 'emote') {
      await this.awaitBeatGate();
    }
    const delay = this.cfg.playerActionDelayMs ?? 0;
    if (delay > 0 && this.interjections.length === 0) await sleep(delay);
  }

  /**
   * Drain pending engine events, append to history, write to log, and publish
   * to subscribers. Returns the drained events so callers (notably the agent's
   * onEngineActed hook) can build their own per-perspective view.
   *
   * If a `combat_started` event was drained AND `initiativeRevealDelayMs` is
   * set, the method sleeps after publishing so the UI can play the initiative
   * reveal before the first combatant's turn is dispatched. The engine's
   * cursor is already at `order[0]` by this point — the delay is what keeps
   * the orchestrator from racing ahead of the animation.
   */
  private async drainAndReturn(log: EventLog): Promise<Event[]> {
    const drained = this.cfg.engine.flushEvents();
    for (const ev of drained) {
      this.allEvents.push(ev);
      await log.append(ev);
      for (const sub of this.cfg.subscribers) {
        const r = filter(ev, sub.viewer);
        if (r !== null) sub.onEvent(r);
      }
      // Note that a readable beat went out so the main loop's beat gate knows
      // to pause before the next turn. (Public narration / speech, so this is
      // perspective-independent.)
      if (isGatingBeat(ev)) this.beatsPendingSinceGate = true;
    }
    // Scene transitions swap the engine's grid + obstacles + decorations.
    // Incremental events alone cannot reproduce the new layout in subscribers
    // (the browser would keep applying events on top of the previous scene),
    // so after any scene_enter is drained, push a fresh per-viewer snapshot
    // so every subscriber re-syncs its view to the active scene.
    if (drained.some((e) => e.type === 'scene_enter')) {
      for (const sub of this.cfg.subscribers) {
        sub.onSnapshot?.(this.cfg.engine.getRedactedSnapshot(sub.viewer));
      }
    }
    // Initiative-reveal gate. Once combat starts the engine's cursor is
    // already on the first combatant, so without a pause the orchestrator
    // would dispatch that turn (move monster tokens, fire roll_requests)
    // while the browser is still playing the "Order of Battle" reveal. With
    // a `revealProvider` the gate is player-driven — block until the browser
    // acks the reveal (Skip / auto-skip), so the first turn genuinely does
    // not start until the player is ready. Without one (headless / CLI),
    // fall back to the fixed wall-clock delay.
    if (drained.some((e) => e.type === 'combat_started')) {
      if (this.cfg.revealProvider) {
        this.revealRequestSeq += 1;
        const requestId = `reveal-${this.cfg.runId}-${this.revealRequestSeq}`;
        await this.cfg.revealProvider.awaitInitiativeReveal(requestId);
      } else {
        const initDelay = this.cfg.initiativeRevealDelayMs ?? 0;
        if (initDelay > 0) await sleep(initDelay);
      }
    }
    const resolveDelay = this.cfg.postResolutionDelayMs ?? 0;
    if (resolveDelay > 0 && drained.some((e) => e.type === 'resolution')) {
      await sleep(resolveDelay);
    }
    return drained;
  }

  /**
   * Drain like {@link drainAndReturn}, but if any of the drained events were
   * `resolution` events (dice rolls), invoke runDmReact so the DM narrates the
   * outcome before any further play. Returns the combined event list (player's
   * events + DM react's events) so the agent's onEngineActed hook can grow
   * liveHistory with the DM's commentary too.
   *
   * The recursion guard `inResolutionReact` prevents an infinite loop in case
   * a future DM-react tool produces a resolution itself (none currently do).
   */
  private inResolutionReact = false;
  private async drainAndReactOnResolution(log: EventLog): Promise<Event[]> {
    const events = await this.drainAndReturn(log);
    if (this.inResolutionReact) return events;
    if (!events.some((e) => e.type === 'resolution')) return events;
    // Skip if the adventure or combat was already concluded by these very events,
    // OR if combat's not active — in narrative phase the DM reacts via runDmTurn.
    const last = this.allEvents[this.allEvents.length - 1];
    if (last?.type === 'adventure_ended') return events;
    this.inResolutionReact = true;
    const before = this.allEvents.length;
    // Hand the DM the engine-truth HP outcome of what just resolved so it quotes
    // those numbers instead of recomputing them off the (already-post-hit) state
    // block and double-subtracting — see Agent.react / summarizeHpOutcome.
    const outcomeSuffix = summarizeHpOutcome(
      events,
      (id) => this.cfg.engine.charactersById().get(id),
    );
    // When the batch holds a SIGNIFICANT reactable action (see
    // summarizeReactableAction) and `partyReactions` is on, the off-turn
    // reaction round — teammates via reactToPartyAction, enemies voiced by the
    // DM — runs CONCURRENTLY with the DM's outcome react: every participant
    // works from the same engine-truth summary, so none needs the others'
    // prose, and the whole block costs ~one LLM call of wall-clock instead of
    // three or four serial ones. Broadcast order is unchanged (DM narration
    // drains first; hero lines, then foes, are emitted only after every call
    // settles). Otherwise just the DM react, as before.
    const trigger = this.cfg.partyReactions && !this.inActionReact && this.interjections.length === 0
      ? this.summarizeReactableAction(events) : null;
    try {
      if (trigger) {
        this.inActionReact = true;
        const [heroReactions, voicings] = await Promise.all([
          this.collectHeroReactions(trigger.actorId, trigger.summary),
          this.collectMonsterVoicings(trigger.actorId, trigger.summary),
          this.runDmReact(log, outcomeSuffix),
        ]);
        await this.broadcastReactions(heroReactions, voicings, trigger.actorId, log);
      } else {
        await this.runDmReact(log, outcomeSuffix);
      }
    } finally {
      this.inResolutionReact = false;
      if (trigger) this.inActionReact = false;
    }
    const reactEvents = this.allEvents.slice(before);
    return [...events, ...reactEvents];
  }

  private historyFor(viewer: Viewer): Event[] {
    const out: Event[] = [];
    for (const ev of this.allEvents) {
      const r = filter(ev, viewer);
      if (r !== null) out.push(r);
    }
    return out;
  }

  private buildManifest(outcome: OrchestratorResult['outcome']): RunManifest {
    const totalInput = this.totalIn + this.totalCacheRead;
    const cacheHitRatio = totalInput > 0 ? this.totalCacheRead / totalInput : 0;
    return {
      runId: this.cfg.runId,
      startedAt: this.startedAt || new Date(0).toISOString(),
      endedAt:   this.endedAt   || new Date(0).toISOString(),
      outcome:   outcome === 'aborted' ? 'in-progress' : outcome,
      adventure: `${this.cfg.adventure.id}@v1`,
      rngSeed:   this.cfg.seed,
      agents:    this.cfg.agentRecords ?? [],
      human:     this.cfg.human ? { characterId: this.humanCharacterId! } : null,
      stepBudget: this.cfg.stepBudget.player,
      totalEvents: this.allEvents.length,
      totalLlmCalls: { ...this.llmCalls },
      totalTokens: { in: this.totalIn + this.totalCacheRead, out: this.totalOut },
      cacheHitRatio,
      // Effective game language: the player's hero-select pick when made,
      // else the scenario default. A Layer-D experiment axis.
      language: this.selectedLanguage ?? this.cfg.language ?? 'en',
      // Per-role wall-clock LLM latency (Agent.completeTimed → recordUsage).
      // The per-call cost behind "how fast does the game generate actions".
      llmLatencyMs: Object.fromEntries(
        Object.entries(this.llmDurations).map(([role, d]) => [role, {
          calls: d.calls,
          totalMs: d.totalMs,
          meanMs: d.calls > 0 ? Math.round(d.totalMs / d.calls) : 0,
          maxMs: d.maxMs,
        }]),
      ),
    };
  }
}
