import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveRunArtifacts, runArtifactObjectName } from '../../src/runtime/run-archive.js';
import type { GcsUploader } from '../../src/runtime/survey-store.js';

/**
 * Pins the end-of-run GCS archive (src/runtime/run-archive.ts):
 *   1. events.jsonl + manifest.json upload under runs/<runId>/ with their
 *      content and content types intact.
 *   2. A missing artifact (e.g. no manifest on a crash path) is skipped — not
 *      a failure.
 *   3. One artifact failing to upload is reported + logged but never thrown,
 *      and does not stop the other artifact.
 */
describe('run-archive', () => {
  let runDir: string;
  const EVENTS = '{"t":0,"type":"narrate"}\n{"t":1,"type":"action"}\n';
  const MANIFEST = '{"runId":"run-9","outcome":"success"}\n';

  beforeEach(async () => { runDir = await mkdtemp(path.join(tmpdir(), 'run-archive-')); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  const seed = async (files: Record<string, string>) => {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(runDir, name), body, 'utf8');
    }
  };

  it('uploads events.jsonl + manifest.json under runs/<runId>/ with content types', async () => {
    await seed({ 'events.jsonl': EVENTS, 'manifest.json': MANIFEST });
    const uploads: Array<{ name: string; body: string; contentType?: string }> = [];
    const uploader: GcsUploader = async (name, body, contentType) => {
      uploads.push({ name, body, ...(contentType !== undefined ? { contentType } : {}) });
    };
    const res = await archiveRunArtifacts({ runDir, runId: 'run-9', uploader });
    expect(res).toEqual({ uploaded: ['events.jsonl', 'manifest.json'], failed: [] });
    expect(uploads).toEqual([
      { name: 'runs/run-9/events.jsonl', body: EVENTS, contentType: 'application/x-ndjson' },
      { name: 'runs/run-9/manifest.json', body: MANIFEST, contentType: 'application/json' },
    ]);
    expect(runArtifactObjectName('run-9', 'events.jsonl')).toBe('runs/run-9/events.jsonl');
  });

  it('skips a missing manifest (crash path) and still archives the event log', async () => {
    await seed({ 'events.jsonl': EVENTS });
    const names: string[] = [];
    const uploader: GcsUploader = async (name) => { names.push(name); };
    const res = await archiveRunArtifacts({ runDir, runId: 'run-x', uploader });
    expect(res).toEqual({ uploaded: ['events.jsonl'], failed: [] });
    expect(names).toEqual(['runs/run-x/events.jsonl']);
  });

  it('reports an upload failure without throwing and still uploads the rest', async () => {
    await seed({ 'events.jsonl': EVENTS, 'manifest.json': MANIFEST });
    const logs: string[] = [];
    const uploader: GcsUploader = async (name) => {
      if (name.endsWith('events.jsonl')) throw new Error('403 forbidden');
    };
    const res = await archiveRunArtifacts({ runDir, runId: 'run-f', uploader, log: (m) => logs.push(m) });
    expect(res).toEqual({ uploaded: ['manifest.json'], failed: ['events.jsonl'] });
    expect(logs.join('\n')).toContain('403 forbidden');
  });

  it('an empty run dir archives nothing and reports no failures', async () => {
    const uploader: GcsUploader = async () => { throw new Error('should not be called'); };
    const res = await archiveRunArtifacts({ runDir, runId: 'run-0', uploader });
    expect(res).toEqual({ uploaded: [], failed: [] });
  });
});
