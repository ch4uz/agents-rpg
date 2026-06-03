import { describe, it, expect } from 'vitest';
import { aggregate, type RawRun } from '../../../src/runtime/metrics/aggregate.js';
import { renderDashboard } from '../../../src/runtime/metrics/render-html.js';
import type { RunManifest } from '../../../src/log/manifest.js';

/**
 * Smoke + escaping guarantees for the HTML renderer: it emits a self-contained
 * document (no external script/style src), surfaces the headline numbers, and
 * escapes tester free-text so a survey moment can't inject markup.
 */

const manifest = (): RunManifest => ({
  runId: 'r',
  startedAt: '2026-06-03T10:00:00.000Z',
  endedAt: '2026-06-03T10:05:00.000Z',
  outcome: 'in-progress',
  adventure: 'basement-o-rats@v1',
  rngSeed: 'seed',
  agents: [{ role: 'dm', model: 'gemini-3.5-flash', promptHash: 'h' }],
  human: { characterId: 'p2' },
  stepBudget: 6,
  totalEvents: 1,
  totalLlmCalls: { dm: 1 },
  totalTokens: { in: 1000, out: 200 },
  cacheHitRatio: 0.5,
  language: 'en',
});

describe('renderDashboard', () => {
  const data = aggregate(
    [
      {
        runId: '2026-06-03T10-00-00-000Z-x-aaa',
        manifest: manifest(),
        eventsJsonl: '{"t":1,"type":"adventure_ended","outcome":"success"}',
        surveys: [
          {
            runId: '2026-06-03T10-00-00-000Z-x-aaa',
            submittedAt: '2026-06-03T12:00:00.000Z',
            scores: { coordination: 5 },
            moment: '<script>alert(1)</script> best moment',
          },
        ],
      } satisfies RawRun,
    ],
    { bucket: 'my-bucket', generatedAt: '2026-06-04T00:00:00.000Z' },
  );

  const html = renderDashboard(data);

  it('produces a self-contained document with no external resources', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain('my-bucket');
    expect(html).toContain('2026-06-04T00:00:00.000Z');
  });

  it('escapes tester free-text so moments cannot inject markup', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('embeds the raw data payload for re-analysis', () => {
    expect(html).toContain('id="dashboard-data"');
    // the embedded JSON escapes "<" so it can never close a tag early
    expect(html).not.toContain('</script>alert');
  });
});
