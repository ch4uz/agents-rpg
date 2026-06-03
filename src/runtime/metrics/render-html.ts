import type { DashboardData, DimensionStat, LatencyStat, RunSummary } from './aggregate.js';

/**
 * Render {@link DashboardData} into a single self-contained HTML document —
 * inline CSS, hand-rolled CSS/SVG charts, and a tiny click-to-sort table, with
 * no external requests so the file opens offline and can be archived or shared
 * as-is. Pure: same data in → same string out (snapshot-testable).
 */

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 12345 → "12,345". Locale-independent so output is deterministic. */
const num = (n: number): string => {
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toString();
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);

const shortRunId = (runId: string): string => {
  // 2026-06-03T21-53-19-130Z-basement-o-rats-4d7df72e → "06-03 21:53 · 4d7df72e"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z-.*-([0-9a-f]+)$/.exec(runId);
  if (!m) return runId;
  const [, , mo, d, h, mi, hash] = m as unknown as string[];
  return `${mo}-${d} ${h}:${mi} · ${hash}`;
};

interface BarRow {
  label: string;
  value: number;
  display?: string;
}

/** Tableau-10 categorical palette — distinct, projector-legible bar colors. */
const PALETTE = [
  'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)',
  'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)',
];

/** Outcome bars carry meaning, so color them semantically. */
const OUTCOME_COLOR: Record<string, string> = {
  success: 'var(--ok)',
  failure: 'var(--bad)',
  'in-progress': 'var(--warn)',
};

interface BarOpts {
  /** Single fill for every bar. */
  color?: string;
  /** Cycle a palette per bar (categorical breakdowns). */
  palette?: string[];
  /** Per-label override; wins over palette/color (e.g. outcomes). */
  colorByLabel?: (label: string) => string | undefined;
}

/** Horizontal CSS bars sharing one max so lengths are comparable. */
const barChart = (rows: BarRow[], opts: BarOpts = {}): string => {
  if (rows.length === 0) return `<p class="empty">No data.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const colorAt = (label: string, i: number): string => {
    const byLabel = opts.colorByLabel?.(label);
    if (byLabel) return byLabel;
    if (opts.palette) return opts.palette[i % opts.palette.length] ?? 'var(--accent)';
    return opts.color ?? 'var(--accent)';
  };
  return `<div class="bars">${rows
    .map(
      (r, i) => `<div class="bar-row">
        <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(r.value / max) * 100}%;background:${colorAt(r.label, i)}"></span></span>
        <span class="bar-val">${esc(r.display ?? num(r.value))}</span>
      </div>`,
    )
    .join('')}</div>`;
};

const recordRows = (rec: Record<string, number>): BarRow[] =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

const card = (value: string, label: string, sub?: string): string =>
  `<div class="card"><div class="card-value">${esc(value)}</div><div class="card-label">${esc(label)}</div>${
    sub ? `<div class="card-sub">${esc(sub)}</div>` : ''
  }</div>`;

const section = (
  title: string,
  body: string,
  opts: { note?: string; panel?: boolean } = {},
): string => {
  const inner = `<h2>${esc(title)}</h2>${opts.note ? `<p class="note">${esc(opts.note)}</p>` : ''}${body}`;
  return `<section${opts.panel ? ' class="panel"' : ''}>${inner}</section>`;
};

/** A 1..5 distribution rendered as a labeled mini bar chart + the mean gauge. */
const dimensionRow = (d: DimensionStat): string => {
  const maxBucket = Math.max(...d.distribution, 1);
  const cols = d.distribution
    .map(
      (count, i) =>
        `<span class="dist-col" title="score ${i + 1}: ${count}">
           <span class="dist-barwrap"><span class="dist-bar" style="height:${(count / maxBucket) * 100}%${count > 0 ? ';min-height:4px' : ''}"></span></span>
           <span class="dist-tick">${i + 1}</span>
           <span class="dist-n">${count}</span>
         </span>`,
    )
    .join('');
  const meanPct = d.mean != null ? (d.mean / 5) * 100 : 0;
  return `<div class="dim">
      <div class="dim-head">
        <span class="dim-label">${esc(d.label)}</span>
        <span class="dim-mean">${d.mean != null ? `${d.mean.toFixed(2)} / 5` : '—'} <em>(n=${d.n})</em></span>
      </div>
      <div class="dim-gauge"><span class="dim-gauge-fill" style="width:${meanPct}%"></span></div>
      <div class="dist">${cols}</div>
    </div>`;
};

const latencyRows = (latency: Record<string, LatencyStat>): string => {
  const entries = Object.entries(latency).sort((a, b) => b[1].meanMs - a[1].meanMs);
  if (entries.length === 0) return `<p class="empty">No latency data.</p>`;
  const max = Math.max(...entries.map(([, s]) => s.maxMs), 1);
  return `<table class="lat">
    <thead><tr><th>Role</th><th>Calls</th><th>Mean</th><th>Max</th><th></th></tr></thead>
    <tbody>${entries
      .map(
        ([role, s]) => `<tr>
          <td class="mono">${esc(role)}</td>
          <td class="r">${num(s.calls)}</td>
          <td class="r">${ms(s.meanMs)}</td>
          <td class="r">${ms(s.maxMs)}</td>
          <td class="lat-bar"><span class="lat-mean" style="width:${(s.meanMs / max) * 100}%"></span><span class="lat-max" style="left:${(s.maxMs / max) * 100}%"></span></td>
        </tr>`,
      )
      .join('')}</tbody></table>`;
};

const runRow = (r: RunSummary): string => {
  const viol = r.events ? r.events.ruleViolations : null;
  const violClass = viol == null ? '' : viol === 0 ? 'ok' : 'bad';
  const cacheClass = r.cacheHitRatio >= 0.3 ? 'ok' : r.cacheHitRatio > 0 ? 'warn' : 'bad';
  const outcomeClass =
    r.outcome === 'success' ? 'ok' : r.outcome === 'failure' ? 'bad' : 'warn';
  return `<tr>
    <td data-sort="${esc(r.runId)}" class="mono">${esc(shortRunId(r.runId))}</td>
    <td data-sort="${esc(r.outcome)}"><span class="pill ${outcomeClass}">${esc(r.outcome)}</span></td>
    <td data-sort="${esc(r.language)}">${esc(r.language)}</td>
    <td data-sort="${esc(r.dmModel ?? '')}" class="mono">${esc(r.dmModel ?? '—')}</td>
    <td data-sort="${r.durationMs ?? -1}" class="r">${r.durationMs != null ? ms(r.durationMs) : '—'}</td>
    <td data-sort="${r.events?.lastStep ?? -1}" class="r">${r.events ? num(r.events.lastStep) : '—'}</td>
    <td data-sort="${r.tokensIn}" class="r">${num(r.tokensIn)}</td>
    <td data-sort="${r.tokensOut}" class="r">${num(r.tokensOut)}</td>
    <td data-sort="${r.cacheHitRatio}" class="r"><span class="pill ${cacheClass}">${pct(r.cacheHitRatio)}</span></td>
    <td data-sort="${r.totalLlmCalls}" class="r">${num(r.totalLlmCalls)}</td>
    <td data-sort="${viol ?? -1}" class="r">${viol == null ? '—' : `<span class="pill ${violClass}">${viol}</span>`}</td>
    <td data-sort="${r.hasSurvey ? 1 : 0}" class="c">${r.hasSurvey ? '✓' : ''}</td>
  </tr>`;
};

const runTable = (runs: RunSummary[]): string => {
  const headers = [
    'Run',
    'Outcome',
    'Lang',
    'DM model',
    'Duration',
    'Steps',
    'Tokens in',
    'Tokens out',
    'Cache hit',
    'LLM calls',
    'Violations',
    'Survey',
  ];
  return `<table id="runs" class="runs">
    <thead><tr>${headers.map((h, i) => `<th data-col="${i}">${esc(h)}<span class="arrow"></span></th>`).join('')}</tr></thead>
    <tbody>${runs.map(runRow).join('')}</tbody>
  </table>`;
};

const momentsList = (data: DashboardData): string => {
  if (data.surveyMoments.length === 0) return `<p class="empty">No free-text moments submitted.</p>`;
  return `<ul class="moments">${data.surveyMoments
    .map(
      (m) => `<li><blockquote>${esc(m.moment)}</blockquote>
        <span class="moment-meta mono">${esc(shortRunId(m.runId))} · ${esc(m.language)}</span></li>`,
    )
    .join('')}</ul>`;
};

const STYLE = `
:root{
  --bg:#ffffff;--panel:#ffffff;--panel2:#eef1f6;--ink:#1f2a37;--muted:#5b6b7c;
  --line:#e3e8ef;--accent:#3f6fa3;--accent2:#2f8f76;
  --ok:#3f9142;--warn:#e2982f;--bad:#d6453d;
  --c1:#4e79a7;--c2:#f28e2b;--c3:#59a14f;--c4:#e15759;
  --c5:#b07aa1;--c6:#76b7b2;--c7:#edae49;--c8:#9c755f;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:36px 28px 96px}
header h1{margin:0 0 6px;font-size:28px;letter-spacing:.2px;font-weight:700}
header .meta{color:var(--muted);font-size:13px;line-height:1.6}
header .meta code{color:var(--accent);background:var(--panel2);padding:1px 6px;border-radius:5px}
section{margin-top:36px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:1.4px;color:#334155;font-weight:700;border-bottom:2px solid var(--line);padding-bottom:9px;margin:0 0 18px}
.note{color:var(--muted);font-size:13px;margin:-8px 0 16px}
.empty{color:var(--muted);font-style:italic}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;box-shadow:0 1px 3px rgba(15,23,42,.05)}
.panel>h2{border:0;padding:0;margin:0 0 4px}
.panel>.note{margin:0 0 18px}
.panel-title{margin:0 0 14px;font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:700}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:0 1px 3px rgba(15,23,42,.05)}
.card-value{font-size:32px;font-weight:700;color:var(--ink);line-height:1.1;font-variant-numeric:tabular-nums}
.card-label{font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-top:6px;font-weight:600}
.card-sub{font-size:12px;color:var(--accent);margin-top:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.bars{display:flex;flex-direction:column;gap:12px}
.bar-row{display:grid;grid-template-columns:175px 1fr 64px;align-items:center;gap:14px;font-size:14px}
.bar-label{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:var(--panel2);border-radius:7px;height:26px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:7px;min-width:3px}
.bar-val{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:700;font-size:15px}
.dim{margin-bottom:26px}
.dim:last-child{margin-bottom:6px}
.dim-head{display:flex;justify-content:space-between;align-items:baseline;font-size:15px;margin-bottom:8px}
.dim-label{color:var(--ink);font-weight:600}
.dim-mean{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700;font-size:16px}
.dim-mean em{color:var(--muted);font-style:normal;font-size:12px;font-weight:500}
.dim-gauge{height:12px;background:var(--panel2);border-radius:6px;overflow:hidden}
.dim-gauge-fill{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--c1),var(--c3))}
.dist{display:flex;gap:10px;align-items:flex-end;margin-top:12px}
.dist-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.dist-barwrap{width:100%;height:72px;display:flex;align-items:flex-end}
.dist-bar{width:100%;background:var(--accent);border-radius:5px 5px 0 0}
.dist-tick{font-size:12px;color:var(--ink);font-weight:600}
.dist-n{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:9px 11px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;cursor:pointer;user-select:none;white-space:nowrap;font-weight:700}
th .arrow{margin-left:4px;color:var(--accent);font-size:10px}
td.r,th.r{text-align:right}td.c{text-align:center}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.runs tbody tr:hover{background:var(--panel2)}
.pill{display:inline-block;padding:2px 10px;border-radius:11px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.pill.ok{background:rgba(63,145,66,.14);color:var(--ok)}
.pill.warn{background:rgba(226,152,47,.18);color:#a86a12}
.pill.bad{background:rgba(214,69,61,.14);color:var(--bad)}
.lat td{border-bottom:1px solid var(--line)}
.lat-bar{position:relative;width:180px;height:18px;background:var(--panel2);border-radius:5px}
.lat-mean{position:absolute;left:0;top:0;height:100%;background:var(--accent);border-radius:5px}
.lat-max{position:absolute;top:-3px;width:3px;height:24px;background:var(--bad);border-radius:2px}
.moments{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}
.moments blockquote{margin:0;padding:14px 18px;background:var(--panel2);border-left:4px solid var(--accent);border-radius:0 10px 10px 0;font-size:14px}
.moment-meta{color:var(--muted);font-size:11px;margin-top:6px;display:block}
.scroll{overflow-x:auto}
footer{margin-top:56px;color:var(--muted);font-size:12px;text-align:center}
`;

const SORT_JS = `
(function(){
  var table=document.getElementById('runs');if(!table)return;
  var tbody=table.tBodies[0];
  var ths=table.tHead.rows[0].cells;
  var sortState={col:0,dir:-1};
  function sortBy(col){
    var dir=sortState.col===col?-sortState.dir:-1;
    sortState={col:col,dir:dir};
    var rows=Array.prototype.slice.call(tbody.rows);
    rows.sort(function(a,b){
      var av=a.cells[col].getAttribute('data-sort'),bv=b.cells[col].getAttribute('data-sort');
      var an=parseFloat(av),bn=parseFloat(bv);
      var cmp=(!isNaN(an)&&!isNaN(bn))?an-bn:String(av).localeCompare(String(bv));
      return cmp*dir;
    });
    rows.forEach(function(r){tbody.appendChild(r)});
    for(var i=0;i<ths.length;i++){ths[i].querySelector('.arrow').textContent=i===col?(dir<0?'▼':'▲'):'';}
  }
  for(var i=0;i<ths.length;i++){(function(i){ths[i].addEventListener('click',function(){sortBy(i)})})(i);}
  sortBy(0);
})();
`;

export const renderDashboard = (data: DashboardData): string => {
  const range =
    data.dateRange.first && data.dateRange.last
      ? `${data.dateRange.first.slice(0, 10)} → ${data.dateRange.last.slice(0, 10)}`
      : '—';

  const overview = `<div class="cards">
    ${card(num(data.runCount), 'Runs archived')}
    ${card(`${num(data.completedCount)}`, 'Reached an ending', `${num(data.runCount - data.completedCount)} abandoned / in-progress`)}
    ${card(num(data.partyWipeCount), 'Party wipes')}
    ${card(num(data.runsWithSurveys), 'Runs with a survey')}
    ${card(num(data.tokens.totalIn + data.tokens.totalOut), 'Total tokens', `${num(data.tokens.totalIn)} in · ${num(data.tokens.totalOut)} out`)}
    ${card(pct(data.cacheHit.mean), 'Mean cache hit', `${data.cacheHit.belowThreshold} run(s) below ${pct(data.cacheHit.threshold)}`)}
  </div>`;

  const breakdowns = `<div class="grid2">
    <div>${section('Outcomes', barChart(recordRows(data.outcomes), { palette: PALETTE, colorByLabel: (l) => OUTCOME_COLOR[l] }), { panel: true })}</div>
    <div>${section('Language', barChart(recordRows(data.languageSplit), { palette: PALETTE }), { panel: true })}</div>
  </div>`;

  const modelsActions = `<div class="grid2">
    <div>${section('Models used (per agent)', barChart(recordRows(data.modelSplit), { palette: PALETTE }), { panel: true })}</div>
    <div>${section('Player actions by kind', barChart(recordRows(data.actionsByKind), { palette: PALETTE }), { panel: true })}</div>
  </div>`;

  const violationRows = recordRows(data.ruleViolations.byReason);
  const quality = section(
    'Rule violations',
    `<div class="cards" style="margin-bottom:20px">
      ${card(num(data.ruleViolations.total), 'Total violations')}
      ${card(`${num(data.ruleViolations.runsWithZero)} / ${num(data.ruleViolations.runsWithEvents)}`, 'Clean runs', 'zero violations / runs with an event log')}
    </div>
    <div class="grid2">
      <div class="panel"><h3 class="panel-title">By reason</h3>${barChart(violationRows, { color: 'var(--bad)' })}</div>
      <div class="panel"><h3 class="panel-title">By actor</h3>${barChart(recordRows(data.ruleViolations.byActor), { color: 'var(--bad)' })}</div>
    </div>`,
    { note: 'Engine-rejected actions. The Layer-C smoke target is zero per run.' },
  );

  const latency = section(
    'LLM latency by role',
    latencyRows(data.latencyByRole),
    { note: 'Wall-clock per round-trip, pooled across all runs. Bar = mean; red tick = max.', panel: true },
  );

  const survey = section(
    'Playtest survey',
    data.runsWithSurveys === 0
      ? `<p class="empty">No surveys submitted yet.</p>`
      : `${data.surveyDimensions.map(dimensionRow).join('')}
         <h3 class="panel-title" style="margin-top:30px">Memorable moments</h3>${momentsList(data)}`,
    { note: 'Five teaming statements (1–5) plus mental effort, pooled across every submission.', panel: true },
  );

  const runs = section(
    'Per-run detail',
    `<div class="scroll">${runTable(data.runs)}</div>`,
    { note: 'Click a column header to sort. Newest run first by default.', panel: true },
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agents-rpg · game metrics</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
  <header>
    <h1>⚔️ agents-rpg — game metrics</h1>
    <div class="meta">
      <code>${esc(data.bucket)}</code> · ${esc(data.runCount)} runs · ${esc(range)}<br>
      generated ${esc(data.generatedAt)}
    </div>
  </header>
  ${section('Overview', overview)}
  ${breakdowns}
  ${section('Tokens & cache', `<div class="cards">
    ${card(num(data.tokens.meanIn), 'Mean tokens in / run')}
    ${card(num(data.tokens.meanOut), 'Mean tokens out / run')}
    ${card(pct(data.cacheHit.mean), 'Mean cache hit', `min ${pct(data.cacheHit.min)} · max ${pct(data.cacheHit.max)}`)}
    ${card(`${num(data.cacheHit.belowThreshold)}`, `Runs below ${pct(data.cacheHit.threshold)}`)}
  </div>`)}
  ${latency}
  ${modelsActions}
  ${quality}
  ${survey}
  ${runs}
  <footer>agents-rpg dashboard · data embedded below for re-analysis</footer>
  <script type="application/json" id="dashboard-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  <script>${SORT_JS}</script>
</div></body></html>`;
};
