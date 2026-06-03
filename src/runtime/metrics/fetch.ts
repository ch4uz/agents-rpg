import type { GcsReader } from './gcs-reader.js';
import type { RawRun } from './aggregate.js';
import type { RunManifest } from '../../log/manifest.js';
import type { SurveyRecord } from '../survey-store.js';

/**
 * Pull every archived run out of the bucket and assemble {@link RawRun}s for
 * aggregation. Kept separate from the real reader so it can be exercised with
 * a fake {@link GcsReader} in tests. Layout written by run-archive.ts /
 * survey-store.ts:
 *
 *   runs/<runId>/manifest.json
 *   runs/<runId>/events.jsonl
 *   surveys/<runId>/<submittedAt>.json   (0+ per run; a re-submit appends)
 *
 * A run may be missing any artifact (crash, abandoned tab) — partial runs are
 * kept, never dropped, so the dashboard reflects reality. A single object that
 * fails to download or parse is skipped with a logged warning.
 */

const RUN_KEY = /^runs\/([^/]+)\/(manifest\.json|events\.jsonl)$/;
const SURVEY_KEY = /^surveys\/([^/]+)\/[^/]+$/;

/** Run a mapper over items with a bounded number of in-flight promises. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

export interface FetchOptions {
  /** Max concurrent downloads. */
  concurrency?: number;
  /** Diagnostics sink; never throws. */
  log?: (msg: string) => void;
}

export const fetchAllRuns = async (
  reader: GcsReader,
  opts: FetchOptions = {},
): Promise<RawRun[]> => {
  const log = opts.log ?? (() => {});
  const concurrency = opts.concurrency ?? 12;

  const [runKeys, surveyKeys] = await Promise.all([reader.list('runs/'), reader.list('surveys/')]);

  // runId → { manifest?, events? }
  const runArtifacts = new Map<string, { manifest?: string; events?: string }>();
  for (const key of runKeys) {
    const m = RUN_KEY.exec(key);
    if (!m) continue;
    const [, runId, file] = m as unknown as [string, string, string];
    const slot = runArtifacts.get(runId) ?? {};
    if (file === 'manifest.json') slot.manifest = key;
    else slot.events = key;
    runArtifacts.set(runId, slot);
  }

  // runId → survey object keys
  const surveyObjects = new Map<string, string[]>();
  for (const key of surveyKeys) {
    const m = SURVEY_KEY.exec(key);
    if (!m) continue;
    const runId = (m as unknown as [string, string])[1];
    const list = surveyObjects.get(runId) ?? [];
    list.push(key);
    surveyObjects.set(runId, list);
  }

  const runIds = new Set<string>([...runArtifacts.keys(), ...surveyObjects.keys()]);

  // Every object we need, flattened so downloads share one concurrency pool.
  const tryDownload = async (name: string): Promise<string | null> => {
    try {
      return await reader.download(name);
    } catch (e) {
      log(`[dashboard] download failed for ${name}: ${String(e)}`);
      return null;
    }
  };

  return mapLimit(Array.from(runIds), concurrency, async (runId): Promise<RawRun> => {
    const artifacts = runArtifacts.get(runId) ?? {};
    const surveyNames = surveyObjects.get(runId) ?? [];

    const [manifestStr, eventsJsonl, ...surveyStrs] = await Promise.all([
      artifacts.manifest ? tryDownload(artifacts.manifest) : Promise.resolve(null),
      artifacts.events ? tryDownload(artifacts.events) : Promise.resolve(null),
      ...surveyNames.map(tryDownload),
    ]);

    let manifest: RunManifest | null = null;
    if (manifestStr) {
      try {
        manifest = JSON.parse(manifestStr) as RunManifest;
      } catch (e) {
        log(`[dashboard] bad manifest JSON for ${runId}: ${String(e)}`);
      }
    }

    const surveys: SurveyRecord[] = [];
    for (const s of surveyStrs) {
      if (!s) continue;
      try {
        surveys.push(JSON.parse(s) as SurveyRecord);
      } catch (e) {
        log(`[dashboard] bad survey JSON for ${runId}: ${String(e)}`);
      }
    }

    return { runId, manifest, eventsJsonl, surveys };
  });
};
