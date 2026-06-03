import { createStore } from './store.js';
import { connectWs, SESSION_ID, type RevealRequest, type OpeningRequest, type HeroSelectRequest } from './ws-client.js';
import { mountLayout } from './components/Layout.js';
import { mountHeroSelect, type HeroSelectResult } from './components/HeroSelect.js';
import { mountBoard, type BoardApi } from './components/Board.js';
import { Dice3DOverlay } from './components/Dice3DOverlay.js';
import { DiceHUD } from './components/DiceHUD.js';
import { notifyRollResolved } from './components/roll-events.js';
import { createRollRequestHandler } from './components/roll-request-handler.js';
import * as SceneConfig from './components/three/SceneConfig.js';

/** Beat between "HUD intro fades in over the board" and "3D dice canvas fades
 *  in + dice fly". 600ms covers the HUD's opacity transition (see
 *  `dice-hud.css`) and the trailing ~400ms gives the player a second to read
 *  who's fighting whom before the throw starts. */
const PRE_DICE_HOLD_MS = 1000;

const root = document.getElementById('app');
if (root) {
  // Clear the SSR-style loading placeholder so lit-html owns the subtree.
  root.replaceChildren();
  const store = createStore();
  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

  // 3D dice overlay — owns the three.js renderer + Rapier physics world. The
  // canvas is mounted inside `.canvas-wrapper` once Board has created that
  // node (deferred until Pixi finishes its async init). `prewarm()` does the
  // canvas-independent work (WASM init, GLB load, three.js module chunk
  // fetch) in parallel with the WS handshake, so the first roll — which
  // always lands seconds after page load behind DM narration — finds those
  // already loaded. `attach()` then completes the boot once the wrapper is
  // available.
  const dice3d = new Dice3DOverlay();
  const diceHUD = new DiceHUD();
  dice3d.applyConfig(SceneConfig);
  void dice3d.prewarm().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Dice3DOverlay prewarm failed:', err);
  });

  // Physics-as-truth dice: the server asks the browser to roll (roll_request),
  // the browser's Rapier sim lands the dice, and we report exactly what they
  // landed on (roll_response). The engine resolves hit/miss from those faces,
  // so what the player watches IS the roll — no snap, no predetermined value.
  // The SUCCESS/FAIL verdict is computed locally from the settled faces using
  // the SAME rule the engine applies (attackerTop >= defenderTop && > 0), so
  // the stamp the player sees always matches the engine's verdict. The handler
  // serializes the HUD across requests so a multi-target special's sub-rolls
  // each present fully instead of racing — see createRollRequestHandler.
  const handleRollRequest = createRollRequestHandler({
    hud: diceHUD,
    stage: dice3d,
    onResolved: notifyRollResolved,
    preDiceHoldMs: PRE_DICE_HOLD_MS,
  });

  // Initiative-reveal gate bridge. When the server sends a `reveal_request`
  // it blocks the first combat turn until the browser acks. ws-client drives
  // `handleRevealRequest`, whose returned promise we resolve from Layout's
  // `onInitiativeRevealDismissed` callback (Skip click / auto-skip). A FIFO
  // queue keeps server and UI decoupled; in practice there's at most one
  // outstanding gate (the server can't reach a second combat before the
  // first is acked), but the queue makes any ordering safe.
  const pendingRevealAcks: Array<() => void> = [];
  const handleRevealRequest = (_req: RevealRequest): Promise<void> =>
    new Promise<void>((resolve) => { pendingRevealAcks.push(resolve); });

  // Opening-splash gate bridge. The server sends `opening_request` at game
  // start to hold the DM's first turn until the player clicks "Begin"; we
  // resolve its promise from Layout's `onOpeningDismissed`. A FIFO queue keeps
  // server and UI decoupled; `openingDismissedEarly` covers the rare case where
  // the click somehow precedes the request, so the request resolves at once
  // instead of stranding the gate.
  const pendingOpeningAcks: Array<() => void> = [];
  let openingDismissedEarly = false;
  const handleOpeningRequest = (_req: OpeningRequest): Promise<void> =>
    new Promise<void>((resolve) => {
      if (openingDismissedEarly) { resolve(); return; }
      pendingOpeningAcks.push(resolve);
    });

  // Hero-selection gate bridge. The server sends `hero_select_request` once at
  // game start (before the opening splash) to hold the run until the player
  // picks which starting hero they control. We mount the "Choose your hero"
  // overlay over the board; the returned promise resolves with the chosen
  // characterId, which ws-client relays as a `hero_select_response`.
  //
  // The first snapshot (carrying `scene.opening`) is published by the server
  // BEFORE this gate. The snapshot's `awaitingHeroSelect` flag already tells
  // Layout to hold the opening splash, so nothing flashes in the window before
  // this request arrives; this call keeps the splash + its typewriter held for
  // the rest of the chooser's lifetime, so the opening text types out ON SCREEN
  // once the player picks — not unseen behind the overlay (which would leave it
  // pre-finished, with no reveal).
  // Re-send dedup: the server re-ships a still-pending hero_select_request on
  // every (re)attach — game-start gates hold across a detach. A reconnect
  // WITHIN this page load would otherwise mount a second chooser on top of
  // the live one; reuse the in-flight promise for the same requestId instead.
  //
  // The chooser also carries the EN/PT game-language toggle; its final value
  // rides back in the same `hero_select_response` (→ the server reroutes the
  // agents' LANGUAGE directive before the first LLM call).
  let activeHeroSelect: { id: string; promise: Promise<HeroSelectResult> } | null = null;
  const handleHeroSelectRequest = (req: HeroSelectRequest): Promise<HeroSelectResult> => {
    if (activeHeroSelect?.id === req.requestId) return activeHeroSelect.promise;
    layoutHandle.setHeroSelectActive(true);
    const promise = mountHeroSelect(root, req.options).then((result) => {
      layoutHandle.setHeroSelectActive(false);
      activeHeroSelect = null;
      return result;
    });
    activeHeroSelect = { id: req.requestId, promise };
    return promise;
  };

  const ws = connectWs(wsUrl, store, {
    onRollRequest: handleRollRequest,
    onRevealRequest: handleRevealRequest,
    onOpeningRequest: handleOpeningRequest,
    onHeroSelectRequest: handleHeroSelectRequest,
  });

  // Vite HMR for the 3D scene's camera + lights + floor. Edits to
  // `SceneConfig.ts` are re-applied to the live overlay in place.
  if (import.meta.hot) {
    import.meta.hot.accept('./components/three/SceneConfig.ts', (newMod) => {
      if (newMod) {
        dice3d.applyConfig(newMod as typeof SceneConfig);
        // eslint-disable-next-line no-console
        console.log('[HMR] SceneConfig re-applied');
      }
    });
  }

  // Layout is mounted before Board (Board lazy-mounts on first snapshot).
  // Selection overlay updates happen through this ref — a noop until Board
  // attaches and replaces it.
  let boardApi: BoardApi | null = null;

  const layoutHandle = mountLayout(root, store, {
    onSubmit: (text, target) => ws.send(
      target && target !== 'game'
        ? { kind: 'human_input', text, target }
        : { kind: 'human_input', text },
    ),
    onAction: (action) => ws.send({ kind: 'structured_action', action }),
    // Playtest survey Submit → the server persists it (run dir + GCS) and
    // replies with a `survey_ack` that flows back through the store.
    onSurveySubmit: (survey) => ws.send({ kind: 'survey_response', survey }),
    onInitiativeRevealDismissed: () => {
      // The Order-of-Battle reveal sat OVER the still-visible 3D dice scene
      // (initiative rolled with `keepVisibleAfterSettle`). Now that the reveal
      // is dismissed, fade the settled 3D dice tray out so the 2D board returns.
      dice3d.hide();
      // Release the oldest outstanding server reveal gate. ws-client relays
      // the matching `reveal_ack`, so the first combat turn starts now.
      const resolve = pendingRevealAcks.shift();
      if (resolve) resolve();
    },
    onOpeningDismissed: () => {
      // Player clicked "Begin" on the title splash. Release the server's
      // opening gate (ws-client relays the `opening_ack`) so the DM's first
      // turn — and the opening's second-half narration — proceeds. If the
      // request hasn't arrived yet, remember the dismissal so it resolves
      // immediately when it does.
      const resolve = pendingOpeningAcks.shift();
      if (resolve) resolve();
      else openingDismissedEarly = true;
    },
    onBeatGateAck: (requestId) => {
      // The playback queue has drained — tell the server the player has read
      // the previous turn's beats so it may start the next turn. The server
      // matches this against the gate it's holding (by request id).
      ws.send({ kind: 'beat_gate_ack', requestId });
    },
    onSelectionChange: (state) => boardApi?.setSelectionOverlay(state),
    // Hovering a coordinate / creature chip in any dialogue surface highlights
    // the matching cell or creature(s) on the board (cleared on mouse-out).
    onRefHover: (target) => boardApi?.setHoverHighlight(target),
    // An `emote` beat reached the front of the playback queue — spawn the
    // balloon over the actor now (in dialogue order). No-op until Board mounts.
    onEmote: (actorId, emoji) => boardApi?.spawnEmote(actorId, emoji),
    onDiceRoll: async (dispatch, context) => {
      diceHUD.clear();
      const hudHandler = context.kind === 'duel'
        ? diceHUD.buildDuelContext(context.summary)
        : diceHUD.buildInitiativeContext(context.summary);
      // Staggered intro: the HUD's combat header / initiative list fades in
      // FIRST over the 2D board, giving the player a moment to read who is
      // fighting whom. Only after that beat does the 3D dice canvas fade in
      // and the throw begin. PRE_DICE_HOLD_MS = HUD fade-in (~600ms) +
      // anticipation pause.
      await new Promise<void>((r) => setTimeout(r, PRE_DICE_HOLD_MS));
      // The dice3d.roll() promise resolves after Dice3DOverlay has held the
      // settled tray for POST_SNAP_HOLD_MS; clear the HUD overlays at the same
      // moment so the combat header, verdict, and initiative list fade out
      // alongside the canvas instead of staying stamped on top of the board.
      //
      // INITIATIVE: keep the settled 3D dice on-screen after they land
      // (`keepVisibleAfterSettle`) so the Order-of-Battle reveal renders OVER
      // the 3D dice scene rather than the 2D board. The scene is faded out
      // later, in `onInitiativeRevealDismissed`, once that reveal is dismissed.
      await dice3d.roll(dispatch, hudHandler, {
        keepVisibleAfterSettle: context.kind === 'initiative',
      });
      // INITIATIVE: project each settled die to its on-screen position and
      // hand the per-character anchors to Layout, so the Order-of-Battle
      // badges render OVER their dice (not the fallback row). The 3D dice
      // spawn attacker lane (summary.heroes) then defender lane
      // (summary.monsters), which is exactly the order
      // `getActiveDieStagePercents()` returns — so index → character maps
      // straight off the summary.
      if (context.kind === 'initiative') {
        const percents = dice3d.getActiveDieStagePercents();
        const { heroes, monsters } = context.summary;
        const positions: Record<string, { x: number; y: number }> = {};
        heroes.forEach((h, i) => {
          const p = percents[i];
          if (p) positions[h.characterId] = p;
        });
        monsters.forEach((m, j) => {
          const p = percents[heroes.length + j];
          if (p) positions[m.characterId] = p;
        });
        layoutHandle.setOrderRevealPositions(positions);
      }
      diceHUD.clear();
    },
  }, {
    // Stamped into the playtest survey's copied answers so a pasted reply can
    // be matched to this tab's run (the server keys the session by this sid).
    sessionId: SESSION_ID,
  });

  // Mount Pixi when the scene is first available. Re-mounting on later snapshots
  // is unnecessary because the board updates incrementally via store.subscribe.
  let boardMounted = false;
  store.subscribe(() => {
    const s = store.getSnapshot();
    if (!boardMounted && s.scene && s.manifest) {
      const boardEl = document.getElementById('board');
      if (boardEl) {
        boardMounted = true;
        void mountBoard(boardEl, store, {
          onCanvasClick: (target) => layoutHandle.handleCanvasClick(target),
          // Right-click removes a die from an over-assigned target mid
          // split-special (whirlwind / split-shot); a no-op otherwise.
          onCanvasRightClick: (target) => layoutHandle.handleCanvasRightClick(target),
          // Forward Board's "who is currently mid-move" set into Layout so
          // the turn-order bar holds its cursor on a combatant whose sprite
          // is still sliding across the grid (most relevant for monster
          // move-only turns, which produce no dice to gate on).
          onMovingActorsChange: (ids) => layoutHandle.setMovingActors(ids),
        }).then((api) => {
          boardApi = api;
          // The 3D dice canvas lives inside `.canvas-wrapper` so it shares the
          // board's bounds and frame (the initiative-card iron/gold ring +
          // chamfer). Board.ts creates `.canvas-wrapper` synchronously during
          // mountBoard, so this lookup succeeds.
          const wrap = boardEl.querySelector('.canvas-wrapper');
          if (wrap instanceof HTMLElement) {
            dice3d.attach(wrap);
            diceHUD.attach(wrap);
          }
          // Replay current selection so the overlay matches Layout's state.
          layoutHandle.refreshSelection();
        });
      }
    }
  });
}
