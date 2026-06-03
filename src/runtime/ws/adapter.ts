import type { Subscriber } from '../subscriber.js';
import type { CharacterId } from '../../engine/ids.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { RedactedSnapshot } from '../../engine/snapshot.js';
import type { HumanInput, HumanInputProvider } from '../orchestrator.js';
import type { RollProvider, AttackRollSpec, AttackRollResult } from '../roll-provider.js';
import type { RevealProvider } from '../reveal-provider.js';
import type { OpeningProvider } from '../opening-provider.js';
import type { HeroSelectProvider, HeroSelection } from '../hero-select-provider.js';
import type { BeatGate } from '../beat-gate.js';
import { encodeServerEnvelope, parseClientEnvelope, type ServerEnvelope, type HeroChoice, type SurveySubmission, type SurveyPersistResult } from './protocol.js';
import type { AssetManifest } from './manifest.js';
import type { WebSocket } from 'ws';

/** Hard cap on how long the orchestrator waits for a browser to settle dice
 *  and send back face values. The browser's physics typically resolves in
 *  ~1-2s; 30s is generous enough to mask transient lag without letting a
 *  stuck simulation freeze the run. On timeout the orchestrator falls back
 *  to the engine's seeded `Dice`. */
const ROLL_TIMEOUT_MS = 30_000;

/** Safety backstop for the browser-driven pacing gates (initiative reveal,
 *  beat gate). These normally have NO wall-clock timeout — the player reads at
 *  their own pace (spec: "human turn blocks indefinitely") — but a WEDGED
 *  browser would otherwise hang the run forever with the orchestrator blocked.
 *  The freeze is real: the *_ack a gate waits on is only sent once the browser's
 *  RAF-driven dice/overlay queue drains, and a backgrounded tab pauses RAF, so a
 *  dice/initiative overlay can stop settling and its ack never fires (observed
 *  live 2026-06-04 at the rat-tunnel transition). This cap is far longer than any
 *  real read, so a present player is never cut off, but bounded so a stuck client
 *  eventually releases and the run advances to the human's turn — which itself
 *  still blocks indefinitely (requestInput has no timeout). Only these two
 *  pacing gates get the backstop; the game-START gates (opening / hero-select)
 *  deliberately keep parking, since auto-passing them unattended free-runs the
 *  game with nobody watching. */
const GATE_MAX_WAIT_MS = 120_000;

/** Client envelopes only a HUMAN produces (typing a message, clicking an
 *  action / hero card / "Begin" / the survey Submit). Receiving one refreshes
 *  `lastHumanActivityMs`. Excludes traffic the page generates by itself —
 *  `roll_response` (physics dice relay), `beat_gate_ack` / `reveal_ack`
 *  (fired by the auto-skip timer) — so an abandoned tab stays "idle". */
const HUMAN_ACTIVITY_KINDS = new Set<string>([
  'human_input', 'structured_action', 'skip_turn',
  'hero_select_response', 'opening_ack', 'survey_response',
]);

/** Thrown by abort() into any pending requestInput so the orchestrator's
 *  human-turn loop unwinds rather than hanging forever. */
export class SessionAbortedError extends Error {
  constructor() { super('session aborted'); this.name = 'SessionAbortedError'; }
}

/**
 * Server-side Subscriber + HumanInputProvider that ships every Subscriber
 * callback as a JSON envelope to a connected browser WebSocket. Handles a
 * single browser per orchestrator run; reconnects re-attach with a fresh
 * snapshot.
 */
export class WsAdapter implements Subscriber, HumanInputProvider, RollProvider, RevealProvider, OpeningProvider, HeroSelectProvider, BeatGate {
  readonly viewer: Viewer;
  private ws: WebSocket | null = null;
  private manifest: AssetManifest;
  private pending: { resolve: (input: HumanInput) => void; reject: (e: Error) => void } | null = null;
  private aborted = false;
  /** Handler for OFF-TURN human input (interjections), registered by the
   *  orchestrator via `onInterject`. When set, a `human_input` that arrives
   *  while no `requestInput()` is pending is forwarded here (instead of being
   *  rejected with `not_your_turn`) so the orchestrator can abort the current
   *  generation and process the message. Null until registered. */
  private interjectHandler: ((input: HumanInput) => void) | null = null;
  /** In-flight roll requests awaiting a browser reply, keyed by requestId.
   *  Resolved by `onClientMessage` (`roll_response`), by `ROLL_TIMEOUT_MS`,
   *  or by `detach`/`abort` — in every "no answer" case the resolve value
   *  is `null` so the orchestrator falls back to the engine's seeded `Dice`. */
  private pendingRolls = new Map<string, {
    resolve: (result: AttackRollResult | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** In-flight initiative-reveal gates awaiting a browser `reveal_ack`, keyed
   *  by requestId. Unlike rolls there is NO timeout while a browser is
   *  attached — the player is given as long as they want to read the order
   *  of battle (spec: "human turn blocks indefinitely"). Resolved by
   *  `onClientMessage` (`reveal_ack`) or, so a closed tab can't hang the run,
   *  by `detach`/`abort`. A `GATE_MAX_WAIT_MS` timer is a last-resort backstop
   *  against a wedged (but still attached) browser whose ack never fires. */
  private pendingReveals = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
  /** In-flight beat-pacing gates awaiting a browser `beat_gate_ack`, keyed by
   *  requestId. Like reveals there is NO timeout while a browser is attached
   *  — the player reads each beat at their own pace (spec: "human turn blocks
   *  indefinitely"). Resolved by `onClientMessage` (`beat_gate_ack`) or, so a
   *  closed tab can't hang the run, by `detach`/`abort`. A `GATE_MAX_WAIT_MS`
   *  timer is a last-resort backstop against a wedged (but still attached)
   *  browser whose ack never fires. */
  private pendingBeatGates = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
  /** In-flight opening-splash gate awaiting a browser `opening_ack`, keyed by
   *  requestId. Like reveals there is NO timeout while a browser is attached —
   *  the player gets as long as they want on the title splash (spec: "human
   *  turn blocks indefinitely"). Resolved by `onClientMessage` (`opening_ack`)
   *  or by `abort`. NOT resolved by `detach`: a game-START gate must HOLD
   *  while no tab is attached (a refresh/closed tab silently "beginning" the
   *  adventure let sessions free-run unattended, burning LLM calls with
   *  nobody watching — observed live 2026-06-03). `attach()` re-sends the
   *  request so a reconnecting tab is re-prompted. */
  private pendingOpenings = new Map<string, () => void>();
  /** In-flight hero-selection gate awaiting a browser `hero_select_response`,
   *  keyed by requestId. Like the other game-start gates there is NO timeout
   *  while a browser is attached — the player chooses at their own pace.
   *  Resolved by `onClientMessage` (`hero_select_response`) with the chosen
   *  hero (+ optional game language), or by `abort` with `null` (→
   *  orchestrator keeps the scenario defaults). NOT resolved by `detach` —
   *  same hold-while-detached rule as the opening gate above; the options are
   *  kept so `attach()` can re-send the full request to a reconnecting tab. */
  private pendingHeroSelects = new Map<string, {
    resolve: (selection: HeroSelection | null) => void;
    options: HeroChoice[];
  }>();
  /** Persists a submitted playtest survey (run dir + optional GCS), registered
   *  by the host via `onSurvey`. Null (stub/preview servers) → the browser
   *  gets a `survey_ack { ok: false }` and falls back to the clipboard. */
  private surveyHandler: ((survey: SurveySubmission) => Promise<SurveyPersistResult>) | null = null;
  /** Epoch ms of the last HUMAN-INITIATED client envelope (see
   *  HUMAN_ACTIVITY_KINDS) — or, before any, of construction. The session
   *  registry's idle-under-queue-pressure sweep reads this to tell a player
   *  who is actually at the table from a tab someone clicked through and
   *  abandoned: automatic traffic (physics `roll_response`s, auto-skip
   *  `beat_gate_ack`s / `reveal_ack`s) deliberately does NOT count. */
  private lastHumanActivity = Date.now();

  /** Whether this session will (or already did) prompt the player to pick a
   *  starting hero. Set at construction from the scenario (human persona
   *  present + not script-automated). Drives the snapshot envelope's
   *  `awaitingHeroSelect` so the browser holds the opening splash until the
   *  chooser is up — see `awaitingHeroSelect()`. */
  private readonly expectsHeroSelect: boolean;
  /** Flips true once the hero-selection gate settles (a real pick OR an abort),
   *  after which snapshots no longer carry `awaitingHeroSelect`. */
  private heroSelectResolved = false;

  constructor(viewer: Viewer, manifest: AssetManifest, opts?: { expectsHeroSelect?: boolean }) {
    this.viewer = viewer;
    this.manifest = manifest;
    this.expectsHeroSelect = opts?.expectsHeroSelect ?? false;
  }

  /** True while the hero-selection gate is still ahead of (or at) the player —
   *  i.e. expected for this session and not yet answered. The browser uses it
   *  to suppress the opening splash (and any pre-game chrome) until the chooser
   *  mounts, closing the snapshot→`hero_select_request` flash window. */
  private awaitingHeroSelect(): boolean {
    return this.expectsHeroSelect && !this.heroSelectResolved;
  }

  /** Epoch ms of the last human-initiated message (or construction). */
  lastHumanActivityMs(): number {
    return this.lastHumanActivity;
  }

  /** Register the survey persistence handler (see `surveyHandler`). */
  onSurvey(handler: (survey: SurveySubmission) => Promise<SurveyPersistResult>): void {
    this.surveyHandler = handler;
  }

  /** Bind this adapter to a live socket and immediately send the snapshot. */
  attach(ws: WebSocket, state: RedactedSnapshot): void {
    this.ws = ws;
    ws.on('message', (raw: Buffer | string) => this.onClientMessage(raw.toString()));
    // Only detach when THIS exact socket closes. The server uses newest-wins:
    // a second connection kicks the old WS, then immediately calls attach()
    // again with the new socket. If the old socket's `close` event arrives
    // AFTER the swap, the captured `ws` no longer matches `this.ws` and we
    // must not nullify the new attachment.
    ws.on('close', () => { if (this.ws === ws) this.detach(); });
    this.send({ kind: 'snapshot', viewer: this.viewer, manifest: this.manifest, state, awaitingHeroSelect: this.awaitingHeroSelect() });
    // If a previous WS dropped mid-input (or got kicked by newest-wins) the
    // orchestrator's requestInput() promise is still pending. Snapshot resets
    // inputUnlocked on the browser, so without this re-send the new tab would
    // sit at "Resolving Bran's action…" forever while the engine waits on it.
    if (this.pending) this.send({ kind: 'input_required' });
    // Game-start gates HOLD across a detach (see the pendingHeroSelects /
    // pendingOpenings docs) — re-prompt the fresh tab so it can answer them.
    for (const [requestId, entry] of this.pendingHeroSelects) {
      this.send({ kind: 'hero_select_request', requestId, options: entry.options });
    }
    for (const [requestId] of this.pendingOpenings) {
      this.send({ kind: 'opening_request', requestId });
    }
  }

  detach(): void {
    // DO NOT reject `pending`. A natural WS close (tab refresh, idle TCP
    // timeout, transient network blip, OS sleeping the laptop) fires the
    // close handler set up in attach() — if we rejected here, runHumanTurn's
    // awaited requestInput() would throw, the orchestrator would tear down
    // the run, and the server would shut down behind the user's back.
    //
    // Instead, keep the pending request alive. When a fresh WS attaches
    // (same tab reconnect, or a new tab via newest-wins), attach() re-sends
    // `input_required` so the new client can fulfill the still-pending
    // promise. To actively kill a session (e.g. a different sid arrives),
    // call abort() instead.
    this.ws = null;
    // Pending rolls CANNOT survive disconnect — the browser's overlay state
    // is gone, so even on reconnect there's nothing to resume. Resolve to
    // null so the orchestrator falls through to the engine's seeded `Dice`
    // for that one roll and the run keeps going.
    this.resolveAllPendingRolls(null);
    // Likewise an initiative-reveal gate can't survive the tab going away —
    // the plaque (and its Skip button) is gone. Resolve so the orchestrator
    // proceeds to the first turn instead of blocking forever on an ack that
    // can never arrive; a reconnecting tab gets a fresh snapshot mid-combat.
    this.resolveAllPendingReveals();
    // Likewise a beat-pacing gate can't survive the tab going away — the
    // narrator (and its Skip button) is gone. Resolve so the orchestrator
    // proceeds to the next turn instead of blocking on an ack that can't
    // arrive; a reconnecting tab gets a fresh snapshot.
    this.resolveAllPendingBeatGates();
    // The game-START gates (hero select / opening splash) deliberately STAY
    // pending: resolving them here let a refreshed/closed tab silently pick
    // the default hero and "begin" the adventure, free-running the whole AI
    // party unattended (LLM calls with nobody watching) until the reap. The
    // run instead PARKS at the gate — silent, zero LLM — and either a
    // reconnecting tab is re-prompted (attach() re-sends the requests) or the
    // registry reaps the session (abort() resolves the gates and the
    // orchestrator's abort checks unwind the run before any turn).
  }

  /**
   * Force-cancel this adapter's session. Drops the WS reference and rejects
   * any in-flight requestInput() so the orchestrator's main loop can unwind
   * and exit with `outcome: 'aborted'`. Idempotent.
   */
  abort(): void {
    this.aborted = true;
    this.ws = null;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(new SessionAbortedError());
    }
    this.resolveAllPendingRolls(null);
    this.resolveAllPendingReveals();
    this.resolveAllPendingBeatGates();
    this.resolveAllPendingOpenings();
    this.resolveAllPendingHeroSelects(null);
  }

  /* Subscriber */
  onStart(): void {
    /* attach() does the initial-snapshot work; nothing to do at orchestrator startup. */
  }
  onEvent(event: RedactedEvent): void               { this.send({ kind: 'event', event }); }
  onTurnStarted(actorId: CharacterId | 'dm'): void  { this.send({ kind: 'turn_started', actorId }); }
  onTurnEnded(actorId: CharacterId | 'dm'): void    { this.send({ kind: 'turn_ended',   actorId }); }
  onThinking(actorId: CharacterId | 'dm'): void     { this.send({ kind: 'thinking',      actorId }); }
  onThinkingDone(actorId: CharacterId | 'dm'): void { this.send({ kind: 'thinking_done', actorId }); }
  onThinkingDelta(actorId: CharacterId | 'dm', text: string): void {
    this.send({ kind: 'thinking_delta', actorId, text });
  }
  onEnd(outcome: 'success' | 'failure' | 'aborted', reason?: 'party_wipe'): void {
    this.send(reason ? { kind: 'end', outcome, reason } : { kind: 'end', outcome });
  }
  /**
   * Mid-run snapshot push — fires after the orchestrator drains a scene_enter
   * so the browser re-syncs its view to the new scene's grid + obstacles +
   * decorations. Same envelope shape as the initial attach snapshot but
   * tagged `reason: 'scene_change'` so the store preserves chat history /
   * input state instead of doing a full reset.
   */
  onSnapshot(state: RedactedSnapshot): void {
    this.send({ kind: 'snapshot', viewer: this.viewer, manifest: this.manifest, state, reason: 'scene_change', awaitingHeroSelect: this.awaitingHeroSelect() });
  }

  /* HumanInputProvider */
  requestInput(): Promise<HumanInput> {
    if (this.aborted) return Promise.reject(new SessionAbortedError());
    if (this.pending) throw new Error('one pending request at a time');
    this.send({ kind: 'input_required' });
    return new Promise<HumanInput>((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  /** Register the orchestrator's off-turn interjection handler (see
   *  `HumanInputProvider.onInterject`). */
  onInterject(handler: (input: HumanInput) => void): void {
    this.interjectHandler = handler;
  }

  /* RollProvider */
  /**
   * Ship a `roll_request` to the browser and resolve with whatever face
   * values come back in the matching `roll_response`. Resolves to `null`
   * (and the orchestrator falls back to the engine's seeded `Dice`) if:
   *   - the adapter is aborted
   *   - no browser is currently attached
   *   - the browser doesn't reply within `ROLL_TIMEOUT_MS`
   *   - the WS disconnects mid-roll (`detach` / `abort` flushes pending)
   * Otherwise resolves with the faces the physics simulation settled on.
   */
  requestAttackRoll(spec: AttackRollSpec): Promise<AttackRollResult | null> {
    if (this.aborted || !this.ws) return Promise.resolve(null);
    return new Promise<AttackRollResult | null>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingRolls.get(spec.requestId);
        if (!entry) return;
        this.pendingRolls.delete(spec.requestId);
        entry.resolve(null);
      }, ROLL_TIMEOUT_MS);
      this.pendingRolls.set(spec.requestId, { resolve, timer });
      this.send({
        kind: 'roll_request',
        requestId: spec.requestId,
        rollKind: spec.check ? 'check' : 'attack',
        ...(spec.check ? { difficulty: spec.check.difficulty } : {}),
        attacker: spec.attacker,
        defender: spec.defender,
      });
    });
  }

  private resolveAllPendingRolls(value: AttackRollResult | null): void {
    for (const [, entry] of this.pendingRolls) {
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
    this.pendingRolls.clear();
  }

  /* RevealProvider */
  /**
   * Ship a `reveal_request` to the browser and resolve once the matching
   * `reveal_ack` arrives — i.e. the player dismissed the on-screen Order of
   * Battle (Skip click, or the auto-skip timer). Resolves IMMEDIATELY (so
   * the orchestrator proceeds straight to the first turn) if:
   *   - the adapter is aborted
   *   - no browser is currently attached
   *   - the WS disconnects mid-reveal (`detach` / `abort` flushes pending)
   * There is deliberately no wall-clock timeout while a browser is attached:
   * the player gets as long as they want to read the roster.
   */
  awaitInitiativeReveal(requestId: string): Promise<void> {
    if (this.aborted || !this.ws) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingReveals.get(requestId);
        if (!entry) return;
        this.pendingReveals.delete(requestId);
        entry.resolve();
      }, GATE_MAX_WAIT_MS);
      this.pendingReveals.set(requestId, { resolve, timer });
      this.send({ kind: 'reveal_request', requestId });
    });
  }

  private resolveAllPendingReveals(): void {
    for (const [, entry] of this.pendingReveals) { clearTimeout(entry.timer); entry.resolve(); }
    this.pendingReveals.clear();
  }

  /* BeatGate */
  /**
   * Ship a `beat_gate` to the browser and resolve once the matching
   * `beat_gate_ack` arrives — i.e. the player has dismissed every queued
   * narration / hero-speech beat (Skip clicks, or auto-skip). Resolves
   * IMMEDIATELY (so the orchestrator starts the next turn without pausing) if:
   *   - the adapter is aborted
   *   - no browser is currently attached
   *   - the WS disconnects mid-gate (`detach` / `abort` flushes pending)
   * There is deliberately no wall-clock timeout while a browser is attached:
   * the player reads each beat at their own pace.
   */
  awaitBeatsDrained(requestId: string): Promise<void> {
    if (this.aborted || !this.ws) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingBeatGates.get(requestId);
        if (!entry) return;
        this.pendingBeatGates.delete(requestId);
        entry.resolve();
      }, GATE_MAX_WAIT_MS);
      this.pendingBeatGates.set(requestId, { resolve, timer });
      this.send({ kind: 'beat_gate', requestId });
    });
  }

  private resolveAllPendingBeatGates(): void {
    for (const [, entry] of this.pendingBeatGates) { clearTimeout(entry.timer); entry.resolve(); }
    this.pendingBeatGates.clear();
  }

  /* OpeningProvider */
  /**
   * Ship an `opening_request` to the browser and resolve once the matching
   * `opening_ack` arrives — i.e. the player clicked "Begin" on the title
   * splash. Resolves IMMEDIATELY (so the orchestrator runs the DM's first turn
   * without pausing) if:
   *   - the adapter is aborted
   *   - no browser is currently attached
   *   - the WS disconnects mid-splash (`detach` / `abort` flushes pending)
   * There is deliberately no wall-clock timeout while a browser is attached:
   * the player gets as long as they want on the opening.
   */
  awaitOpeningDismissed(requestId: string): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingOpenings.set(requestId, resolve);
      // No tab right now (refresh window / closed tab)? PARK without sending —
      // attach() re-sends the request to whichever socket reattaches. The gate
      // must not auto-pass while nobody is watching (see pendingOpenings doc).
      if (this.ws) this.send({ kind: 'opening_request', requestId });
    });
  }

  private resolveAllPendingOpenings(): void {
    for (const [, resolve] of this.pendingOpenings) resolve();
    this.pendingOpenings.clear();
  }

  /* HeroSelectProvider */
  /**
   * Ship a `hero_select_request` to the browser and resolve once the matching
   * `hero_select_response` arrives — i.e. the player picked a hero on the
   * "Choose your hero" screen. Resolves to `null` (→ the orchestrator keeps the
   * scenario's default human hero) if:
   *   - the adapter is aborted
   *   - no browser is currently attached
   *   - the WS disconnects mid-selection (`detach` / `abort` flushes pending)
   * There is deliberately no wall-clock timeout while a browser is attached:
   * the player gets as long as they want to choose.
   */
  awaitHeroSelection(requestId: string, options: HeroChoice[]): Promise<HeroSelection | null> {
    if (this.aborted) return Promise.resolve(null);
    return new Promise<HeroSelection | null>((resolve) => {
      this.pendingHeroSelects.set(requestId, { resolve, options });
      // No tab right now? PARK without sending — attach() re-sends (see
      // awaitOpeningDismissed above; same hold-while-detached rule).
      if (this.ws) this.send({ kind: 'hero_select_request', requestId, options });
    });
  }

  private resolveAllPendingHeroSelects(value: HeroSelection | null): void {
    for (const [, entry] of this.pendingHeroSelects) entry.resolve(value);
    this.pendingHeroSelects.clear();
    // Abort path: the gate is settled (the run is unwinding) — don't keep
    // advertising it as pending on any trailing snapshot.
    this.heroSelectResolved = true;
  }

  /* internal */
  private send(env: ServerEnvelope): void {
    if (!this.ws) return;
    const OPEN = 1;
    if ((this.ws as unknown as { readyState: number }).readyState !== OPEN) return;
    this.ws.send(encodeServerEnvelope(env));
  }

  private onClientMessage(raw: string): void {
    const env = parseClientEnvelope(raw);
    if (!env) { this.send({ kind: 'rejected', reason: 'invalid_envelope' }); return; }
    // Track the human's presence: a message a PERSON had to produce (typing,
    // clicking an action / hero card / Begin / survey Submit) refreshes the
    // activity stamp the registry's idle sweep reads. Automatic relays —
    // physics roll_responses, auto-skip beat/reveal acks — don't count, so an
    // abandoned tab whose page keeps acking still reads as idle.
    if (HUMAN_ACTIVITY_KINDS.has(env.kind)) this.lastHumanActivity = Date.now();
    // Roll responses can arrive at any time the orchestrator has a pending
    // physics roll out — they're independent of the human-input request
    // lifecycle, so handle them BEFORE the "is anyone awaiting input?" check.
    if (env.kind === 'roll_response') {
      const entry = this.pendingRolls.get(env.requestId);
      if (!entry) return;  // stale or unknown id — ignore silently
      clearTimeout(entry.timer);
      this.pendingRolls.delete(env.requestId);
      entry.resolve({ attackerFaces: env.attackerFaces, defenderFaces: env.defenderFaces });
      return;
    }
    // Reveal acks are likewise independent of the human-input lifecycle —
    // they release the initiative-reveal gate the orchestrator is blocked on
    // between `combat_started` and the first combatant's turn.
    if (env.kind === 'reveal_ack') {
      const entry = this.pendingReveals.get(env.requestId);
      if (!entry) return;  // stale or unknown id — ignore silently
      clearTimeout(entry.timer);
      this.pendingReveals.delete(env.requestId);
      entry.resolve();
      return;
    }
    // Beat-pacing acks are also independent of the human-input lifecycle —
    // they release the gate the orchestrator is holding between turns while
    // the player reads the previous turn's narration.
    if (env.kind === 'beat_gate_ack') {
      const entry = this.pendingBeatGates.get(env.requestId);
      if (!entry) return;  // stale or unknown id — ignore silently
      clearTimeout(entry.timer);
      this.pendingBeatGates.delete(env.requestId);
      entry.resolve();
      return;
    }
    // Opening acks release the title-splash gate the orchestrator holds before
    // the DM's first turn — independent of the human-input lifecycle.
    if (env.kind === 'opening_ack') {
      const resolve = this.pendingOpenings.get(env.requestId);
      if (!resolve) return;  // stale or unknown id — ignore silently
      this.pendingOpenings.delete(env.requestId);
      resolve();
      return;
    }
    // Survey submissions are pure side-channel — independent of turns, gates,
    // and the input lifecycle (the tester can submit at any time, including
    // after the run ended). Persist via the registered handler and ack the
    // result so the modal can confirm (or steer to the clipboard fallback).
    if (env.kind === 'survey_response') {
      const handler = this.surveyHandler;
      if (!handler) {
        this.send({ kind: 'survey_ack', ok: false, detail: 'no survey handler registered' });
        return;
      }
      void handler(env.survey)
        .then((result) => this.send({ kind: 'survey_ack', ...result }))
        .catch((e: unknown) => this.send({ kind: 'survey_ack', ok: false, detail: String(e) }));
      return;
    }
    // Hero-select responses release the game-start hero-selection gate — also
    // independent of the human-input lifecycle (it fires before any turn).
    if (env.kind === 'hero_select_response') {
      const entry = this.pendingHeroSelects.get(env.requestId);
      if (!entry) return;  // stale or unknown id — ignore silently
      this.pendingHeroSelects.delete(env.requestId);
      // The gate is answered — later snapshots (localized-name re-publish,
      // scene changes) must stop advertising a pending hero select.
      this.heroSelectResolved = true;
      entry.resolve({
        characterId: env.characterId as CharacterId,
        ...(env.language !== undefined ? { language: env.language } : {}),
      });
      return;
    }
    if (!this.pending) {
      // No requestInput() is outstanding — it isn't the human's turn. A free-text
      // line "to Game" / "to DM" is an INTERJECTION: forward it to the
      // orchestrator (if it registered a handler) so it can abort whatever is
      // generating and process the message. Turn-structured inputs (skip /
      // structured_action) still need the turn, so they're rejected as before.
      if (env.kind === 'human_input' && this.interjectHandler) {
        const input: HumanInput = env.target === 'dm'
          ? { kind: 'ooc_query', text: env.text }
          : { kind: 'free_text', text: env.text };
        // Wake the orchestrator if it's parked on a between-turns gate (beat /
        // initiative reveal) so the interjection is handled promptly instead of
        // waiting on a Skip click the human is clearly not going to make.
        this.resolveAllPendingBeatGates();
        this.resolveAllPendingReveals();
        this.interjectHandler(input);
        return;
      }
      this.send({ kind: 'rejected', reason: 'not_your_turn' });
      return;
    }
    const input: HumanInput = env.kind === 'skip_turn'
      ? { kind: 'skip' }
      : env.kind === 'structured_action'
        ? { kind: 'structured_action', action: env.action }
        : env.target === 'dm'
          ? { kind: 'ooc_query', text: env.text }
          : { kind: 'free_text', text: env.text };
    const p = this.pending; this.pending = null;
    this.send({ kind: 'input_done' });
    p.resolve(input);
  }
}
