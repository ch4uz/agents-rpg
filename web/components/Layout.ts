import { html, nothing, render, type TemplateResult } from 'lit-html';
import type { Store } from '../store.js';
import type { PlayerAction } from '../../src/engine/action.js';
import type { CharacterId } from '../../src/engine/ids.js';
import { type ActorInfo } from './ChatLog.js';
import {
  narratorWindow,
  updateNarratorText,
  paintHeroSpeeches,
  latestNarration,
  latestDmOocReply,
  TYPEWRITER_CHAR_MS,
  characterSpeechSpriteUrl,
  isTypewriterActive,
  completeTypewriter,
  type HeroSpeech,
} from './NarratorWindow.js';
import { eventLog, selectEventLog } from './EventLog.js';
import { dmAside, type DmAsidePayload } from './DmAside.js';
import {
  setRefContext,
  buildRefContext,
  refTargetFromElement,
  type RefTarget,
} from './refs.js';
import { rollSummaryAt, type RollSummary } from './RollPanel.js';
import {
  notifyRollMounted,
  notifyRollResolved,
  isRollResolved,
} from './roll-events.js';
import {
  dispatchAttackRoll,
  type RollDispatch,
} from './three/DiceDispatcher.js';
import type { Face } from './three/DiceMesh.js';
import { skinForCharacter } from './three/DiceSkins.js';

export type DiceRollContext =
  | { kind: 'duel'; summary: RollSummary }
  | { kind: 'initiative'; summary: InitiativeSummary };
import {
  initiativeSummaryAt,
  type InitiativeSummary,
} from './InitiativePanel.js';
import {
  combatBeginsSplash,
  COMBAT_BEGINS_SPLASH_MS,
  COMBAT_BEGINS_DISPATCH_AT_MS,
} from './CombatBeginsSplash.js';
import { openingSplash, openingVisibleLength, openingBefore, openingCast } from './OpeningSplash.js';
import { queueWindow, sessionGoneWindow } from './QueueWindow.js';
import {
  battleOrderReveal,
  BATTLE_ORDER_REVEAL_MS,
  BATTLE_ORDER_REVEAL_FADE_OUT_MS,
  type BadgeAnchors,
} from './BattleOrderReveal.js';
import type { RedactedCharacter, RedactedSnapshot } from '../../src/engine/snapshot.js';
import type { ChatEntry } from '../store.js';
import { actionButtons, selectionHint, type SelectionMode, type SelectionOverlay } from './ActionButtons.js';
import { t, onLanguageChange } from '../i18n.js';
import { findPath, findReachable, type MoveField } from './pathfinder.js';
import {
  splitTargetIds,
  addDie,
  removeDie,
  allocTotal,
  budgetLeft as splitBudgetLeft,
  diceSplitParams,
  type SplitPlan,
  type Allocation,
} from './special-alloc.js';
import { inNormalAttackRange, normalAttackTargetIds } from './attack-range.js';
import { displayName, monsterSayReadsAsNarration } from './names.js';
import { engineLoader, deriveActivity } from './EngineLoader.js';
import { turnOrderBar, selectTurnOrder } from './TurnOrderBar.js';
import { passiveTriggerBanner, type PassiveBannerData } from './PassiveTriggerBanner.js';
import { endingBanner } from './EndingBanner.js';
import { gameOverScreen } from './GameOverScreen.js';
import { surveyModal, createSurveyForm, applySurveyAck } from './SurveyModal.js';
import type { SurveySubmission } from '../../src/runtime/ws/protocol.js';
import type { ClickTarget } from './Board.js';

/** Where a free-text prompt is directed. 'game' is the default in-character
 *  flow (DM interprets into player actions). 'dm' is an out-of-character
 *  sidebar question that doesn't consume the turn. */
export type PromptTarget = 'game' | 'dm';

/** How long a "bonus ability triggered" banner holds before it begins fading
 *  out, and the fade-out duration (matches the CSS `passive-banner--out`). */
export const PASSIVE_BANNER_MS = 3000;
export const PASSIVE_BANNER_FADE_OUT_MS = 360;

/** Build the {@link PassiveBannerData} for the LATEST `passive_triggered` event
 *  in a chat feed, resolving the firing hero against the live roster for the
 *  portrait. Returns `{ count }` (total passive events seen) plus `data` for the
 *  most recent one, or `data: null` when the feed carries none. Pure — the
 *  caller owns show/dismiss timing. Exported for unit tests. */
export const selectLatestPassiveBanner = (
  chat: ReadonlyArray<ChatEntry>,
  characters: ReadonlyArray<RedactedCharacter>,
): { count: number; data: PassiveBannerData | null } => {
  type PassiveEv = { actorId?: string; abilityName?: string; effect?: string };
  const passives = chat
    .map((entry, idx) => ({ idx, ev: (entry as { event?: { type?: string } }).event }))
    .filter((x): x is { idx: number; ev: PassiveEv & { type: 'passive_triggered' } } =>
      !!x.ev && (x.ev as { type?: string }).type === 'passive_triggered',
    );
  const count = passives.length;
  if (count === 0) return { count, data: null };
  const { idx, ev } = passives[count - 1]!;
  const hero = characters.find((c) => String(c.id) === String(ev.actorId));
  const data: PassiveBannerData = {
    key: `passive-${idx}`,
    name: displayName(hero?.name ?? String(ev.actorId ?? '')),
    archetype: hero?.archetype ?? null,
    sprite: hero?.sprite ?? null,
    abilityName: String(ev.abilityName ?? ''),
    ...(ev.effect ? { effect: String(ev.effect) } : {}),
  };
  return { count, data };
};

export interface LayoutCallbacks {
  /** Free-text fallback from the Prompt panel.
   *  `target` defaults to 'game' (in-character) when omitted; 'dm' routes the
   *  text as an OOC question that doesn't consume the turn. */
  onSubmit(text: string, target?: PromptTarget): void;
  /** Structured action from a button or map click. */
  onAction(action: PlayerAction): void;
  /** Push the current selection overlay (highlight cells / targets) to Board. */
  onSelectionChange?(state: SelectionOverlay): void;
  /**
   * Optional: invoked when a dice roll queue item promotes. The implementation
   * (typically `Dice3DOverlay.roll` + `DiceHUD`) animates the physical roll
   * on the 3D overlay and drives the combat HUD. The promise is
   * fire-and-forget here — the existing `notifyRollMounted` gate still
   * drives the post-roll effect timing.
   *
   * For initiative rolls, the dispatch carries heroes in `attacker` and
   * monsters in `defender`. The promise resolves once both lanes have
   * settled.
   */
  onDiceRoll?(
    dispatch: RollDispatch,
    context: DiceRollContext,
  ): Promise<void>;
  /**
   * Fired exactly once per combat when the player dismisses the on-screen
   * "Order of Battle" reveal — a Skip click in manual mode, or the
   * auto-dismiss timer in auto mode. The host (main.ts) relays this as a
   * `reveal_ack`, releasing the server's first-turn gate so the game only
   * starts the first combat turn once the player is ready. A no-op when no
   * reveal gate is outstanding (tests, or a server with no revealProvider).
   */
  onInitiativeRevealDismissed?(): void;
  /**
   * Fired once per outstanding beat-pacing gate, when the playback queue has
   * fully drained — i.e. the player has dismissed every narration / hero-
   * speech beat (Skip clicks, or auto-skip). The host (main.ts) relays this
   * as a `beat_gate_ack`, releasing the server's hold so it starts the next
   * turn. A no-op when no gate is outstanding (tests, or a server with no
   * beatGate).
   */
  onBeatGateAck?(requestId: string): void;
  /**
   * Fired once when the player dismisses the adventure-opening title splash
   * (clicks "Begin"). The host (main.ts) relays this as an `opening_ack`,
   * releasing the server's first-turn gate so the DM begins. A no-op when no
   * opening gate is outstanding (tests, or a server with no openingProvider).
   */
  onOpeningDismissed?(): void;
  /**
   * Fired when the player hovers (or stops hovering) a dialogue-reference chip
   * — a coordinate `(11,3)` or creature mention the DM / a hero wrote. The host
   * (main.ts) forwards it to `Board.setHoverHighlight` so the matching cell /
   * creature(s) glow on the board. `null` clears the highlight. A no-op when
   * the board isn't mounted (tests / pre-attach).
   */
  onRefHover?(target: RefTarget | null): void;
  /**
   * Fired when an `emote` beat is promoted in the playback queue, so the board
   * can spawn the emoji balloon over the actor at that moment (in dialogue
   * order) rather than the instant the WS event arrived. The host (main.ts)
   * forwards it to `Board.spawnEmote`. A no-op when the board isn't mounted
   * (tests / pre-attach); the beat still self-advances either way.
   */
  onEmote?(actorId: string, emoji: string): void;
  /**
   * Ship a submitted playtest survey to the server as a `survey_response`
   * (persisted run-side; the `survey_ack` reply flows back through the store
   * and resolves the modal's Saved ✓ / failed status). Absent (tests, no WS
   * host) → the modal renders without a Submit button (clipboard-only).
   */
  onSurveySubmit?(survey: SurveySubmission): void;
}

export interface LayoutOptions {
  /** The browser tab's WS session id (`?sid=`). Stamped into the playtest
   *  survey's copied markdown so a pasted reply can be matched to its run. */
  sessionId?: string;
}

export interface LayoutHandle {
  /** Forward a Board canvas click into the active selection mode. */
  handleCanvasClick(target: ClickTarget): void;
  /** Forward a Board canvas right-click. Used during a multi-target split
   *  special (whirlwind / split-shot) to REMOVE a die from a target the player
   *  over-assigned. A no-op in every other mode. */
  handleCanvasRightClick(target: ClickTarget): void;
  /** Re-emit the current selection — Board may mount after Layout. */
  refreshSelection(): void;
  /** Update the set of actors currently animating a move on the Board.
   *  Layout uses this to hold the turn-order cursor on a combatant while
   *  their sprite is still sliding, even after WS reports `turn_ended`. */
  setMovingActors(actorIds: ReadonlySet<string>): void;
  /** Force the dialog auto-skip mode on or off. In manual mode (default),
   *  narration and hero/enemy speech beats wait for a Skip click before
   *  advancing. In auto mode, they advance on the original timed hold.
   *  Exposed for tests that drive the WS flow synthetically — real users
   *  toggle this via the in-narrator "▶ Skip" button. */
  setAutoSkip(enabled: boolean): void;
  /** Mark whether the "Choose your hero" overlay (mounted separately by the
   *  host, ABOVE the board) is currently up. The opening title splash — and its
   *  typewriter — are suppressed while it is, so the splash doesn't type its
   *  text out UNSEEN behind the chooser and then appear pre-finished. The host
   *  flips this true before mounting the chooser and false when it resolves, so
   *  the opening reveal starts the moment the splash is actually visible. */
  setHeroSelectActive(active: boolean): void;
  /** Supply the per-character die screen anchors (PERCENT of the board stage)
   *  for the Order-of-Battle reveal, so each badge renders OVER the 3D die
   *  that character rolled. The host (main.ts) projects the settled dice and
   *  calls this just before the reveal mounts; omitted/empty → the reveal
   *  falls back to an evenly spaced row. */
  setOrderRevealPositions(positions: BadgeAnchors): void;
}

const IDLE_OVERLAY: SelectionOverlay = { mode: 'idle', reachable: [], targets: [], objectTargets: [] };

const MOVE_BUDGET = 4;

/** Single queue item — what currently occupies the slot below the board. The
 *  queue plays out in strict chat order, one item at a time. Action buttons
 *  only surface once the queue is empty (so the player isn't asked to act
 *  while the previous beat is still being read / animated). */
export type QueueItem =
  | { kind: 'narration'; chatIdx: number; text: string }
  | { kind: 'hero-speech'; chatIdx: number; speech: HeroSpeech }
  | { kind: 'dice'; chatIdx: number; roll: RollSummary; attackerId: string | null }
  | { kind: 'initiative'; chatIdx: number; summary: InitiativeSummary }
  // Ambient emoji reaction (a hero/npc/monster `emote`). Carried through the
  // SAME playback queue as speech so the board balloon spawns in dialogue
  // order — and paces the beat gate — instead of popping the instant the WS
  // event lands (which races ahead of, and desyncs from, the queued speech /
  // dice beats it accompanies). The balloon itself is owned by Board (spawned
  // via the `onEmote` callback on promotion); this item only sequences it.
  | { kind: 'emote'; chatIdx: number; actorId: string; emoji: string };

/** Post-typewriter hold for narration / hero-speech beats: once the last
 *  character has appeared, the line stays on screen for this long before a
 *  fresh queue item is allowed to displace it. Combined with the typewriter
 *  duration (`text.length * TYPEWRITER_CHAR_MS`), this gives the player a
 *  guaranteed read window proportional to the line's length. */
const POST_REVEAL_HOLD_MS = 3000;

/** How long an `emote` queue item stays the active beat before the queue
 *  auto-advances. An emoji carries no text to read, so — unlike narration /
 *  hero-speech — it does NOT wait for a Skip click (auto-advances regardless
 *  of the manual autoSkip flag, like dice / initiative are driven by their own
 *  signal). Kept short so the game isn't stalled on flavour; the board balloon
 *  itself lingers past this via its own fade timer (EMOTE_BALLOON_LIFETIME_MS).
 *  The non-zero hold is what makes the beat gate wait long enough for the
 *  player to actually see an emote-only reaction instead of racing past it. */
const EMOTE_BEAT_HOLD_MS = 1500;

/** Last-resort backstop for a `dice` / `initiative` beat whose 3D overlay roll
 *  promise never settles. These beats have NO Skip override (they drain only on
 *  the overlay's `notifyRollResolved` signal), so if the overlay never settles
 *  the playback queue — and the beat gate the server holds behind it — wedge
 *  forever. The known trigger: a backgrounded tab pauses requestAnimationFrame,
 *  so the dice physics never comes to rest (observed live 2026-06-04, the
 *  rat-tunnel freeze). `setTimeout` still fires in a background tab (throttled,
 *  unlike RAF), so this reliably force-settles the beat. Set well beyond any
 *  real roll (physics + verdict resolves in a few seconds) so a normal roll is
 *  never cut short. */
const OVERLAY_SETTLE_BACKSTOP_MS = 20_000;

/** Per-character tick for the adventure-OPENING splash specifically — slower
 *  than the narrator's `TYPEWRITER_CHAR_MS` (22ms ≈ 45 chars/sec) so the
 *  one-off cinematic intro types out at a more deliberate, closer-to-reading
 *  pace (~25 chars/sec). The in-game narrator keeps its faster cadence. */
const OPENING_TYPEWRITER_CHAR_MS = 40;

/** Hold window for typewritten queue items. Narration / hero-speech use
 *  `typewriter_duration + POST_REVEAL_HOLD_MS` so the text stays readable
 *  for a guaranteed window after the last character lands. Dice / initiative
 *  items are NOT timer-gated — they drain when the dice overlay signals
 *  `notifyRollResolved` (see `isQueueItemReady`). */
const queueItemHoldMs = (item: QueueItem & { kind: 'narration' | 'hero-speech' }): number => {
  if (item.kind === 'narration') {
    return item.text.length * TYPEWRITER_CHAR_MS + POST_REVEAL_HOLD_MS;
  }
  return item.speech.text.length * TYPEWRITER_CHAR_MS + POST_REVEAL_HOLD_MS;
};

/** Predicate: has this queue item been on screen long enough (or, for
 *  dice/initiative, has the overlay's `notifyRollResolved` fired) so it can
 *  be displaced by the next item or cleared from `currentDisplay`?
 *
 *  Narration / hero-speech beats only auto-advance when `autoSkip` is true.
 *  Otherwise they sit on screen until the user clicks the in-narrator Skip
 *  button (see `onDialogSkipClick` in `mountLayout`). Dice and initiative
 *  panels are driven by the overlay's resolve signal, not the timer, so
 *  they ignore the `autoSkip` flag. */
const isQueueItemReady = (
  item: QueueItem,
  shownAt: number,
  now: number,
  autoSkip: boolean,
): boolean => {
  if (item.kind === 'dice') return isRollResolved(item.roll.t);
  if (item.kind === 'initiative') return isRollResolved(item.summary.t);
  // Emote beats carry no text — they auto-advance after a short ambient hold
  // regardless of the manual autoSkip flag (forcing a Skip click to dismiss a
  // wordless emoji would be busywork). The balloon outlives the beat via its
  // own fade timer.
  if (item.kind === 'emote') return (now - shownAt) >= EMOTE_BEAT_HOLD_MS;
  if (!autoSkip) return false;
  return (now - shownAt) >= queueItemHoldMs(item);
};

const clampFace = (v: number): Face => {
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > 6) return 6;
  return n as Face;
};

/** Normalize a narration event into queue text. Returns an empty list when
 *  the trimmed text is empty so the queue stays clean. Multi-paragraph
 *  narration used to be split into one queue item per paragraph; it's now
 *  emitted as a single item so the whole block typewrites as one beat. */
const narrationToQueueTexts = (text: string): string[] => {
  const trimmed = text.trim();
  return trimmed.length > 0 ? [trimmed] : [];
};

/** Match a single chat event to zero-or-more queue items. Mirrors the rules
 *  in latestNarration / selectHeroSpeechFeed / rollSummaryAt but per-event so
 *  the queue can hold every beat in order (the "latest" selectors only
 *  return the most recent, which silently drops intermediate beats when
 *  events arrive back-to-back). DM narration is emitted as a single queue
 *  beat regardless of internal line breaks, so a multi-paragraph reply plays
 *  out as one continuous typewriter reveal. */
export const matchQueueItems = (
  chat: ReadonlyArray<ChatEntry>,
  idx: number,
  characters: ReadonlyArray<RedactedCharacter>,
  physicsMode = false,
): QueueItem[] => {
  const raw = chat[idx]!.event as {
    type?: string;
    actorId?: string;
    text?: string;
    public?: { rollRequestId?: unknown };
    action?: { kind?: string; text?: string };
  };

  // DM narration: top-level `narrate`, or DM `action.kind === 'narrate'`,
  // or DM `action.kind === 'say'` (treated as narration per NarratorWindow).
  const narrationText: string | null =
    raw.type === 'narrate' && typeof raw.text === 'string' && raw.text.length > 0
      ? raw.text
      : raw.type === 'action'
        && raw.actorId === 'dm'
        && raw.action
        && (raw.action.kind === 'narrate' || raw.action.kind === 'say')
        && typeof raw.action.text === 'string'
        && raw.action.text.length > 0
        ? raw.action.text
        : null;
  if (narrationText !== null) {
    return narrationToQueueTexts(narrationText).map((text) => ({
      kind: 'narration' as const,
      chatIdx: idx,
      text,
    }));
  }

  // Character speech: `action.kind === 'say'` from a hero, npc, OR monster
  // actor. (DM `say` is handled in the narration branch above.) Monsters speak
  // only when the DM voices an off-turn enemy reaction (see `reactAsMonsters`);
  // their line renders as a speech bubble over the foe, same as a hero's.
  if (raw.type === 'action' && raw.action?.kind === 'say'
      && typeof raw.actorId === 'string' && raw.actorId !== 'dm'
      && typeof raw.action.text === 'string' && raw.action.text.length > 0) {
    const actor = characters.find((c) => String(c.id) === raw.actorId);
    if (actor && (actor.kind === 'hero' || actor.kind === 'npc' || actor.kind === 'monster')) {
      // A monster `say` whose text reads as third-person narration about the
      // creature ("The King Rat squeaks in triumph…") is the DM narrating, not
      // the monster speaking — surfacing it in a first-person speech bubble
      // (name + portrait as the speaker) reads wrong. Fall back to a DM-
      // narration caption instead. (First-person utterances — "Skreee!",
      // taunts — stay a bubble; see `monsterSayReadsAsNarration`.)
      if (actor.kind === 'monster' && monsterSayReadsAsNarration(raw.action.text, actor.name)) {
        return narrationToQueueTexts(raw.action.text).map((text) => ({
          kind: 'narration' as const,
          chatIdx: idx,
          text,
        }));
      }
      const spriteUrl = characterSpeechSpriteUrl(actor);
      return [{
        kind: 'hero-speech',
        chatIdx: idx,
        speech: {
          key: `${raw.actorId}:${idx}`,
          actorId: raw.actorId,
          actorName: actor.name,
          ...(spriteUrl !== undefined ? { spriteUrl } : {}),
          // A monster's sprite isn't humanoid (e.g. the low, horizontal giant
          // rat), so flag it for the full-sprite portrait crop instead of the
          // humanoid head-crop that would clip its face. This is the LIVE bubble
          // path (selectHeroSpeechFeed, which also sets this, is not rendered).
          ...(actor.kind === 'monster' ? { isMonster: true } : {}),
          text: raw.action.text,
        },
      }];
    }
  }

  // Character emote: `action.kind === 'emote'` from a non-DM actor with a
  // non-empty emoji. Queued (rather than spawned on WS arrival) so the board
  // balloon fires in dialogue order — after the speech / dice beats it
  // accompanies — and so an emote-only reaction paces the beat gate instead of
  // racing past. Board owns the balloon (spawned via `onEmote` on promotion);
  // the actor's on-board position is resolved there at spawn time, so no
  // character lookup is needed here (a position-less / off-board actor is
  // skipped board-side, same as before).
  if (raw.type === 'action' && raw.action?.kind === 'emote'
      && typeof raw.actorId === 'string' && raw.actorId !== 'dm'
      && typeof (raw.action as { emoji?: unknown }).emoji === 'string'
      && (raw.action as { emoji: string }).emoji.length > 0) {
    return [{
      kind: 'emote',
      chatIdx: idx,
      actorId: raw.actorId,
      emoji: (raw.action as { emoji: string }).emoji,
    }];
  }

  // Dice resolution: rollSummaryAt validates the shape; returns null for
  // events that aren't a usable resolution.
  //
  // Physics-as-truth: when the resolution carries a `rollRequestId`, the
  // browser already animated these dice in response to the server's
  // `roll_request` (see main.ts `handleRollRequest`). Re-enqueuing a dice
  // item here would roll them a SECOND time, so skip it — the request-id →
  // `t` bridge in ws-client still fires the numeric-`t` resolved signal so
  // Board's flash/projectile and ws-deferred's HP drain land on cue.
  if (raw.type === 'resolution') {
    if (typeof raw.public?.rollRequestId === 'string') return [];
    // Physics-as-truth run, but this resolution has NO rollRequestId — it's a
    // seeded FALLBACK (the browser failed to answer the roll_request in time).
    // Do NOT enqueue a dice beat: re-animating it would (a) show a spurious /
    // degenerate roll the player never triggered and (b) risk wedging the
    // playback queue — and the beat gate behind it — if that overlay (already
    // proven flaky for this roll) never settles. ws-client fires the timing
    // signal for `t` immediately so the deferred HP-drain still lands.
    if (physicsMode) return [];
    const roll = rollSummaryAt(chat, idx, characters);
    if (roll) {
      // Carry the attacker's id alongside the dice item so the turn-order
      // bar can hold its cursor on this actor while the dice are still
      // queued / playing — even after the WS layer has already reported
      // their `turn_ended` and the next combatant's `turn_started`.
      const attackerId = typeof raw.actorId === 'string' ? raw.actorId : null;
      return [{ kind: 'dice', chatIdx: idx, roll, attackerId }];
    }
  }
  // Combat start: engine rolls one d6 per character and emits a
  // `combat_started` event carrying the per-character results. Surface the
  // panel here so it plays out in the same slot as attack dice rolls.
  if (raw.type === 'combat_started') {
    const summary = initiativeSummaryAt(chat, idx, characters);
    if (summary) return [{ kind: 'initiative', chatIdx: idx, summary }];
  }
  return [];
};

export const mountLayout = (
  root: HTMLElement,
  store: Store,
  cb: LayoutCallbacks,
  opts: LayoutOptions = {},
): LayoutHandle => {
  let narratorBusy = false;
  let selectionMode: SelectionMode = 'idle';
  // Multi-target split-special (warrior whirlwind / hunter split-shot) dice
  // allocation in progress. Non-null only while `selectionMode === 'special'`
  // for a split-type special; single-click specials (flame-burst / healing-
  // touch) and old snapshots with no `targeting` keep `splitSession === null`
  // and fall back to the original one-click dispatch.
  let splitSession: { plan: SplitPlan; alloc: Allocation[] } | null = null;
  let eventLogOpen = false;
  const toggleEventLog = () => { eventLogOpen = !eventLogOpen; renderOnce(); };
  // Playtest survey (docs/tester-survey.md) — opened from the floating Survey
  // button below the Log toggle. The form outlives the modal (close/reopen
  // keeps half-filled answers); see SurveyModal.ts.
  let surveyOpen = false;
  const toggleSurvey = () => { surveyOpen = !surveyOpen; renderOnce(); };
  const surveyForm = createSurveyForm();
  // A submitted survey sits at "Saving…" until the server's `survey_ack` lands
  // and applySurveyAck resolves it. That ack can be lost without a trace — the
  // socket may not be OPEN when the request is sent or when the reply comes
  // back (reconnect / duplicate-tab kick), or the GCS upload may stall — which
  // would pin the button at "Saving…" forever. Guard with a client-side
  // timeout: if no ack resolves the submit in time, flip it to "failed" so the
  // tester is steered to the always-offline Copy fallback (and can retry).
  const SURVEY_ACK_TIMEOUT_MS = 12_000;
  let surveyAckTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSurveyAckTimer = () => {
    if (surveyAckTimer !== null) { clearTimeout(surveyAckTimer); surveyAckTimer = null; }
  };
  const submitSurvey = (submission: SurveySubmission): void => {
    // surveyModal's click handler has already set submitState='sending'.
    cb.onSurveySubmit?.(submission);
    clearSurveyAckTimer();
    surveyAckTimer = setTimeout(() => {
      surveyAckTimer = null;
      if (surveyForm.submitState === 'sending') {
        surveyForm.submitState = 'failed';
        renderOnce();
      }
    }, SURVEY_ACK_TIMEOUT_MS);
  };
  // Last OOC submission, echoed under the narrator text with a "to DM"
  // indicator. We ONLY echo DM-target submissions — game-target submissions
  // already render as a hero-speech bubble in the chat queue (the `say`
  // action the engine emits), so echoing them too would double up the same
  // line on screen. Once the DM emits a `dm_ooc_reply`, the reply text
  // populates `reply` (paired bubble under the question) and the pair stays
  // visible until the DM moves on with a fresh narrate line — at that point
  // we clear the whole echo. The `oocReplyAtSubmit` / `narrationAtSubmit`
  // snapshots distinguish "fresh" from "stale" since `latest*` returns the
  // same string before and after the matching event lands.
  let lastPrompt: {
    text: string;
    reply: string | null;
    oocReplyAtSubmit: string | null;
    narrationAtSubmit: string | null;
  } | null = null;

  /** Current target of the free-text Prompt input. Players toggle between
   *  'dm' (out-of-character question → DM answers in chat, turn unchanged)
   *  and 'game' (in-character → DM interprets into player actions, consumes
   *  the turn — the default, since speaking to the Party is the primary
   *  mode). Resets to 'game' after each submit so the default persists. */
  let promptTarget: PromptTarget = 'game';

  // Playback queue: chat events that should occupy the slot below the board
  // are appended here in chat order. `currentDisplay` tracks the item being
  // shown right now with the `performance.now()` timestamp when it became
  // active. `lastIngestedChatIdx` is the high-water mark for queue ingestion
  // so renderOnce only scans the tail of the chat each call. The queue
  // guarantees every narration / hero speech / dice roll is visible for its
  // full minimum duration before being displaced — fixes the "intermediate
  // narrations get skipped" bug that the previous "latest only" hold had.
  const playbackQueue: QueueItem[] = [];
  let currentDisplay: { item: QueueItem; shownAt: number } | null = null;
  // Last beat-gate request id we've already acked, so the queue-drained ack
  // (fired from renderOnce, which runs on every store change) is sent exactly
  // once per gate. A fresh gate carries a new request id and acks again.
  let lastAckedBeatGate: string | null = null;
  // Snapshot of the most recent narration / hero-speech beat. When `dice`
  // becomes the current display, this is what stays painted in the dialog
  // slot — the dice panel overlays the existing dialog instead of clearing
  // it, so the player can still see the line that motivated the roll.
  let lastDialogBeat: QueueItem | null = null;
  let lastIngestedChatIdx = -1;

  // When the player sends a message TO THE PARTY ("to game"), their line must
  // appear IMMEDIATELY — ahead of any narrator beats already queued. We remember
  // the submitted text here; the playback queue HOLDS promotion until the
  // matching hero-speech beat arrives, then jumps it to the front so it shows
  // first (queued narration resumes after). `pendingGameSayTimer` is a safety
  // release so a dropped/never-arriving echo can't freeze the queue.
  let pendingGameSay: string | null = null;
  let pendingGameSayTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPendingGameSay = (): void => {
    pendingGameSay = null;
    if (pendingGameSayTimer !== null) { clearTimeout(pendingGameSayTimer); pendingGameSayTimer = null; }
  };

  // Sticky cursor for the turn-order tape. The store clears `activeActor` to
  // null on every `turn_ended` envelope and re-populates it on the next
  // `turn_started`. Between those two messages the bar would otherwise snap
  // its cursor back to slot 0 (the `selectTurnOrder` fallback for "no active
  // actor"), then snap forward to the next slot when `turn_started` arrives —
  // the "backwards-then-forwards glitch" players see. We remember the last
  // active combatant locally and feed it to `selectTurnOrder` whenever the
  // store reports null, so the tape holds the previous slot until the next
  // turn legitimately begins.
  let lastCombatActor: string | null = null;

  // Actors currently animating a move on the Board (sprite still sliding
  // across the grid). Populated by Board.ts via the `setMovingActors`
  // LayoutHandle method. The turn-order bar consults this set so a
  // monster's slot stays lit until their move animation ends — even if
  // the engine has already drained their `turn_ended` and started the
  // next combatant. Reference identity matters: we replace the whole set
  // each callback so a single equality check suffices in renderOnce.
  let movingActors: ReadonlySet<string> = new Set();

  // Initiative reveal flow. While initiative dice are tumbling, the top
  // turn-order bar stays hidden so the dice are the only thing on screen.
  // Once the dice resolve, an unfurling "Order of Battle" parchment
  // plaque holds the slot for ~3.9s announcing the turn order, then
  // dismisses and lets the regular looping `turnOrderBar` take over:
  //   1. 'announcing'    — "To Arms!" splash up; bar hidden until the
  //                        splash hands off to the rolling dice.
  //   2. 'rolling'       — dice flying; bar still hidden.
  //   3. 'order-reveal'  — dice resolved; the BattleOrderReveal plaque
  //                        unfurls, holds, and rolls back up. Bar stays
  //                        hidden because the plaque is the bar's
  //                        replacement for this beat.
  //   4. 'idle' (settle) — plaque dismissed, regular `turnOrderBar`
  //                        takes the slot back.
  let initiativeUiPhase:
    | 'idle'
    | 'announcing'
    | 'rolling'
    | 'order-reveal' = 'idle';
  // Summary cached during `'order-reveal'` so the plaque can render
  // turn-order rows even though the queue item has already been
  // unmounted from `currentDisplay`.
  let orderRevealSummary: InitiativeSummary | null = null;
  // Per-character die screen anchors (PERCENT of the stage), supplied by the
  // host (main.ts) once it has projected the settled 3D dice. Undefined →
  // the reveal lays the badges out in an evenly spaced fallback row.
  let orderRevealPositions: BadgeAnchors | undefined;
  // Timestamp the plaque mounted, used to compute the remaining hold
  // window if the player toggles Auto on mid-reveal.
  let orderRevealShownAt: number | null = null;
  // True once the closing fade-out has been kicked off — either by a
  // Skip click (manual mode) or by the auto-dismiss timer (auto mode).
  // While true the plaque is animating out and a second Skip click is
  // a no-op.
  let orderRevealDismissing = false;
  // Two timers drive the plaque dismissal:
  //   - `orderRevealAutoDismissTimer` (auto mode only): fires at
  //     `orderRevealShownAt + BATTLE_ORDER_REVEAL_MS − fade-out` and
  //     kicks off the fade-out.
  //   - `orderRevealUnmountTimer`: fires after the fade-out completes
  //     and flips the phase back to `'idle'`.
  // Both are cleared on a fresh combat so a second fight doesn't
  // double-fire.
  let orderRevealAutoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  let orderRevealUnmountTimer: ReturnType<typeof setTimeout> | null = null;
  // Two timers drive the announce phase, decoupled so the splash can stay
  // mounted THROUGH the dice canvas fade-in:
  //   - `initiativeAnnounceTimer` fires at COMBAT_BEGINS_DISPATCH_AT_MS and
  //     dispatches the dice (the canvas starts fading in). Splash stays up.
  //   - `initiativeSplashUnmountTimer` fires at COMBAT_BEGINS_SPLASH_MS and
  //     pulls the splash off-screen — by which time the dice canvas is
  //     fully visible (CANVAS_FADE_MS = 600 ms < SPLASH_MS − DISPATCH_AT_MS).
  let initiativeAnnounceTimer: ReturnType<typeof setTimeout> | null = null;
  let initiativeSplashUnmountTimer: ReturnType<typeof setTimeout> | null = null;

  // Bonus-ability "triggered" banner. A `passive_triggered` event in the chat
  // feed pops a transient avatar+name card at the top of the board stage; it
  // holds for PASSIVE_BANNER_MS then fades out. `passiveSeenCount` tracks how
  // many passive events we've already surfaced so renderOnce (called on every
  // store change) only reacts to NEW triggers; it clamps back down when the
  // chat is reset (scene change / reconnect) so a fresh run starts clean.
  let passiveBanner: PassiveBannerData | null = null;
  let passiveBannerDismissing = false;
  let passiveSeenCount = 0;
  let passiveBannerDismissTimer: ReturnType<typeof setTimeout> | null = null;
  let passiveBannerUnmountTimer: ReturnType<typeof setTimeout> | null = null;
  let combatBeginsSplashVisible = false;

  // Opening-splash state. At game start — the scene carries an `opening` and no
  // narration has landed yet — the title splash covers the screen. Clicking
  // "Begin" latches this true, relays the opening_ack (→ the server runs the
  // DM's first turn, which emits the opening's second half as narration), and
  // unmounts the splash. The latch means a mid-run reconnect never re-shows it.
  let openingDismissed = false;
  // Typewriter reveal for the splash body: `openingRevealChars` is the count of
  // body characters currently shown; a timer ticks it up at the opening's own,
  // slower-than-the-narrator cadence (OPENING_TYPEWRITER_CHAR_MS). Armed once
  // when the splash first renders.
  let openingRevealChars = 0;
  let openingTypeStarted = false;
  let openingTypeTimer: ReturnType<typeof setInterval> | null = null;
  // True while the host's separate "Choose your hero" overlay (z-index 40) is
  // covering the splash (z-index 30). The first snapshot — which carries
  // `scene.opening` — is published by the server BEFORE the hero-select gate, so
  // without this guard the splash would arm its typewriter and run it to
  // completion HIDDEN behind the chooser; by the time the player picks a hero
  // the text would already be fully revealed (no visible reveal). Gating the
  // splash on this flag holds the reveal until the chooser is dismissed, so the
  // text types out on screen exactly like a narrator beat.
  let heroSelectActive = false;
  // Flips true (and stays true) once the player completes the hero pick this
  // page load. The boot "Summoning the Tale" loader is gated on it
  // (data-hero-picked, see main.css): on a fresh load the loader would
  // otherwise flash during the window between mount and the server's
  // `hero_select_request` arriving — the chooser, not the loader, is the
  // first thing the player should see.
  let heroSelectDone = false;
  const stopOpeningTypewriter = (): void => {
    if (openingTypeTimer !== null) { clearInterval(openingTypeTimer); openingTypeTimer = null; }
  };
  /** Jump the typewriter to the end (click-to-skip while typing). */
  const fastForwardOpening = (): void => {
    const sc = store.getSnapshot().scene;
    if (sc?.opening) openingRevealChars = openingVisibleLength(openingBefore(sc.opening));
    stopOpeningTypewriter();
    renderOnce();
  };
  const dismissOpeningSplash = (): void => {
    if (openingDismissed) return;
    openingDismissed = true;
    stopOpeningTypewriter();
    cb.onOpeningDismissed?.();
    renderOnce();
  };

  // Dialog skip state. Narration and hero/enemy speech beats default to
  // manual-skip mode: each beat sits on screen until the user clicks the
  // in-narrator "▶ Skip" button. A separate "⏯ Auto" toggle next to Skip
  // flips auto-skip on/off; when on, beats advance on the original timed
  // hold (text.length × TYPEWRITER_CHAR_MS + POST_REVEAL_HOLD_MS). The
  // two controls are deliberately independent — Skip never "leaks" into
  // mode changes, and Auto never advances the current beat.
  let autoSkipEnabled = false;

  // One-shot wake timer that fires renderOnce() at the moment the current
  // queue item's minimum-visible duration elapses. Cleared and re-armed each
  // renderOnce() so we never trigger more often than needed.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHoldRender = (delayMs: number): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    const clamped = Math.max(0, delayMs);
    holdTimer = setTimeout(() => { holdTimer = null; renderOnce(); }, clamped);
  };

  /** React to NEW `passive_triggered` events in the chat feed: pop the latest
   *  one as a top-of-board banner and (re)arm its hold→fade-out timers. Called
   *  every renderOnce; only does work when the passive count has grown (a fresh
   *  trigger). Resets cleanly when the chat is replaced (scene change). */
  const processPassiveBanners = (s: ReturnType<typeof store.getSnapshot>): void => {
    const { count, data } = selectLatestPassiveBanner(s.chat, s.characters);
    if (count < passiveSeenCount) {
      // Chat was reset (scene change / reconnect) — clear and start over.
      passiveSeenCount = count;
      if (passiveBanner !== null) {
        if (passiveBannerDismissTimer !== null) { clearTimeout(passiveBannerDismissTimer); passiveBannerDismissTimer = null; }
        if (passiveBannerUnmountTimer !== null) { clearTimeout(passiveBannerUnmountTimer); passiveBannerUnmountTimer = null; }
        passiveBanner = null;
        passiveBannerDismissing = false;
      }
      return;
    }
    if (count === passiveSeenCount || !data) return;
    // A new trigger (or several since last render): show the latest.
    passiveSeenCount = count;
    passiveBanner = data;
    passiveBannerDismissing = false;
    if (passiveBannerDismissTimer !== null) clearTimeout(passiveBannerDismissTimer);
    if (passiveBannerUnmountTimer !== null) clearTimeout(passiveBannerUnmountTimer);
    passiveBannerDismissTimer = setTimeout(() => {
      passiveBannerDismissTimer = null;
      passiveBannerDismissing = true;
      passiveBannerUnmountTimer = setTimeout(() => {
        passiveBannerUnmountTimer = null;
        passiveBanner = null;
        passiveBannerDismissing = false;
        renderOnce();
      }, PASSIVE_BANNER_FADE_OUT_MS);
      renderOnce();
    }, PASSIVE_BANNER_MS);
  };

  /** Begin the closing fade-out for the order-of-battle plaque, then
   *  flip the phase back to `'idle'` once the fade-out completes.
   *  Idempotent: a second call while already dismissing is a no-op. */
  const dismissOrderReveal = (): void => {
    if (initiativeUiPhase !== 'order-reveal' || orderRevealDismissing) return;
    if (orderRevealAutoDismissTimer !== null) {
      clearTimeout(orderRevealAutoDismissTimer);
      orderRevealAutoDismissTimer = null;
    }
    orderRevealDismissing = true;
    // The player has committed to starting combat — release the server's
    // first-turn gate. The guard above makes this fire exactly once per
    // reveal, for BOTH the Skip-click and auto-dismiss-timer paths. Sent at
    // dismiss-start (not after the fade-out) so the server gets a head start
    // while the plaque fades; the queue still stays blocked until the phase
    // returns to 'idle', so no first-turn beat shows under the fading plaque.
    cb.onInitiativeRevealDismissed?.();
    if (orderRevealUnmountTimer !== null) clearTimeout(orderRevealUnmountTimer);
    orderRevealUnmountTimer = setTimeout(() => {
      orderRevealUnmountTimer = null;
      orderRevealSummary = null;
      orderRevealShownAt = null;
      orderRevealDismissing = false;
      orderRevealPositions = undefined;
      initiativeUiPhase = 'idle';
      renderOnce();
    }, BATTLE_ORDER_REVEAL_FADE_OUT_MS);
    renderOnce();
  };

  /** Schedule the auto-dismiss timer for the plaque, sized so the total
   *  on-screen lifetime (mount → unmount) matches
   *  `BATTLE_ORDER_REVEAL_MS`. Only effectful when auto-skip is on and
   *  the plaque is mounted and not yet dismissing. If the mount happened
   *  long enough ago that the dismiss window has already elapsed, the
   *  fade-out fires synchronously instead. */
  const armOrderRevealAutoDismiss = (now: number): void => {
    if (initiativeUiPhase !== 'order-reveal') return;
    if (orderRevealDismissing) return;
    if (orderRevealShownAt === null) return;
    const dismissAt =
      orderRevealShownAt + BATTLE_ORDER_REVEAL_MS - BATTLE_ORDER_REVEAL_FADE_OUT_MS;
    const remaining = dismissAt - now;
    if (orderRevealAutoDismissTimer !== null) {
      clearTimeout(orderRevealAutoDismissTimer);
      orderRevealAutoDismissTimer = null;
    }
    if (remaining <= 0) {
      dismissOrderReveal();
      return;
    }
    orderRevealAutoDismissTimer = setTimeout(() => {
      orderRevealAutoDismissTimer = null;
      dismissOrderReveal();
    }, remaining);
  };

  /** The active actor's split-special plan (whirlwind / split-shot), or null
   *  when the actor's special is a single-click / area effect (or the snapshot
   *  predates the `targeting` field). */
  const activeSplitPlan = (): SplitPlan | null => {
    const s = store.getSnapshot();
    const actorId = typeof s.activeActor === 'string' ? s.activeActor : null;
    if (!actorId) return null;
    const me = s.characters.find((c) => String(c.id) === actorId);
    const t = me?.specialAction?.targeting;
    if (!t || t.mode !== 'split') return null;
    return { attackKind: t.attackKind, pool: t.pool, range: t.range, requiresLos: t.requiresLos };
  };

  /** Live instruction line for a split-special allocation: how many dice are
   *  left to place, what's assigned so far, and the controls. */
  const splitHint = (
    characters: ReadonlyArray<RedactedCharacter>,
    session: { plan: SplitPlan; alloc: Allocation[] },
  ): string => {
    const isArrow = session.plan.attackKind === 'ranged';
    const noun = (n: number): string =>
      isArrow
        ? t(n === 1 ? 'split.arrow.one' : 'split.arrow.many')
        : t(n === 1 ? 'split.die.one' : 'split.die.many');
    const left = splitBudgetLeft(session.alloc, session.plan.pool);
    const nameOf = (id: string) =>
      displayName(characters.find((c) => String(c.id) === id)?.name ?? id);
    const assigned = session.alloc.length
      ? t('split.assigned', { list: session.alloc.map((a) => `${nameOf(a.id)} ×${a.dice}`).join(', ') })
      : '';
    const prompt = left > 0
      ? t('split.assign', { left, noun: noun(left) })
      : t('split.firing');
    return t('split.line', { pool: session.plan.pool, noun: noun(session.plan.pool), assigned, prompt });
  };

  const setMode = (m: SelectionMode) => {
    selectionMode = (selectionMode === m) ? 'idle' : m;
    // Open a fresh split-allocation session when entering Special for a
    // split-type special; clear it on any other transition (incl. cancel).
    if (selectionMode === 'special') {
      const plan = activeSplitPlan();
      splitSession = plan ? { plan, alloc: [] } : null;
    } else {
      splitSession = null;
    }
    renderOnce();
  };

  /** True iff any narrator / hero-speech element in `root` is still
   *  revealing text (fade or typewriter in flight). Walks the dialog
   *  elements lazily — there's at most one of each on screen at a time. */
  const isAnyTypewriterActive = (): boolean => {
    const narratorEl = root.querySelector('.narrator-text');
    if (narratorEl instanceof HTMLElement && isTypewriterActive(narratorEl)) return true;
    const heroEls = root.querySelectorAll('.hero-text[data-speech-key]');
    for (const el of Array.from(heroEls)) {
      if (el instanceof HTMLElement && isTypewriterActive(el)) return true;
    }
    return false;
  };
  /** Force any in-flight reveal in `root`'s narrator / hero-speech slots to
   *  finish in place. Used by the Skip click handler — see the comment on
   *  `onDialogSkipClick` for the rationale. */
  const completeAllTypewriters = (): void => {
    const narratorEl = root.querySelector('.narrator-text');
    if (narratorEl instanceof HTMLElement) completeTypewriter(narratorEl);
    const heroEls = root.querySelectorAll('.hero-text[data-speech-key]');
    for (const el of Array.from(heroEls)) {
      if (el instanceof HTMLElement) completeTypewriter(el);
    }
  };

  /** Brief gold tint pulse on a dialog control activation (mouse click and
   *  hotkey alike — the hotkeys route through `btn.click()`). Uses the Web
   *  Animations API rather than a CSS class because both click handlers call
   *  `renderOnce()` synchronously, and lit-html rewrites the buttons' `class`
   *  attribute on every render — a flash class would be wiped mid-pulse. A
   *  WAAPI animation rides above the style system, finishes on its own, and
   *  reverts to the stylesheet values (no fill). steps() easing keeps the
   *  pulse pixel-flavored, matching the buttons' hover transition. */
  const flashDialogButton = (e: Event): void => {
    const btn = e.currentTarget;
    // jsdom (tests) has no Element.animate — the flash is cosmetic, skip it.
    if (!(btn instanceof HTMLElement) || typeof btn.animate !== 'function') return;
    btn.animate(
      [
        { color: '#fff3cf', opacity: 1 },
        { color: '#f0c270', opacity: 1 },
      ],
      { duration: 240, easing: 'steps(3, end)' },
    );
  };

  /** Skip button handler.
   *
   *   - Typewriter still revealing the current line: "finish the line" —
   *     complete the in-flight fade + reveal in place. The beat stays on
   *     screen and the playback queue does not advance. This branch fires
   *     in both modes (auto and manual) so a click mid-typewriter is
   *     always interpreted as "show me the rest of THIS line."
   *
   *   - Reveal already done: advance past the current narration / hero-
   *     speech beat. Next render promotes the next queued item, or clears
   *     the slot if none is queued. Mode is unchanged — Skip never toggles
   *     auto on its own (use the Auto toggle for that). */
  const onDialogSkipClick = (): void => {
    if (isAnyTypewriterActive()) {
      completeAllTypewriters();
      return;
    }
    // Order-of-Battle plaque: Skip kicks off the closing fade-out so
    // the plaque advances on the user's beat, mirroring the way Skip
    // advances a narration / hero-speech beat.
    if (initiativeUiPhase === 'order-reveal' && !orderRevealDismissing) {
      dismissOrderReveal();
      return;
    }
    if (currentDisplay !== null
        && (currentDisplay.item.kind === 'narration'
            || currentDisplay.item.kind === 'hero-speech')) {
      lastDialogBeat = currentDisplay.item;
      currentDisplay = null;
    }
    renderOnce();
  };

  /** Flush whatever narration / hero-speech beat is currently parked so the
   *  player's just-sent message — and the responses streaming in behind it —
   *  surface in the narrator window instead of sitting invisibly queued behind
   *  the old beat. Called when the player submits a prompt: typing IS their
   *  "advance," so unlike a single Skip click (which first just finishes the
   *  typewriter) this fully clears the beat in one go. No-op when nothing is
   *  parked. Caller re-renders. */
  const flushDialogueForSubmit = (): void => {
    if (isAnyTypewriterActive()) completeAllTypewriters();
    if (currentDisplay !== null
        && (currentDisplay.item.kind === 'narration'
            || currentDisplay.item.kind === 'hero-speech')) {
      lastDialogBeat = currentDisplay.item;
      currentDisplay = null;
    }
  };

  /** Auto-skip toggle. Independent of Skip — flips the auto-advance mode
   *  on or off without touching the currently-displayed beat. The beat
   *  itself doesn't advance from this click; it just changes whether the
   *  queue will start using its timed holds again.
   *
   *  When the Order-of-Battle plaque is up: flipping ON arms the
   *  auto-dismiss timer (sized so the plaque's total lifetime matches
   *  `BATTLE_ORDER_REVEAL_MS`); flipping OFF cancels a pending
   *  auto-dismiss so the plaque waits for an explicit Skip click again.
   *  The plaque is not unmounted on the toggle itself — that's Skip's
   *  job. */
  const onAutoToggleClick = (): void => {
    autoSkipEnabled = !autoSkipEnabled;
    // Flipping ON mid-reveal: snap the current line to its finished text so
    // AutoSkip's "no animation" promise applies to the in-flight beat too,
    // not just the next one.
    if (autoSkipEnabled) completeAllTypewriters();
    if (initiativeUiPhase === 'order-reveal' && !orderRevealDismissing) {
      if (autoSkipEnabled) {
        const now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        armOrderRevealAutoDismiss(now);
      } else if (orderRevealAutoDismissTimer !== null) {
        clearTimeout(orderRevealAutoDismissTimer);
        orderRevealAutoDismissTimer = null;
      }
    }
    renderOnce();
  };

  // Attack and Special are "main actions" — per HeroKids rules they conclude
  // the player's turn, so we auto-dispatch end_turn right after the action.
  // Move stays non-terminal: the player can attack/special after moving.
  const isMainAction = (a: PlayerAction): boolean =>
    a.kind === 'normal_attack' || a.kind === 'special_action' || a.kind === 'attack_object';

  const dispatchAction = (action: PlayerAction) => {
    selectionMode = 'idle';
    cb.onAction(action);
    if (isMainAction(action)) cb.onAction({ kind: 'end_turn' });
  };

  // Build the engine MoveField for the active actor, shared by the move
  // highlight (computeSelection) and the move submission (handleCanvasClick) so
  // they can NEVER disagree. Live obstacles → walls; cave rock → rock; live
  // foes → enemies and live teammates → allies (both block transit AND end —
  // you cannot move through a living character of either side). Destroyed
  // obstacles and KO'd characters of either side are omitted from every set —
  // the engine treats them as passable floor.
  const moveFieldFor = (
    scene: NonNullable<RedactedSnapshot['scene']>,
    characters: ReadonlyArray<RedactedCharacter>,
    me: RedactedCharacter,
    actorId: string,
  ): MoveField => {
    const destroyed = new Set(scene.destroyedObstacles.map((d) => `${d.x},${d.y}`));
    const live = characters.filter((c) => c.pos != null && c.health.status !== 'KO');
    return {
      gridW: scene.gridW,
      gridH: scene.gridH,
      walls: scene.obstacles
        .filter((o) => !destroyed.has(`${o.x},${o.y}`))
        .map((o) => ({ x: o.x, y: o.y })),
      rock: (scene.wallCells ?? []).map((w) => ({ x: w.x, y: w.y })),
      enemies: live
        .filter((c) => c.kind !== me.kind)
        .map((c) => ({ x: c.pos!.x, y: c.pos!.y })),
      allies: live
        .filter((c) => c.kind === me.kind && String(c.id) !== actorId)
        .map((c) => ({ x: c.pos!.x, y: c.pos!.y })),
    };
  };

  const computeSelection = (): SelectionOverlay => {
    const s = store.getSnapshot();
    if (!s.inputUnlocked || s.ended || narratorBusy || !s.scene) return IDLE_OVERLAY;
    if (selectionMode === 'idle') return IDLE_OVERLAY;
    const actorId = typeof s.activeActor === 'string' ? s.activeActor : null;
    if (!actorId || actorId === 'dm') return IDLE_OVERLAY;
    const me = s.characters.find((c) => String(c.id) === actorId);
    if (!me?.pos) return IDLE_OVERLAY;

    if (selectionMode === 'move') {
      // Highlight every cell the engine would let me end on this turn. Uses the
      // engine's own Grid.reachable (8-connected, walls/rock block, foes block
      // transit, teammates are walk-through), so the highlight matches the
      // server exactly — including the cells past a smashed-open breach.
      const field = moveFieldFor(s.scene, s.characters, me, actorId);
      return {
        mode: 'move',
        reachable: findReachable(me.pos, field, MOVE_BUDGET),
        targets: [],
      };
    }
    if (selectionMode === 'special' && splitSession) {
      // Multi-target split special: highlight ONLY the targets the engine will
      // accept (in range, + LoS for ranged), so the player can't waste a die on
      // an illegal target and lose the whole allocation. Carries the running
      // per-target dice + remaining budget so Board draws the assigned rings,
      // ×N badges, and the HUD reads the dice left.
      const field = moveFieldFor(s.scene, s.characters, me, actorId);
      return {
        mode: 'special',
        reachable: [],
        targets: splitTargetIds(me, s.characters, splitSession.plan, field),
        allocations: splitSession.alloc.map((a) => ({ ...a })),
        budgetLeft: splitBudgetLeft(splitSession.alloc, splitSession.plan.pool),
      };
    }
    if (selectionMode === 'attack') {
      // Highlight ONLY the targets the engine will accept — within the actor's
      // normal-attack range (+ line of sight for ranged/magic), mirroring
      // `computeNormalAttackContext` — so an out-of-range click can't round-trip
      // into a rule_violation. Heroes are included (friendly fire stays legal);
      // KO'd are excluded.
      const field = moveFieldFor(s.scene, s.characters, me, actorId);
      const targets = normalAttackTargetIds(me, s.characters, field);
      // Inanimate Things (live obstacles minus those already smashed, plus
      // DM-spawned emoji props) gate the SAME way: `attack_object` mirrors
      // normal_attack's range + LoS in the engine.
      const destroyed = new Set(
        s.scene.destroyedObstacles.map((d) => `${d.x},${d.y}`),
      );
      const objectTargets = [
        ...s.scene.obstacles
          // Attack-proof stalagmites can't be smashed — don't offer them as
          // attack targets (the engine would reject the swing anyway).
          .filter((o) => !destroyed.has(`${o.x},${o.y}`) && !o.attackProof)
          .map((o) => ({ x: o.x, y: o.y })),
        ...s.props.map((p) => ({ x: p.pos.x, y: p.pos.y })),
      ].filter((cell) => inNormalAttackRange(me, cell, field));
      return { mode: 'attack', reachable: [], targets, objectTargets };
    }
    // Single-click special (flame-burst auto-AoE, healing-touch, or a snapshot
    // with no targeting): highlight any non-self, non-KO'd target — heroes
    // included (friendly heals / fire). NOT range-gated: healing-touch has
    // unlimited reach and flame-burst auto-targets its own adjacent foes, so
    // neither produces an out-of-range rejection the way a normal attack does.
    const targets = s.characters
      .filter((c) =>
        String(c.id) !== actorId &&
        c.pos != null &&
        c.health.status !== 'KO',
      )
      .map((c) => String(c.id));
    return { mode: selectionMode, reachable: [], targets };
  };

  const pushSelection = () => cb.onSelectionChange?.(computeSelection());

  // Input is disabled while narrator is animating OR an action mode is
  // selected (the player must finish picking a target first or cancel).
  // The free-text input is also disabled during target-picking modes — clicking
  // a button puts the human in "pick a target" mode, not "type a fallback."
  const handleCanvasClick: LayoutHandle['handleCanvasClick'] = (target) => {
    const s = store.getSnapshot();
    if (!s.inputUnlocked || s.ended || narratorBusy) return;
    const actorId = typeof s.activeActor === 'string' ? s.activeActor : null;
    if (!actorId || actorId === 'dm') return;
    const me = s.characters.find((c) => String(c.id) === actorId);
    if (!me?.pos) return;

    if (selectionMode === 'attack') {
      // Guard the dispatch with the SAME range + LoS rule that gates the
      // highlight (computeSelection), so a click landing on a non-highlighted
      // out-of-range cell is a no-op rather than a doomed round-trip.
      const scene = s.scene;
      if (!scene) return;
      const field = moveFieldFor(scene, s.characters, me, actorId);
      if (target.actorId && target.actorId !== actorId) {
        const tgt = s.characters.find((c) => String(c.id) === target.actorId);
        if (tgt && tgt.pos && tgt.health.status !== 'KO' && inNormalAttackRange(me, tgt.pos, field)) {
          dispatchAction({ kind: 'normal_attack', targetId: target.actorId as CharacterId });
        }
        return;
      }
      // Cell not occupied by a character — look for an inanimate Thing
      // (live obstacle or DM-spawned prop) at that cell. Live = not in
      // destroyedObstacles.
      const destroyed = scene.destroyedObstacles.some(
        (d) => d.x === target.pos.x && d.y === target.pos.y,
      );
      const obstacleHere = !destroyed && scene.obstacles.some(
        (o) => o.x === target.pos.x && o.y === target.pos.y && !o.attackProof,
      );
      const propHere = s.props.some(
        (p) => p.pos.x === target.pos.x && p.pos.y === target.pos.y,
      );
      if ((obstacleHere || propHere) && inNormalAttackRange(me, target.pos, field)) {
        dispatchAction({ kind: 'attack_object', pos: target.pos });
      }
      return;
    }
    if (selectionMode === 'move') {
      const scene = s.scene;
      if (!scene) return;
      // Can't end on a LIVE character (foe or teammate). A KO'd corpse cell is
      // a legal destination per the engine, so allow it (matches the highlight).
      if (target.actorId !== null) {
        const occ = s.characters.find((c) => String(c.id) === target.actorId);
        if (occ && occ.health.status !== 'KO') return;
      }
      const field = moveFieldFor(scene, s.characters, me, actorId);
      const path = findPath(me.pos, target.pos, field, MOVE_BUDGET);
      if (path && path.length > 1) {
        dispatchAction({ kind: 'move', path });
      }
      return;
    }
    if (selectionMode === 'special') {
      if (splitSession) {
        // Multi-target split: each click on a legal target assigns one die.
        // When the pool is fully assigned, fire the special_action with the
        // diceSplit; otherwise re-render so the HUD/badges track the running
        // allocation. (Right-click removes a die — see handleCanvasRightClick.)
        if (!target.actorId || target.actorId === actorId) return;
        if (!s.scene) return;
        const field = moveFieldFor(s.scene, s.characters, me, actorId);
        const legal = new Set(splitTargetIds(me, s.characters, splitSession.plan, field));
        if (!legal.has(target.actorId)) return;
        splitSession.alloc = addDie(splitSession.alloc, target.actorId, splitSession.plan.pool);
        if (allocTotal(splitSession.alloc) >= splitSession.plan.pool) {
          const action: PlayerAction = {
            kind: 'special_action',
            targetIds: splitSession.alloc.map((a) => a.id as CharacterId),
            params: { diceSplit: diceSplitParams(splitSession.alloc) },
          };
          splitSession = null;
          dispatchAction(action); // resets mode → idle, auto-appends end_turn
          return;
        }
        renderOnce(); // refresh hint + overlay (badges / dice-left HUD)
        return;
      }
      // Single-click special (flame-burst auto-AoE, healing-touch, or a snapshot
      // with no targeting): unchanged one-target dispatch.
      if (target.actorId && target.actorId !== actorId) {
        dispatchAction({ kind: 'special_action', targetIds: [target.actorId as CharacterId] });
      }
      return;
    }
  };

  const handleCanvasRightClick: LayoutHandle['handleCanvasRightClick'] = (target) => {
    // Only meaningful mid-split: pull one die back off a target you over-assigned.
    if (selectionMode !== 'special' || !splitSession) return;
    if (!target.actorId) return;
    splitSession.alloc = removeDie(splitSession.alloc, target.actorId);
    renderOnce();
  };

  const renderOnce = () => {
    const s = store.getSnapshot();

    // Resolve the server's reply to a submitted playtest survey into the form
    // (Saved ✓ / failed). Runs every render — the ack may land while the
    // modal is closed — and consumes each ack at most once (seq-guarded). A
    // real ack that resolves the in-flight submit cancels the safety timeout.
    const surveyWasSending = surveyForm.submitState === 'sending';
    applySurveyAck(surveyForm, s.surveyAck);
    if (surveyWasSending && surveyForm.submitState !== 'sending') clearSurveyAckTimer();

    // Surface any fresh bonus-ability trigger as a top-of-board banner. Pure
    // state + timer bookkeeping; the actual card is rendered in the board stage
    // below. Safe to call here — it only schedules async timers.
    processPassiveBanners(s);

    // Refresh the dialogue-reference context BEFORE rendering: every
    // `markdownInline` / narrator-typewriter call below reads it to wrap
    // coordinate / creature mentions in hoverable `.dlg-ref` chips. Built from
    // the live roster + grid, so newly-revealed monsters become hoverable as
    // soon as they appear.
    setRefContext(buildRefContext(s));

    const actors = new Map<string, ActorInfo>([['dm', { name: 'DM', kind: 'dm' }]]);
    for (const c of s.characters) {
      const friendly = displayName(c.name);
      if (c.kind === 'hero') {
        actors.set(String(c.id), {
          name: friendly,
          kind: 'hero',
          ...(c.archetype !== undefined && { archetype: c.archetype }),
        });
      } else {
        actors.set(String(c.id), { name: friendly, kind: 'monster' });
      }
    }

    const inputReady = s.inputUnlocked && !s.ended && !narratorBusy;
    const activeActorId = typeof s.activeActor === 'string' ? s.activeActor : null;
    const activeSpecial = activeActorId
      ? s.characters.find((c) => String(c.id) === activeActorId)?.specialAction ?? null
      : null;
    const hint = !inputReady
      ? ''
      : selectionMode === 'special' && splitSession
        ? splitHint(s.characters, splitSession)
        : selectionHint(selectionMode, activeSpecial);

    // Update the sticky combat-actor cursor (read by the turn-order bar
    // call site further down). Skip 'dm' — the bar isn't shown for the DM,
    // and we don't want a DM-initiated narrative beat to overwrite the
    // last combatant slot.
    if (typeof s.activeActor === 'string' && s.activeActor !== 'dm') {
      lastCombatActor = s.activeActor;
    }

    // OOC echo lifecycle:
    //   1. Populate `reply` once a fresh `dm_ooc_reply` has landed (so the
    //      DM's answer renders as a paired bubble under the question).
    //   2. Clear the whole echo once the DM has moved on with a fresh
    //      in-character narration — at that point the Q&A no longer fits
    //      the current narrator beat.
    if (lastPrompt) {
      if (lastPrompt.reply === null) {
        const latest = latestDmOocReply(s.chat);
        if (latest !== null && latest !== lastPrompt.oocReplyAtSubmit) {
          lastPrompt = { ...lastPrompt, reply: latest };
        }
      }
      if (lastPrompt && latestNarration(s.chat) !== lastPrompt.narrationAtSubmit) {
        lastPrompt = null;
      }
    }

    // -- Playback queue --------------------------------------------------
    // Walk the tail of the chat since the last ingest and append any
    // displayable beats. Then promote the next queued item if the current
    // one has been on screen for its minimum duration. Exactly one queue
    // item is visible at a time; action buttons surface only once the queue
    // is empty.
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    for (let i = lastIngestedChatIdx + 1; i < s.chat.length; i++) {
      for (const item of matchQueueItems(s.chat, i, s.characters, s.physicsActive)) {
        // The player's own "to party" line jumps to the FRONT of the queue so
        // it shows immediately, ahead of any narrator beats already waiting —
        // and releases the promotion hold set at submit time.
        if (item.kind === 'hero-speech' && pendingGameSay !== null && item.speech.text === pendingGameSay) {
          playbackQueue.unshift(item);
          clearPendingGameSay();
        } else {
          playbackQueue.push(item);
        }
      }
    }
    lastIngestedChatIdx = s.chat.length - 1;

    // Advance the current display. The promotion rule splits by item kind:
    //
    //   - Overlay panels (`dice`, `initiative`) are transient effects, not
    //     the resting state of the dialog. Once their hold expires they
    //     CLEAR themselves — even if nothing else is queued — so the
    //     turn-order bar can surface and the next narration beat (when it
    //     eventually arrives) appears in the freshly-empty slot. Without
    //     this, the initiative panel sticks in `currentDisplay` forever,
    //     keeping `initiativePending` true until a future `resolution`
    //     event happens to displace it — which is typically AFTER the
    //     first combatant has already attacked, producing the "bar appears
    //     after Kael's hit" bug.
    //
    //   - Narration / hero-speech beats stay parked when the queue is
    //     empty (the player should keep reading the last line). They only
    //     get displaced by a fresh queue item.
    // Promote the next queued item into `currentDisplay`. If the promoted
    // item is a dice panel, fire `notifyRollMounted` so Board.ts and
    // ws-deferred can schedule their dependent effects against the panel's
    // real mount time — not the resolution event's arrival in chat, which
    // can be many seconds earlier when narration sits ahead in the queue.
    const promoteNext = (): void => {
      const next = playbackQueue.shift()!;
      currentDisplay = { item: next, shownAt: now };
      if (next.kind === 'dice') {
        notifyRollMounted(next.roll.t);
        const rollKey = next.roll.t;
        // Settle handler: bound to BOTH success and rejection so a thrown
        // overlay error can't leave the queue stuck on the dice slot
        // forever. `renderOnce()` wakes the queue so it can drain. Idempotent
        // (the promise AND the backstop timer can both fire) and clears the
        // backstop on the first call.
        let settled = false;
        let backstop: ReturnType<typeof setTimeout> | null = null;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          if (backstop !== null) { clearTimeout(backstop); backstop = null; }
          notifyRollResolved(rollKey);
          renderOnce();
        };
        // Force-settle if the overlay's roll promise never resolves (see
        // OVERLAY_SETTLE_BACKSTOP_MS) so this beat can't wedge the queue.
        backstop = setTimeout(settle, OVERLAY_SETTLE_BACKSTOP_MS);
        if (cb.onDiceRoll) {
          // Each lane is owned by a single character: attacker pool gets the
          // actor's skin, defender pool gets the target's. The 3D overlay
          // applies the tint per die when cloning the mesh.
          const attackerSkin = skinForCharacter(next.roll.attackerKind, next.roll.attackerArchetype);
          const defenderSkin = skinForCharacter(next.roll.targetKind,   next.roll.targetArchetype);
          const dispatch = dispatchAttackRoll({
            t: rollKey,
            attackerTop: next.roll.attackerTop,
            attackerPool: next.roll.attackerPool,
            attackerActual: next.roll.rolls?.attack ?? null,
            attackerSkin,
            defenderTop: next.roll.defenderTop,
            defenderArmorPool: next.roll.defenderArmorPool,
            defenderActual: next.roll.rolls?.armor ?? null,
            defenderSkin,
          });
          cb.onDiceRoll(dispatch, { kind: 'duel', summary: next.roll }).then(settle, settle);
        } else {
          // No overlay handler installed (e.g. tests / headless): treat as
          // already-resolved so the queue and downstream effects don't stall.
          settle();
        }
      } else if (next.kind === 'initiative') {
        const rollKey = next.summary.t;
        // settle(): fires AFTER the dice overlay's post-snap hold has
        // elapsed. Hands off from the dice tray to the BattleOrderReveal
        // plaque: cache the summary, flip phase to `'order-reveal'`, and
        // schedule a dismiss timer that flips back to `'idle'` so the
        // regular `turnOrderBar` can take the slot. Also clears any
        // pending splash unmount timer + flag — normally the splash has
        // long since unmounted by this point, but a fast-resolving
        // stubbed dice roll (tests) can finish before the splash timer
        // fires.
        let settled = false;
        let backstop: ReturnType<typeof setTimeout> | null = null;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          if (backstop !== null) { clearTimeout(backstop); backstop = null; }
          notifyRollResolved(rollKey);
          if (initiativeSplashUnmountTimer !== null) {
            clearTimeout(initiativeSplashUnmountTimer);
            initiativeSplashUnmountTimer = null;
          }
          combatBeginsSplashVisible = false;
          // Enter the reveal phase. The plaque renders against the
          // cached summary, holds at opacity 1 indefinitely, and is
          // dismissed by either a Skip click (manual mode) or the
          // auto-dismiss timer scheduled below (auto mode). The total
          // on-screen lifetime in auto mode still matches
          // BATTLE_ORDER_REVEAL_MS — see `armOrderRevealAutoDismiss`.
          const mountedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
          orderRevealSummary = next.summary;
          orderRevealShownAt = mountedAt;
          orderRevealDismissing = false;
          initiativeUiPhase = 'order-reveal';
          if (autoSkipEnabled) armOrderRevealAutoDismiss(mountedAt);
          renderOnce();
        };
        // Force-settle if the initiative overlay never resolves (e.g. a
        // backgrounded tab pauses the dice physics) so combat can't hang at
        // the order-of-battle roll (see OVERLAY_SETTLE_BACKSTOP_MS).
        backstop = setTimeout(settle, OVERLAY_SETTLE_BACKSTOP_MS);
        const heroEntries    = next.summary.heroes;
        const monsterEntries = next.summary.monsters;
        const heroFaces: Face[]    = heroEntries.map((h) => clampFace(h.d6));
        const monsterFaces: Face[] = monsterEntries.map((m) => clampFace(m.d6));
        const heroSkins    = heroEntries.map((h) => skinForCharacter(h.kind, h.archetype));
        const monsterSkins = monsterEntries.map((m) => skinForCharacter(m.kind, m.archetype));
        // No combatants at all is degenerate (engine shouldn't emit it) —
        // just settle so the queue can drain.
        if (!cb.onDiceRoll || (heroFaces.length === 0 && monsterFaces.length === 0)) {
          settle();
          return;
        }
        const dispatch: RollDispatch = {
          t: rollKey,
          attacker: heroFaces,
          defender: monsterFaces,
          ...(heroSkins.length > 0    && { attackerSkins: heroSkins }),
          ...(monsterSkins.length > 0 && { defenderSkins: monsterSkins }),
        };
        // "To Arms!" splash flow (two decoupled timers):
        //   1. Show the splash immediately and enter 'announcing' phase
        //      (bar hidden).
        //   2. At COMBAT_BEGINS_DISPATCH_AT_MS, fire the dice dispatch and
        //      flip phase to 'rolling'. The dice canvas starts its
        //      CANVAS_FADE_MS (600ms) fade-in UNDER the still-mounted
        //      splash — no visual gap between "the engine decided combat"
        //      and "the dice are on screen".
        //   3. At COMBAT_BEGINS_SPLASH_MS, unmount the splash. By this
        //      point the canvas is fully visible and the dice are rolling.
        //   4. When both dice lanes settle, the onDiceRoll promise resolves
        //      and `settle()` flips the phase back to 'idle' — the regular
        //      `turnOrderBar` takes the slot on the next render.
        const startRolling = (): void => {
          initiativeAnnounceTimer = null;
          initiativeUiPhase = 'rolling';
          renderOnce();
          cb.onDiceRoll!(
            dispatch,
            { kind: 'initiative', summary: next.summary },
          ).then(settle, settle);
        };
        const unmountSplash = (): void => {
          initiativeSplashUnmountTimer = null;
          combatBeginsSplashVisible = false;
          renderOnce();
        };
        initiativeUiPhase = 'announcing';
        combatBeginsSplashVisible = true;
        // Clear the DM narration that opened combat — the initiative roll
        // takes over the screen, so the narrator window should be blank
        // through the whole "To Arms!" → dice → Order-of-Battle sequence
        // instead of leaving the pre-combat line stamped underneath. Nulling
        // the cached beat also stops it re-appearing after the plaque
        // dismisses; the first turn's fresh narration fills the slot then.
        lastDialogBeat = null;
        // Tear down any leftover reveal state from a previous combat in
        // the same session so the new fight starts from a clean phase.
        if (orderRevealAutoDismissTimer !== null) {
          clearTimeout(orderRevealAutoDismissTimer);
          orderRevealAutoDismissTimer = null;
        }
        if (orderRevealUnmountTimer !== null) {
          clearTimeout(orderRevealUnmountTimer);
          orderRevealUnmountTimer = null;
        }
        orderRevealSummary = null;
        orderRevealShownAt = null;
        orderRevealDismissing = false;
        orderRevealPositions = undefined;
        if (initiativeAnnounceTimer !== null) clearTimeout(initiativeAnnounceTimer);
        if (initiativeSplashUnmountTimer !== null) clearTimeout(initiativeSplashUnmountTimer);
        initiativeAnnounceTimer = setTimeout(startRolling, COMBAT_BEGINS_DISPATCH_AT_MS);
        initiativeSplashUnmountTimer = setTimeout(unmountSplash, COMBAT_BEGINS_SPLASH_MS);
      } else if (next.kind === 'emote') {
        // The emoji's turn in the dialogue has come up: spawn the board
        // balloon now (Board owns the overlay). The beat then self-advances
        // after EMOTE_BEAT_HOLD_MS via the wake timer scheduled below.
        cb.onEmote?.(next.actorId, next.emoji);
      }
    };
    // Promotion gate: during the order-of-battle reveal the plaque owns
    // the screen and no first-turn beats (DM narration, monster moves,
    // hero-speech) should play out beneath it. Hold the queue still
    // until the player dismisses the plaque (Skip click in manual mode,
    // or the auto-dismiss timer in auto mode); items keep accumulating
    // in `playbackQueue` and drain naturally when phase returns to
    // `'idle'`. The initiative item itself is still cleared from
    // `currentDisplay` so the plaque can take the overlay slot — that's
    // what the inner `currentDisplay = null` branch handles, and we
    // allow it even while order-reveal is active.
    const orderRevealBlocking = initiativeUiPhase === 'order-reveal';
    // While awaiting the player's just-sent "to party" line, HOLD promotion of
    // dialogue beats so a queued narration can't slip in ahead of it. The line
    // is unshifted to the front the moment it arrives (clearing this hold), so
    // it shows first; the held narration resumes right after. Dice / initiative
    // overlays are still allowed to self-clear so combat isn't frozen.
    const holdForPlayerSay = pendingGameSay !== null;
    if (currentDisplay !== null) {
      if (isQueueItemReady(currentDisplay.item, currentDisplay.shownAt, now, autoSkipEnabled)) {
        if (playbackQueue.length > 0 && !orderRevealBlocking && !holdForPlayerSay) {
          promoteNext();
        } else if (
          currentDisplay.item.kind === 'initiative'
          || currentDisplay.item.kind === 'dice'
          // Emote beats self-clear too (they're transient overlays, not a
          // resting dialog line): once the hold elapses with nothing queued
          // behind, drop back to null so the prior narration/speech reappears.
          || currentDisplay.item.kind === 'emote'
        ) {
          currentDisplay = null;
        }
      }
    } else if (playbackQueue.length > 0 && !orderRevealBlocking && !holdForPlayerSay) {
      promoteNext();
    }

    // Wake whenever the current TYPEWRITTEN beat still has hold-window time
    // left. Two reasons we need this even when the queue is empty: (a) a
    // fresh item may need to swap in if more events arrive, and (b)
    // `queueDrained` must flip true at the moment the hold expires so the
    // action buttons can surface. Dice / initiative items are NOT timer-
    // gated — their wake-up comes from `notifyRollResolved` → `renderOnce`
    // inside `promoteNext.settle`, so no scheduleHoldRender is needed here.
    if (currentDisplay !== null && currentDisplay.item.kind === 'emote') {
      // Emote beats self-advance after a short hold REGARDLESS of autoSkip
      // (they carry no text to read), so they always need a wake timer to
      // fire the advance — and to flip `queueDrained` so the beat gate
      // releases the next turn.
      const remaining = EMOTE_BEAT_HOLD_MS - (now - currentDisplay.shownAt);
      if (remaining > 0) scheduleHoldRender(remaining);
    } else if (autoSkipEnabled
        && currentDisplay !== null
        && currentDisplay.item.kind !== 'dice'
        && currentDisplay.item.kind !== 'initiative'
        && currentDisplay.item.kind !== 'emote') {
      const remaining =
        queueItemHoldMs(currentDisplay.item) - (now - currentDisplay.shownAt);
      if (remaining > 0) scheduleHoldRender(remaining);
    }

    // Remember the most recent dialog beat (narration / hero-speech) so the
    // dice panel can render OVER it rather than clearing it. Emote beats are
    // EXCLUDED: an emoji balloon is additive board flavour, not a line of
    // dialogue, so it must not replace the narration/speech the player is
    // reading (otherwise the narrator slot would blank for the emote's hold).
    if (currentDisplay
        && currentDisplay.item.kind !== 'dice'
        && currentDisplay.item.kind !== 'initiative'
        && currentDisplay.item.kind !== 'emote') {
      lastDialogBeat = currentDisplay.item;
    }

    // Dice / initiative / emote are overlays — when one is the current display,
    // fall back to the last dialog beat for the narration / hero-speech slots
    // so the player still sees the line that motivated the roll (and keeps
    // reading the dialogue while an emoji floats over the board).
    const dialogBeat: QueueItem | null =
      currentDisplay
      && currentDisplay.item.kind !== 'dice'
      && currentDisplay.item.kind !== 'initiative'
      && currentDisplay.item.kind !== 'emote'
        ? currentDisplay.item
        : lastDialogBeat;
    // The OOC question + DM reply NO LONGER touch the narrator text. They
    // render in their own `.dm-aside` margin slip (see `dmAsidePayload`
    // below), so the in-fiction narration that was on screen when the player
    // asked the DM a side question is never overwritten. The narrator slot
    // shows only genuine in-character narration beats.
    //
    // While the initiative roll owns the screen ('announcing' → 'rolling' →
    // 'order-reveal'), the narrator/DM dialog is blanked so the roll reads as
    // its own beat. `lastDialogBeat` was already nulled when the roll started.
    const initiativeActive = initiativeUiPhase !== 'idle';
    const visibleNarrationText =
      initiativeActive
        ? null
        : (dialogBeat?.kind === 'narration' ? dialogBeat.text : null);
    const visibleHeroSpeeches: HeroSpeech[] =
      !initiativeActive && dialogBeat?.kind === 'hero-speech' ? [dialogBeat.speech] : [];
    const visibleRoll =
      currentDisplay?.item.kind === 'dice' ? currentDisplay.item.roll : null;
    const visibleInitiative =
      currentDisplay?.item.kind === 'initiative' ? currentDisplay.item.summary : null;
    // Top-bar surface choice during initiative:
    //   - queued (waiting in line) / 'announcing' / 'rolling' → bar hidden
    //     (splash and dice tray take the screen instead)
    //   - 'order-reveal' (dice settled, parchment up)         → bar hidden
    //     while the BattleOrderReveal plaque holds the slot
    //   - everything else                                     → regular
    //     looping `turnOrderBar` fed by `selectTurnOrder`
    const initiativeQueued =
      playbackQueue.some((item) => item.kind === 'initiative')
      // visibleInitiative is non-null only AT the moment the queue item
      // promoted but before `initiativeUiPhase` was set this turn; the
      // synchronous phase update in `promoteNext` keeps this branch
      // effectively unreachable, but we keep it defensively in case of
      // re-entrant renders.
      || (visibleInitiative !== null && initiativeUiPhase === 'idle');
    // 'announcing' (splash up, no dice yet) and 'rolling' (dice in flight)
    // both blank the top bar — the splash overlay takes the screen, then
    // hands off to the rolling dice without the bar flashing in between.
    const initiativeRolling =
      initiativeUiPhase === 'announcing' || initiativeUiPhase === 'rolling';
    const showOrderReveal =
      initiativeUiPhase === 'order-reveal' && orderRevealSummary !== null;
    // Splash mount is its own flag because the splash stays up THROUGH the
    // dice canvas fade-in — i.e. into 'heroes-rolling'. See the two-timer
    // setup in the 'initiative' branch of `promoteNext` for the timeline.
    const showCombatBeginsSplash = combatBeginsSplashVisible;

    // Action buttons may surface once the queue has fully drained — the
    // current beat (if any) has lived past its minimum window AND nothing
    // is queued behind it. The dialog itself stays rendered; the buttons
    // appear in the slot below. The initiative phases ('announcing',
    // 'rolling', 'order-reveal') all gate the buttons off so the first
    // combatant's input controls never appear under the splash or the
    // order-of-battle plaque.
    const queueDrained =
      initiativeUiPhase === 'idle' &&
      playbackQueue.length === 0 &&
      (currentDisplay === null ||
        isQueueItemReady(currentDisplay.item, currentDisplay.shownAt, now, autoSkipEnabled));

    // Beat-pacing gate ack: the server is holding the next turn until the
    // player has read every queued beat. Once the queue has drained (Skip
    // clicks, or auto-skip), release the gate — exactly once per request id.
    // With auto-skip on, this fires automatically after the timed holds, so
    // the toggle "bypasses" the manual click. (Dedup keeps renderOnce — which
    // runs on every store change — from acking the same gate twice.)
    const pendingBeatGate = s.pendingBeatGate;
    if (pendingBeatGate && pendingBeatGate !== lastAckedBeatGate && queueDrained) {
      lastAckedBeatGate = pendingBeatGate;
      cb.onBeatGateAck?.(pendingBeatGate);
    }

    // Hold the turn-order cursor on the actor whose action is still being
    // visually played out. The WS protocol fires `turn_ended` the instant the
    // engine resolves the action, but visually the dice may still be tumbling
    // and the sprite may still be sliding across the board — so without this
    // hold the bar would advance to the next combatant while the player is
    // still watching the previous one finish. Priority:
    //   1. The currently-displayed dice's attacker (attack/special is the
    //      most visually disruptive case).
    //   2. The first queued dice's attacker (covers the case where the dice
    //      panel hasn't been promoted yet because earlier narration is still
    //      typewriting).
    //   3. An actor whose sprite is still mid-move on the Board (movingActors
    //      is fed by Board.ts via `setMovingActors`). Covers move-only turns
    //      where there's no dice to gate on — without this the bar would
    //      advance the moment `turn_started` for the next combatant arrives,
    //      typically while the sprite is still walking.
    //   4. The sticky `lastCombatActor` — the previously-active combatant,
    //      held across the brief gap between `turn_ended` and `turn_started`.
    let visibleCombatActor: string | null = null;
    if (currentDisplay?.item.kind === 'dice' && currentDisplay.item.attackerId) {
      visibleCombatActor = currentDisplay.item.attackerId;
    } else {
      for (const item of playbackQueue) {
        if (item.kind === 'dice' && item.attackerId) {
          visibleCombatActor = item.attackerId;
          break;
        }
      }
    }
    if (visibleCombatActor === null && movingActors.size > 0) {
      // Prefer the sticky last combatant if they're the one moving — keeps
      // the cursor anchored across the activeActor cleared/repopulated cycle.
      // Otherwise just pick any mover (in combat there's at most one).
      if (lastCombatActor !== null && movingActors.has(lastCombatActor)) {
        visibleCombatActor = lastCombatActor;
      } else {
        visibleCombatActor = movingActors.values().next().value ?? null;
      }
    }
    const barActor: string | null = visibleCombatActor ?? lastCombatActor;

    // Game is "loaded" once the DM has produced its first narration line. Until
    // then the "Summoning the Tale" loader holds the screen (only after the
    // hero pick — data-hero-picked — so it never flashes before the chooser
    // arrives on a fresh page load) — and the player prompt must stay hidden
    // behind it (there's nothing to talk to yet).
    const gameLoaded = latestNarration(s.chat) !== null;

    // Hero-selection is pending while EITHER the chooser overlay is already up
    // (`heroSelectActive`) OR the server's first snapshot says one is coming
    // (`s.awaitingHeroSelect`) — the latter closes the flash window between that
    // snapshot (which already carries `scene.opening`) and the later
    // `hero_select_request` that mounts the chooser. `heroSelectDone` overrides
    // both: once the player has picked, the splash must reveal even if a stale
    // snapshot still advertised the gate (EN sessions don't re-publish after
    // the pick, so the store flag lingers until the next snapshot).
    const heroSelectPending = !heroSelectDone && (heroSelectActive || s.awaitingHeroSelect);

    // Adventure-opening splash: shown over the loader at game start when the
    // scene carries an `opening` and nothing has been narrated yet. `gameLoaded`
    // in the guard means a mid-run reconnect (which replays prior narration into
    // `chat`) never re-shows it, and it auto-clears once the opening's second
    // half arrives as the first narration beat.
    const showOpeningSplash =
      !!s.scene?.opening && !openingDismissed && !gameLoaded && !s.ended
      && !heroSelectPending;

    // After the player clicks "Begin" (`openingDismissed`) the opening gate is
    // released, but the DM's first narration line is still a round-trip + LLM
    // call away (`gameLoaded` stays false). We HOLD the splash on screen — in a
    // quiet "summoning" pending state — for that window instead of unmounting
    // it: unmounting would re-expose the boot "Summoning the Tale" loader (it's
    // suppressed only while `data-opening` is set), which fades in and straight
    // back out the moment narration lands — read as a jarring flash. Keeping the
    // splash up suppresses the loader and keeps the cinematic text in place
    // until the board reveals.
    const openingPending =
      !!s.scene?.opening && openingDismissed && !gameLoaded && !s.ended
      && !heroSelectPending;
    const openingVisible = showOpeningSplash || openingPending;

    // Arm the splash typewriter once, the first time it renders. The interval
    // ticks `openingRevealChars` up at the opening's own (slower than the
    // narrator) cadence and re-renders; it clears itself (and on fast-forward /
    // dismiss) once the body is fully revealed. fake-timer unit tests advance
    // past it to see the full text.
    if (showOpeningSplash && !openingTypeStarted && s.scene?.opening) {
      openingTypeStarted = true;
      const total = openingVisibleLength(openingBefore(s.scene.opening));
      openingRevealChars = 1;
      if (total > 1) {
        openingTypeTimer = setInterval(() => {
          openingRevealChars += 1;
          if (openingRevealChars >= total) stopOpeningTypewriter();
          renderOnce();
        }, OPENING_TYPEWRITER_CHAR_MS);
      }
    }

    // The run is over the moment an `adventure_ended` event lands — which the
    // engine emits BEFORE the server's `end` envelope sets `s.ended` (and raises
    // the Victory UI banner). Treat both as "over" so the prompt never lingers
    // under the closing narration / banner during that window. Scanned from the
    // tail since `adventure_ended` is the final event.
    let runEnded = s.ended != null;
    for (let i = s.chat.length - 1; !runEnded && i >= 0; i--) {
      if ((s.chat[i]!.event as { type?: string }).type === 'adventure_ended') runEnded = true;
    }

    let playerSlot: TemplateResult | null = null;
    // The free-text Prompt (To Game / Ask DM) is ALWAYS available once the run
    // is live: the player may speak to the game or ask the DM at ANY moment,
    // even when it is not their turn — which aborts the current generation
    // server-side and processes their message. Only the turn-structured controls
    // (the combat action toolbar, the story-mode Skip) stay gated on the
    // player's own turn (`turnControlsReady`). Suppressed entirely while the
    // game is still loading or once the run has ended (loader / Victory UI).
    if (gameLoaded && !runEnded) {
      const turnControlsReady = inputReady && queueDrained;
      // Shared submit path for BOTH the Enter key and the Send button: take
      // the already-trimmed text, record the OOC echo / reset the target,
      // hand it to the server, and re-render.
      const submitPrompt = (text: string) => {
        const submittedTarget = promptTarget;
        // Echo only OOC submissions under the narrator (with a "to DM"
        // indicator). Game-target text becomes a literal `say` action and
        // already renders as a hero-speech bubble — echoing it too would
        // show the same line twice. Snapshot the at-submit reply + narration
        // text so the echo can promote to "question + reply" the moment the
        // DM answers, and clear entirely once the DM moves on with a fresh
        // in-character narration.
        if (submittedTarget === 'dm') {
          const snapshotChat = store.getSnapshot().chat;
          lastPrompt = {
            text,
            reply: null,
            oocReplyAtSubmit: latestDmOocReply(snapshotChat),
            narrationAtSubmit: latestNarration(snapshotChat),
          };
        } else {
          lastPrompt = null;
          // A message TO THE PARTY must appear immediately — ahead of any
          // narrator beats already queued. Remember it so the playback queue
          // holds promotion until this exact line arrives, then jumps it to the
          // front (see the ingestion loop + `holdForPlayerSay`). Re-arm a safety
          // release so a dropped echo can't freeze the queue.
          pendingGameSay = text;
          if (pendingGameSayTimer !== null) clearTimeout(pendingGameSayTimer);
          pendingGameSayTimer = setTimeout(() => { clearPendingGameSay(); renderOnce(); }, 4000);
        }
        // Reset to the Party (in-character) default for the next submission
        // so the picker's default selection persists across messages.
        promptTarget = 'game';
        cb.onSubmit(text, submittedTarget);
        // Skip the parked dialogue so the player's message (and the agents' /
        // DM's replies arriving behind it) surface in the narrator window
        // rather than queueing invisibly behind the beat they interrupted.
        flushDialogueForSubmit();
        renderOnce();
      };
      // Pull the live text out of an input, validate + clear it, then submit.
      // Shared by the Enter handler and the Send-button click (which has no
      // value of its own and reaches across to its sibling input).
      const submitFromInput = (input: HTMLInputElement | null | undefined) => {
        if (!input) return;
        const text = input.value.trim();
        if (text.length === 0) return;
        input.value = '';
        submitPrompt(text);
      };
      const onPromptKeydown = (e: KeyboardEvent) => {
        // ESC "leaves" the input: blur without submitting or clearing the
        // draft, handing the page hotkeys (Enter-to-focus, A-to-skip) back.
        if (e.key === 'Escape') {
          (e.target as HTMLInputElement).blur();
          return;
        }
        if (e.key !== 'Enter') return;
        submitFromInput(e.target as HTMLInputElement);
      };
      const onSendClick = (e: MouseEvent) => {
        const group = (e.currentTarget as HTMLElement).closest('.prompt-compact');
        submitFromInput(group?.querySelector<HTMLInputElement>('.prompt-input'));
      };
      const onTargetChange = (e: Event) => {
        promptTarget = (e.target as HTMLInputElement).value === 'game' ? 'game' : 'dm';
        renderOnce();
      };
      // Target picker — a radio group that lives BELOW the input bar (it used
      // to be a toggle chip welded inside the bar). Two plain radio options —
      // a circular dot + a bare text label, no caption, card, or emoji:
      // "Party" (in-character — the default selection, rendered first) and
      // "Dungeon Master" (out-of-character). The group's accessible name rides
      // on aria-label ("Say to") since the visible caption was removed. The
      // real <input type="radio"> elements are visually hidden but stay
      // keyboard-focusable; the custom dot is styled from the :checked state in
      // CSS — both options fill the same gold when selected. `data-target` on
      // each option mirrors its value for tests + CSS.
      const targetOption = (target: PromptTarget, label: string) => html`
        <label
          class=${`prompt-target-option prompt-target-option--${target} ${
            promptTarget === target ? 'is-selected' : ''
          }`}
          data-target=${target}
        >
          <input
            type="radio"
            name="prompt-target"
            value=${target}
            aria-label=${label}
            .checked=${promptTarget === target}
            @change=${onTargetChange}
          />
          <span class="prompt-target-option-face">${label}</span>
        </label>
      `;
      const targetRadios = html`
        <div class="prompt-target-radios" role="radiogroup" aria-label=${t('prompt.sayToAria')}>
          ${targetOption('game', t('prompt.party'))}
          ${targetOption('dm', t('prompt.dm'))}
        </div>
      `;
      // Story mode (not in combat): no grid actions exist, so the player
      // interacts with the DM purely through free text. Hide the action
      // buttons and the selection hint — only the Prompt input + a Skip
      // button (pass the narrative turn back to the DM without speaking)
      // are offered. Combat mode keeps the full action toolbar; the End
      // Turn button there already covers the "skip" role.
      const placeholder = promptTarget === 'dm'
        ? t('prompt.placeholderDm')
        : t('prompt.placeholderGame');
      const inputEl = html`
        <input
          class=${`prompt-input prompt-input--${promptTarget}`}
          type="text"
          placeholder=${placeholder}
          data-target=${promptTarget}
          @keydown=${onPromptKeydown}
        />
      `;
      // Send button — the right segment of the welded control, the mouse
      // counterpart to pressing Enter. It carries no value itself, so its
      // click reaches across to the sibling input. Shown ONLY when the input
      // holds text: the CSS rule
      //   .prompt-input:not(:placeholder-shown) ~ .prompt-send
      // flips it in as soon as the first character is typed and out again the
      // moment the field is cleared — no per-keystroke re-render. It always
      // wears the forge-orange act-btn-active face (regardless of target) so
      // Send reads as one consistent affordance.
      const sendButton = html`
        <button
          class="prompt-send act-btn act-btn-active"
          type="button"
          data-target=${promptTarget}
          aria-label=${promptTarget === 'dm'
            ? t('prompt.sendDmAria')
            : t('prompt.sendGameAria')}
          title=${t('prompt.sendTitle')}
          @click=${onSendClick}
        >➤</button>
      `;
      // The input + send form a Space.compact group: a single 1px seam, the
      // send button welded to the input's right edge. The input flexes to
      // fill the bar; the send button only appears once the field holds text.
      const compactGroup = html`
        <div class="prompt-compact">
          ${inputEl}
          ${sendButton}
        </div>
      `;
      const promptPanel = s.inCombat
        ? html`
          <div class="prompt-panel" role="group" aria-label=${t('prompt.panelAria')}>
            ${compactGroup}
            ${targetRadios}
          </div>
        `
        : html`
          <div class="prompt-panel" role="group" aria-label=${t('prompt.panelAria')}>
            <div class="prompt-row">
              ${compactGroup}
              ${turnControlsReady
                ? html`<button
                    class="act-btn prompt-skip"
                    type="button"
                    aria-label=${t('prompt.skipAria')}
                    @click=${() => dispatchAction({ kind: 'skip_turn' })}
                  >${t('prompt.skip')}</button>`
                : ''}
            </div>
            ${targetRadios}
          </div>
        `;
      playerSlot = s.inCombat
        ? html`
          ${turnControlsReady
            ? html`
              <div class="action-hint" role="status">${hint}</div>
              ${actionButtons({
                mode: selectionMode,
                onMode: setMode,
                onEndTurn: () => dispatchAction({ kind: 'skip_turn' }),
                canMove: !s.hasMoved,
                canAct:  !s.hasActed,
              })}
            `
            : ''}
          ${promptPanel}
        `
        : html`${promptPanel}`;
    }

    // Dialog playback controls: two bare icon buttons aligned to the
    // right edge of the narrator window. Skip advances the current
    // narration / hero-speech beat (or completes its typewriter). Auto
    // toggles auto-advance mode. Both render whenever a dialog beat is
    // on screen OR auto is enabled (so the user can always toggle it
    // back to manual). Skip is hidden in auto mode — the queue is
    // advancing on its own there, so a manual pill would be confusing.
    //
    // The glyphs are inline pixel-art SVGs drawn on a 14×14 grid with
    // stepped diagonals + crisp-edges rendering, so they read in the same
    // visual language as the "Press Start 2P" / "Jersey 10" pixel
    // typography elsewhere on screen. Skip = stepped right-pointing
    // triangle + vertical bar (advance-one). Auto = two stepped triangles
    // back-to-back (advance-continuously).
    const skipIconSvg = html`
      <svg viewBox="0 0 14 14" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
        <path d="M3 2 h1 v1 h1 v1 h1 v1 h1 v1 h1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 Z"/>
        <rect x="9" y="2" width="2" height="9"/>
      </svg>
    `;
    const autoIconSvg = html`
      <svg viewBox="0 0 14 14" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
        <path d="M2 2 h1 v1 h1 v1 h1 v1 h1 v1 h1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 Z"/>
        <path d="M7 2 h1 v1 h1 v1 h1 v1 h1 v1 h1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 Z"/>
      </svg>
    `;
    const dialogBeatShowing =
      currentDisplay !== null
      && (currentDisplay.item.kind === 'narration'
          || currentDisplay.item.kind === 'hero-speech');
    // The Order-of-Battle plaque adopts the same Skip/Auto dialog
    // controls as a narration beat: while it's on screen and not yet
    // dismissing, Skip kicks off the closing fade-out and Auto arms the
    // BATTLE_ORDER_REVEAL_MS-sized auto-dismiss timer.
    const orderRevealSkippable =
      initiativeUiPhase === 'order-reveal'
      && orderRevealSummary !== null
      && !orderRevealDismissing;
    const skipTargetShowing = dialogBeatShowing || orderRevealSkippable;
    // BOTH buttons always render (user decision) — a constant pair of
    // controls beats pills that blink in and out, and the keycap hotkey
    // hints (A / S) stay discoverable at all times. The row container was
    // already permanent: its reserved min-height (main.css) keeps the
    // narrator window's flow height constant so the board above never
    // shifts. With nothing to skip, the Skip button dims to an inert state
    // (`--inert`) — its click handler is naturally a no-op then. The Auto
    // toggle is never inert: flipping the mode is meaningful even between
    // beats. Both flash a gold tint on activation (`flashDialogButton`),
    // so a hotkey press gives the same visual acknowledgement as a click.
    const dialogSkipSlot: TemplateResult = html`
      <div class="dialog-skip-row">
        <button
          class=${skipTargetShowing ? 'dialog-skip' : 'dialog-skip dialog-skip--inert'}
          type="button"
          aria-label=${t('dialog.skipAria')}
          aria-disabled=${skipTargetShowing ? 'false' : 'true'}
          @click=${(e: Event) => { flashDialogButton(e); onDialogSkipClick(); }}
        >${skipIconSvg}<span class="dialog-key-hint" aria-hidden="true">A</span></button>
        <button
          class=${autoSkipEnabled ? 'dialog-auto dialog-auto--on' : 'dialog-auto'}
          type="button"
          aria-label=${autoSkipEnabled
            ? t('dialog.autoOnAria')
            : t('dialog.autoOffAria')}
          aria-pressed=${autoSkipEnabled ? 'true' : 'false'}
          @click=${(e: Event) => { flashDialogButton(e); onAutoToggleClick(); }}
        >${autoIconSvg}<span class="dialog-key-hint" aria-hidden="true">S</span></button>
      </div>
    `;

    // OOC margin note: the player's question + the DM's reply, pinned to the
    // left edge in `.dm-aside`. Driven by the same `lastPrompt` lifecycle that
    // used to feed the in-narrator echo (populated on a DM-target submit,
    // `.reply` filled when the `dm_ooc_reply` lands, cleared on fresh
    // narration). Suppressed once the run ends, mirroring the narrator window
    // being dropped under the Victory UI.
    const dmAsidePayload: DmAsidePayload | null =
      lastPrompt === null || runEnded
        ? null
        : { question: lastPrompt.text, reply: lastPrompt.reply };

    const activity = deriveActivity(s, actors);
    // `gameLoaded` (computed above) also drives the board reveal: until the DM's
    // first narration lands we hide the board so viewers see only the engine
    // loader — boots/manifest/scene all arrive before the opening line, and a
    // bare empty map flickering before the story starts reads as broken.
    const tpl: TemplateResult = html`
      <main
        class="app"
        aria-label=${t('layout.gameAria')}
        data-event-log=${eventLogOpen ? 'open' : 'closed'}
        data-loaded=${gameLoaded ? 'true' : 'false'}
        data-queued=${s.queued ? 'true' : nothing}
        data-hero-select=${heroSelectActive ? 'true' : nothing}
        data-hero-picked=${heroSelectDone ? 'true' : nothing}
        data-opening=${openingVisible ? 'true' : nothing}
        data-mode=${s.inCombat ? 'combat' : 'story'}
        data-ended=${s.ended ? s.ended.outcome : nothing}
      >
        ${engineLoader({ activity })}
        <!--
          Centered "the game is loading" panel. Always rendered so it can fade
          out smoothly on the data-loaded flip; CSS shows it only after the
          hero pick (data-hero-picked) and hides it under
          .app[data-loaded="true"]. Mirrors the wood-and-gold visual language
          of the board frame: gold pixel-font title flanked by hairline rules
          with a diamond pip, italic sub-line with marching-dot animation.
        -->
        <div class="game-loading" role="status" aria-live="polite">
          <div class="game-loading-rule" aria-hidden="true">
            <span class="rule-line"></span>
            <span class="rule-pip">◆</span>
            <span class="rule-line"></span>
          </div>
          <h2 class="game-loading-title">${t('boot.title')}</h2>
          <p class="game-loading-sub">
            ${t('boot.sub')}<span class="game-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
          </p>
          <div class="game-loading-rule" aria-hidden="true">
            <span class="rule-line"></span>
            <span class="rule-pip">◆</span>
            <span class="rule-line"></span>
          </div>
        </div>
        <!--
          Session-queue window — shown while the server holds this tab in the
          wait line for a free game slot (store.queued). The data-queued flag
          above hides the boot loader AND the top status banner via CSS, so
          this centered window is the whole story until the slot frees; the
          attach snapshot (session admitted) clears store.queued and the
          normal boot flow resumes.
        -->
        ${s.queued ? queueWindow(s.queued) : ''}
        <!--
          Session-gone window — the server refused this tab's reattach (its
          game no longer exists: restart / idle reap) and ws-client stopped
          reconnecting. Sits above every other screen because a stale hero
          select / splash / board may still be on display; its Reload button
          makes a fresh claim.
        -->
        ${s.sessionGone ? sessionGoneWindow() : ''}
        <!--
          Adventure-opening title splash — covers the loader + (hidden) board at
          game start, holding the screen on the scene's opening box text until
          the player clicks "Begin". Dismissing it releases the server's
          first-turn gate; the opening's second half then arrives as the first
          narration beat (revealing the board + filling the narrator window).
        -->
        ${openingVisible && s.scene?.opening
          ? openingSplash(
              openingBefore(s.scene.opening),
              openingCast(s.scene.opening.cast ?? []),
              openingRevealChars,
              dismissOpeningSplash,
              fastForwardOpening,
              openingPending,
            )
          : ''}
        <div class="game-area">
          <div class="board-row">
            <div class="board-column">
              ${initiativeQueued || initiativeRolling || showOrderReveal
                ? html``
                : turnOrderBar(selectTurnOrder(
                    s.chat,
                    s.characters,
                    // `barActor` paces the cursor with the playback
                    // queue: it holds on the previous combatant
                    // whenever a dice panel for them is still queued
                    // or visible. When no dice is in flight it falls
                    // back to the sticky `lastCombatActor`, which
                    // itself covers the brief gap between `turn_ended`
                    // and `turn_started`.
                    barActor,
                  ))}
              <div class="board-stage">
                <section
                  id="board"
                  class="board"
                  role="region"
                  aria-label=${t('layout.boardAria')}
                ></section>
                <!--
                  Dice rolls (attack/ability) and initiative rolls render
                  entirely through the 3D overlay (Dice3DOverlay) — the
                  former 2D portrait + dice-strip + verdict panel has been
                  removed. The on-board HIT/MISS flashRoll popover (driven
                  by Board.ts) and the turn-order ribbon still carry the
                  outcome-readout role.
                -->
                ${showCombatBeginsSplash ? combatBeginsSplash() : ''}
                ${showOrderReveal ? battleOrderReveal(orderRevealSummary, orderRevealDismissing, orderRevealPositions) : ''}
                ${passiveBanner && !s.ended ? passiveTriggerBanner(passiveBanner, passiveBannerDismissing) : ''}
                ${s.ended
                  ? s.ended.outcome === 'failure' && s.ended.reason === 'party_wipe'
                    ? gameOverScreen(
                        s.characters
                          .filter((c) => c.kind === 'hero')
                          .map((c) => displayName(c.name)),
                      )
                    : endingBanner(s.ended.outcome)
                  : ''}
              </div>
              <!--
                Once the run ends the ending banner (VICTORY UI) is the whole
                closing screen — drop the narrator window so no leftover DM
                narration or hero/NPC speech text sits beneath it. The
                board-anchored emote balloons live inside #board, so they are
                already hidden by the data-ended board fade above.
              -->
              ${s.ended
                ? ''
                : narratorWindow(
                    // Dock the player UI to the BOTTOM of the reserved narrator
                    // window (CSS .player-dock { margin-top: auto }) so the
                    // prompt holds a fixed Y: the slack in the reserved height
                    // pools ABOVE the prompt, so a growing/shrinking narration
                    // line eats the gap instead of sliding the prompt up/down.
                    playerSlot === null
                      ? null
                      : html`<div class="player-dock">${playerSlot}</div>`,
                    // The OOC echo moved OUT of the narrator stack into the
                    // left-margin `.dm-aside` (rendered in the .app shell
                    // below), so the in-character narration is never
                    // overwritten by a DM side-answer.
                    null,
                    visibleHeroSpeeches,
                    null,
                    dialogSkipSlot,
                  )}
            </div>
          </div>
        </div>
        <!--
          DM's Aside — the OOC question/answer thread, pinned to the LEFT
          viewport margin (the meta mirror of the right-side Event Log). It's
          position:fixed, so its place in DOM order here is purely for stacking
          + reading order; it never participates in the board/narrator layout
          and so can never overwrite the in-fiction narration below the board.
        -->
        ${dmAside(dmAsidePayload, () => {
          // Manual dismiss: retire the OOC thread from the foreground now,
          // rather than waiting for the next narration to auto-clear it. The
          // Q&A persists in the Event Log, so this only hides the spotlight.
          lastPrompt = null;
          renderOnce();
        })}
        ${eventLogOpen ? '' : html`
          <button
            class="event-log-toggle"
            type="button"
            aria-expanded="false"
            aria-controls="event-log-drawer"
            aria-label=${t('log.open')}
            @click=${toggleEventLog}
          >
            <span class="event-log-toggle-icon" aria-hidden="true">📜</span>
            <span class="event-log-toggle-label">${t('log.label')}</span>
          </button>
          <!-- Playtest survey — same stamped-iron button language as the Log
               toggle, parked directly below it. Hidden (with the Log button)
               while the drawer is open so the drawer edge stays clean. -->
          <button
            class="event-log-toggle survey-toggle"
            type="button"
            aria-haspopup="dialog"
            aria-label=${t('survey.openAria')}
            @click=${toggleSurvey}
          >
            <span class="event-log-toggle-icon" aria-hidden="true">📋</span>
            <span class="event-log-toggle-label">${t('survey.label')}</span>
          </button>
        `}
        <aside
          id="event-log-drawer"
          class=${eventLogOpen ? 'event-log-drawer open' : 'event-log-drawer'}
          aria-hidden=${eventLogOpen ? 'false' : 'true'}
        >
          <button
            class="event-log-close"
            type="button"
            aria-label=${t('log.close')}
            @click=${toggleEventLog}
          >✕</button>
          ${eventLog(selectEventLog(s.chat, s.characters))}
        </aside>
        ${surveyOpen
          ? surveyModal(surveyForm, {
              onClose: toggleSurvey,
              requestRender: renderOnce,
              ...(cb.onSurveySubmit ? { onSubmit: submitSurvey } : {}),
              ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            })
          : ''}
      </main>
    `;
    render(tpl, root);

    const narratorTextEl = root.querySelector('.narrator-text');
    if (narratorTextEl instanceof HTMLElement) {
      // AutoSkip on → paint text instantly (no fade/typewriter).
      updateNarratorText(narratorTextEl, visibleNarrationText, (busy) => {
        if (narratorBusy === busy) return;
        narratorBusy = busy;
        renderOnce();
      }, autoSkipEnabled);
    }
    // Run the hero-speech typewriter painter in the same frame as the
    // bubble's first appearance — the `.hero-text` span is rendered with
    // an empty body, so this is its only source of content. AutoSkip on →
    // each bubble is written in full at once.
    paintHeroSpeeches(root, autoSkipEnabled);

    pushSelection();

    const eventScroll = root.querySelector('.event-log-scroll');
    if (eventScroll) eventScroll.scrollTop = 0;
  };
  // Global hotkey: a bare Enter from anywhere on the page snaps focus to the
  // free-text Prompt input, so the player can start typing without first
  // clicking the bar. Listens on `window` because the most common starting
  // point — nothing focused — targets <body>, which a `root`-scoped listener
  // would never see (events don't propagate down into root). We deliberately
  // do NOT submit here: this only parks the cursor; the input's own Enter
  // handler (`onPromptKeydown`) does the submit on the next press. ESC in
  // the input is the inverse — it blurs the field, putting this hotkey
  // (and A-to-skip) back in service.
  const onGlobalEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    // Plain Enter only — leave Ctrl/Meta/Alt/Shift+Enter free for other use.
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Stale listener guard: in tests several Layouts mount against detached
    // roots; only the one still in the document should act on the hotkey.
    if (!root.isConnected) return;
    // Don't hijack Enter that an interactive/editable element is already
    // handling itself — the prompt input's own submit, a focused button's
    // activation, a radio toggle, etc.
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        tag === 'BUTTON' || tag === 'A' || target.isContentEditable
      ) {
        return;
      }
    }
    const input = root.querySelector<HTMLInputElement>('.prompt-input');
    if (!input || input.disabled) return;
    e.preventDefault();
    input.focus();
  };
  window.addEventListener('keydown', onGlobalEnter);

  // Global dialogue hotkeys: a bare "A" clicks the in-narrator Skip button,
  // a bare "S" clicks the Auto toggle — both advertised by the keycap hints
  // rendered under the buttons. Routing through the BUTTONS (not the click
  // handlers directly) keeps each key's effect byte-identical to a click —
  // including the tint flash. The selectors are row-scoped so the opening
  // splash's Skip/Begin control (which reuses the `.dialog-skip` glyph
  // class) is never hotkey-driven.
  const onGlobalDialogKey = (e: KeyboardEvent) => {
    const sel =
      e.key === 'a' || e.key === 'A' ? '.dialog-skip-row .dialog-skip'
      : e.key === 's' || e.key === 'S' ? '.dialog-skip-row .dialog-auto'
      : null;
    if (sel === null) return;
    // Bare key only — Cmd/Ctrl+A is select-all, Alt+letter may compose a
    // glyph. Shift is allowed: a shifted letter is still just that letter.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Stale listener guard (see onGlobalEnter).
    if (!root.isConnected) return;
    // Typing into the prompt input — or any other editable element, e.g.
    // the survey modal's free-text fields — must never trigger a control.
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
        return;
      }
    }
    const btn = root.querySelector<HTMLButtonElement>(sel);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  };
  window.addEventListener('keydown', onGlobalDialogKey);

  // Dialogue-reference hover bridge. Delegated on `root` (a stable ancestor of
  // every dialogue surface — narrator, hero-speech bubbles, event log, DM's
  // aside) so it survives lit-html re-renders and the narrator's imperative
  // innerHTML re-paints. `mouseover` / `mouseout` bubble, so a single pair of
  // listeners catches every `.dlg-ref` chip. The chip itself sets
  // `pointer-events: auto`, so it receives events even inside the otherwise
  // click-through narrator window.
  const onRefMouseOver = (e: MouseEvent): void => {
    const chip = (e.target as Element | null)?.closest?.('[data-ref-kind]');
    if (!(chip instanceof HTMLElement)) return;
    const target = refTargetFromElement(chip);
    if (target) cb.onRefHover?.(target);
  };
  const onRefMouseOut = (e: MouseEvent): void => {
    const chip = (e.target as Element | null)?.closest?.('[data-ref-kind]');
    if (!(chip instanceof HTMLElement)) return;
    // Ignore moves that stay inside the same chip (e.g. between its child text
    // nodes); only clear when the pointer actually leaves it.
    const to = e.relatedTarget as Node | null;
    if (to && chip.contains(to)) return;
    cb.onRefHover?.(null);
  };
  root.addEventListener('mouseover', onRefMouseOver);
  root.addEventListener('mouseout', onRefMouseOut);

  store.subscribe(renderOnce);
  // Re-render on a game-language switch (the EN/PT toggle on the hero-select
  // screen) so the chrome behind the chooser — boot loader, status banner —
  // flips language immediately instead of on the next store event.
  onLanguageChange(() => renderOnce());
  renderOnce();

  const setMovingActors: LayoutHandle['setMovingActors'] = (actorIds) => {
    // Only re-render when the set actually changed. Board fires this on
    // every animation start/end; if Layout subscribed to that signal
    // unconditionally it would rerender twice per move with no visible
    // delta when no combatant is actually mid-move.
    if (actorIds.size === movingActors.size) {
      let same = true;
      for (const id of actorIds) {
        if (!movingActors.has(id)) { same = false; break; }
      }
      if (same) return;
    }
    movingActors = actorIds;
    renderOnce();
  };

  const setAutoSkip: LayoutHandle['setAutoSkip'] = (enabled) => {
    if (autoSkipEnabled === enabled) return;
    autoSkipEnabled = enabled;
    // Flipping ON mid-reveal: snap the current line to its finished text
    // (mirrors onAutoToggleClick).
    if (autoSkipEnabled) completeAllTypewriters();
    // Mirror onAutoToggleClick: when the plaque is up, flipping ON
    // arms the auto-dismiss timer; flipping OFF cancels any pending
    // auto-dismiss so the plaque waits for an explicit Skip click.
    if (initiativeUiPhase === 'order-reveal' && !orderRevealDismissing) {
      if (autoSkipEnabled) {
        const now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        armOrderRevealAutoDismiss(now);
      } else if (orderRevealAutoDismissTimer !== null) {
        clearTimeout(orderRevealAutoDismissTimer);
        orderRevealAutoDismissTimer = null;
      }
    }
    renderOnce();
  };

  const setOrderRevealPositions: LayoutHandle['setOrderRevealPositions'] = (positions) => {
    orderRevealPositions = positions;
    // The host calls this just before `settle()` flips into the order-reveal
    // phase, so the next render already has the anchors. Re-render anyway in
    // case positions arrive while the reveal is already mounted (e.g. a future
    // resize/re-project), so the badges snap onto their dice immediately.
    renderOnce();
  };

  const setHeroSelectActive: LayoutHandle['setHeroSelectActive'] = (active) => {
    if (heroSelectActive === active) return;
    if (heroSelectActive && !active) heroSelectDone = true;
    heroSelectActive = active;
    if (active) {
      // The server publishes the first snapshot (carrying `scene.opening`) JUST
      // before the hero-select gate, so the splash has very likely already armed
      // its typewriter by the time this fires. Tear it down and reset, so the
      // reveal re-arms from char 0 when the chooser is dismissed — i.e. types
      // out ON SCREEN, not silently to completion behind the overlay.
      stopOpeningTypewriter();
      openingTypeStarted = false;
      openingRevealChars = 0;
    }
    // Re-render so the splash hides while the chooser is up, then reappears (and
    // re-arms its typewriter from the start) the instant the chooser clears.
    renderOnce();
  };

  return {
    handleCanvasClick,
    handleCanvasRightClick,
    refreshSelection: pushSelection,
    setMovingActors,
    setAutoSkip,
    setHeroSelectActive,
    setOrderRevealPositions,
  };
};
