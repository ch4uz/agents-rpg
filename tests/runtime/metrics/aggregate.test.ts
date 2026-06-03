import { describe, it, expect } from 'vitest';
import {
  deriveEventMetrics,
  summarizeRun,
  aggregate,
  CACHE_HIT_THRESHOLD,
  type RawRun,
} from '../../../src/runtime/metrics/aggregate.js';
import type { RunManifest } from '../../../src/log/manifest.js';
import type { SurveyRecord } from '../../../src/runtime/survey-store.js';

/**
 * Pins the pure dashboard aggregation (src/runtime/metrics/aggregate.ts):
 *   - event-log replay derives violations / actions / outcomes and tolerates a
 *     torn final line on a crashed run;
 *   - a run's manifest flattens into a summary, with the event log's
 *     adventure_ended verdict beating the manifest's "in-progress";
 *   - the rollup pools tokens, cache-hit, latency (meanMs = totalMs/calls
 *     across runs), violations, and survey scores correctly.
 */

const manifest = (over: Partial<RunManifest> = {}): RunManifest => ({
  runId: 'r',
  startedAt: '2026-06-03T10:00:00.000Z',
  endedAt: '2026-06-03T10:05:00.000Z',
  outcome: 'in-progress',
  adventure: 'basement-o-rats@v1',
  rngSeed: 'seed',
  agents: [
    { role: 'dm', model: 'gemini-3.5-flash', promptHash: 'h' },
    { role: 'p1', characterId: 'p1', model: 'gemini-3.5-flash', promptHash: 'h' },
    { role: 'p2', characterId: 'p2', model: 'claude-sonnet-4-6', promptHash: 'h' },
  ],
  human: { characterId: 'p2' },
  stepBudget: 6,
  totalEvents: 10,
  totalLlmCalls: { dm: 2, p1: 3 },
  totalTokens: { in: 1000, out: 200 },
  cacheHitRatio: 0.5,
  language: 'en',
  llmLatencyMs: { dm: { calls: 2, totalMs: 400, meanMs: 200, maxMs: 250 } },
  ...over,
});

const jsonl = (events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n');

describe('deriveEventMetrics', () => {
  it('counts violations, actions, scenes, and the terminal outcome', () => {
    const m = deriveEventMetrics(
      jsonl([
        { t: 1, type: 'scene_enter', sceneId: 'tavern-basement' },
        { t: 2, type: 'thought', actorId: 'p1', text: 'hmm' },
        { t: 3, type: 'action', actorId: 'p1', action: { kind: 'move', path: [] } },
        { t: 4, type: 'action', actorId: 'p1', action: { kind: 'normal_attack', targetId: 'm1' } },
        { t: 5, type: 'rule_violation', actorId: 'p1', violation: { reason: 'out-of-range' } },
        { t: 6, type: 'rule_violation', actorId: 'dm', violation: { reason: 'wrong-phase' } },
        { t: 7, type: 'narrate', actorId: 'dm', text: 'boo' },
        { t: 8, type: 'human_input', actorId: 'p2', text: 'go left' },
        { t: 9, type: 'scene_enter', sceneId: 'rat-tunnel' },
        { t: 10, type: 'adventure_ended', outcome: 'success' },
      ]),
    );
    expect(m.eventCount).toBe(10);
    expect(m.lastStep).toBe(10);
    expect(m.ruleViolations).toBe(2);
    expect(m.ruleViolationsByReason).toEqual({ 'out-of-range': 1, 'wrong-phase': 1 });
    expect(m.ruleViolationsByActor).toEqual({ p1: 1, dm: 1 });
    expect(m.actionsByKind).toEqual({ move: 1, normal_attack: 1 });
    expect(m.thoughtCount).toBe(1);
    expect(m.narrateCount).toBe(1);
    expect(m.humanInputCount).toBe(1);
    expect(m.scenesEntered).toEqual(['tavern-basement', 'rat-tunnel']);
    expect(m.adventureOutcome).toBe('success');
    expect(m.partyWipe).toBe(false);
  });

  it('flags a party wipe and tolerates a torn final line', () => {
    const m = deriveEventMetrics(
      jsonl([{ t: 1, type: 'adventure_ended', outcome: 'failure', reason: 'party_wipe' }]) +
        '\n{ "t": 2, "type": "thoug',
    );
    expect(m.adventureOutcome).toBe('failure');
    expect(m.partyWipe).toBe(true);
    expect(m.eventCount).toBe(1); // torn line skipped, not counted
  });

  it('is empty (not throwing) for a blank log', () => {
    const m = deriveEventMetrics('\n  \n');
    expect(m.eventCount).toBe(0);
    expect(m.adventureOutcome).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('flattens a manifest and upgrades outcome from the event log', () => {
    const raw: RawRun = {
      runId: 'r1',
      manifest: manifest(),
      eventsJsonl: jsonl([{ t: 1, type: 'adventure_ended', outcome: 'success' }]),
      surveys: [],
    };
    const s = summarizeRun(raw);
    expect(s.outcome).toBe('success'); // beats manifest "in-progress"
    expect(s.completed).toBe(true);
    expect(s.durationMs).toBe(5 * 60 * 1000);
    expect(s.tokensIn).toBe(1000);
    expect(s.tokensOut).toBe(200);
    expect(s.cacheHitRatio).toBe(0.5);
    expect(s.totalLlmCalls).toBe(5);
    expect(s.dmModel).toBe('gemini-3.5-flash');
    expect(s.models).toEqual(['claude-sonnet-4-6', 'gemini-3.5-flash']); // distinct, sorted
    expect(s.hasSurvey).toBe(false);
  });

  it('survives a missing manifest with safe zeros', () => {
    const s = summarizeRun({ runId: 'r2', manifest: null, eventsJsonl: null, surveys: [] });
    expect(s.outcome).toBe('unknown');
    expect(s.tokensIn).toBe(0);
    expect(s.cacheHitRatio).toBe(0);
    expect(s.language).toBe('en');
    expect(s.models).toEqual([]);
    expect(s.events).toBeNull();
  });
});

const survey = (scores: Record<string, number | null>, over: Partial<SurveyRecord> = {}): SurveyRecord => ({
  runId: 'r',
  submittedAt: '2026-06-03T12:00:00.000Z',
  scores,
  moment: '',
  ...over,
});

describe('aggregate', () => {
  const opts = { bucket: 'b', generatedAt: '2026-06-04T00:00:00.000Z' };

  it('rolls up outcomes, splits, tokens, cache, and latency', () => {
    const runs: RawRun[] = [
      {
        runId: '2026-06-03T10-00-00-000Z-x-aaa',
        manifest: manifest({ cacheHitRatio: 0.5, totalTokens: { in: 1000, out: 200 } }),
        eventsJsonl: jsonl([{ t: 1, type: 'adventure_ended', outcome: 'success' }]),
        surveys: [],
      },
      {
        runId: '2026-06-03T11-00-00-000Z-x-bbb',
        manifest: manifest({
          language: 'pt',
          cacheHitRatio: 0.1,
          totalTokens: { in: 3000, out: 400 },
          llmLatencyMs: { dm: { calls: 2, totalMs: 600, meanMs: 300, maxMs: 800 } },
        }),
        eventsJsonl: jsonl([
          { t: 1, type: 'rule_violation', actorId: 'p1', violation: { reason: 'out-of-range' } },
        ]),
        surveys: [],
      },
    ];
    const d = aggregate(runs, opts);

    expect(d.runCount).toBe(2);
    expect(d.outcomes).toEqual({ success: 1, 'in-progress': 1 });
    expect(d.completedCount).toBe(1);
    expect(d.languageSplit).toEqual({ en: 1, pt: 1 });
    expect(d.modelSplit).toEqual({ 'gemini-3.5-flash': 2, 'claude-sonnet-4-6': 2 });

    expect(d.tokens.totalIn).toBe(4000);
    expect(d.tokens.totalOut).toBe(600);
    expect(d.tokens.meanIn).toBe(2000);

    expect(d.cacheHit.mean).toBeCloseTo(0.3, 5);
    expect(d.cacheHit.min).toBe(0.1);
    expect(d.cacheHit.max).toBe(0.5);
    expect(d.cacheHit.belowThreshold).toBe(1); // 0.1 < 0.30
    expect(d.cacheHit.threshold).toBe(CACHE_HIT_THRESHOLD);

    // dm latency pooled: calls 2+2=4, totalMs 400+600=1000, mean 250, max 800
    expect(d.latencyByRole['dm']).toEqual({ calls: 4, totalMs: 1000, meanMs: 250, maxMs: 800 });

    expect(d.ruleViolations.total).toBe(1);
    expect(d.ruleViolations.runsWithZero).toBe(1);
    expect(d.ruleViolations.runsWithEvents).toBe(2);
    expect(d.ruleViolations.byReason).toEqual({ 'out-of-range': 1 });

    // newest run first
    expect(d.runs[0]?.runId).toContain('11-00-00');
  });

  it('pools survey scores into per-dimension mean + 1..5 distribution', () => {
    const runs: RawRun[] = [
      {
        runId: 'r1',
        manifest: manifest(),
        eventsJsonl: null,
        surveys: [survey({ coordination: 5, effort: 2 }, { moment: 'great breach play' })],
      },
      {
        runId: 'r2',
        manifest: manifest(),
        eventsJsonl: null,
        surveys: [survey({ coordination: 3, effort: null }, { moment: '', submittedAt: '2026-06-03T13:00:00.000Z' })],
      },
    ];
    const d = aggregate(runs, opts);

    expect(d.runsWithSurveys).toBe(2);
    const coord = d.surveyDimensions.find((x) => x.key === 'coordination')!;
    expect(coord.n).toBe(2);
    expect(coord.mean).toBe(4); // (5+3)/2
    expect(coord.distribution).toEqual([0, 0, 1, 0, 1]); // one 3, one 5

    const effort = d.surveyDimensions.find((x) => x.key === 'effort')!;
    expect(effort.n).toBe(1); // null ignored
    expect(effort.mean).toBe(2);

    // only the non-empty moment survives
    expect(d.surveyMoments).toHaveLength(1);
    expect(d.surveyMoments[0]?.moment).toBe('great breach play');
  });

  it('handles an empty bucket without dividing by zero', () => {
    const d = aggregate([], opts);
    expect(d.runCount).toBe(0);
    expect(d.tokens.meanIn).toBe(0);
    expect(d.cacheHit.mean).toBe(0);
    expect(d.surveyDimensions.every((x) => x.mean === null)).toBe(true);
  });
});
