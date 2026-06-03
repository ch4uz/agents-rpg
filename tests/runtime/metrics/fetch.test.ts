import { describe, it, expect } from 'vitest';
import { fetchAllRuns } from '../../../src/runtime/metrics/fetch.js';
import type { GcsReader } from '../../../src/runtime/metrics/gcs-reader.js';

/**
 * Pins fetch.ts grouping over a fake GcsReader: objects are bucketed by runId
 * across the runs/ and surveys/ prefixes, partial runs are kept, and a single
 * unreadable / malformed object is skipped rather than failing the whole pull.
 */

const fakeReader = (objects: Record<string, string>, failing: Set<string> = new Set()): GcsReader => ({
  async list(prefix) {
    return Object.keys(objects).filter((k) => k.startsWith(prefix));
  },
  async download(name) {
    if (failing.has(name)) throw new Error(`boom: ${name}`);
    const body = objects[name];
    if (body === undefined) throw new Error(`missing: ${name}`);
    return body;
  },
});

describe('fetchAllRuns', () => {
  it('groups manifest, events, and surveys by runId', async () => {
    const reader = fakeReader({
      'runs/RUN_A/manifest.json': JSON.stringify({ runId: 'RUN_A', cacheHitRatio: 0.4 }),
      'runs/RUN_A/events.jsonl': '{"t":1,"type":"narrate","actorId":"dm","text":"hi"}',
      'surveys/RUN_A/2026-06-03T12-00-00-000Z.json': JSON.stringify({ runId: 'RUN_A', moment: 'x', scores: {} }),
      'surveys/RUN_A/2026-06-03T13-00-00-000Z.json': JSON.stringify({ runId: 'RUN_A', moment: 'y', scores: {} }),
    });
    const runs = await fetchAllRuns(reader);
    expect(runs).toHaveLength(1);
    const a = runs[0]!;
    expect(a.runId).toBe('RUN_A');
    expect(a.manifest?.cacheHitRatio).toBe(0.4);
    expect(a.eventsJsonl).toContain('narrate');
    expect(a.surveys).toHaveLength(2);
  });

  it('keeps a run that only has a survey, and one that only has events', async () => {
    const reader = fakeReader({
      'surveys/SURVEY_ONLY/2026-06-03T12-00-00-000Z.json': JSON.stringify({ runId: 'SURVEY_ONLY', moment: '', scores: {} }),
      'runs/EVENTS_ONLY/events.jsonl': '{"t":1,"type":"narrate","actorId":"dm","text":"hi"}',
    });
    const runs = await fetchAllRuns(reader);
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect(byId.get('SURVEY_ONLY')?.manifest).toBeNull();
    expect(byId.get('SURVEY_ONLY')?.surveys).toHaveLength(1);
    expect(byId.get('EVENTS_ONLY')?.eventsJsonl).toContain('narrate');
    expect(byId.get('EVENTS_ONLY')?.surveys).toHaveLength(0);
  });

  it('skips an unreadable manifest and a malformed survey without throwing', async () => {
    const reader = fakeReader(
      {
        'runs/RUN_B/manifest.json': '{ not json',
        'runs/RUN_B/events.jsonl': 'ok',
        'surveys/RUN_B/2026-06-03T12-00-00-000Z.json': '{ also not json',
      },
      new Set(['runs/RUN_B/events.jsonl']), // download throws for this one
    );
    const logs: string[] = [];
    const runs = await fetchAllRuns(reader, { log: (m) => logs.push(m) });
    expect(runs).toHaveLength(1);
    const b = runs[0]!;
    expect(b.manifest).toBeNull(); // bad JSON
    expect(b.eventsJsonl).toBeNull(); // download failed
    expect(b.surveys).toHaveLength(0); // bad JSON
    expect(logs.length).toBeGreaterThan(0);
  });

  it('ignores objects that do not match the expected layout', async () => {
    const reader = fakeReader({
      'runs/stray-top-level-file.txt': 'nope',
      'runs/RUN_C/manifest.json': JSON.stringify({ runId: 'RUN_C' }),
    });
    const runs = await fetchAllRuns(reader);
    expect(runs.map((r) => r.runId)).toEqual(['RUN_C']);
  });
});
