import { parseServerEnvelope, type ClientEnvelope, type ServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { Store } from './store.js';
import { createDeferredDispatcher } from './ws-deferred.js';
import { notifyRollMounted, notifyRollResolved, waitForRollResolved } from './components/roll-events.js';

export interface WsClient {
  send(msg: ClientEnvelope): void;
}

/** Faces the browser's 3D physics settled on for one attack roll. */
export interface RollRequestResult {
  attackerFaces: number[];
  defenderFaces: number[];
}

/** A `roll_request` from the server: roll the dice and report what they land
 *  on. The host (main.ts) drives the 3D overlay and resolves with the settled
 *  faces; ws-client relays them back as a `roll_response`. */
export type RollRequest = Extract<ServerEnvelope, { kind: 'roll_request' }>;

/**
 * A `reveal_request` from the server: combat has begun and the server is
 * holding the first turn until the player dismisses the on-screen Order of
 * Battle. The host (main.ts) resolves the returned promise when the reveal
 * is dismissed (Skip click, or auto-skip); ws-client then relays a
 * `reveal_ack` so the server proceeds.
 */
export type RevealRequest = Extract<ServerEnvelope, { kind: 'reveal_request' }>;

/**
 * An `opening_request` from the server: at game start the server is holding the
 * DM's first turn until the player dismisses the title splash. The host
 * (main.ts) resolves the returned promise when the player clicks "Begin";
 * ws-client then relays an `opening_ack` so the server proceeds.
 */
export type OpeningRequest = Extract<ServerEnvelope, { kind: 'opening_request' }>;

/**
 * A `hero_select_request` from the server: at game start the server is holding
 * the whole run until the player chooses which starting hero they control. The
 * host (main.ts) shows the "Choose your hero" screen and resolves the returned
 * promise with the chosen hero's characterId; ws-client then relays a
 * `hero_select_response` so the server proceeds.
 */
export type HeroSelectRequest = Extract<ServerEnvelope, { kind: 'hero_select_request' }>;

export interface WsClientHooks {
  /**
   * Physics-as-truth dice. Invoked when the server asks the browser to roll.
   * Resolve with the faces the dice settled on (lengths matching the request's
   * pool sizes). If omitted, the browser never answers and the server falls
   * back to its seeded engine dice after a timeout.
   */
  onRollRequest?(req: RollRequest): Promise<RollRequestResult>;
  /**
   * Initiative-reveal gate. Invoked when the server asks the browser to
   * confirm the player has seen the Order of Battle. Resolve when the reveal
   * is dismissed; ws-client sends the `reveal_ack` on resolution. If omitted,
   * the browser never acks and the server proceeds only on disconnect / abort.
   */
  onRevealRequest?(req: RevealRequest): Promise<void>;
  /**
   * Opening-splash gate. Invoked when the server asks the browser to confirm
   * the player has dismissed the title splash. Resolve when "Begin" is clicked;
   * ws-client sends the `opening_ack` on resolution. If omitted, the browser
   * never acks and the server proceeds only on disconnect / abort.
   */
  onOpeningRequest?(req: OpeningRequest): Promise<void>;
  /**
   * Hero-selection gate. Invoked when the server asks the browser to let the
   * player choose their hero at game start. Resolve with the chosen hero's
   * characterId — plus the game language picked on the same screen, which the
   * server uses to reroute the agents' LANGUAGE directive before the first
   * LLM call; ws-client sends the `hero_select_response` on resolution. If
   * omitted, the browser never answers and the server keeps the scenario
   * default (proceeding only on disconnect / abort).
   */
  onHeroSelectRequest?(req: HeroSelectRequest): Promise<{ characterId: string; language?: 'en' | 'pt' }>;
}

const generateSid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/** sessionStorage key holding this tab's session id (see resolveSessionId). */
export const SID_STORAGE_KEY = 'agents-rpg-sid';

/**
 * Resolve this TAB's session id: one per browser tab, STICKY ACROSS RELOADS.
 *
 * The id lives in sessionStorage (per-tab, survives refresh, gone when the
 * tab closes), so a refresh re-attaches to the SAME server-side game instead
 * of minting a new sid. Under the server's session cap that distinction is
 * critical: a fresh-sid refresh would start a WHOLE NEW game while the old
 * session sat as a disconnected zombie holding a slot — with a full server
 * the refreshed tab then queued behind its own abandoned game (observed live
 * 2026-06-03). A genuinely NEW tab still gets a fresh id (sessionStorage is
 * per-tab); a tab DUPLICATED in the browser copies sessionStorage, carrying
 * the same sid — the server's per-sid newest-wins kick then retires the older
 * tab (`rejected: session_in_use`), which is the right outcome there too.
 *
 * Storage access is fully guarded (private-mode / sandboxed iframes can
 * throw) — on any failure we fall back to a per-load id, i.e. the legacy
 * behaviour.
 */
export const resolveSessionId = (storage: Pick<Storage, 'getItem' | 'setItem'> | null): string => {
  try {
    const existing = storage?.getItem(SID_STORAGE_KEY);
    if (existing) return existing;
    const fresh = generateSid();
    storage?.setItem(SID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return generateSid();
  }
};

/** Exported so the host can stamp UI artifacts (e.g. the playtest survey's
 *  copied answers) with the id the server keys this tab's run by. */
export const SESSION_ID = resolveSessionId(
  typeof sessionStorage !== 'undefined' ? sessionStorage : null,
);

/** Cap on the exponential reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 8000;
const BASE_RECONNECT_DELAY_MS = 500;

export const connectWs = (url: string, store: Store, hooks: WsClientHooks = {}): WsClient => {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  // True once THIS page load has received a snapshot — i.e. the server built
  // (or reattached) a session for us. From then on every reconnect is marked
  // `reattach=1`: it may only RE-JOIN that session. If the server no longer
  // knows it (process restarted, session reaped/ended) it refuses with
  // `rejected: session_gone` instead of starting a fresh game — that refusal
  // is what stops a forgotten tab's reconnect loop from silently grabbing a
  // game slot every time the server comes back up.
  let hadSnapshot = false;
  // Defer state_change events that follow a ranged/magic-attack resolution
  // so HP-bar damage and KO removal land in sync with the projectile impact
  // instead of the moment the attacker presses the trigger.
  const dispatcher = createDeferredDispatcher(store);

  const fullUrl = `${url}${url.includes('?') ? '&' : '?'}sid=${encodeURIComponent(SESSION_ID)}`;

  const sendRaw = (msg: ClientEnvelope): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  /**
   * Bridge a physics-rolled resolution's string request id to its numeric
   * `t`. The roll_request handler (main.ts) signals `notifyRollResolved(
   * requestId)` when its dice animation + verdict + hold completes; Board and
   * ws-deferred gate their projectile / flash / HP-drain on the numeric `t`.
   * Re-emitting the `t` signal when the request id resolves keeps those
   * downstream effects landing AFTER the player has watched the dice settle —
   * exactly as the legacy resolution-driven dice flow did.
   */
  const bridgePhysicsResolution = (env: ServerEnvelope): void => {
    if (env.kind !== 'event') return;
    const e = env.event as { type?: string; t?: number; public?: { rollRequestId?: unknown } };
    if (e.type !== 'resolution') return;
    if (typeof e.t !== 'number') return;
    const t = e.t;
    const requestId = e.public?.rollRequestId;
    if (typeof requestId === 'string') {
      void waitForRollResolved(requestId).then(() => {
        notifyRollMounted(t);
        notifyRollResolved(t);
      });
      return;
    }
    // No rollRequestId in a physics-as-truth run = a SEEDED fallback: the
    // browser never answered the server's roll_request (e.g. a backgrounded
    // tab paused the dice physics), so the engine rolled with seeded Dice and
    // there is no overlay animation to wait for. Fire the timing signal NOW so
    // ws-deferred's held HP-drain/KO lands and any consumer keyed on `t`
    // unblocks. matchQueueItems also suppresses the dice beat in this case, so
    // nothing is left to wedge the playback queue / beat gate. (In a NON-physics
    // run we never get here for these — the legacy seeded path keeps animating
    // the dice beat and firing its own resolve on settle.)
    if (store.getSnapshot().physicsActive) {
      notifyRollMounted(t);
      notifyRollResolved(t);
    }
  };

  const open = () => {
    ws = new WebSocket(hadSnapshot ? `${fullUrl}&reattach=1` : fullUrl);
    ws.addEventListener('open', () => { attempt = 0; });
    ws.addEventListener('message', (ev) => {
      const env = parseServerEnvelope(typeof ev.data === 'string' ? ev.data : '');
      if (!env) return;
      // A snapshot means a session exists for this sid — reconnects from here
      // on are reattach-only (see `hadSnapshot`).
      if (env.kind === 'snapshot') hadSnapshot = true;
      // Physics-as-truth: the server asks the browser to roll. Drive the 3D
      // overlay via the host hook and relay the settled faces back. Handled
      // out-of-band — it never touches the store / playback queue.
      if (env.kind === 'roll_request') {
        // The server runs physics-as-truth dice. Remember it: a later
        // resolution WITHOUT a rollRequestId is then a seeded fallback (the
        // browser failed to answer in time), handled specially below + in
        // matchQueueItems so it can't enqueue an un-drainable dice beat.
        store.markPhysicsActive();
        const handler = hooks.onRollRequest;
        if (handler) {
          void handler(env).then((result) => {
            sendRaw({
              kind: 'roll_response',
              requestId: env.requestId,
              attackerFaces: result.attackerFaces,
              defenderFaces: result.defenderFaces,
            });
          });
        }
        return;
      }
      // Initiative-reveal gate: the server is holding the first combat turn
      // until the player dismisses the Order of Battle. Drive the host hook
      // (which resolves on Skip / auto-skip) and relay the ack back. Handled
      // out-of-band — it never touches the store / playback queue.
      if (env.kind === 'reveal_request') {
        const handler = hooks.onRevealRequest;
        if (handler) {
          void handler(env).then(() => {
            sendRaw({ kind: 'reveal_ack', requestId: env.requestId });
          });
        }
        return;
      }
      // Opening-splash gate: at game start the server holds the DM's first
      // turn until the player dismisses the title splash. Drive the host hook
      // (which resolves on the "Begin" click) and relay the ack back. Handled
      // out-of-band — it never touches the store / playback queue.
      if (env.kind === 'opening_request') {
        const handler = hooks.onOpeningRequest;
        if (handler) {
          void handler(env).then(() => {
            sendRaw({ kind: 'opening_ack', requestId: env.requestId });
          });
        }
        return;
      }
      // Hero-selection gate: at game start the server holds the whole run until
      // the player chooses their hero. Drive the host hook (which resolves with
      // the chosen characterId) and relay the response back. Handled out-of-band
      // — it never touches the store / playback queue.
      if (env.kind === 'hero_select_request') {
        const handler = hooks.onHeroSelectRequest;
        if (handler) {
          void handler(env).then(({ characterId, language }) => {
            sendRaw({
              kind: 'hero_select_response', requestId: env.requestId, characterId,
              ...(language !== undefined ? { language } : {}),
            });
          });
        }
        return;
      }
      // Server uses newest-wins: it sends this envelope to the OLDER tab when
      // a new one connects. Stop the retry loop so the kicked tab doesn't
      // immediately steal the session back — that oscillation is what makes
      // "Connecting to engine…" persist forever across multiple tabs.
      if (env.kind === 'rejected' && env.reason === 'session_in_use') {
        closed = true;
      }
      // Our reattach-only reconnect named a session this server doesn't have
      // (restart / reap / ended). The game is gone — stop reconnecting (the
      // store shows "reload to rejoin"); a manual reload makes a fresh claim.
      if (env.kind === 'rejected' && env.reason === 'session_gone') {
        closed = true;
      }
      // The server also closes the socket and ends the session when the run
      // wraps up. Stop reconnecting so refresh — not auto-reconnect — is what
      // brings the user back.
      if (env.kind === 'end') {
        closed = true;
      }
      // For physics-rolled resolutions, wire the request-id timing signal to
      // the numeric `t` BEFORE the dispatcher processes the event (so
      // ws-deferred's wait is armed before the bridge can fire).
      bridgePhysicsResolution(env);
      dispatcher.apply(env);
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      // Exponential backoff capped at MAX_RECONNECT_DELAY_MS. Keeps a flapping
      // server from being hammered while still recovering within seconds of a
      // brief network blip.
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      attempt += 1;
      setTimeout(open, delay);
    });
  };

  open();

  return { send: sendRaw };
};
