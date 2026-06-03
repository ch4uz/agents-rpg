import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GcsUploader } from './survey-store.js';

/**
 * End-of-run archive: upload a session's run artifacts to GCS so they outlive
 * Render's ephemeral disk. Called by `bin/play.ts` when the orchestrator's
 * `run()` settles (win / wipe / abort / crash) — by then `events.jsonl` is
 * complete and `manifest.json` has been written (the manifest may be absent
 * on a crash path; a missing artifact is skipped, not an error).
 *
 * Objects land next to the surveys, under the run's id:
 *   gs://<bucket>/runs/<runId>/events.jsonl
 *   gs://<bucket>/runs/<runId>/manifest.json
 *
 * Strictly best-effort: a failed upload is logged and reported in the result,
 * never thrown — archiving must not break session teardown.
 */

/** The run-dir artifacts worth archiving (survey.json is uploaded separately,
 *  per submission, by survey-store.ts). */
const ARTIFACTS = [
  { file: 'events.jsonl', contentType: 'application/x-ndjson' },
  { file: 'manifest.json', contentType: 'application/json' },
] as const;

export interface ArchiveRunOptions {
  runDir: string;
  runId: string;
  uploader: GcsUploader;
  /** Diagnostics sink (e.g. the session's console logger). Never throws. */
  log?: (msg: string) => void;
}

export interface ArchiveRunResult {
  /** Artifact file names successfully uploaded. */
  uploaded: string[];
  /** Artifact file names that existed but failed to upload. */
  failed: string[];
}

/** GCS object name for one archived run artifact. */
export const runArtifactObjectName = (runId: string, file: string): string =>
  `runs/${runId}/${file}`;

export const archiveRunArtifacts = async (opts: ArchiveRunOptions): Promise<ArchiveRunResult> => {
  const log = opts.log ?? (() => {});
  const uploaded: string[] = [];
  const failed: string[] = [];
  for (const { file, contentType } of ARTIFACTS) {
    let body: string;
    try {
      body = await readFile(path.join(opts.runDir, file), 'utf8');
    } catch {
      continue;  // artifact never produced (e.g. manifest on a crash) — skip
    }
    try {
      await opts.uploader(runArtifactObjectName(opts.runId, file), body, contentType);
      uploaded.push(file);
    } catch (e) {
      failed.push(file);
      log(`[archive] upload of ${file} failed: ${String(e)}`);
    }
  }
  return { uploaded, failed };
};
