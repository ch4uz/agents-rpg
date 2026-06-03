import { skinForCharacter } from './three/DiceSkins.js';
import type { Face } from './three/DiceMesh.js';
import type { RollDispatch } from './three/DiceDispatcher.js';
import type { LaneSettledHandler } from './Dice3DOverlay.js';
import type { DuelFrameInfo } from './DiceHUD.js';
import type { RollRequest, RollRequestResult } from '../ws-client.js';
import { displayName } from './names.js';

/** The slice of `DiceHUD` the roll handler drives. */
export interface DuelHud {
  beginDuel(
    attacker: DuelFrameInfo,
    defender: DuelFrameInfo,
    check?: { difficulty: number },
  ): LaneSettledHandler;
  clear(): void;
  showDuelVerdict(hit: boolean): void;
}

/** The slice of `Dice3DOverlay` the roll handler drives. */
export interface DuelStage {
  roll(dispatch: RollDispatch, onLaneSettled?: LaneSettledHandler): Promise<void>;
}

export interface RollRequestHandlerDeps {
  hud: DuelHud;
  stage: DuelStage;
  /** Signal that this request's dice animation + verdict + hold finished, so
   *  the ws-client bridge releases the numeric-`t`-gated board effects
   *  (HP drain, projectile, hit flash). */
  onResolved(requestId: string): void;
  /** Injectable timer (tests pass a fake). Defaults to setTimeout. */
  delay?(ms: number): Promise<void>;
  /** Intro beat — HUD fade-in + a moment to read who-vs-who — before the throw. */
  preDiceHoldMs?: number;
  /** Delay from the deciding lane settling to the SUCCESS/FAIL stamp. */
  verdictDelayMs?: number;
}

const DEFAULT_PRE_DICE_HOLD_MS = 1000;
const DEFAULT_VERDICT_DELAY_MS = 900;
const realDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const topFace = (xs: ReadonlyArray<number>): number => xs.reduce((m, v) => (v > m ? v : m), 0);

/**
 * Build the physics-as-truth `roll_request` handler (the browser rolls the
 * dice, reads the settled faces, and reports them back so the engine resolves
 * from exactly what the player watched land).
 *
 * Each request: show the duel HUD, roll the 3D dice, report the faces back as
 * soon as the deciding lane settles (so the server isn't blocked on the
 * ~2s verdict + read hold), then stamp SUCCESS/FAIL and clear the HUD.
 *
 * The HUD PRESENTATION is serialized across requests: a roll's `beginDuel`
 * waits for the previous roll's `clear()`. A multi-target special (whirlwind /
 * split-shot) fires one `roll_request` per sub-attack, and the server pipelines
 * the next request the instant it receives the current one's (early) faces —
 * well before that sub-roll's on-screen hold ends. Without the gate the next
 * `beginDuel` runs mid-presentation and the prior sub-roll's deferred
 * `clear()` / verdict land on the wrong cards: the first sub-roll's defender
 * dice get wiped almost immediately and the second sub-roll's cards are cleared
 * out from under it (they never reappear). The gate keeps each sub-roll's
 * `beginDuel → dice → verdict → clear` atomic while leaving the early
 * face-report (single-attack responsiveness) intact.
 */
export const createRollRequestHandler = (
  deps: RollRequestHandlerDeps,
): ((req: RollRequest) => Promise<RollRequestResult>) => {
  const delay = deps.delay ?? realDelay;
  const preHold = deps.preDiceHoldMs ?? DEFAULT_PRE_DICE_HOLD_MS;
  const verdictDelay = deps.verdictDelayMs ?? DEFAULT_VERDICT_DELAY_MS;
  let seq = 0;
  // Resolves once the most-recently-started roll's HUD has cleared, freeing the
  // shared HUD for the next roll. Starts resolved (HUD free).
  let hudReady: Promise<void> = Promise.resolve();

  return async (req: RollRequest): Promise<RollRequestResult> => {
    const aSkin = skinForCharacter(req.attacker.characterKind, req.attacker.archetype);
    const dSkin = skinForCharacter(req.defender.characterKind, req.defender.archetype);
    // Face VALUES are placeholders — the overlay rolls free physics and reads
    // the actual settled faces. Only the array LENGTH (pool size) + per-die
    // skin matter at dispatch time.
    const placeholders = (n: number): Face[] =>
      Array.from({ length: Math.max(0, n) }, () => 1 as Face);
    const attackerDice = placeholders(req.attacker.poolSize);
    const defenderDice = placeholders(req.defender.poolSize);
    seq += 1;
    const dispatch: RollDispatch = {
      t: seq,
      attacker: attackerDice,
      defender: defenderDice,
      attackerSkins: attackerDice.map(() => aSkin),
      defenderSkins: defenderDice.map(() => dSkin),
    };

    // Claim the HUD only after the previous roll's presentation has cleared.
    // Reassigning `hudReady` synchronously (before the await) chains requests
    // in arrival order even if several land back-to-back.
    const prevHud = hudReady;
    let releaseHud!: () => void;
    hudReady = new Promise<void>((r) => { releaseHud = r; });
    await prevHud;

    // Nameplates route through displayName so a PT session shows the
    // translated creature name ("Rato Gigante") while the wire stays English.
    const laneSetter = deps.hud.beginDuel(
      { name: displayName(req.attacker.name), kind: req.attacker.characterKind, archetype: req.attacker.archetype, sprite: req.attacker.sprite },
      { name: displayName(req.defender.name), kind: req.defender.characterKind, archetype: req.defender.archetype, sprite: req.defender.sprite },
      req.rollKind === 'check' ? { difficulty: req.difficulty ?? 0 } : undefined,
    );

    let attackerFaces: number[] = [];
    let defenderFaces: number[] = [];
    let resolveFaces!: (r: RollRequestResult) => void;
    const facesReady = new Promise<RollRequestResult>((r) => { resolveFaces = r; });
    const hasDefenderLane = defenderDice.length > 0;

    // On the deciding lane's settle: (1) hand the faces back immediately so the
    // server can proceed, and (2) compute + schedule the SUCCESS/FAIL stamp.
    const finish = (): void => {
      resolveFaces({ attackerFaces, defenderFaces });
      const hit = req.rollKind === 'check'
        ? topFace(attackerFaces) >= (req.difficulty ?? 0)
        : topFace(attackerFaces) >= topFace(defenderFaces) && topFace(attackerFaces) > 0;
      void delay(verdictDelay).then(() => deps.hud.showDuelVerdict(hit));
    };

    const laneHandler: LaneSettledHandler = (lane, faces) => {
      laneSetter(lane, faces);
      if (lane === 'attacker') {
        attackerFaces = [...faces];
        if (!hasDefenderLane) finish();
      } else {
        defenderFaces = [...faces];
        finish();
      }
    };

    // HUD intro beat over the board before the dice fly.
    await delay(preHold);
    void deps.stage.roll(dispatch, laneHandler)
      // A physics failure must not wedge the HUD gate: clear + release anyway.
      .catch(() => { /* swallow — the .then below still runs */ })
      .then(() => {
        deps.hud.clear();
        deps.onResolved(req.requestId);
        releaseHud();
      });

    return facesReady;
  };
};
