import type { Character } from '../../engine/character.js';
import type { Adventure, Scene } from '../../engine/adventure.js';
import type { EmojiProp } from '../../engine/snapshot.js';
import type { Event } from '../../log/events.js';
import type { AnthropicMessage, PromptSegment } from '../llm/llm-client.js';
import { renderPlayerSystem } from './templates/player-system.js';
import { renderDmSystem } from './templates/dm-system.js';
import { renderPlayerStateBlock, renderDmStateBlock } from './templates/state-block.js';
import { resolveLocalized, type GameLanguage, type Localized } from '../language.js';

export type Observation =
  | { kind: 'fresh_turn' }
  | { kind: 'rule_violation'; reason: string }
  | { kind: 'public_resolution'; summary: string }
  | { kind: 'between_turns'; summary: string }
  /** DM-only: it is a monster's combat turn and the DM must act for it. */
  | { kind: 'control_combatant'; actorId: string };

export interface BuildPlayerArgs {
  character: Character;
  /** Other heroes on the board — rendered as the live PARTY block so this hero
   *  can coordinate (cover the wounded, flank to engage, divide the work). */
  party?: ReadonlyArray<Character>;
  /** Foes on the board — rendered as the live FOES block (HP/pos) so this hero
   *  can focus-fire and read who is about to gang up. */
  foes?: ReadonlyArray<Character>;
  /** Persona markdown; may carry a pt variant resolved by the builder's language. */
  persona: Localized;
  /** Pre-rendered party roster; may carry a pt variant (the hero names differ
   *  in a pt session) resolved by the builder's language. */
  partyDescription: Localized;
  adventure: Adventure;
  activeScene: Scene;
  /** Visibility-filtered events for this player. */
  history: Event[];
  observation: Observation;
  /** 0-based index of the current turn within the run. Used for snapshot partition. */
  currentTurnIdx: number;
  /** Current DM-spawned emoji props on the grid (always public). */
  props?: ReadonlyArray<EmojiProp>;
  /** Live obstacles on the grid (type, pos, durability, attack-proof/pushable
   *  flags) so the player knows what is breakable, what is an attack-proof wall,
   *  and what they can shove. From `engine.activeSceneObstacles()`. */
  obstacles?: ReadonlyArray<{ type: string; x: number; y: number; durability?: number; remaining?: number; explosive?: boolean; cover?: boolean; attackProof?: boolean; pushable?: boolean }>;
}

export interface BuildDmArgs {
  party: Character[];
  monstersInScene: Character[];
  /** Persona markdown; may carry a pt variant resolved by the builder's language. */
  persona: Localized;
  adventure: Adventure;
  activeScene: Scene;
  history: Event[];
  observation: Observation;
  currentTurnIdx: number;
  /** Current DM-spawned emoji props on the grid. */
  props?: ReadonlyArray<EmojiProp>;
  /** True when the browser UI is rendering this scene's opening itself, so the
   *  DM should skip narrating the intro (see {@link DmSystemContext.uiShowsIntro}). */
  uiShowsIntro?: boolean;
}

export interface BuiltPrompt {
  system: PromptSegment[];
  messages: AnthropicMessage[];
}

export interface PromptBuilderConfig {
  snapshotEveryTurns: number;
  /**
   * Game language for agent-visible text: `'pt'` injects a LANGUAGE directive
   * into every system prompt so the DM narrates and the heroes speak Brazilian
   * Portuguese. Defaults to `'en'` (no directive — prompts unchanged).
   */
  language?: GameLanguage;
}

const formatEventLine = (e: Event): string =>
  `[t=${e.t}] ${JSON.stringify({ ...e, t: undefined })}`;

export class PromptBuilder {
  private language: GameLanguage;

  constructor(private readonly cfg: PromptBuilderConfig) {
    this.language = cfg.language ?? 'en';
  }

  /**
   * Switch the game language. Called once when the player picks a language on
   * the hero-select screen — which gates BEFORE the first LLM call, so the
   * system band stays byte-stable across every call of the run and prompt
   * caching is unaffected.
   */
  setLanguage(language: GameLanguage): void {
    this.language = language;
  }

  buildPlayer(args: BuildPlayerArgs): BuiltPrompt {
    const systemText = renderPlayerSystem({
      character: args.character,
      persona: resolveLocalized(args.persona, this.language),
      partyDescription: resolveLocalized(args.partyDescription, this.language),
      language: this.language,
    });
    const stateBlock = renderPlayerStateBlock({
      character: args.character,
      ...(args.party && { party: args.party }),
      ...(args.foes && { foes: args.foes }),
      ...(args.props && { props: args.props }),
      ...(args.obstacles && { obstacles: args.obstacles }),
    });
    return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx, stateBlock);
  }

  buildDm(args: BuildDmArgs): BuiltPrompt {
    // `uiShowsIntro` flips the dm-system template from "INTRO (read or
    // paraphrase faithfully on entry)" to "OPENING (already on screen — do NOT
    // narrate it)" — the browser splash + the engine-emitted `opening.after`
    // narration already showed the player the intro, so the DM re-narrating it
    // would duplicate it under the revealed board. Only set when the UI renders
    // openings AND the active scene has one (see Agent's buildDm call).
    const systemText = renderDmSystem({
      adventure: args.adventure,
      activeScene: args.activeScene,
      party: args.party,
      monstersInScene: args.monstersInScene,
      persona: resolveLocalized(args.persona, this.language),
      language: this.language,
      ...(args.uiShowsIntro ? { uiShowsIntro: true } : {}),
    });
    const stateBlock = renderDmStateBlock({
      party: args.party,
      monstersInScene: args.monstersInScene,
      ...(args.props && { props: args.props }),
    });
    return this.assemble(systemText, args.history, args.observation, args.currentTurnIdx, stateBlock);
  }

  private assemble(
    systemText: string,
    history: Event[],
    observation: Observation,
    currentTurnIdx: number,
    stateBlock: string,
  ): BuiltPrompt {
    // Band 1: system (always cacheable)
    const system: PromptSegment[] = [{ text: systemText, cacheable: true }];

    // Band 2 boundary: snapshot point at every K turns. snapshotIdx = floor(currentTurnIdx / K) * K.
    const k = this.cfg.snapshotEveryTurns;
    const snapshotTurnIdx = Math.floor(currentTurnIdx / k) * k;

    // Partition history events into prefix (up to snapshot) and tail (after snapshot).
    // For Layer B simplicity, "snapshotTurnIdx" maps to event index by counting `request_action`
    // events (each marks a new turn). Approximation: split events at the first event whose
    // implicit turn index >= snapshotTurnIdx.
    const turnBoundaries: number[] = []; // event indices where a new turn begins
    history.forEach((ev, idx) => {
      if (ev.type === 'request_action') {
        turnBoundaries.push(idx);
      }
    });

    const splitIdx = (() => {
      if (snapshotTurnIdx === 0) return 0;
      if (turnBoundaries.length > 0) {
        return turnBoundaries[Math.min(snapshotTurnIdx, turnBoundaries.length) - 1] ?? 0;
      }
      // No request_action markers: fall back to raw event-index partition.
      return Math.min(snapshotTurnIdx, history.length);
    })();

    // Band 2 drops `thought` events. An agent's own thinking summaries are by
    // far the dominant history growth term (measured 85% of event chars in a
    // live run) and re-sending EVERY past thought every call paid thousands of
    // input tokens for stale deliberation. Old thoughts (past the snapshot
    // boundary) add nothing the action/resolution record doesn't already say;
    // RECENT thoughts — the volatile tail below, bounded by the snapshot
    // window — are kept for plan continuity ("I was moving to smash the
    // rubble"). Dropping only from the frozen prefix keeps the band's text
    // STABLE across calls, so prompt caching is unaffected. The full thought
    // record still lives in events.jsonl for replay/audit.
    const prefix = history.slice(0, splitIdx).filter((ev) => ev.type !== 'thought');
    const tail   = history.slice(splitIdx);

    const messages: AnthropicMessage[] = [];

    // Cacheable history snapshot (band 2).
    if (prefix.length > 0) {
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `History (cached snapshot, t=${prefix[0]!.t}..${prefix[prefix.length - 1]!.t}):\n` +
                prefix.map(formatEventLine).join('\n'),
          cacheable: true,
        }],
      });
    }

    // Uncacheable tail + observation (band 3).
    const tailLines = tail.map(formatEventLine).join('\n');
    const obsLine = (() => {
      switch (observation.kind) {
        case 'fresh_turn':         return 'It is your turn. Take your first reasoning step.';
        case 'rule_violation':     return `Rule violation: ${observation.reason}. Choose another action.`;
        case 'public_resolution':  return `Result of your last action: ${observation.summary}. Continue your turn.`;
        case 'between_turns':      return `Between turns: ${observation.summary}`;
        case 'control_combatant':  return `It is ${observation.actorId}'s turn in combat — and YOU control this monster. `
          + `Act for ${observation.actorId} only: move it toward the heroes and attack (use its special ability if better), `
          + `narrate the action in one vivid sentence, then call monster_action with end_turn. Do NOT act for any other monster.`;
      }
    })();

    const tailText = `${stateBlock}\n\n` +
      (tail.length > 0 ? `Recent events:\n${tailLines}\n\n` : '') +
      obsLine;

    messages.push({
      role: 'user',
      content: [{ type: 'text', text: tailText, cacheable: false }],
    });

    return { system, messages };
  }
}
