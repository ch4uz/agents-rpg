import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeManifest, type RunManifest } from '../../src/log/manifest.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'manifest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('manifest', () => {
  it('writes and re-reads a complete manifest', async () => {
    const m: RunManifest = {
      runId: 'test-run-1',
      startedAt: '2026-05-08T14:00:00Z',
      endedAt: '2026-05-08T15:00:00Z',
      outcome: 'success',
      adventure: 'stub-one-scene@v1',
      rngSeed: 'abc123',
      agents: [],
      human: null,
      stepBudget: 6,
      totalEvents: 42,
      totalLlmCalls: {},
      totalTokens: { in: 0, out: 0 },
      cacheHitRatio: 0,
    };
    await writeManifest(join(dir, 'manifest.json'), m);
    const read = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(read).toEqual(m);
  });
});
