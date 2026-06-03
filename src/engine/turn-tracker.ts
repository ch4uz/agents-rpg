import type { Dice } from './dice.js';
import type { CharacterId } from './ids.js';

export type TurnPhase = 'narrative' | 'combat';
export type Side = 'hero' | 'monster';

/** Per-character initiative result: raw d6, dex modifier, and the total
 *  (d6 + dex) that drives turn order. */
export interface InitiativeRoll {
  d6: number;
  dex: number;
  total: number;
}

/** Map of characterId → initiative result, keyed by string for serialisability. */
export type InitiativeRolls = Record<string, InitiativeRoll>;

/**
 * Optional pre-rolled d6 face values for initiative. Parallel to the
 * `heroSide` / `monsterSide` arrays passed to `startCombat` — element `i`
 * of `hero` is the d6 for `heroSide[i]`. When present, the engine uses
 * these verbatim instead of asking `dice` to roll. Used when the client's
 * 3D physics is authoritative for the visible initiative dice.
 *
 * Arrays MUST match the lengths of the corresponding side arrays.
 */
export interface ProvidedInitiativeRolls {
  hero: readonly number[];
  monster: readonly number[];
}

export interface CombatOrder {
  heroSide: CharacterId[];
  monsterSide: CharacterId[];
  /** Combined turn order, sorted by the rolled d6 descending — highest die
   *  acts first, regardless of side, so an enemy genuinely can land between
   *  two heroes. `dex` is recorded in `rolls` but does NOT affect the order.
   *  Ties on the die fall back to declaration order to keep the result
   *  deterministic given the same dice seed. */
  order: CharacterId[];
  /** Index into `order`. */
  cursor: number;
  /** Per-character initiative results, keyed by hero/monster side for audit. */
  rolls: { hero: InitiativeRolls; monster: InitiativeRolls };
}

export class TurnTracker {
  phase: TurnPhase = 'narrative';
  combatOrder: CombatOrder | null = null;
  /**
   * 1-based combat round counter. `0` out of combat; set to `1` when combat
   * starts; incremented each time `advance` wraps the cursor back past the
   * start of the initiative order (one full cycle = one round). Drives
   * scene-scripted monster focus — the orchestrator gates the deterministic
   * monster planner's fixate-on-target behaviour on this value (see
   * `GameEngine.activeMonsterFocus`). Not used by replay (which replays the
   * recorded actions), so this stays a pure orchestration-time signal.
   */
  roundNumber = 0;
  /** Out-of-combat: null (DM picks via request_action). In combat: derived from order. */
  private narrativeActor: CharacterId | null = null;
  /** Per-turn flags reset every time the active actor changes. Used by
   *  GameEngine to enforce HeroKids' 1-move + 1-main-action per turn rule. */
  private turnFlags: { moved: boolean; acted: boolean } = { moved: false, acted: false };

  get activeActorId(): CharacterId | null {
    if (this.phase === 'narrative') return this.narrativeActor;
    if (!this.combatOrder) return null;
    return this.combatOrder.order[this.combatOrder.cursor] ?? null;
  }

  hasMoved(): boolean { return this.turnFlags.moved; }
  hasActed(): boolean { return this.turnFlags.acted; }
  markMoved(): void { this.turnFlags.moved = true; }
  markActed(): void { this.turnFlags.acted = true; }
  private resetTurnFlags(): void { this.turnFlags = { moved: false, acted: false }; }

  setNarrativeActor(id: CharacterId | null): void {
    this.narrativeActor = id;
    this.resetTurnFlags();
  }

  /**
   * Roll initiative for every combatant and build a single interleaved turn
   * order. Each character rolls 1d6. The combined order is sorted by that
   * rolled die descending — highest die acts first, with no side bias — so
   * the turn order matches the dice the player watches settle. The `dex`
   * modifier (looked up via `dexFor`, defaulting to 0) is still recorded in
   * `rolls` as `total = d6 + dex` for the audit breakdown, but it does NOT
   * influence the order. Ties on the die keep declaration order so the
   * result is deterministic given the same dice seed and inputs.
   */
  startCombat(
    dice: Dice,
    heroSide: CharacterId[],
    monsterSide: CharacterId[],
    dexFor: (id: CharacterId) => number = () => 0,
    provided?: ProvidedInitiativeRolls,
  ): {
    order: CharacterId[];
    rolls: { hero: InitiativeRolls; monster: InitiativeRolls };
  } {
    const heroRolls: InitiativeRolls = {};
    const monsterRolls: InitiativeRolls = {};

    // Each entry remembers its raw d6 and a globalIdx — the latter is the
    // position the character was registered in (heroes then monsters), used
    // only as the final deterministic fallback when both total and d6 are
    // tied.
    type Entry = {
      id: CharacterId;
      side: Side;
      total: number;
      d6: number;
      globalIdx: number;
    };
    const entries: Entry[] = [];

    for (let i = 0; i < heroSide.length; i++) {
      const id = heroSide[i]!;
      const d6 = provided ? provided.hero[i]! : dice.rollD6();
      const dex = dexFor(id);
      const total = d6 + dex;
      heroRolls[String(id)] = { d6, dex, total };
      entries.push({
        id, side: 'hero', total, d6,
        globalIdx: entries.length,
      });
    }
    for (let i = 0; i < monsterSide.length; i++) {
      const id = monsterSide[i]!;
      const d6 = provided ? provided.monster[i]! : dice.rollD6();
      const dex = dexFor(id);
      const total = d6 + dex;
      monsterRolls[String(id)] = { d6, dex, total };
      entries.push({
        id, side: 'monster', total, d6,
        globalIdx: entries.length,
      });
    }

    entries.sort((a, b) => {
      // Turn order is decided by the rolled d6 ALONE — highest die acts
      // first (HeroKids: initiative is a plain 1d6). `dex` is still recorded
      // in `rolls` for the audit breakdown, but it must NOT bias the order:
      // when it did (sorting by d6+dex total), a high-DEX hero led the line
      // despite a visibly lower die, which reads as a hard-coded "heroes
      // first" and makes the order look disconnected from the dice on screen.
      if (b.d6 !== a.d6) return b.d6 - a.d6;
      // Tie on the die: declaration order is the deterministic fallback so
      // the result is reproducible given the same dice seed. No side bias —
      // whoever was listed first in heroSide/monsterSide slips ahead.
      return a.globalIdx - b.globalIdx;
    });

    const order = entries.map((e) => e.id);

    this.combatOrder = {
      heroSide: [...heroSide],
      monsterSide: [...monsterSide],
      order,
      cursor: 0,
      rolls: { hero: heroRolls, monster: monsterRolls },
    };
    this.phase = 'combat';
    this.narrativeActor = null;
    this.roundNumber = 1;
    this.resetTurnFlags();
    return { order, rolls: { hero: heroRolls, monster: monsterRolls } };
  }

  endCombat(): void {
    this.phase = 'narrative';
    this.combatOrder = null;
    this.narrativeActor = null;
    this.roundNumber = 0;
    this.resetTurnFlags();
  }

  advance(isAlive?: (id: CharacterId) => boolean): void {
    if (this.phase !== 'combat' || !this.combatOrder) return;
    // Stable local reference: the `isAlive(...)` call below would otherwise
    // de-narrow `this.combatOrder` back to nullable across loop iterations.
    const co = this.combatOrder;
    const seq = co.order;
    if (seq.length === 0) return;
    for (let i = 0; i < seq.length; i++) {
      const prev = co.cursor;
      const next = (prev + 1) % seq.length;
      // Stepping the cursor from a later slot back to an earlier-or-equal one
      // means it wrapped past the end of the initiative order — a new round.
      // A single advance call crosses this boundary at most once (the cursor
      // moves forward at most `seq.length` times), so over-counting can't occur
      // even while skipping a run of dead actors.
      if (next <= prev) this.roundNumber += 1;
      co.cursor = next;
      if (!isAlive || isAlive(seq[next]!)) {
        this.resetTurnFlags();
        return;
      }
    }
    // All actors dead — leave the cursor where it is; phase change is the caller's responsibility.
    this.resetTurnFlags();
  }
}
