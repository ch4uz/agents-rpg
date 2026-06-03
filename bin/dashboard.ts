#!/usr/bin/env tsx
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createGcsReader } from '../src/runtime/metrics/gcs-reader.js';
import { fetchAllRuns } from '../src/runtime/metrics/fetch.js';
import { aggregate } from '../src/runtime/metrics/aggregate.js';
import { renderDashboard } from '../src/runtime/metrics/render-html.js';

/**
 * Build the game-metrics dashboard from the GCS run archive.
 *
 *   npm run dashboard                  # pull the default bucket, write + open dashboard/
 *   npm run dashboard -- --no-open     # don't auto-open the HTML
 *   npm run dashboard -- --out site    # write into ./site instead of ./dashboard
 *   GCS_BUCKET=other npm run dashboard # point at a different bucket
 *
 * Reads runs/<id>/{manifest.json,events.jsonl} and surveys/<id>/*.json (the
 * artifacts run-archive.ts / survey-store.ts upload), aggregates them into
 * pure metrics, and bakes a single self-contained HTML file plus a data.json
 * for downstream notebook analysis. Auth is ADC, same as the uploaders
 * (`gcloud auth application-default login`).
 */

const DEFAULT_BUCKET = 'agents-rpg-surveys-high-torch-494308-r0';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (flag: string): boolean => process.argv.includes(flag);

const main = async (): Promise<void> => {
  const bucket = process.env['GCS_BUCKET'] || DEFAULT_BUCKET;
  if (bucket === 'none' || bucket === '') {
    console.error('GCS_BUCKET is disabled — set a real bucket to build the dashboard.');
    process.exit(1);
  }
  const outDir = path.resolve(process.cwd(), arg('--out') ?? 'dashboard');

  console.error(`[dashboard] reading gs://${bucket}/ …`);
  const reader = createGcsReader(bucket);
  const rawRuns = await fetchAllRuns(reader, { log: (m) => console.error(m) });
  console.error(`[dashboard] fetched ${rawRuns.length} run(s)`);

  const data = aggregate(rawRuns, { bucket, generatedAt: new Date().toISOString() });
  const html = renderDashboard(data);

  await mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'index.html');
  const jsonPath = path.join(outDir, 'data.json');
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');

  console.error(`[dashboard] wrote ${htmlPath}`);
  console.error(`[dashboard] wrote ${jsonPath}`);
  console.error(
    `[dashboard] ${data.runCount} runs · ${data.runsWithSurveys} surveys · ` +
      `mean cache hit ${(data.cacheHit.mean * 100).toFixed(1)}% · ` +
      `${data.ruleViolations.total} rule violations`,
  );

  if (!has('--no-open')) {
    try {
      const { default: open } = await import('open');
      await open(htmlPath);
    } catch {
      console.error(`[dashboard] open it manually: file://${htmlPath}`);
    }
  }
};

main().catch((e) => {
  console.error(`[dashboard] failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
