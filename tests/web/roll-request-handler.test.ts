// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRollRequestHandler,
  type DuelHud,
  type DuelStage,
} from '../../web/components/roll-request-handler.js';
import type { LaneSettledHandler } from '../../web/components/Dice3DOverlay.js';
import type { RollDispatch } from '../../web/components/three/DiceDispatcher.js';
import type { Face } from '../../web/components/three/DiceMesh.js';
import type { RollRequest } from '../../web/ws-client.js';

/**
 * Regression: a multi-target special (split-shot / whirlwind) fires one
 * `roll_request` per sub-attack. The server pipelines the next request the
 * instant it gets the current one's (early) faces — before that sub-roll's
 * ~2s HUD hold ends. The handler must serialize the shared DiceHUD so each
 * sub-roll's `beginDuel → lanes → verdict → clear` plays fully before the next
 * `beginDuel`. The original code raced: sub-roll 1's deferred clear/verdict
 * landed on sub-roll 2's cards (rat dice vanished on roll 1; no cards on roll 2).
 */
describe('createRollRequestHandler — serializes the HUD across sub-rolls', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Stage timings (relative). Verdict (40) < POST hold (300) so the verdict
  // stamps while the dice are still held, before clear.
  const ATTACKER_SETTLE = 20;
  const DEFENDER_SETTLE = 20;
  const POST_HOLD = 300;
  const PRE_HOLD = 50;
  const VERDICT = 40;

  const makeHud = (log: string[]): DuelHud => ({
    beginDuel: (a, _d, check) => {
      log.push(`begin:${a.name}${check ? `:dc=${check.difficulty}` : ''}`);
      const setter: LaneSettledHandler = (lane, faces) => {
        log.push(`lane:${a.name}:${lane}:${faces.join(',')}`);
      };
      return setter;
    },
    clear: () => log.push('clear'),
    showDuelVerdict: (hit) => log.push(`verdict:${hit ? 'hit' : 'miss'}`),
  });

  // Fake 3D stage: throws the attacker lane, settles, throws the defender lane,
  // settles, then holds. Lane faces are fixed so the verdict is deterministic.
  const makeStage = (
    faces: Record<string, { attacker: number[]; defender: number[] }>,
  ): DuelStage => ({
    roll: async (dispatch: RollDispatch, onLaneSettled?: LaneSettledHandler) => {
      const key = `t${dispatch.t}`;
      const f = faces[key] ?? { attacker: [3], defender: [2] };
      await new Promise<void>((r) => setTimeout(r, ATTACKER_SETTLE));
      onLaneSettled?.('attacker', f.attacker as Face[]);
      if (dispatch.defender.length > 0) {
        await new Promise<void>((r) => setTimeout(r, DEFENDER_SETTLE));
        onLaneSettled?.('defender', f.defender as Face[]);
      }
      await new Promise<void>((r) => setTimeout(r, POST_HOLD));
    },
  });

  const req = (id: string, name: string, aPool: number, dPool: number): RollRequest => ({
    kind: 'roll_request',
    requestId: id,
    rollKind: 'attack',
    attacker: { poolSize: aPool, name, characterKind: 'hero', archetype: 'hunter', sprite: null },
    defender: { poolSize: dPool, name: 'Giant Rat', characterKind: 'monster', archetype: null, sprite: 'giant-rat' },
  } as RollRequest);

  it('the second sub-roll begins only after the first fully clears', async () => {
    const log: string[] = [];
    const resolved: string[] = [];
    const handler = createRollRequestHandler({
      hud: makeHud(log),
      // sub-roll 1: Bran(1) vs rat(2) → 1 vs 6 miss; sub-roll 2: 4 vs 6 miss.
      stage: makeStage({ t1: { attacker: [1], defender: [6, 5] }, t2: { attacker: [4], defender: [2, 6] } }),
      onResolved: (id) => resolved.push(id),
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      preDiceHoldMs: PRE_HOLD,
      verdictDelayMs: VERDICT,
    });

    // Sub-roll 1 (the server awaits its faces before sending the next request).
    const p1 = handler(req('r-7', 'Bran', 1, 2));
    await vi.advanceTimersByTimeAsync(PRE_HOLD + ATTACKER_SETTLE + DEFENDER_SETTLE + 5);
    const faces1 = await p1;
    expect(faces1).toEqual({ attackerFaces: [1], defenderFaces: [6, 5] });

    // Server immediately pipelines sub-roll 2. At this moment sub-roll 1 has
    // NOT cleared yet (its POST hold is still running), so sub-roll 2 must be
    // gated — its beginDuel hasn't fired.
    const p2 = handler(req('r-8', 'Bran', 1, 2));
    await vi.advanceTimersByTimeAsync(10);
    expect(log.filter((l) => l === 'begin:Bran')).toHaveLength(1);

    // Drain everything: sub-roll 1 clears, then sub-roll 2 plays in full.
    await vi.advanceTimersByTimeAsync(2000);
    const faces2 = await p2;
    expect(faces2).toEqual({ attackerFaces: [4], defenderFaces: [2, 6] });

    // Both sub-rolls presented fully, in order, with no cross-contamination:
    expect(log).toEqual([
      'begin:Bran',
      'lane:Bran:attacker:1',
      'lane:Bran:defender:6,5',
      'verdict:miss',
      'clear',
      'begin:Bran',
      'lane:Bran:attacker:4',
      'lane:Bran:defender:2,6',
      'verdict:miss',
      'clear',
    ]);
    expect(resolved).toEqual(['r-7', 'r-8']);
  });

  it('the first sub-roll shows its defender (rat) dice before clearing', async () => {
    const log: string[] = [];
    const handler = createRollRequestHandler({
      hud: makeHud(log),
      stage: makeStage({ t1: { attacker: [5], defender: [3, 2] } }),
      onResolved: () => {},
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      preDiceHoldMs: PRE_HOLD,
      verdictDelayMs: VERDICT,
    });

    const p1 = handler(req('r-7', 'Bran', 1, 2));
    // Advance just past the defender settle — the rat's dice must be on screen
    // and NOT yet cleared (the bug wiped them within a network-latency window).
    await vi.advanceTimersByTimeAsync(PRE_HOLD + ATTACKER_SETTLE + DEFENDER_SETTLE + 5);
    expect(log).toContain('lane:Bran:defender:3,2');
    expect(log).not.toContain('clear');

    await vi.advanceTimersByTimeAsync(2000);
    await p1;
    // 5 vs 3 → hit; verdict precedes clear.
    expect(log.indexOf('verdict:hit')).toBeGreaterThan(log.indexOf('lane:Bran:defender:3,2'));
    expect(log.indexOf('clear')).toBeGreaterThan(log.indexOf('verdict:hit'));
  });

  it('a single-pool check roll (no defender lane) reports faces and stamps a verdict', async () => {
    const log: string[] = [];
    const handler = createRollRequestHandler({
      hud: makeHud(log),
      stage: makeStage({ t1: { attacker: [5, 3, 2], defender: [] } }),
      onResolved: () => {},
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      preDiceHoldMs: PRE_HOLD,
      verdictDelayMs: VERDICT,
    });
    const checkReq: RollRequest = {
      kind: 'roll_request', requestId: 'c-1', rollKind: 'check', difficulty: 5,
      attacker: { poolSize: 3, name: 'Bran', characterKind: 'hero', archetype: 'hunter', sprite: null },
      defender: { poolSize: 0, name: '', characterKind: 'dm', archetype: null, sprite: null },
    } as RollRequest;

    const p = handler(checkReq);
    await vi.advanceTimersByTimeAsync(PRE_HOLD + ATTACKER_SETTLE + 5);
    expect(await p).toEqual({ attackerFaces: [5, 3, 2], defenderFaces: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(log).toContain('verdict:hit'); // top 5 ≥ DC 5
    // The DC threads to beginDuel so the HUD can paint it as a die icon + number.
    expect(log).toContain('begin:Bran:dc=5');
  });
});
