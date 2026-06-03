import type { RunManifest } from '../../log/manifest.js';
import type { Event } from '../../log/events.js';
import type { SurveyRecord } from '../survey-store.js';

/**
 * Pure metric aggregation for the run-archive dashboard (bin/dashboard.ts).
 *
 * Input is whatever the GCS bucket holds for each run — a manifest, the raw
 * events.jsonl, and zero-or-more survey submissions — any of which may be
 * missing (a crash drops the manifest, an abandoned run never gets a survey).
 * The functions here are deliberately I/O-free and total over partial data so
 * they're unit-testable and the dashboard never throws on a half-written run.
 */

/** The cache-hit ratio the Layer-C smoke treats as the pass bar (CLAUDE.md). */
export const CACHE_HIT_THRESHOLD = 0.3;

/** The five teaming statements + the optional effort score, in survey order
 *  (docs/tester-survey.md). `effort` is inverted in meaning (1 = effortless). */
export const SURVEY_DIMENSIONS = [
  { key: 'coordination', label: 'AI–AI coordination' },
  { key: 'responsiveness', label: 'Responsiveness to me' },
  { key: 'communication', label: 'Communication usefulness' },
  { key: 'persona', label: 'Persona distinctiveness' },
  { key: 'trust', label: 'Teaming & trust (overall)' },
  { key: 'effort', label: 'Mental effort (1 = effortless)' },
] as const;

/** Everything the dashboard knows about one archived run before aggregation. */
export interface RawRun {
  runId: string;
  manifest: RunManifest | null;
  /** Raw newline-delimited events.jsonl, or null if it wasn't archived. */
  eventsJsonl: string | null;
  /** All survey submissions for the run (a re-submit appends another). */
  surveys: SurveyRecord[];
}

/** Metrics we can only get by replaying the event log, not the manifest. */
export interface EventMetrics {
  eventCount: number;
  /** Highest logical step `t` seen — a rough "how far did the run get". */
  lastStep: number;
  ruleViolations: number;
  ruleViolationsByReason: Record<string, number>;
  ruleViolationsByActor: Record<string, number>;
  actionsByKind: Record<string, number>;
  thoughtCount: number;
  narrateCount: number;
  humanInputCount: number;
  passiveTriggers: number;
  combatStartedCount: number;
  scenesEntered: string[];
  /** From the terminal `adventure_ended` event, if the run reached one. */
  adventureOutcome: 'success' | 'failure' | null;
  partyWipe: boolean;
}

export interface LatencyStat {
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
}

/** A flattened, dashboard-ready view of a single run. */
export interface RunSummary {
  runId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Manifest outcome, upgraded to the event log's verdict when it has one. */
  outcome: string;
  completed: boolean;
  adventure: string | null;
  language: 'en' | 'pt';
  dmModel: string | null;
  /** Distinct models across every agent in the run. */
  models: string[];
  humanCharacterId: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheHitRatio: number;
  totalLlmCalls: number;
  llmCallsByRole: Record<string, number>;
  latencyByRole: Record<string, LatencyStat>;
  events: EventMetrics | null;
  hasSurvey: boolean;
  surveys: SurveyRecord[];
}

export interface DimensionStat {
  key: string;
  label: string;
  n: number;
  mean: number | null;
  /** Count of each 1..5 answer; index 0 = score 1. */
  distribution: [number, number, number, number, number];
}

export interface SurveyMoment {
  runId: string;
  submittedAt: string;
  moment: string;
  language: string;
}

/** The complete payload the dashboard renders (and we also dump as JSON). */
export interface DashboardData {
  generatedAt: string;
  bucket: string;
  runCount: number;
  runsWithEvents: number;
  runsWithSurveys: number;
  dateRange: { first: string | null; last: string | null };
  /** Best-known outcome per run (event verdict beats manifest). */
  outcomes: Record<string, number>;
  completedCount: number;
  partyWipeCount: number;
  languageSplit: Record<string, number>;
  modelSplit: Record<string, number>;
  tokens: {
    totalIn: number;
    totalOut: number;
    meanIn: number;
    meanOut: number;
  };
  cacheHit: {
    mean: number;
    min: number;
    max: number;
    belowThreshold: number;
    threshold: number;
  };
  latencyByRole: Record<string, LatencyStat>;
  ruleViolations: {
    total: number;
    runsWithZero: number;
    runsWithEvents: number;
    byReason: Record<string, number>;
    byActor: Record<string, number>;
  };
  actionsByKind: Record<string, number>;
  surveyDimensions: DimensionStat[];
  surveyMoments: SurveyMoment[];
  /** Newest run first. */
  runs: RunSummary[];
}

const round = (n: number, dp = 0): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const bump = (rec: Record<string, number>, key: string, by = 1): void => {
  rec[key] = (rec[key] ?? 0) + by;
};

/** Parse one events.jsonl blob into the derived combat/quality metrics. */
export const deriveEventMetrics = (jsonl: string): EventMetrics => {
  const m: EventMetrics = {
    eventCount: 0,
    lastStep: 0,
    ruleViolations: 0,
    ruleViolationsByReason: {},
    ruleViolationsByActor: {},
    actionsByKind: {},
    thoughtCount: 0,
    narrateCount: 0,
    humanInputCount: 0,
    passiveTriggers: 0,
    combatStartedCount: 0,
    scenesEntered: [],
    adventureOutcome: null,
    partyWipe: false,
  };

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Event;
    try {
      ev = JSON.parse(trimmed) as Event;
    } catch {
      continue; // tolerate a torn final line on a crashed run
    }
    m.eventCount += 1;
    if (typeof ev.t === 'number' && ev.t > m.lastStep) m.lastStep = ev.t;

    switch (ev.type) {
      case 'rule_violation':
        m.ruleViolations += 1;
        bump(m.ruleViolationsByReason, ev.violation?.reason ?? 'unknown');
        bump(m.ruleViolationsByActor, String(ev.actorId));
        break;
      case 'action':
        bump(m.actionsByKind, ev.action?.kind ?? 'unknown');
        break;
      case 'thought':
        m.thoughtCount += 1;
        break;
      case 'narrate':
        m.narrateCount += 1;
        break;
      case 'human_input':
        m.humanInputCount += 1;
        break;
      case 'passive_triggered':
        m.passiveTriggers += 1;
        break;
      case 'combat_started':
        m.combatStartedCount += 1;
        break;
      case 'scene_enter':
        if (!m.scenesEntered.includes(ev.sceneId)) m.scenesEntered.push(ev.sceneId);
        break;
      case 'adventure_ended':
        m.adventureOutcome = ev.outcome;
        if (ev.reason === 'party_wipe') m.partyWipe = true;
        break;
      default:
        break;
    }
  }
  return m;
};

/** Flatten one run's raw artifacts into a dashboard-ready summary. */
export const summarizeRun = (raw: RawRun): RunSummary => {
  const man = raw.manifest;
  const events = raw.eventsJsonl !== null ? deriveEventMetrics(raw.eventsJsonl) : null;

  const llmCallsByRole = man?.totalLlmCalls ?? {};
  const totalLlmCalls = Object.values(llmCallsByRole).reduce((a, b) => a + b, 0);

  const models = man
    ? Array.from(new Set(man.agents.map((a) => a.model))).sort()
    : [];
  const dmModel = man?.agents.find((a) => a.role === 'dm')?.model ?? null;

  const startedAt = man?.startedAt ?? null;
  const endedAt = man?.endedAt ?? null;
  const durationMs =
    startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null;

  // Manifest outcome is often "in-progress" (abandoned tabs); the event log's
  // adventure_ended is the stronger signal when present.
  const manifestOutcome = man?.outcome ?? 'unknown';
  const outcome = events?.adventureOutcome ?? manifestOutcome;

  return {
    runId: raw.runId,
    startedAt,
    endedAt,
    durationMs,
    outcome,
    completed: events?.adventureOutcome != null,
    adventure: man?.adventure ?? null,
    language: man?.language ?? 'en',
    dmModel,
    models,
    humanCharacterId: man?.human?.characterId ?? null,
    tokensIn: man?.totalTokens?.in ?? 0,
    tokensOut: man?.totalTokens?.out ?? 0,
    cacheHitRatio: man?.cacheHitRatio ?? 0,
    totalLlmCalls,
    llmCallsByRole,
    latencyByRole: man?.llmLatencyMs ?? {},
    events,
    hasSurvey: raw.surveys.length > 0,
    surveys: raw.surveys,
  };
};

/** Roll all runs up into the single payload the dashboard renders. */
export const aggregate = (
  rawRuns: RawRun[],
  opts: { bucket: string; generatedAt: string },
): DashboardData => {
  const runs = rawRuns.map(summarizeRun).sort((a, b) => b.runId.localeCompare(a.runId));

  const outcomes: Record<string, number> = {};
  const languageSplit: Record<string, number> = {};
  const modelSplit: Record<string, number> = {};
  const latencyByRole: Record<string, LatencyStat> = {};
  const violByReason: Record<string, number> = {};
  const violByActor: Record<string, number> = {};
  const actionsByKind: Record<string, number> = {};

  let totalIn = 0;
  let totalOut = 0;
  let cacheSum = 0;
  let cacheMin = Number.POSITIVE_INFINITY;
  let cacheMax = Number.NEGATIVE_INFINITY;
  let cacheBelow = 0;
  let completedCount = 0;
  let partyWipeCount = 0;
  let runsWithEvents = 0;
  let runsWithSurveys = 0;
  let totalViolations = 0;
  let runsWithZeroViolations = 0;
  let firstStart: string | null = null;
  let lastStart: string | null = null;

  for (const r of runs) {
    bump(outcomes, r.outcome);
    bump(languageSplit, r.language);
    for (const model of r.models.length ? r.models : ['(no manifest)']) bump(modelSplit, model);

    totalIn += r.tokensIn;
    totalOut += r.tokensOut;
    cacheSum += r.cacheHitRatio;
    cacheMin = Math.min(cacheMin, r.cacheHitRatio);
    cacheMax = Math.max(cacheMax, r.cacheHitRatio);
    if (r.cacheHitRatio < CACHE_HIT_THRESHOLD) cacheBelow += 1;
    if (r.completed) completedCount += 1;

    for (const [role, stat] of Object.entries(r.latencyByRole)) {
      const acc = (latencyByRole[role] ??= { calls: 0, totalMs: 0, meanMs: 0, maxMs: 0 });
      acc.calls += stat.calls;
      acc.totalMs += stat.totalMs;
      acc.maxMs = Math.max(acc.maxMs, stat.maxMs);
    }

    if (r.events) {
      runsWithEvents += 1;
      totalViolations += r.events.ruleViolations;
      if (r.events.ruleViolations === 0) runsWithZeroViolations += 1;
      if (r.events.partyWipe) partyWipeCount += 1;
      for (const [k, v] of Object.entries(r.events.ruleViolationsByReason)) bump(violByReason, k, v);
      for (const [k, v] of Object.entries(r.events.ruleViolationsByActor)) bump(violByActor, k, v);
      for (const [k, v] of Object.entries(r.events.actionsByKind)) bump(actionsByKind, k, v);
    }

    if (r.hasSurvey) runsWithSurveys += 1;
    if (r.startedAt) {
      if (!firstStart || r.startedAt < firstStart) firstStart = r.startedAt;
      if (!lastStart || r.startedAt > lastStart) lastStart = r.startedAt;
    }
  }

  for (const stat of Object.values(latencyByRole)) {
    stat.meanMs = stat.calls > 0 ? round(stat.totalMs / stat.calls) : 0;
  }

  const n = runs.length || 1;

  // Survey dimensions: pool every submission across every run.
  const allSurveys = runs.flatMap((r) => r.surveys);
  const surveyDimensions: DimensionStat[] = SURVEY_DIMENSIONS.map(({ key, label }) => {
    const dist: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let sum = 0;
    let count = 0;
    for (const s of allSurveys) {
      const v = s.scores[key];
      if (typeof v === 'number' && v >= 1 && v <= 5) {
        const idx = v - 1;
        dist[idx] = (dist[idx] ?? 0) + 1;
        sum += v;
        count += 1;
      }
    }
    return { key, label, n: count, mean: count ? round(sum / count, 2) : null, distribution: dist };
  });

  const surveyMoments: SurveyMoment[] = allSurveys
    .filter((s) => s.moment && s.moment.trim().length > 0)
    .map((s) => ({
      runId: s.runId,
      submittedAt: s.submittedAt,
      moment: s.moment,
      language: s.language ?? 'en',
    }))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  return {
    generatedAt: opts.generatedAt,
    bucket: opts.bucket,
    runCount: runs.length,
    runsWithEvents,
    runsWithSurveys,
    dateRange: { first: firstStart, last: lastStart },
    outcomes,
    completedCount,
    partyWipeCount,
    languageSplit,
    modelSplit,
    tokens: {
      totalIn,
      totalOut,
      meanIn: round(totalIn / n),
      meanOut: round(totalOut / n),
    },
    cacheHit: {
      mean: round(cacheSum / n, 3),
      min: runs.length ? round(cacheMin, 3) : 0,
      max: runs.length ? round(cacheMax, 3) : 0,
      belowThreshold: cacheBelow,
      threshold: CACHE_HIT_THRESHOLD,
    },
    latencyByRole,
    ruleViolations: {
      total: totalViolations,
      runsWithZero: runsWithZeroViolations,
      runsWithEvents,
      byReason: violByReason,
      byActor: violByActor,
    },
    actionsByKind,
    surveyDimensions,
    surveyMoments,
    runs,
  };
};
