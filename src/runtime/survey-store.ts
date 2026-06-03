import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SurveySubmission, SurveyPersistResult } from './ws/protocol.js';

/**
 * Persistence for submitted playtest surveys (docs/tester-survey.md).
 *
 * Every submission is written into the session's run directory as
 * `survey.json` (next to events.jsonl / manifest.json — best-effort, and
 * ephemeral on Render's free disk) AND, when an uploader is configured,
 * uploaded to the project's GCS bucket as
 * `surveys/<runId>/<submittedAt>.json` — one object per submission, so a
 * re-submitted survey appends history instead of overwriting (which also
 * keeps the Render service account on the narrow `storage.objectCreator`
 * role: create-only, no overwrite/delete needed).
 *
 * Failure ladder: cloud upload failing degrades to a local-only ack; both
 * failing returns `ok: false` so the browser steers the tester to the
 * clipboard fallback. Persistence must never throw into the WS adapter.
 */

/** What lands on disk / in the bucket: the answers + the run identity the
 *  server stamps (the client only ships scores + moment). */
export interface SurveyRecord extends SurveySubmission {
  runId: string;
  /** The browser tab's WS session id, when known. */
  sid?: string;
  /** ISO-8601 server time of the submission. */
  submittedAt: string;
}

/** Uploads one object to durable storage (surveys here; the end-of-run
 *  event-log archive in run-archive.ts shares it). Implemented by
 *  {@link createGcsUploader}; injected as a fake in tests. */
export type GcsUploader = (objectName: string, body: string, contentType?: string) => Promise<void>;

export interface PersistSurveyOptions {
  runDir: string;
  runId: string;
  sid?: string;
  /** Absent → local runDir write only. */
  uploader?: GcsUploader;
  /** Injectable clock (tests). Default: `new Date()`. */
  now?: () => Date;
  /** Diagnostics sink (e.g. the session's console logger). Never throws. */
  log?: (msg: string) => void;
  /** Hard cap on the cloud upload before it degrades to a local-only ack
   *  (default {@link DEFAULT_UPLOAD_TIMEOUT_MS}). Without it, a stalled GCS
   *  request — gaxios sets no request timeout — leaves this promise unresolved,
   *  so no `survey_ack` is ever sent and the browser's Submit button is pinned
   *  at "Saving…". Injectable (small) in tests. */
  uploadTimeoutMs?: number;
}

/** Default ceiling for {@link PersistSurveyOptions.uploadTimeoutMs}. */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 10_000;

/** Reject if `p` hasn't settled within `ms`, so a hung upload can't block the
 *  ack. The losing branch's timer is cleared either way; the abandoned upload
 *  promise stays handled (Promise.race attaches to it) so a later rejection
 *  doesn't surface as unhandled. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`upload timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/** GCS object name for one submission — unique per submit (see module doc). */
export const surveyObjectName = (runId: string, submittedAt: string): string =>
  `surveys/${runId}/${submittedAt.replace(/[:.]/g, '-')}.json`;

/**
 * Real GCS uploader. Lazily imports `@google-cloud/storage` on first use so
 * headless/CI runs without the dependency-or-credentials never pay for it.
 * Auth is ADC — `gcloud auth application-default login` locally, the service
 * account JSON (`GOOGLE_APPLICATION_CREDENTIALS`) on Render — i.e. the same
 * credential chain the Vertex AI path already uses.
 */
export const createGcsUploader = (bucket: string): GcsUploader =>
  async (objectName, body, contentType = 'application/json') => {
    const { Storage } = await import('@google-cloud/storage');
    const storage = new Storage();
    await storage.bucket(bucket).file(objectName).save(body, {
      contentType,
      // Small single-shot payloads — resumable sessions just add latency.
      resumable: false,
    });
  };

export const persistSurvey = async (
  survey: SurveySubmission,
  opts: PersistSurveyOptions,
): Promise<SurveyPersistResult> => {
  const log = opts.log ?? (() => {});
  const submittedAt = (opts.now ?? (() => new Date()))().toISOString();
  const record: SurveyRecord = {
    runId: opts.runId,
    ...(opts.sid !== undefined ? { sid: opts.sid } : {}),
    submittedAt,
    scores: survey.scores,
    moment: survey.moment,
  };
  const json = JSON.stringify(record, null, 2);

  let localOk = false;
  try {
    await writeFile(path.join(opts.runDir, 'survey.json'), `${json}\n`, 'utf8');
    localOk = true;
  } catch (e) {
    log(`[survey] local write failed: ${String(e)}`);
  }

  if (opts.uploader) {
    try {
      await withTimeout(
        opts.uploader(surveyObjectName(opts.runId, submittedAt), json),
        opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
      );
      return { ok: true, destination: 'cloud' };
    } catch (e) {
      log(`[survey] cloud upload failed: ${String(e)}`);
      return localOk
        ? { ok: true, destination: 'local', detail: 'cloud upload failed; saved to run dir' }
        : { ok: false, detail: 'cloud upload and local write both failed' };
    }
  }

  return localOk
    ? { ok: true, destination: 'local' }
    : { ok: false, detail: 'local write failed' };
};
