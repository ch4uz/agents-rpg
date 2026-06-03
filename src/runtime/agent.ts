import type { CharacterId } from '../engine/ids.js';
import type { Character } from '../engine/character.js';
import type { Adventure, Scene } from '../engine/adventure.js';
import type { GameEngine } from '../engine/game-engine.js';
import type { PlayerAction, DmAction } from '../engine/action.js';
import type { Event } from '../log/events.js';
import type { LlmClient, ToolSchema, LlmResponse, LlmStreamCallbacks, ParsedToolUse } from './llm/llm-client.js';
import type { PromptBuilder, Observation } from './prompt/builder.js';
import type { Localized } from './language.js';
import type { Result } from '../engine/primitives.js';
import type { RuleViolation } from '../engine/action.js';
import type { ActionOk } from '../engine/game-engine.js';
import { LlmAbortedError } from './llm/llm-client.js';
import { decodePlayerToolUse, decodeDmToolUse, OOC_REPLY_TOOL, PLAYER_TOOLS, PARTY_REACT_TOOLS, MONSTER_REACT_TOOLS } from './prompt/tools.js';
import { filter as visibilityFilter } from './visibility/filter.js';
import type { Viewer } from './visibility/types.js';

export interface AgentStep {
  thought: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  observation: Observation;
}

/**
 * Outcome of `Agent.interpretHumanTurn`: the DM either answered the human's
 * on-turn message as a Q&A sidebar (`reply`, turn NOT consumed) or interpreted
 * it into a sequence of the human's own player actions (`act`).
 */
export type HumanTurnInterpretation =
  | { kind: 'reply'; text: string }
  | { kind: 'act'; actions: PlayerAction[] };

export interface AgentRunHooks {
  /** Called for every thinking block in every step. Default: no-op. */
  emitThought?(text: string, actorId: CharacterId | 'dm'): void;
  /**
   * Incremental thinking text while a streamed turn call generates. Runtime
   * display only — NOT an event, never logged (the atomic `thought` event is
   * still emitted per completed block via emitThought). The orchestrator
   * broadcasts it to subscribers so the browser's status banner shows the
   * live thought instead of dead air. Absent in tests / headless.
   */
  emitThinkingDelta?(text: string, actorId: CharacterId | 'dm'): void;
  /** Called once if budget is exhausted before turn ends. */
  emitBudgetExhausted?(actorId: CharacterId | 'dm'): void;
  /**
   * Called after every step (rule_violation OR successful action) so the
   * orchestrator can drain engine.flushEvents(), write to the log, and
   * publish to subscribers. Returns the drained events so the Agent can
   * append the self-visible subset to its in-turn history. Without this,
   * later steps in the same turn would not see what the agent just did
   * and the LLM would loop on the same action.
   */
  onEngineActed?(): Promise<Event[]>;
  /** Called after every successful LLM response so the orchestrator can
   *  accumulate token usage, call counts, and wall-clock latency into the
   *  manifest. `durationMs` is the measured round-trip time of the call
   *  (see Agent.completeTimed). */
  onLlmResponse?(role: string, usage: LlmResponse['usage'], durationMs?: number): void;
  /**
   * Optional override for `engine.applyAction` on the player branch. The
   * orchestrator passes its `applyActionWithRolls` helper here so AI
   * agents' normal_attack actions also go through the browser's 3D
   * physics roll provider (when one is configured). Defaults to
   * `engine.applyAction` when absent.
   *
   * The override returns a Promise so async paths (waiting on a WS
   * roll_response) can compose; sync engine fallback resolves immediately.
   */
  applyPlayerAction?(
    actorId: CharacterId,
    action: PlayerAction,
  ): Promise<Result<ActionOk, RuleViolation>>;
  /**
   * Optional override for `engine.applyDmAction` on the DM branch — the
   * orchestrator's analogue of `applyPlayerAction`. It routes a DM-puppeted
   * monster's attack-like `monster_action` through the physics roll provider
   * (so monster dice match hero dice), and delegates every other DM action to
   * `engine.applyDmAction`. Defaults to `engine.applyDmAction` when absent.
   */
  applyDmAction?(action: DmAction): Promise<Result<ActionOk, RuleViolation>>;
  /**
   * Optional pacing hook awaited BETWEEN two chained player actions from one
   * LLM reply (after action i has applied + drained, before action i+1).
   * Without it a chained `say + move + attack + end_turn` reply applies in a
   * single burst — the speech bubble, the move tween, and the dice all land
   * on the browser at once. The orchestrator implements it as: await the beat
   * gate after a `say`/`emote` (the player READS the line before the hero
   * acts on it), then a short stagger (`playerActionDelayMs`). Absent in
   * tests / headless → chains apply back-to-back, as before.
   */
  onChainGap?(prevAction: PlayerAction): Promise<void>;
  /**
   * Optional cancellation signal for the turn's LLM calls. The orchestrator
   * fires the backing AbortController when the human interjects off-turn, so
   * the ReACT loop unwinds promptly (returning `reason: 'interrupted'`) instead
   * of finishing a turn whose context is now stale. Absent in tests / headless.
   * Widened to include `undefined` so callers can thread an optional signal
   * directly under `exactOptionalPropertyTypes`.
   */
  signal?: AbortSignal | undefined;
}

export interface AgentTurnResult {
  steps: AgentStep[];
  /**
   * `interrupted` = a human interjection aborted an in-flight LLM call mid-turn.
   * The turn did NOT end and no terminal action was forced — the orchestrator
   * processes the interjection and re-dispatches this actor's turn.
   */
  reason: 'end_turn' | 'budget_exhausted' | 'interrupted';
}

export interface AgentConstructorArgs {
  role: 'dm' | 'player';
  actorId: CharacterId | 'dm';
  /** Persona markdown. May carry a pt variant ({ en, pt }) — the Agent passes
   *  it through untouched; the PromptBuilder resolves it by the session
   *  language at build time (the language is picked at the hero-select gate,
   *  AFTER agents are constructed). */
  persona: Localized;
  llm: LlmClient;
  promptBuilder: PromptBuilder;
  tools: ToolSchema[];
  stepBudget: number;
  engine: GameEngine;
  adventure: Adventure;
  /** Pre-rendered "  - p2 (warlock)\n..." roster. May carry a pt variant —
   *  pass-through to the PromptBuilder, which resolves by session language. */
  partyDescription: Localized;
  tag: string;                     // for ScriptedLlmClient matching
  model: string;
  maxTokens: number;
  getActiveScene(): Scene;
  getCharacters(): Character[];
  getMonstersInScene(): Character[];
  /**
   * DM only. True when the browser UI renders scene openings itself (a
   * pre-board splash + an orchestrator-emitted narrator beat). Combined with
   * the active scene actually HAVING an `opening`, this tells the DM to skip
   * narrating that scene's intro. Static "browser is attached" flag — the
   * per-scene gating happens at prompt-build time. Absent/false on headless,
   * CLI, and AI-only runs, so the DM reads the intro as before.
   */
  uiShowsIntro?: boolean;
}

/**
 * Thinking config for light single-shot calls — off-turn reactions, OOC
 * replies, the DM's between-turns outcome react. `budgetTokens: 0` explicitly
 * disables extended thinking (see {@link LlmCompleteRequest}): these calls
 * produce at most a line or two of banter, and thinking tokens dominated their
 * latency (~half of a live turn's LLM calls are these) for no quality gain.
 * Full turns (`takeTurn`) and human-intent interpretation keep thinking on.
 */
const LIGHT_CALL_THINKING = { type: 'enabled' as const, budgetTokens: 0 };

/**
 * ADAPTIVE thinking budget for FULL turns (`takeTurn`, `interpretHumanTurn`).
 * Thinking stays ON but the ceiling is computed per call from deterministic
 * engine signals, instead of the provider default (Gemini's AUTO spent 12–22s
 * per hero turn — run db17508d) or a flat cap (1024 made the heroes
 * noticeably dumber in exactly the coordination moments that matter).
 *
 * The budget is a CEILING, not a spend — the model may think less — so the
 * heuristic trims the over-thinking tail on routine "walk forward and bite"
 * turns while removing the clip on the turns where decision quality is the
 * whole point (a fight opening, a teammate down, a pack to fight, a re-plan
 * after the engine rejected the cheap thought). All signals are engine truth
 * available at prompt-build time — no extra LLM call — and the chosen budget
 * is deterministic + auditable, which makes "deliberation budget vs play
 * quality" a measurable Layer-D experiment axis.
 *
 * Base 1024 = Anthropic's API minimum (portable floor); each signal adds
 * 1024; ceiling clamped to 4096.
 */
export const computeTurnThinkingBudget = (signals: {
  /** Combat phase, round 1 — the planning moment of a fight. */
  combatOpening: boolean;
  /** A hero is KO'd / bound / prone or at ≤1 HP — cover/rescue coordination. */
  allyInDanger: boolean;
  /** ≥3 living foes on the board — multi-target tactics (focus fire, lanes). */
  outnumbered: boolean;
  /** This step retries a rule violation — the cheap thought already failed. */
  retryingViolation: boolean;
}): number => {
  let budget = 1024;
  if (signals.combatOpening) budget += 1024;
  if (signals.allyInDanger) budget += 1024;
  if (signals.outnumbered) budget += 1024;
  if (signals.retryingViolation) budget += 1024;
  return Math.min(budget, 4096);
};

const isPlayerTurnEnding = (a: PlayerAction): boolean => a.kind === 'end_turn';
const isDmTurnEnding = (a: DmAction): boolean =>
  a.kind === 'request_action' || a.kind === 'start_combat' ||
  a.kind === 'end_combat' || a.kind === 'end_adventure' ||
  // A monster's turn ends when the DM ends/skips it.
  (a.kind === 'monster_action' && (a.action.kind === 'end_turn' || a.action.kind === 'skip_turn'));

/**
 * Engine-truth suffix appended to a `public_resolution` observation. After an
 * action is applied and the engine's events are drained, this reports the
 * AUTHORITATIVE resulting HP of every character whose HP/status changed — the
 * same numbers the board (UI) shows.
 *
 * It exists to fix a narration/UI inconsistency: the bare observation ("monster_action"
 * for the DM, "attacked m1" for a player) carried no outcome, so the DM
 * reconstructed HP from the CURRENT STATE block — which ALREADY reflects the hit
 * it just landed — and subtracted the damage a SECOND time, narrating "Bran is
 * down to 1 HP" while the board correctly showed 2. Handing the agent the
 * post-resolution HP directly removes the temptation to recompute it.
 *
 * Returns '' when nothing's HP/status changed (a move, a `say`); a missed attack
 * reports only the whiff.
 */
export const summarizeHpOutcome = (
  drained: ReadonlyArray<Event>,
  lookup: (id: CharacterId) => Character | undefined,
): string => {
  // `p1_warrior (Gareth)` — a bare id tempts the narrator to improvise a name
  // (a name-bearing id `p1_anwen` once read as "Anwen" live); skip the parens
  // when the name IS the id (test fixtures).
  const label = (id: string): string => {
    const c = lookup(id as CharacterId);
    return c && c.name && c.name !== id ? `${id} (${c.name})` : id;
  };
  const parts: string[] = [];
  // Hit / miss for real attacks only. Normal + special sub-attacks carry a
  // boolean `hit` and a character `targetId`; ability_test / attack_object /
  // free_ally report `success` (and no character targetId), so they're excluded
  // from the HIT/MISS wording — their effects still surface as HP lines below.
  for (const ev of drained) {
    if (ev.type !== 'resolution') continue;
    const p = ev.public as { hit?: unknown; damage?: unknown; targetId?: unknown };
    if (typeof p.hit !== 'boolean' || typeof p.targetId !== 'string') continue;
    parts.push(p.hit
      ? `HIT ${label(p.targetId)} for ${typeof p.damage === 'number' ? p.damage : 0}`
      : `MISS on ${label(p.targetId)}`);
  }
  // Resulting absolute HP for every character whose HP or status actually
  // changed this step (damage, KO, a heal, or immobilized→normal from free_ally).
  // Read from post-apply engine truth via `lookup`, in first-seen order.
  const affected: CharacterId[] = [];
  for (const ev of drained) {
    if (ev.type !== 'state_change') continue;
    for (const ch of ev.changes) {
      if (('damage' in ch || 'status' in ch) && !affected.includes(ch.id)) {
        affected.push(ch.id);
      }
    }
  }
  for (const id of affected) {
    const c = lookup(id);
    if (c) parts.push(`${label(id)} now ${c.health.total - c.health.damage}/${c.health.total} HP (${c.health.status})`);
  }
  return parts.length === 0 ? '' : ` — ${parts.join('; ')}`;
};

export class Agent {
  constructor(private readonly args: AgentConstructorArgs) {}

  /**
   * `uiShowsIntro` spread for EVERY DM `buildDm` call: suppress the DM's intro
   * narration only when the UI renders openings itself AND the CURRENT scene
   * actually has one (the splash + the engine-emitted `opening.after` already
   * showed the player the intro). Shared across turn / react / ooc / interpret
   * / monster-react builds so the DM system band stays byte-identical within a
   * scene — re-narrated intros and prompt-cache churn both come from drift here.
   */
  private dmUiShowsIntro(): { uiShowsIntro: true } | Record<string, never> {
    return this.args.uiShowsIntro && this.args.getActiveScene().opening
      ? { uiShowsIntro: true }
      : {};
  }

  /**
   * Derive the adaptive thinking ceiling for a full-turn call from live engine
   * truth (see {@link computeTurnThinkingBudget}). `retryingViolation` is the
   * one signal the engine can't see — the caller passes whether this call
   * re-plans after a rule violation.
   */
  private turnThinking(retryingViolation: boolean): { type: 'enabled'; budgetTokens: number } {
    const chars = Array.from(this.args.engine.charactersById().values());
    const heroes = chars.filter((c) => c.kind === 'hero');
    const livingFoes = chars.filter((c) => c.kind === 'monster' && c.health.status !== 'KO').length;
    return {
      type: 'enabled',
      budgetTokens: computeTurnThinkingBudget({
        combatOpening: this.args.engine.turn.phase === 'combat'
          && this.args.engine.turn.roundNumber <= 1,
        allyInDanger: heroes.some((c) =>
          c.health.status !== 'normal' || c.health.total - c.health.damage <= 1),
        outnumbered: livingFoes >= 3,
        retryingViolation,
      }),
    };
  }

  /**
   * One timed LLM round-trip: measures wall-clock around `llm.complete` and
   * reports usage + duration through `onLlmResponse`, so the orchestrator can
   * aggregate per-role latency into the manifest (`llmLatencyMs`) and live-log
   * the call. Errors — including interjection aborts — propagate before any
   * reporting, exactly as the un-timed calls did. Every Agent LLM call goes
   * through here; this is the instrumentation point for "where does the time
   * between actions go".
   */
  private async completeTimed(
    req: unknown,
    hooks: AgentRunHooks,
    role: string,
    cb?: LlmStreamCallbacks,
  ): Promise<LlmResponse> {
    const startedAt = Date.now();
    // Streaming when callbacks are supplied AND the client supports it; the
    // duration covers the full stream (first byte to last), same as batch.
    const resp = cb && this.args.llm.completeStream
      ? await this.args.llm.completeStream(req as never, cb)
      : await this.args.llm.complete(req as never);
    hooks.onLlmResponse?.(role, resp.usage, Date.now() - startedAt);
    return resp;
  }

  async takeTurn(
    initialObservation: Observation,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<AgentTurnResult> {
    const steps: AgentStep[] = [];
    let observation = initialObservation;

    // Live history grows within the turn so step N+1 sees the events the agent
    // emitted in step N. The orchestrator's onEngineActed hook drains the
    // engine queue and returns the events; we filter for the agent's own
    // perspective and append.
    const liveHistory: Event[] = [...history];
    const selfViewer: Viewer = { kind: 'self', actorId: this.args.actorId };
    const drainAndAppend = async (): Promise<Event[]> => {
      if (!hooks.onEngineActed) return [];
      const drained = await hooks.onEngineActed();
      for (const ev of drained) {
        const r = visibilityFilter(ev, selfViewer);
        if (r !== null) liveHistory.push(r);
      }
      // Return the raw (unfiltered) batch so the caller can summarize the
      // engine-truth outcome (resulting HP) for the next step's observation.
      return drained;
    };

    for (let stepNo = 1; stepNo <= this.args.stepBudget; stepNo++) {
      const propsSnapshot = this.args.engine.propsList();
      // Live party + foes for the awareness block: teammates and foes are
      // public (minis + health boxes on the table), so we render current engine
      // truth — not the visibility-filtered history. Only thoughts stay private.
      const allChars = Array.from(this.args.engine.charactersById().values());
      const party = allChars.filter(
        (c) => c.kind === 'hero' && c.id !== this.args.actorId,
      );
      const foes = allChars.filter((c) => c.kind === 'monster');
      const prompt = this.args.role === 'player'
        ? this.args.promptBuilder.buildPlayer({
            character: this.args.engine.charactersById().get(this.args.actorId as CharacterId)!,
            party,
            foes,
            persona: this.args.persona,
            partyDescription: this.args.partyDescription,
            adventure: this.args.adventure,
            activeScene: this.args.getActiveScene(),
            history: liveHistory, observation, currentTurnIdx,
            props: propsSnapshot,
            obstacles: this.args.engine.activeSceneObstacles(),
          })
        : this.args.promptBuilder.buildDm({
            party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
            monstersInScene: this.args.getMonstersInScene(),
            persona: this.args.persona,
            adventure: this.args.adventure,
            activeScene: this.args.getActiveScene(),
            history: liveHistory, observation, currentTurnIdx,
            props: propsSnapshot,
            ...this.dmUiShowsIntro(),
          });

      const req = {
        system: prompt.system,
        messages: prompt.messages,
        tools: this.args.tools,
        // Adaptive ceiling: more deliberation on the turns that deserve it
        // (fight opening, ally down, outnumbered, re-plan after a violation).
        thinking: this.turnThinking(observation.kind === 'rule_violation'),
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: this.args.tag,
        // Players may chain a whole turn (move + attack + end_turn) in ONE
        // reply — the calls are applied in order below, so a typical turn costs
        // one LLM round-trip instead of three. The DM keeps one-tool-per-step:
        // its turn flow (reveal / start_combat / request_action) is stateful
        // enough that each step should see the engine's reply.
        ...(this.args.role === 'player' ? { allowParallelTools: true } : {}),
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      };
      // ---- Streamed-apply scaffolding ------------------------------------
      // When the client supports streaming, thinking deltas surface live
      // (emitThinkingDelta → browser banner), `thought` events are emitted per
      // COMPLETED block (so they land before the actions they led to), and —
      // player only — each tool call is APPLIED the moment it completes in the
      // stream: the board updates while the model is still generating the rest
      // of its reply. The same `applyOne` closure then handles whatever the
      // stream didn't pre-apply (everything, on the batch/scripted path), so
      // both modes share one code path and identical chain semantics.
      const isPlayer = this.args.role === 'player';
      const thoughtParts: string[] = [];
      let thoughtAttributed = false;
      /** First step of this response carries the joined thinking; later ones ''. */
      const takeThought = (): string => {
        if (thoughtAttributed) return '';
        thoughtAttributed = true;
        return thoughtParts.join('\n');
      };

      // Chain state (player only). The chain stops at the first rule violation
      // (the remaining calls were premised on it; the next round-trip re-plans
      // off the violation observation) or at a turn-ending action.
      const applied: string[] = [];
      let prevApplied: PlayerAction | null = null;
      let halted = false;
      let endedTurn = false;
      let streamedSeen = 0;   // tool calls already consumed via the stream callback
      const applyOne = async (tu: ParsedToolUse): Promise<void> => {
        if (halted) return;
        const action = decodePlayerToolUse(tu);
        // Pace the chain: let the previous action's beat land (bubble read,
        // tween finish) before the next one fires — see hooks.onChainGap.
        if (prevApplied) await hooks.onChainGap?.(prevApplied);
        const result = hooks.applyPlayerAction
          ? await hooks.applyPlayerAction(this.args.actorId as CharacterId, action)
          : this.args.engine.applyAction(this.args.actorId as CharacterId, action);
        if (!result.ok) {
          this.args.engine.emitRuntime({
            type: 'rule_violation',
            actorId: this.args.actorId as CharacterId,
            violation: result.error,
            attempted: action,
          } as Omit<Event, 't'>);
          observation = { kind: 'rule_violation', reason: result.error.reason };
          steps.push({ thought: takeThought(), toolName: tu.name, toolInput: tu.input, observation });
          await drainAndAppend();
          halted = true;
          return;
        }
        // Drain first so the observation can quote engine-truth resulting HP.
        const drained = await drainAndAppend();
        applied.push(this.summarizeOk(action)
          + summarizeHpOutcome(drained, (id) => this.args.engine.charactersById().get(id)));
        // The loop-carried observation accumulates every action applied from
        // this response, so the next round-trip sees the whole chain's outcome.
        observation = { kind: 'public_resolution', summary: applied.join('; then ') };
        steps.push({ thought: takeThought(), toolName: tu.name, toolInput: tu.input, observation });
        if (isPlayerTurnEnding(action)) { halted = true; endedTurn = true; return; }
        prevApplied = action;
      };

      const streaming = typeof this.args.llm.completeStream === 'function';
      let resp;
      try {
        resp = await this.completeTimed(req, hooks, this.args.tag, streaming ? {
          onThinkingDelta: (text) => hooks.emitThinkingDelta?.(text, this.args.actorId),
          onThinkingBlockDone: (text) => {
            thoughtParts.push(text);
            hooks.emitThought?.(text, this.args.actorId);
          },
          // Live apply is player-only: the DM's exactly-one-tool contract is
          // validated against the COMPLETE response below.
          ...(isPlayer
            ? { onToolUse: async (tu: ParsedToolUse) => { streamedSeen += 1; await applyOne(tu); } }
            : {}),
        } : undefined);
      } catch (e) {
        // A human interjection cancelled this call: stop the ReACT loop without
        // forcing a terminal action. The orchestrator processes the message and
        // re-dispatches this actor's turn with the human's words now in history
        // (any actions already streamed-applied are tracked by the engine, so
        // the resumed turn continues from its real state).
        if (e instanceof LlmAbortedError) return { steps, reason: 'interrupted' };
        throw e;
      }
      if (!streaming) {
        // Batch path: thoughts surface here, still before any action applies.
        thoughtParts.push(...resp.thinkingBlocks);
        for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, this.args.actorId);
      }

      if (isPlayer) {
        if (resp.toolUses.length === 0) {
          this.args.engine.emitRuntime({
            type: 'rule_violation',
            actorId: this.args.actorId as CharacterId,
            violation: { reason: 'invalid-action-shape', details: 'expected at least 1 tool call, got 0' },
          } as Omit<Event, 't'>);
          observation = { kind: 'rule_violation', reason: 'expected at least 1 tool call, got 0' };
          steps.push({ thought: takeThought(), toolName: '(none)', toolInput: {}, observation });
          await drainAndAppend();
          continue;
        }
        // Apply whatever the stream didn't already pre-apply (with a real
        // stream this slice is empty; on batch/scripted it's the whole reply).
        for (const tu of resp.toolUses.slice(streamedSeen)) {
          await applyOne(tu);
        }
        if (endedTurn) return { steps, reason: 'end_turn' };
      } else {
        if (resp.toolUses.length !== 1) {
          this.args.engine.emitRuntime({
            type: 'rule_violation',
            actorId: 'dm',
            violation: { reason: 'invalid-action-shape', details: `expected exactly 1 tool call, got ${resp.toolUses.length}` },
          } as Omit<Event, 't'>);
          observation = { kind: 'rule_violation', reason: `expected exactly 1 tool call, got ${resp.toolUses.length}` };
          steps.push({ thought: takeThought(), toolName: '(none)', toolInput: {}, observation });
          await drainAndAppend();
          continue;
        }
        const tu = resp.toolUses[0]!;
        const action = decodeDmToolUse(tu);
        const result = hooks.applyDmAction
          ? await hooks.applyDmAction(action)
          : this.args.engine.applyDmAction(action);
        if (!result.ok) {
          this.args.engine.emitRuntime({
            type: 'rule_violation',
            actorId: 'dm',
            violation: result.error,
            attempted: action,
          } as Omit<Event, 't'>);
          observation = { kind: 'rule_violation', reason: result.error.reason };
          steps.push({ thought: takeThought(), toolName: tu.name, toolInput: tu.input, observation });
          await drainAndAppend();
          continue;
        }
        // Drain first so the observation can quote engine-truth resulting HP —
        // this is what keeps DM narration of a monster's bite ("down to N HP")
        // matching the board instead of double-counting off the state block.
        const drained = await drainAndAppend();
        observation = {
          kind: 'public_resolution',
          summary: tu.name
            + summarizeHpOutcome(drained, (id) => this.args.engine.charactersById().get(id)),
        };
        steps.push({ thought: takeThought(), toolName: tu.name, toolInput: tu.input, observation });
        if (isDmTurnEnding(action)) return { steps, reason: 'end_turn' };
      }
    }

    hooks.emitBudgetExhausted?.(this.args.actorId);
    await drainAndAppend();
    return { steps, reason: 'budget_exhausted' };
  }

  private summarizeOk(a: PlayerAction): string {
    switch (a.kind) {
      case 'move':            return `moved to (${a.path[a.path.length - 1]!.x},${a.path[a.path.length - 1]!.y})`;
      case 'normal_attack':   return `attacked ${a.targetId}`;
      case 'special_action':  return `used special action`;
      case 'use_item':        return `used item ${a.itemId}`;
      case 'use_boon':        return `used boon ${a.boonId}`;
      case 'equip':           return `equipped ${a.equipmentId}`;
      case 'ability_test':    return `attempted ${a.characteristic} test (DC ${a.difficulty})`;
      case 'attack_object':   return `attacked object at (${a.pos.x},${a.pos.y})`;
      case 'push_object':     return `pushed the object at (${a.pos.x},${a.pos.y})`;
      case 'open_chest':      return `opened chest ${a.chestId}`;
      case 'throw_item':      return `threw ${a.itemId} to (${a.pos.x},${a.pos.y})`;
      case 'free_ally':       return `tried to free ${a.targetId}`;
      case 'say':             return `said "${a.text}"`;
      case 'emote':           return `emoted ${a.emoji}`;
      case 'end_turn':        return 'ended turn';
      case 'skip_turn':       return 'skipped turn';
    }
  }

  /**
   * Answer an out-of-character question from the human. DM-only. The reply is
   * a single short text blurb — no engine actions, no narration of in-world
   * events. The orchestrator side-channels this through `dm_ooc_reply` so the
   * party-mate agents never see it.
   *
   * Failure modes are absorbed quietly: if the LLM emits zero or wrong tool
   * calls, we return a polite fallback string rather than throw, because the
   * human's turn must continue regardless. We surface the misuse as a
   * rule_violation event for the audit log.
   */
  async answerOocQuery(
    text: string,
    fromActorId: CharacterId,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<string> {
    if (this.args.role !== 'dm') {
      throw new Error('answerOocQuery is only valid on a DM agent');
    }
    const humanChar = this.args.getCharacters().find((c) => c.id === fromActorId);
    const humanName = humanChar?.name ?? String(fromActorId);

    const prompt = this.args.promptBuilder.buildDm({
      party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
      monstersInScene: this.args.getMonstersInScene(),
      persona: this.args.persona,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      observation: { kind: 'between_turns', summary:
        `OUT-OF-CHARACTER question from ${humanName} (controlled by the human): "${text}"\n\n` +
        `Answer in your DM voice with a single \`ooc_reply\` tool call. This is ` +
        `a meta sidebar — do NOT narrate new in-fiction events, change NPC ` +
        `state, or call any other tool. Reply in <= 2 sentences.`,
      },
      currentTurnIdx,
      props: this.args.engine.propsList(),
      ...this.dmUiShowsIntro(),
    });

    let resp;
    try {
      resp = await this.completeTimed({
        system: prompt.system,
        messages: prompt.messages,
        tools: [OOC_REPLY_TOOL],
        thinking: LIGHT_CALL_THINKING,
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: `${this.args.tag}:ooc`,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      }, hooks, `${this.args.tag}:ooc`);
    } catch (e) {
      // A newer interjection cancelled this OOC answer — return empty so the
      // orchestrator skips emitting a blank reply and moves on to the next one.
      if (e instanceof LlmAbortedError) return '';
      throw e;
    }

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

    if (resp.toolUses.length !== 1 || resp.toolUses[0]!.name !== 'ooc_reply') {
      this.args.engine.emitRuntime({
        type: 'rule_violation',
        actorId: 'dm',
        violation: {
          reason: 'invalid-action-shape',
          details: `ooc: expected exactly 1 ooc_reply tool call, got ${resp.toolUses.length}`,
        },
      } as Omit<Event, 't'>);
      return '(The DM is busy — try again in a moment.)';
    }
    const replyText = resp.toolUses[0]!.input['text'];
    if (typeof replyText !== 'string' || replyText.length === 0) {
      return '(The DM had nothing to add.)';
    }
    return replyText;
  }

  /**
   * Interpret an on-turn message the human directed at the DM. Unlike
   * `answerOocQuery` (off-turn / pure Q&A), this runs while the human HOLDS the
   * floor, so the DM may turn the message into real play: it is given the
   * player toolset alongside `ooc_reply` and classifies the message itself —
   *
   *   - a QUESTION / rules clarification → a single `ooc_reply` (no world change)
   *     → returned as `{ kind: 'reply' }` (the caller does NOT consume the turn);
   *   - an ACTION the player wants to take ("I jump the barrels", "shoot the
   *     rat") → one or more PLAYER tool calls, decoded in order and returned as
   *     `{ kind: 'act', actions }`. The caller applies them as the human's own
   *     actions (engine still validates + rolls the dice), so the DM owns
   *     *intent* only — never resolution. HeroKids allows 1 move + 1 main
   *     action, so the DM may chain e.g. `move` then `normal_attack`.
   *
   * The engine's `not-actors-turn` guard means this is only ever reachable on
   * the human's turn; off-turn messages route through `answerOocQuery`, which
   * has no player tools and therefore cannot act (in combat: only on the
   * player's own turn).
   *
   * Failure modes degrade to a reply so the human's turn never wedges: an
   * aborted call (newer interjection) returns an empty reply; zero / only
   * unparseable tool calls return a polite "try again" reply and log a
   * rule_violation.
   */
  async interpretHumanTurn(
    text: string,
    fromActorId: CharacterId,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<HumanTurnInterpretation> {
    if (this.args.role !== 'dm') {
      throw new Error('interpretHumanTurn is only valid on a DM agent');
    }
    const humanChar = this.args.getCharacters().find((c) => c.id === fromActorId);
    const humanName = humanChar?.name ?? String(fromActorId);
    const where = humanChar?.pos ? ` at (${humanChar.pos.x},${humanChar.pos.y})` : '';

    const prompt = this.args.promptBuilder.buildDm({
      party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
      monstersInScene: this.args.getMonstersInScene(),
      persona: this.args.persona,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      observation: { kind: 'between_turns', summary:
        `It is ${humanName}'s turn (controlled by the human)${where}. They told you, in their ` +
        `own words: "${text}"\n\n` +
        `Decide what this means and answer with tool calls:\n` +
        `• If it is a QUESTION or rules/scene clarification, reply with a SINGLE \`ooc_reply\` ` +
        `(<= 2 sentences, no narration, no world changes).\n` +
        `• If it is an ACTION ${humanName} wants to take THIS turn, translate it into ${humanName}'s ` +
        `player tools and call them IN ORDER (you may chain one \`move\` then one main action — ` +
        `HeroKids allows 1 move + 1 main action per turn). Use \`ability_test\` for athletic / clever ` +
        `feats like jumping, climbing, squeezing or shoving (pick a characteristic + difficulty: 4 easy, ` +
        `5 normal, 6 hard); \`attack_object\` to smash an obstacle (barrel / crate / stalagmite); ` +
        `\`normal_attack\` / \`special_action\` to fight; \`move\` to reposition. Movement cannot pass ` +
        `through walls, obstacles, or occupied / KO'd squares, and attacks need range + line of sight. ` +
        `Only add \`end_turn\` if they clearly want to finish.\n` +
        `If the literal request is impossible, either pick the closest LEGAL interpretation, or ` +
        `reply with a single \`ooc_reply\` explaining why and suggesting an alternative (smash it, go ` +
        `around). Call ONLY ${humanName}'s player tools, or exactly one \`ooc_reply\` — never both, ` +
        `and no DM-only tools.`,
      },
      currentTurnIdx,
      props: this.args.engine.propsList(),
      ...this.dmUiShowsIntro(),
    });

    let resp;
    try {
      resp = await this.completeTimed({
        system: prompt.system,
        messages: prompt.messages,
        tools: [...PLAYER_TOOLS, OOC_REPLY_TOOL],
        thinking: this.turnThinking(false),
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: `${this.args.tag}:ooc`,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      }, hooks, `${this.args.tag}:ooc`);
    } catch (e) {
      // A newer interjection cancelled this — empty reply so the orchestrator
      // skips the blank bubble and re-prompts.
      if (e instanceof LlmAbortedError) return { kind: 'reply', text: '' };
      throw e;
    }

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

    const tus = resp.toolUses;
    // ooc_reply present → treat the whole turn as a Q&A answer (a well-behaved
    // DM never mixes ooc_reply with player tools; if it does, the answer wins).
    const oocReply = tus.find((t) => t.name === 'ooc_reply');
    if (oocReply) {
      const replyText = oocReply.input['text'];
      return {
        kind: 'reply',
        text: typeof replyText === 'string' && replyText.length > 0
          ? replyText : '(The DM had nothing to add.)',
      };
    }

    const actions: PlayerAction[] = [];
    for (const tu of tus) {
      try {
        actions.push(decodePlayerToolUse(tu));
      } catch {
        // Skip an unparseable tool call rather than wedge the turn.
      }
    }
    if (actions.length === 0) {
      this.args.engine.emitRuntime({
        type: 'rule_violation',
        actorId: 'dm',
        violation: {
          reason: 'invalid-action-shape',
          details: `interpret: expected an ooc_reply or >=1 player tool call, got ${tus.length}`,
        },
      } as Omit<Event, 't'>);
      return { kind: 'reply', text: '(The DM is thinking — try that again in a moment.)' };
    }
    return { kind: 'act', actions };
  }

  /**
   * Single-step DM reaction between player turns. The DM gets one tool call
   * and is expected to either narrate, call request_action, or end_adventure.
   * If the DM uses a non-DM tool or produces zero/multiple tool uses, the call
   * is logged as a rule_violation and otherwise silently dropped.
   *
   * Audit fix F8 — the DM previously narrated only at adventure start and end,
   * leaving 50+ events of combat unnarrated. This hook lets the DM react after
   * every player/human/monster turn without taking a full ReACT turn.
   *
   * `outcomeSuffix` is the engine-truth HP summary of whatever just resolved
   * (from `summarizeHpOutcome`). Without it the DM had only the generic prompt
   * and the CURRENT STATE block — which ALREADY reflects the hit — so it
   * recomputed HP and subtracted the damage a SECOND time, narrating "down to
   * 1 HP" while the board correctly showed 2 (observed live 2026-05-31 t=319:
   * King Rat narrated at 1 HP while at 2). Feeding the post-resolution HP
   * straight into the observation removes the temptation to recompute, exactly
   * as the `takeTurn` paths already do.
   */
  async react(
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
    outcomeSuffix = '',
  ): Promise<void> {
    if (this.args.role !== 'dm') {
      throw new Error('react is only valid on a DM agent');
    }
    const prompt = this.args.promptBuilder.buildDm({
      party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
      monstersInScene: this.args.getMonstersInScene(),
      persona: this.args.persona,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      // F27 — between_turns is the right framing here; "Result of your last
      // action" misled the DM into thinking it had just acted.
      observation: { kind: 'between_turns', summary:
        (outcomeSuffix
          ? `Just resolved${outcomeSuffix}. Those HP values are AUTHORITATIVE — already applied; quote them verbatim, do NOT subtract damage again. `
          : '')
        + 'React with one tool call (narrate / request_action / end_adventure) — or skip by calling narrate with empty text.' },
      currentTurnIdx,
      props: this.args.engine.propsList(),
      ...this.dmUiShowsIntro(),
    });
    let resp;
    try {
      resp = await this.completeTimed({
        system: prompt.system,
        messages: prompt.messages,
        tools: this.args.tools,
        thinking: LIGHT_CALL_THINKING,
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: `${this.args.tag}:react`,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      }, hooks, `${this.args.tag}:react`);
    } catch (e) {
      // Interjection cancelled the react — drop it silently; the human's
      // message is processed by the orchestrator and the DM reacts next time.
      if (e instanceof LlmAbortedError) return;
      throw e;
    }

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

    if (resp.toolUses.length === 1) {
      const action = decodeDmToolUse(resp.toolUses[0]!);
      const r = this.args.engine.applyDmAction(action);
      if (!r.ok) {
        this.args.engine.emitRuntime({
          type: 'rule_violation', actorId: 'dm', violation: r.error, attempted: action,
        } as Omit<Event, 't'>);
      }
    } else if (resp.toolUses.length !== 0) {
      this.args.engine.emitRuntime({
        type: 'rule_violation', actorId: 'dm',
        violation: { reason: 'invalid-action-shape', details: `react: expected 0 or 1 tool calls, got ${resp.toolUses.length}` },
      } as Omit<Event, 't'>);
    }
  }

  /**
   * Single-step OPTIONAL reaction to a teammate's PARTY message (a line said
   * "to the party"). The agent MAY reply with a short in-character line and/or
   * a face emoji, or stay SILENT (no tool call). Player-only. Unlike `takeTurn`,
   * this neither consumes the turn nor applies anything to the engine — `say` /
   * `emote` are pure banter that mutate no rule state — so it just RETURNS the
   * chosen reaction and the orchestrator broadcasts it off-turn. The agent may
   * both speak AND emote in one response (allowParallelTools). Returns empty
   * arrays on silence, on a malformed reply, or on an interjection abort.
   */
  async reactToPartyMessage(
    message: string,
    fromName: string,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<{ says: string[]; emojis: string[] }> {
    return this.runPlayerReaction(
      `${fromName} just spoke to the party: "${message}"\n\n` +
      `You MAY react to this — it is NOT your turn, and reacting does NOT use a turn or any ` +
      `action; it's pure banter. If you have something to add, call \`say\` with a SHORT ` +
      `in-character line (one or two sentences) and/or \`emote\` with a single face emoji. ` +
      `If you have nothing worth adding, reply with NO tool call and stay silent. Do not ` +
      `simply repeat what a teammate already said.`,
      history, currentTurnIdx, hooks,
    );
  }

  /**
   * Single-step OPTIONAL reaction to something another agent (a teammate OR a
   * foe) just DID on its turn — e.g. a hero smashing an oil cask onto their own
   * head, a kill, a rescue. Same shape and contract as `reactToPartyMessage`:
   * off-turn banter that consumes nothing and mutates nothing, returned for the
   * orchestrator to broadcast. `actionSummary` is a one-line description of what
   * happened (the full event is also in `history`). Player-only.
   */
  async reactToPartyAction(
    actionSummary: string,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<{ says: string[]; emojis: string[] }> {
    return this.runPlayerReaction(
      `${actionSummary}\n\n` +
      `It is NOT your turn — but you just SAW that happen, and you MAY react to it. Reacting ` +
      `does NOT use a turn or any action; it's pure banter (a quip, a warning, a cheer, an ` +
      `"are you OK?"). If you have something worth saying, call \`say\` with a SHORT ` +
      `in-character line (one or two sentences) and/or \`emote\` with a single face emoji. ` +
      `If you have nothing worth adding, reply with NO tool call and stay silent — most ` +
      `routine actions don't need a comment.`,
      history, currentTurnIdx, hooks,
    );
  }

  /**
   * Shared implementation of the player off-turn reaction round. Builds the
   * player prompt with `observationSummary` as the `between_turns` framing, asks
   * the LLM with the say/emote-only `PARTY_REACT_TOOLS`, and returns the chosen
   * lines + emojis (empty on silence / malformed reply / interjection abort).
   * Applies nothing to the engine — the caller broadcasts the result off-turn.
   */
  private async runPlayerReaction(
    observationSummary: string,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<{ says: string[]; emojis: string[] }> {
    if (this.args.role !== 'player') {
      throw new Error('player reactions are only valid on a player agent');
    }
    const allChars = Array.from(this.args.engine.charactersById().values());
    const party = allChars.filter((c) => c.kind === 'hero' && c.id !== this.args.actorId);
    const foes = allChars.filter((c) => c.kind === 'monster');
    const prompt = this.args.promptBuilder.buildPlayer({
      character: this.args.engine.charactersById().get(this.args.actorId as CharacterId)!,
      party, foes,
      persona: this.args.persona,
      partyDescription: this.args.partyDescription,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      observation: { kind: 'between_turns', summary: observationSummary },
      currentTurnIdx,
      props: this.args.engine.propsList(),
      obstacles: this.args.engine.activeSceneObstacles(),
    });

    let resp;
    try {
      resp = await this.completeTimed({
        system: prompt.system,
        messages: prompt.messages,
        tools: PARTY_REACT_TOOLS,
        thinking: LIGHT_CALL_THINKING,
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: `${this.args.tag}:party-react`,
        allowParallelTools: true,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      }, hooks, `${this.args.tag}:party-react`);
    } catch (e) {
      // A newer interjection cancelled the reaction — treat it as silence.
      if (e instanceof LlmAbortedError) return { says: [], emojis: [] };
      throw e;
    }

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, this.args.actorId);

    const says: string[] = [];
    const emojis: string[] = [];
    for (const tu of resp.toolUses) {
      const text = tu.input['text'];
      const emoji = tu.input['emoji'];
      if (tu.name === 'say' && typeof text === 'string' && text.trim().length > 0) {
        says.push(text.trim());
      } else if (tu.name === 'emote' && typeof emoji === 'string' && emoji.trim().length > 0) {
        emojis.push(emoji.trim());
      }
      // Any other tool (the model shouldn't emit one) is ignored.
    }
    return { says, emojis };
  }

  /**
   * Single-step OPTIONAL reaction round VOICING the enemies' response to an
   * action that just resolved (a hero hurting themselves, a kill, a rescue).
   * Monsters have no LLM of their own, so the DM is their voice: it may call
   * `voice_monster` 0+ times (allowParallelTools) — once per foe it wants to
   * react for, or not at all (stay silent). DM-only. Like the player reaction,
   * this applies NOTHING to the engine — it returns the chosen per-monster
   * reactions and the orchestrator broadcasts them off-turn as that monster's
   * `say` / `emote`. Returns an empty array on silence / malformed reply / abort.
   */
  async reactAsMonsters(
    actionSummary: string,
    history: Event[],
    currentTurnIdx: number,
    hooks: AgentRunHooks,
  ): Promise<Array<{ monsterId: string; say?: string; emoji?: string }>> {
    if (this.args.role !== 'dm') {
      throw new Error('reactAsMonsters is only valid on a DM agent');
    }
    const prompt = this.args.promptBuilder.buildDm({
      party: this.args.getCharacters().filter((c) => c.kind === 'hero'),
      monstersInScene: this.args.getMonstersInScene(),
      persona: this.args.persona,
      adventure: this.args.adventure,
      activeScene: this.args.getActiveScene(),
      history,
      observation: { kind: 'between_turns', summary:
        `${actionSummary}\n\n` +
        `The enemies just witnessed that. You MAY voice how one or more of them REACT — ` +
        `a hiss, a screech, a snarl, a taunt — WITHOUT taking a turn or any action (pure ` +
        `flavour, no rule effect). Each reaction is shown as THAT MONSTER'S OWN speech ` +
        `bubble, so write the SOUND OR WORDS THE CREATURE ITSELF MAKES, in the FIRST PERSON — ` +
        `e.g. "Skreeeee!" or "Your warlock falls, little heroes!" — NEVER a third-person ` +
        `description like "The King Rat squeaks in triumph." Call \`voice_monster\` once per ` +
        `foe that reacts (a SHORT utterance and/or a face emoji), or call it ZERO times to ` +
        `leave the enemies silent. React only when a beat genuinely warrants it; never for ` +
        `every routine action. Only living monsters on the board may react, and never the ` +
        `one that just acted.` },
      currentTurnIdx,
      props: this.args.engine.propsList(),
      ...this.dmUiShowsIntro(),
    });

    let resp;
    try {
      resp = await this.completeTimed({
        system: prompt.system,
        messages: prompt.messages,
        tools: MONSTER_REACT_TOOLS,
        thinking: LIGHT_CALL_THINKING,
        model: this.args.model,
        maxTokens: this.args.maxTokens,
        tag: `${this.args.tag}:monster-react`,
        allowParallelTools: true,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      }, hooks, `${this.args.tag}:monster-react`);
    } catch (e) {
      // A newer interjection cancelled the reaction — treat it as silence.
      if (e instanceof LlmAbortedError) return [];
      throw e;
    }

    for (const t of resp.thinkingBlocks) hooks.emitThought?.(t, 'dm');

    const out: Array<{ monsterId: string; say?: string; emoji?: string }> = [];
    for (const tu of resp.toolUses) {
      if (tu.name !== 'voice_monster') continue;
      const monsterId = tu.input['monsterId'];
      if (typeof monsterId !== 'string' || monsterId.trim().length === 0) continue;
      const text = tu.input['text'];
      const emoji = tu.input['emoji'];
      const reaction: { monsterId: string; say?: string; emoji?: string } = { monsterId: monsterId.trim() };
      if (typeof text === 'string' && text.trim().length > 0) reaction.say = text.trim();
      if (typeof emoji === 'string' && emoji.trim().length > 0) reaction.emoji = emoji.trim();
      // Skip an empty reaction (neither a line nor an emoji) — nothing to broadcast.
      if (reaction.say === undefined && reaction.emoji === undefined) continue;
      out.push(reaction);
    }
    return out;
  }
}
