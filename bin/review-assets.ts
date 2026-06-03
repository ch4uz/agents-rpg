/**
 * review-assets.ts — local server for iterative asset review.
 *
 *   tsx bin/review-assets.ts <candidatesRootDir> [port]
 *
 * Scans <root> for every sub-dir containing a `candidates.json` and renders each
 * as a batch on one dark gallery page. Each asset gets a "⟳ Regenerate" button
 * with an optional comment; clicking it appends a request to <root>/regen-queue.jsonl,
 * which the agent watches. When the agent overwrites a candidate PNG with fresh
 * art, the page's version-poller swaps the image in automatically (no reload).
 *
 * The "🗺 Test maps" tab composes real maps in-browser from the Wang tilesets,
 * using the SAME corner-sampling autotiling the engine uses (web/components/
 * TileMap.ts:chooseTileBox) but over arbitrary hand-authored terrain fields —
 * proving the 16-tile sets can build coherent maps, not just a wall ring.
 *
 * Manifests are re-read on every request, so new batches / new art appear on reload.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] ?? 5180);
if (!root) {
  console.error('usage: tsx bin/review-assets.ts <candidatesRootDir> [port]');
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.json': 'application/json',
};

type Item = { id: string; name: string; type: string; files: string[]; note?: string };
type Manifest = { title: string; batch?: number; style?: string; note?: string; items: Item[] };

// Discover batches = sub-dirs of root that contain candidates.json. Newest first.
function batches(): { dir: string; mtime: number }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'candidates.json')))
    .map((d) => ({ dir: d.name, mtime: statSync(join(root, d.name, 'candidates.json')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function fileVersion(dir: string, file: string): number {
  const p = join(root, dir, file);
  return existsSync(p) ? statSync(p).mtimeMs | 0 : 0;
}

function loadBatch(dir: string) {
  const m: Manifest = JSON.parse(readFileSync(join(root, dir, 'candidates.json'), 'utf8'));
  return {
    dir,
    title: m.title,
    style: m.style ?? '',
    note: m.note ?? '',
    items: m.items.map((it) => ({
      id: it.id,
      name: it.name,
      type: it.type,
      note: it.note ?? '',
      version: Math.max(0, ...it.files.map((f) => fileVersion(dir, f))),
      files: it.files.map((f) => ({
        name: f,
        url: `/asset/${encodeURIComponent(dir)}/${encodeURIComponent(f)}`,
        exists: fileVersion(dir, f) > 0,
      })),
    })),
  };
}

// { dir: { itemId: version } } — polled by the page to auto-swap regenerated art.
function versions() {
  const out: Record<string, Record<string, number>> = {};
  for (const { dir } of batches()) {
    const m: Manifest = JSON.parse(readFileSync(join(root, dir, 'candidates.json'), 'utf8'));
    out[dir] = {};
    for (const it of m.items) out[dir][it.id] = Math.max(0, ...it.files.map((f) => fileVersion(dir, f)));
  }
  return out;
}

// Live map demos — only those whose tileset PNG + metadata exist are shown.
// `terrain` (client-side, keyed by id) defines the 0/1 field over grid vertices.
const ALL_TEST_MAPS = [
  { id: 'sewer', title: 'Sewer — water channel + pool through a stone walkway',
    img: '/asset/sewers/sewer-tileset.png', meta: '/asset/sewers/sewer-tileset.json',
    lower: 'stone walkway', upper: 'sewer water', cols: 16, rows: 9,
    files: ['sewers/sewer-tileset.png', 'sewers/sewer-tileset.json'] },
  { id: 'cave', title: "Rat-den cave — rock walls enclosing a floor, with pillars",
    img: '/asset/basement-o-rats/rat-den-tileset.png', meta: '/asset/basement-o-rats/rat-den-tileset.json',
    lower: 'cave floor', upper: 'rock wall', cols: 14, rows: 9,
    files: ['basement-o-rats/rat-den-tileset.png', 'basement-o-rats/rat-den-tileset.json'] },
  { id: 'river', title: 'Forest river — winding water across a grassy bank',
    img: '/asset/whispering-woods/river-tileset.png', meta: '/asset/whispering-woods/river-tileset.json',
    lower: 'grass', upper: 'river water', cols: 16, rows: 10,
    files: ['whispering-woods/river-tileset.png', 'whispering-woods/river-tileset.json'] },
];
const TEST_MAPS = ALL_TEST_MAPS.filter((m) => m.files.every((f) => existsSync(join(root, f))));

const PAGE = (data: unknown) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Asset review</title>
<style>
  :root{ --bg:#0c0f0d; --panel:#161b18; --panel2:#1d2521; --ink:#cfe0d4; --muted:#7f9486;
         --acc:#5fc27e; --warn:#e0a23a; --danger:#d8643c; --line:#2a332d; }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);min-height:100vh;
       background:radial-gradient(120% 80% at 50% -10%,#13211a 0%,var(--bg) 60%)}
  header{position:sticky;top:0;z-index:5;background:rgba(10,14,12,.93);backdrop-filter:blur(6px);
         border-bottom:1px solid var(--line);padding:12px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:15px;margin:0;letter-spacing:.5px}
  .tabs{display:flex;gap:8px;flex-wrap:wrap}
  .tab{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--muted);
       padding:6px 13px;border-radius:8px}
  .tab.active{color:#06140b;background:var(--acc);border-color:#3a8f55;font-weight:700}
  .grow{flex:1}
  main{max-width:1200px;margin:0 auto;padding:20px 22px 60px}
  .batch{display:none}.batch.active{display:block}
  .bhead{margin:4px 0 16px}.bhead .style{color:var(--acc);font-size:12px}
  .bhead .note{color:var(--muted);font-size:12px;margin-top:4px;max-width:820px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;
        display:flex;flex-direction:column;transition:border-color .15s,box-shadow .15s}
  .card.busy{border-color:var(--warn);box-shadow:0 0 0 1px var(--warn) inset}
  .card.fresh{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
  .thumbs{position:relative;display:flex;gap:6px;padding:14px;min-height:172px;justify-content:center;align-items:center;
      background:repeating-conic-gradient(#11150f 0 25%,#0c0f0d 0 50%) 0 0/22px 22px}
  .thumbs img{image-rendering:pixelated;width:auto;height:148px;max-width:100%;
      filter:drop-shadow(0 4px 8px rgba(0,0,0,.55))}
  .thumbs img.tileset{height:132px;border:1px solid var(--line)}
  .thumbs .ph{color:var(--muted);font-size:12px}
  .spin{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;
      background:rgba(8,11,9,.78);color:var(--warn);font-size:12px}
  .card.busy .spin{display:flex}
  .spin .ring{width:24px;height:24px;border:3px solid var(--line);border-top-color:var(--warn);
      border-radius:50%;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .meta{padding:12px 14px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
  .meta .name{font-weight:600}
  .badge{align-self:flex-start;font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:2px 7px;border-radius:5px;color:#06140b}
  .badge.tileset{background:#6aa9e0}.badge.obstacle{background:#b08968}.badge.trap{background:var(--danger)}
  .badge.decoration{background:#8fd17a}.badge.character{background:#c79be0}
  .itemnote{color:var(--warn);font-size:11px;line-height:1.35}
  textarea{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:7px;
      padding:7px 9px;font:inherit;resize:vertical;min-height:36px}
  .regen{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #6a4d22;background:#2a2113;color:var(--warn);
      padding:8px 12px;font-weight:600}
  .regen:hover{background:#352a18}
  .regen:disabled{opacity:.55;cursor:not-allowed}
  /* test maps */
  .mapcard{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:18px}
  .maptitle{font-weight:600;margin-bottom:4px}
  .legend{color:var(--muted);font-size:12px;margin-bottom:12px}
  .legend b{color:var(--ink)}
  .mapcard canvas{image-rendering:pixelated;max-width:100%;border:1px solid var(--line);border-radius:6px;
      background:#05070a;display:block}
</style></head>
<body>
<header>
  <h1>🎨 Asset review</h1>
  <div class="tabs" id="tabs"></div>
  <span class="grow"></span>
  <span id="poll" style="color:var(--muted);font-size:11px">live ●</span>
</header>
<main id="main"></main>
<script>
const DATA = ${JSON.stringify(data)};
const BATCHES = DATA.batches, TEST_MAPS = DATA.testMaps || [];
const main = document.getElementById('main'), tabsEl = document.getElementById('tabs');
const known = {}; // dir -> id -> version

function activate(dir){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.dir === dir));
  document.querySelectorAll('.batch').forEach(s => s.classList.toggle('active', s.dataset.dir === dir));
}
function addTab(dir, label){
  const tab = document.createElement('button'); tab.className = 'tab'; tab.textContent = label; tab.dataset.dir = dir;
  tab.onclick = () => activate(dir); tabsEl.appendChild(tab); return tab;
}

function card(dir, it){
  const c = document.createElement('div'); c.className = 'card'; c.dataset.dir = dir; c.dataset.id = it.id;
  known[dir] = known[dir] || {}; known[dir][it.id] = it.version;
  const thumbs = it.files.map(f => f.exists
    ? '<img class="'+(it.type==='tileset'?'tileset':'')+'" src="'+f.url+'?v='+it.version+'" alt="'+it.name+'">'
    : '<div class="ph">— not generated yet —</div>').join('');
  c.innerHTML =
    '<div class="thumbs">'+thumbs+'<div class="spin"><div class="ring"></div>regenerating…</div></div>'+
    '<div class="meta"><span class="name">'+it.name+'</span>'+
    '<span class="badge '+it.type+'">'+it.type+'</span>'+
    (it.note ? '<span class="itemnote">⚠ '+it.note+'</span>' : '')+
    '<textarea placeholder="optional: what to change (e.g. darker, more rust, top-down)…"></textarea>'+
    '<button class="regen">⟳ Regenerate'+(it.type==='character'?' (heavy)':'')+'</button></div>';
  const btn = c.querySelector('button'), ta = c.querySelector('textarea');
  btn.addEventListener('click', async () => {
    btn.disabled = true; c.classList.add('busy'); c.classList.remove('fresh');
    await fetch('/regenerate', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ batch: dir, id: it.id, comment: ta.value.trim() })});
    ta.value = '';
  });
  return c;
}

/* ---- Test-map autotiler: same corner-sampling as TileMap.ts:chooseTileBox ---- */
// Terrain field over grid VERTICES. (x,y) range 0..cols / 0..rows. 1 = upper.
const TERRAIN = {
  sewer: (x,y,c,r) => {
    const mid = 4.3 + 1.7*Math.sin(x*0.5);                 // wavy channel down the middle
    if (Math.abs(y - mid) <= 1.15) return 1;
    if ((x-12)*(x-12) + (y-6.5)*(y-6.5) <= 6) return 1;    // a pool bulging off it
    return 0;
  },
  cave: (x,y,c,r) => {
    if (x===0 || x===c || y===0 || y===r) return 1;        // enclosing rock wall
    if (x>=4 && x<=5 && y>=3 && y<=4) return 1;            // rock pillar
    if (x>=9 && x<=10 && y>=5 && y<=6) return 1;           // rock pillar
    return 0;
  },
  river: (x,y,c,r) => {
    const mid = 1.4 + 0.5*x + 1.5*Math.sin(x*0.7);         // diagonal winding river
    return Math.abs(y - mid) <= 1.0 ? 1 : 0;
  },
};
function pickBox(NW,NE,SW,SE, tiles){
  for (const t of tiles){ const k=t.corners; if (k.NW===NW&&k.NE===NE&&k.SW===SW&&k.SE===SE) return t.bbox; }
  return tiles[0].bbox; // defensive — all 16 combos exist, so never hit
}
function loadImage(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
async function renderTestMaps(){
  for (const m of TEST_MAPS){
    const canvas = document.getElementById('map-'+m.id);
    if (!canvas || canvas.dataset.done) continue;
    try {
      const [img, raw] = await Promise.all([ loadImage(m.img), fetch(m.meta).then(r=>r.json()) ]);
      const tw = raw.tile_size.width, th = raw.tile_size.height;
      const tiles = raw.tileset_data.tiles.map(t => ({ corners: t.corners, bbox: t.bounding_box }));
      const T = (x,y) => TERRAIN[m.id](x,y,m.cols,m.rows) === 1 ? 'upper' : 'lower';
      canvas.width = m.cols*tw; canvas.height = m.rows*th;
      const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
      for (let cy=0; cy<m.rows; cy++) for (let cx=0; cx<m.cols; cx++){
        const b = pickBox(T(cx,cy), T(cx+1,cy), T(cx,cy+1), T(cx+1,cy+1), tiles);
        ctx.drawImage(img, b.x, b.y, b.width, b.height, cx*tw, cy*th, tw, th);
      }
      canvas.style.width = Math.min(m.cols*tw*3, 1100) + 'px';
      canvas.dataset.done = '1';
    } catch(e){ canvas.outerHTML = '<div class="legend">⚠ failed to render: '+e+'</div>'; }
  }
}

// ---- Build tabs + sections ----
if (TEST_MAPS.length){
  addTab('__maps__', '🗺 Test maps');
  const sec = document.createElement('section'); sec.className='batch'; sec.dataset.dir='__maps__';
  sec.innerHTML = '<div class="bhead"><div class="style">Composed live in your browser from the 16-tile Wang sets — same corner-match autotiling the engine uses (TileMap.ts), but over arbitrary hand-authored terrain instead of a plain wall ring.</div></div>';
  for (const m of TEST_MAPS){
    const c = document.createElement('div'); c.className='mapcard';
    c.innerHTML = '<div class="maptitle">'+m.title+'</div>'+
      '<div class="legend">floor (lower) = <b>'+m.lower+'</b> · raised (upper) = <b>'+m.upper+'</b> · '+m.cols+'×'+m.rows+' tiles</div>'+
      '<canvas id="map-'+m.id+'"></canvas>';
    sec.appendChild(c);
  }
  main.appendChild(sec);
}
BATCHES.forEach((b) => {
  addTab(b.dir, b.title + ' ('+b.items.length+')');
  const sec = document.createElement('section'); sec.className='batch'; sec.dataset.dir=b.dir;
  sec.innerHTML = '<div class="bhead"><div class="style">'+(b.style||'')+'</div>'+(b.note?'<div class="note">'+b.note+'</div>':'')+'</div>';
  const grid = document.createElement('div'); grid.className='grid';
  b.items.forEach(it => grid.appendChild(card(b.dir, it)));
  sec.appendChild(grid); main.appendChild(sec);
});
activate(TEST_MAPS.length ? '__maps__' : (BATCHES[0] && BATCHES[0].dir));
renderTestMaps();

// Poll for regenerated art and swap images in place.
async function poll(){
  try{
    const v = await (await fetch('/versions')).json();
    for(const dir in v) for(const id in v[dir]){
      const nv = v[dir][id], ov = (known[dir]||{})[id];
      if(ov!=null && nv!==ov){
        known[dir][id]=nv;
        const c = document.querySelector('.card[data-dir="'+dir+'"][data-id="'+id+'"]');
        if(c){ c.classList.remove('busy'); c.classList.add('fresh');
          const img=c.querySelector('img'); if(img) img.src = img.src.replace(/\\?v=.*/,'')+'?v='+nv;
          else location.reload(); }
      }
    }
  }catch(e){}
  setTimeout(poll, 2500);
}
poll();
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method === 'POST' && url.pathname === '/regenerate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body || '{}');
      const line = JSON.stringify({ ts: new Date().toISOString(), batch: r.batch, id: r.id, comment: r.comment ?? '' });
      appendFileSync(join(root, 'regen-queue.jsonl'), line + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      console.log(`[review] regen queued: ${r.batch}/${r.id}${r.comment ? ' — "' + r.comment + '"' : ''}`);
    });
    return;
  }
  if (url.pathname === '/versions') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(versions()));
    return;
  }
  if (url.pathname === '/') {
    const data = { batches: batches().map((b) => loadBatch(b.dir)), testMaps: TEST_MAPS };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE(data));
    return;
  }
  if (url.pathname.startsWith('/asset/')) {
    const [, , dir, file] = url.pathname.split('/').map(decodeURIComponent);
    const p = join(root, dir, file);
    if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(p));
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(port, () => {
  console.log(`[review] root: ${root}`);
  console.log(`[review] batches: ${batches().map((b) => b.dir).join(', ') || '(none)'}`);
  console.log(`[review] test maps: ${TEST_MAPS.map((m) => m.id).join(', ') || '(none)'}`);
  console.log(`[review] open  http://localhost:${port}`);
});
