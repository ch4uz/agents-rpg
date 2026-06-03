import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistSurvey, surveyObjectName, type GcsUploader } from '../../src/runtime/survey-store.js';

/**
 * Pins survey persistence (src/runtime/survey-store.ts):
 *   1. Every submission lands in <runDir>/survey.json with the server-stamped
 *      run identity (runId / sid / submittedAt) alongside the answers.
 *   2. With an uploader, the same JSON goes to the bucket under a UNIQUE
 *      per-submission object name (surveys/<runId>/<stamp>.json) and the
 *      result acks `destination: 'cloud'`.
 *   3. Failure ladder: cloud failing degrades to a local-only ok ack; both
 *      failing returns ok:false. Nothing throws into the caller.
 */
describe('survey-store', () => {
  let runDir: string;
  const survey = { scores: { coordination: 4, effort: 2 }, moment: 'Best: the breach' };
  const NOW = new Date('2026-06-03T12:00:00.000Z');

  beforeEach(async () => { runDir = await mkdtemp(path.join(tmpdir(), 'survey-store-')); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  it('writes survey.json into the run dir with the server-stamped identity', async () => {
    const result = await persistSurvey(survey, { runDir, runId: 'run-1', sid: 'sid-9', now: () => NOW });
    expect(result).toEqual({ ok: true, destination: 'local' });
    const onDisk = JSON.parse(await readFile(path.join(runDir, 'survey.json'), 'utf8'));
    expect(onDisk).toEqual({
      runId: 'run-1',
      sid: 'sid-9',
      submittedAt: '2026-06-03T12:00:00.000Z',
      scores: { coordination: 4, effort: 2 },
      moment: 'Best: the breach',
    });
  });

  it('uploads the same JSON to a unique per-submission object and acks cloud', async () => {
    const uploads: Array<{ name: string; json: string }> = [];
    const uploader: GcsUploader = async (name, json) => { uploads.push({ name, json }); };
    const result = await persistSurvey(survey, { runDir, runId: 'run-2', now: () => NOW, uploader });
    expect(result).toEqual({ ok: true, destination: 'cloud' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.name).toBe(surveyObjectName('run-2', NOW.toISOString()));
    // Object names must be GCS-safe (no colons) and unique per submission.
    expect(uploads[0]!.name).toBe('surveys/run-2/2026-06-03T12-00-00-000Z.json');
    expect(JSON.parse(uploads[0]!.json)).toMatchObject({ runId: 'run-2', scores: survey.scores });
    // The local copy is written too.
    expect(JSON.parse(await readFile(path.join(runDir, 'survey.json'), 'utf8')).runId).toBe('run-2');
  });

  it('degrades to a local-only ok ack when the cloud upload fails', async () => {
    const logs: string[] = [];
    const uploader: GcsUploader = async () => { throw new Error('403 forbidden'); };
    const result = await persistSurvey(survey, { runDir, runId: 'run-3', uploader, log: (m) => logs.push(m) });
    expect(result.ok).toBe(true);
    expect(result.destination).toBe('local');
    expect(result.detail).toContain('cloud upload failed');
    expect(logs.join('\n')).toContain('403 forbidden');
  });

  it('degrades to a local-only ok ack when the cloud upload stalls past the timeout', async () => {
    const logs: string[] = [];
    // A never-settling uploader — the GCS hang that pinned the browser at
    // "Saving…" before persistSurvey gained an upload timeout.
    const uploader: GcsUploader = () => new Promise<void>(() => {});
    const result = await persistSurvey(survey, {
      runDir, runId: 'run-timeout', uploader, uploadTimeoutMs: 20, log: (m) => logs.push(m),
    });
    expect(result.ok).toBe(true);
    expect(result.destination).toBe('local');
    expect(logs.join('\n')).toContain('timed out');
    // The local copy still landed despite the stalled upload.
    expect(JSON.parse(await readFile(path.join(runDir, 'survey.json'), 'utf8')).runId).toBe('run-timeout');
  });

  it('returns ok:false when both the cloud upload and the local write fail', async () => {
    const uploader: GcsUploader = async () => { throw new Error('no creds'); };
    const result = await persistSurvey(survey, {
      runDir: path.join(runDir, 'does', 'not', 'exist'),
      runId: 'run-4',
      uploader,
      log: () => {},
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on a failed local write with no uploader configured', async () => {
    const result = await persistSurvey(survey, {
      runDir: path.join(runDir, 'missing', 'dir'),
      runId: 'run-5',
      log: () => {},
    });
    expect(result).toMatchObject({ ok: false });
  });
});
