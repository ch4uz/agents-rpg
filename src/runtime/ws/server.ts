import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeServerEnvelope, type ServerEnvelope } from './protocol.js';
import { loadManifest, validateManifest, type AssetManifest } from './manifest.js';

/**
 * Info exposed to the onConnect handler. `sid` is the `?sid=` query param the
 * browser includes when it opens the WS — a fresh uuid per page load. The
 * session manager in bin/play.ts uses it to decide between reattach (same sid,
 * the same tab reconnecting after a blip) and reset (new sid, the user opened
 * a fresh tab / hit refresh).
 */
export interface WsConnectInfo {
  sid: string | null;
  /** True when the upgrade URL carried `reattach=1` — the tab already HELD a
   *  session this page load (it received a snapshot) and is reconnecting to
   *  it. The session manager refuses such a connect when it doesn't know the
   *  sid (server restarted / session reaped) instead of starting a fresh
   *  game — see SessionRegistry "REATTACH-ONLY connects". */
  reattachOnly: boolean;
}

export interface BootedServer {
  port: number;
  server: Server;
  wss: WebSocketServer;
  manifest: AssetManifest;
  /** Called when a fresh WS client connects (after rejecting any duplicate). */
  onConnect: (handler: (ws: WebSocket, info: WsConnectInfo) => void) => void;
  shutdown: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const safeJoin = (root: string, relUrl: string): string | null => {
  const normalized = normalize(relUrl).replace(/^\/+/, '');
  const full = resolvePath(join(root, normalized));
  if (!full.startsWith(resolvePath(root))) return null;
  return full;
};

/** Strip a `?...` query suffix before resolving against the static-file root. */
const stripQuery = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};

/** Pull the `sid` + `reattach` parameters out of a WS upgrade URL like
 *  `/ws?sid=abcd&reattach=1`. */
const parseConnectParams = (url: string | undefined): { sid: string | null; reattachOnly: boolean } => {
  if (!url) return { sid: null, reattachOnly: false };
  const q = url.indexOf('?');
  if (q === -1) return { sid: null, reattachOnly: false };
  const params = new URLSearchParams(url.slice(q + 1));
  const sid = params.get('sid');
  return {
    sid: sid && sid.length > 0 ? sid : null,
    reattachOnly: params.get('reattach') === '1',
  };
};

/** Cookie name carrying the shared-password token once a visitor signs in. */
const AUTH_COOKIE = 'rpg_auth';

/** Parse a `Cookie:` header into a key→value map (values URL-decoded). */
const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
};

/** Minimal sign-in page shown until the visitor presents the shared password.
 *  Posts to `/__login`; on success the server sets the auth cookie + redirects. */
const loginPage = (error: boolean): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agents RPG — Sign in</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1a1410;color:#e8dcc0;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#2a2018;padding:2rem;border-radius:12px;border:1px solid #4a3b28;box-shadow:0 8px 30px rgba(0,0,0,.5);width:280px}
  h1{font-size:1.1rem;margin:0 0 1rem;text-align:center}
  input{width:100%;box-sizing:border-box;padding:.6rem;margin-bottom:.75rem;border-radius:6px;border:1px solid #4a3b28;background:#1a1410;color:#e8dcc0;font-size:1rem}
  button{width:100%;padding:.6rem;border:0;border-radius:6px;background:#b5832e;color:#1a1410;font-weight:600;font-size:1rem;cursor:pointer}
  .err{color:#e0736b;font-size:.85rem;margin-bottom:.5rem;text-align:center}
</style></head>
<body><form method="POST" action="/__login">
<h1>🐀 Basement O' Rats</h1>
${error ? '<div class="err">Incorrect password.</div>' : ''}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Enter</button>
</form></body></html>`;

export const bootWsServer = async (opts: {
  webRoot: string;     // e.g. dist/web
  assetsRoot: string;  // e.g. assets
  port?: number;       // 0 = auto-pick
  /** Default true: kick the prior socket when a second connects. Set false for
   *  spectator/test scenarios where multiple concurrent clients are wanted. */
  singleClient?: boolean;
}): Promise<BootedServer> => {
  const manifestPath = join(opts.assetsRoot, 'manifest.json');
  const manifest = loadManifest(manifestPath);
  validateManifest(manifest, opts.assetsRoot);

  let connectHandler: ((ws: WebSocket, info: WsConnectInfo) => void) | null = null;
  // Active client socket(s) keyed by `sid`. Newest-wins is PER SESSION: a new
  // connection only kicks a still-open prior socket carrying the SAME sid (a
  // stale socket for a tab that's reconnecting), so two DIFFERENT tabs/sids run
  // side by side — that is what lets bin/play.ts host independent games in
  // parallel. Connections with no `?sid=` (legacy clients, the CLI smoke,
  // server tests) share one bucket, preserving the old "second connection kicks
  // the first" behaviour for that case.
  const activeClients = new Map<string, WebSocket>();
  const NO_SID = '__nosid__';  // sentinel bucket for connections without ?sid=

  // Opt-in shared-password gate. Active ONLY when ACCESS_PASSWORD is set, so
  // local `npm run play` and the test suite (which never set it) stay ungated.
  // We use a cookie rather than HTTP Basic Auth because a browser `WebSocket`
  // can't attach an Authorization header, but it DOES send same-origin cookies
  // on the upgrade request — so one cookie protects both the page and the WS.
  // TEMP (2026-06-03): gate disabled by user request — the game is open even
  // when ACCESS_PASSWORD is set (e.g. on the Render deploy). Flip the flag
  // below back to true to restore the password requirement.
  const PASSWORD_GATE_ENABLED = false as boolean;
  const accessPassword = PASSWORD_GATE_ENABLED
    ? process.env['ACCESS_PASSWORD']?.trim() || null
    : null;
  const isAuthed = (req: IncomingMessage): boolean =>
    !accessPassword || parseCookies(req.headers.cookie)[AUTH_COOKIE] === accessPassword;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Gate: until a valid auth cookie is presented, serve only the sign-in page
    // and accept its submission. Everything else (bundle, assets, SPA fallback)
    // is withheld so an unauthenticated visitor can't load the game or its art.
    if (accessPassword && !isAuthed(req)) {
      if (req.method === 'POST' && stripQuery(req.url ?? '') === '/__login') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 4096) req.destroy();  // cap; a password is tiny
        });
        req.on('end', () => {
          const submitted = new URLSearchParams(body).get('password');
          if (submitted === accessPassword) {
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
            res.writeHead(302, {
              'Set-Cookie': `${AUTH_COOKIE}=${encodeURIComponent(accessPassword)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`,
              Location: '/',
            });
            res.end();
          } else {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(loginPage(true));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(false));
      return;
    }

    const url = stripQuery(req.url ?? '/');
    // Sprite paths → assetsRoot. Vite bundle chunks live under /bundle/* and fall through to webRoot.
    if (url.startsWith('/assets/')) {
      const full = safeJoin(opts.assetsRoot, url.slice('/assets/'.length));
      if (!full || !existsSync(full) || !statSync(full).isFile()) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', MIME[extname(full)] ?? 'application/octet-stream');
      res.end(readFileSync(full));
      return;
    }
    // Web bundle → webRoot. SPA fallback to index.html for non-asset paths.
    const reqPath = url === '/' ? '/index.html' : url;
    const full = safeJoin(opts.webRoot, reqPath);
    if (full && existsSync(full) && statSync(full).isFile()) {
      res.setHeader('Content-Type', MIME[extname(full)] ?? 'application/octet-stream');
      res.end(readFileSync(full));
      return;
    }
    const indexFull = safeJoin(opts.webRoot, '/index.html');
    if (indexFull && existsSync(indexFull)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(indexFull));
      return;
    }
    res.statusCode = 404; res.end();
  });

  const wss = new WebSocketServer({ server });
  const singleClient = opts.singleClient !== false;
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Gate the socket itself: a visitor who never signed in (no valid cookie on
    // the upgrade request) is closed before any session — so a direct hit on
    // /ws can't spin up a game and burn the API budget. 1008 = policy violation.
    if (!isAuthed(req)) {
      try { ws.close(1008, 'unauthorized'); } catch { /* socket already dead */ }
      return;
    }
    const { sid, reattachOnly } = parseConnectParams(req.url);
    const key = sid ?? NO_SID;
    // Newest-wins, scoped to this sid: when a second socket connects for the
    // SAME session, kick the old one rather than rejecting the new one. The old
    // tab receives a `rejected: session_in_use` envelope (treated by
    // web/ws-client.ts as a "stop reconnecting" signal) so it cannot oscillate
    // back in. Sockets with a DIFFERENT sid are left untouched — that is what
    // lets independent games run in parallel on one server.
    const prior = activeClients.get(key);
    if (singleClient && prior && prior !== ws && (prior as unknown as { readyState: number }).readyState === 1) {
      try { prior.send(encodeServerEnvelope({ kind: 'rejected', reason: 'session_in_use' } satisfies ServerEnvelope)); } catch { /* socket already dead */ }
      try { prior.close(); } catch { /* idem */ }
    }
    activeClients.set(key, ws);
    ws.on('close', () => { if (activeClients.get(key) === ws) activeClients.delete(key); });
    const info: WsConnectInfo = { sid, reattachOnly };
    if (connectHandler) connectHandler(ws, info);
  });

  await new Promise<void>((resolveListen) => server.listen(opts.port ?? 0, resolveListen));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);

  return {
    port, server, wss, manifest,
    onConnect: (h) => { connectHandler = h; },
    shutdown: async () => {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
};
