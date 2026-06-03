/**
 * 3D dice overlay — owns the three.js renderer, the Rapier physics world, and
 * the canvas DOM node injected on top of the Pixi board. Lifecycle:
 *
 *   const overlay = new Dice3DOverlay({ glbUrl });
 *   overlay.prewarm();                   // optional: load WASM + GLB early
 *   overlay.attach(canvasWrapperEl);     // once, when board mounts
 *   await overlay.roll(dispatch);        // resolves when ALL dice have snapped
 *
 * Boot is split into two halves so `prewarm()` can run during page load (when
 * the Pixi board hasn't created `.canvas-wrapper` yet) and `attach()` finishes
 * the boot once the wrapper is available. If a `roll(...)` arrives before
 * either half, the dispatch is queued and flushed when the engine is live.
 *
 * The canvas remains mounted between rolls but is hidden (`display: none`)
 * when idle to avoid a second WebGL context fighting Pixi on memory-constrained
 * mobile browsers.
 */
import type * as THREE_NS from 'three';
import type { RollDispatch } from './three/DiceDispatcher.js';
import type { Face } from './three/DiceMesh.js';
export type { Face };
import type { SceneConfigModule } from './three/SceneConfig.js';

/** Callback invoked once per lane after that lane's dice settle, with the
 *  face that landed up on each die in that lane (one entry per die, in
 *  spawn order). Fires twice for a duel (attacker then defender), once
 *  for a single-lane roll. The caller can compute the top face via
 *  `Math.max(...faces)`. */
export type LaneSettledHandler = (
  lane: 'attacker' | 'defender',
  faces: Face[],
) => void;

/** Pause between the attacker's settle + result reveal and the defender's
 *  throw. Gives the player time to see the attacker's top face stamp in
 *  before the next set of dice flies. */
const BETWEEN_LANES_MS = 400;

/** How long the overlay stays visible after the last die snaps before
 *  scheduleHide() fires. Must be ≥ DiceHUD's 900ms verdict-reveal delay
 *  (see `buildDuelContext` in DiceHUD.ts) plus a read window, otherwise
 *  the canvas hides before the player sees SUCCESS/FAIL. */
const POST_SNAP_HOLD_MS = 2000;

/** Duration of the canvas opacity crossfade (in and out). Matched to the
 *  HUD root fade in `dice-hud.css` so both layers come and go together. */
const CANVAS_FADE_MS = 600;

interface QueuedRoll {
  dispatch: RollDispatch;
  onLaneSettled?: LaneSettledHandler;
  keepVisibleAfterSettle?: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export interface RollOptions {
  /** When true the canvas is NOT auto-hidden after the post-snap hold — the
   *  settled dice tray (and its frame) stay on-screen until `hide()` is
   *  called. Used by the INITIATIVE roll so the Order-of-Battle reveal can
   *  render OVER the still-visible 3D dice scene instead of the 2D board.
   *  Default: false (the canvas crossfades back to the board on its own). */
  keepVisibleAfterSettle?: boolean;
}

interface Engine {
  THREE: typeof THREE_NS;
  scene: import('./three/DiceScene.js').DiceScene;
  physics: import('./three/DicePhysics.js').DicePhysics;
  loadDiceMesh: typeof import('./three/DiceMesh.js').loadDiceMesh;
  cloneDie: typeof import('./three/DiceMesh.js').cloneDie;
}

export interface Dice3DOverlayOptions {
  /** URL to the GLB asset. Defaults to `/assets/dice/perfect_little_dice_3cm.glb`. */
  glbUrl?: string;
}

interface PrewarmedModules {
  rapier: typeof import('@dimforge/rapier3d-compat');
  diceScene: typeof import('./three/DiceScene.js');
  dicePhysics: typeof import('./three/DicePhysics.js');
  diceMesh: typeof import('./three/DiceMesh.js');
  three: typeof THREE_NS;
}

export class Dice3DOverlay {
  private readonly glbUrl: string;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private engine: Engine | null = null;
  /** Canvas-independent boot — WASM + GLB + module imports. Started by
   *  `prewarm()` (eager) or lazily by `roll()` if attach happened first. */
  private prewarmPromise: Promise<PrewarmedModules> | null = null;
  /** Resolves once prewarm AND attach have both completed. Underlies `roll()`. */
  private enginePromise: Promise<Engine> | null = null;
  private engineResolve: ((e: Engine) => void) | null = null;
  private engineReject: ((e: unknown) => void) | null = null;
  private queue: QueuedRoll[] = [];
  private rolling = false;
  private resizeObs: ResizeObserver | null = null;
  private hideTimer: number | null = null;
  /** Cloned die meshes currently in the scene; cleared between rolls. */
  private activeDice: THREE_NS.Object3D[] = [];
  /** Pending SceneConfig applied as soon as the engine boots. Lets HMR fire
   *  before the renderer is ready without losing the update. */
  private pendingConfig: SceneConfigModule | null = null;
  /** Most recent SceneConfig — used per-roll for throw parameters. */
  private currentConfig: SceneConfigModule | null = null;

  constructor(opts: Dice3DOverlayOptions = {}) {
    this.glbUrl = opts.glbUrl ?? '/assets/dice/perfect_little_dice_3cm.glb';
    this.enginePromise = new Promise<Engine>((res, rej) => {
      this.engineResolve = res;
      this.engineReject = rej;
    });
  }

  /**
   * Kick off canvas-independent boot work (Rapier WASM init, GLB load, module
   * chunk fetches). Idempotent and fire-and-forget — safe to call before the
   * Pixi board has created `.canvas-wrapper`. The engine isn't fully booted
   * until `attach(host)` also runs.
   */
  prewarm(): Promise<PrewarmedModules> {
    if (!this.prewarmPromise) this.prewarmPromise = this.bootPrewarm();
    return this.prewarmPromise;
  }

  /**
   * Mount the overlay's canvas inside `host` (typically `.canvas-wrapper`,
   * the bordered element whose ::before pseudo-element draws the board frame
   * — putting the dice canvas inside means the frame visually wraps the 3D
   * scene per the design brief). Sizes via ResizeObserver. Idempotent: a
   * second attach to the same host is a no-op.
   */
  attach(host: HTMLElement): void {
    if (this.host === host) return;
    this.detach();
    this.host = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'dice3d-canvas';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '20';
    canvas.style.pointerEvents = 'none';
    canvas.style.display = 'none';
    // Opacity-driven fade so the canvas crossfades onto the board instead of
    // popping in. `display:none` is still used between rolls to keep the
    // second WebGL context off mobile memory; `show()` flips display first,
    // then bumps opacity to 1 on the next frame so the transition fires.
    canvas.style.opacity = '0';
    canvas.style.transition = `opacity ${CANVAS_FADE_MS}ms ease-in-out`;
    canvas.style.imageRendering = 'pixelated';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(canvas);
    this.canvas = canvas;

    this.resizeObs = new ResizeObserver(() => this.syncSize());
    this.resizeObs.observe(host);

    // Complete the boot now that we have a canvas. `prewarm()` may already
    // be in flight from main.ts — bootRenderer awaits it either way.
    void this.bootRenderer().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Dice3DOverlay: renderer boot failed', err);
      this.engineReject?.(err);
    });
  }

  /**
   * Apply a new SceneConfig to the live scene — used by Vite HMR handlers
   * after `SceneConfig.ts` changes. Safe to call before the engine has
   * finished booting: the config is buffered and applied on boot.
   */
  applyConfig(config: SceneConfigModule): void {
    this.currentConfig = config;
    if (!this.engine) {
      this.pendingConfig = config;
      return;
    }
    this.applyEngineConfig(this.engine, config);
  }

  /**
   * Push the latest scene config into the renderer AND rebuild the
   * viewport-edge collision walls so they always wrap the current camera's
   * visible footprint on the floor. Called from `applyConfig` (live updates)
   * and from `bootRenderer` (initial setup after lazy chunks load).
   */
  private applyEngineConfig(engine: Engine, config: SceneConfigModule): void {
    engine.scene.applyConfig(config);
    // syncSize first so getViewportFloorCorners uses up-to-date aspect.
    this.syncSize();
    const corners = engine.scene.getViewportFloorCorners();
    if (corners.length === 4) engine.physics.setViewportWalls(corners);
  }

  /**
   * Read the face currently showing on each die that is still in the scene.
   * Useful AFTER `roll(...)` resolves but before the next roll clears the
   * tray (e.g. test pages that want to display the simulated outcome). The
   * lane order matches the dispatch order: attacker dice first, defender
   * dice second.
   */
  getCurrentFaces(): Face[] {
    if (!this.engine) return [];
    const engine = this.engine;
    return this.activeDice.map((obj) => engine.physics.readFaceUp(obj));
  }

  /**
   * Screen anchors (PERCENT of the displayed canvas, origin top-left) for the
   * dice currently in the tray, in the SAME lane order as `getCurrentFaces`
   * (attacker dice first, defender dice second). Used to position the
   * Order-of-Battle badges over each settled die. Empty before the engine
   * boots or when no dice are active.
   */
  getActiveDieStagePercents(): Array<{ x: number; y: number }> {
    const engine = this.engine;
    if (!engine) return [];
    const v = new engine.THREE.Vector3();
    return this.activeDice.map((obj) => {
      obj.getWorldPosition(v);
      return engine.scene.projectToStagePercent(v);
    });
  }

  /**
   * Debug helper for calibrating `FACE_NORMALS`. Spawns one kinematic die
   * in the center of the tray oriented so the requested face is up
   * according to the current table. The visible pip count is the GLB's
   * TRUE label for that axis — compare to the requested number to validate
   * or correct DiceMesh.ts.
   */
  async showFaceForCalibration(face: Face): Promise<void> {
    const engine = await this.enginePromise!;
    this.show();
    this.clearActiveDice();
    const obj = engine.cloneDie();
    obj.scale.setScalar(1 / 0.03);
    const center = engine.scene.getViewportFloorCenter()
      ?? { x: this.currentConfig?.CAMERA.target.x ?? 0, z: this.currentConfig?.CAMERA.target.z ?? 0 };
    obj.position.set(center.x, 1, center.z);
    const { FACE_NORMALS } = await import('./three/DiceMesh.js');
    const T = engine.THREE;
    const q = new T.Quaternion().setFromUnitVectors(
      FACE_NORMALS[face],
      new T.Vector3(0, 1, 0),
    );
    obj.quaternion.copy(q);
    engine.scene.addDie(obj);
    this.activeDice.push(obj);
  }

  detach(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.canvas && this.canvas.parentElement === this.host) {
      this.host?.removeChild(this.canvas);
    }
    this.canvas = null;
    this.host = null;
    if (this.engine) {
      this.engine.physics.clear();
      this.engine.scene.dispose();
      this.engine = null;
    }
  }

  /**
   * Roll one or two pools sequentially by lane. The attacker pool flies
   * first; once those dice settle the `onLaneSettled` callback fires with
   * the lane's top face, then (after a brief reveal pause) the defender
   * pool flies and the callback fires again. Resolves when both lanes are
   * fully settled.
   *
   * If the overlay hasn't been attached yet (i.e. Pixi hasn't created
   * `.canvas-wrapper`), the dispatch sits in the queue until `attach()` lands.
   */
  roll(
    dispatch: RollDispatch,
    onLaneSettled?: LaneSettledHandler,
    opts: RollOptions = {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Build conditionally so optional props are omitted (not set to
      // `undefined`) — required under tsconfig `exactOptionalPropertyTypes`.
      const item: QueuedRoll = { dispatch, resolve, reject };
      if (onLaneSettled) item.onLaneSettled = onLaneSettled;
      if (opts.keepVisibleAfterSettle) item.keepVisibleAfterSettle = true;
      this.queue.push(item);
      void this.pump();
    });
  }

  /**
   * Fade the settled dice tray off-screen — the public counterpart to the
   * internal post-snap auto-hide. Used after a `keepVisibleAfterSettle` roll
   * (initiative) so the host can dismiss the 3D scene once the Order-of-Battle
   * reveal that sat over it is dismissed. No-op when nothing is showing.
   */
  hide(): void {
    this.scheduleHide();
  }

  private async pump(): Promise<void> {
    if (this.rolling) return;
    if (this.queue.length === 0) return;
    this.rolling = true;
    let engine: Engine;
    try {
      engine = await this.enginePromise!;
    } catch (e) {
      const err = e;
      const pending = this.queue.slice();
      this.queue = [];
      this.rolling = false;
      for (const q of pending) q.reject(err);
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      try {
        await this.runRoll(
          engine,
          next.dispatch,
          next.onLaneSettled,
          next.keepVisibleAfterSettle ?? false,
        );
        next.resolve();
      } catch (e) {
        next.reject(e);
      }
    }
    this.rolling = false;
  }

  private async runRoll(
    engine: Engine,
    dispatch: RollDispatch,
    onLaneSettled?: LaneSettledHandler,
    keepVisibleAfterSettle = false,
  ): Promise<void> {
    this.show();
    this.clearActiveDice();

    const config = this.currentConfig;
    if (!config) throw new Error('Dice3DOverlay: no SceneConfig — call applyConfig before rolling');
    const throwCfg = config.THROW;

    // Throw target: the actual center of the viewport on the floor — i.e.
    // where the camera's center ray crosses y=0. NOT the look-at target's
    // X/Z, because the look-at sits below the floor for the current camera
    // and its X/Z drift away from the on-screen center. Each die picks a
    // random azimuth around this point — constrained to the half of the
    // floor away from the camera — and flies inward.
    const viewportCenter = engine.scene.getViewportFloorCenter();
    const focus = viewportCenter ?? { x: config.CAMERA.target.x, z: config.CAMERA.target.z };
    const cameraXZ = {
      x: config.CAMERA.position.x,
      z: config.CAMERA.position.z,
    };

    // Spawn helper for a single lane. Returns the Object3Ds spawned so the
    // caller can read each die's final face from physics once the lane
    // settles. Dice from earlier lanes stay in `activeDice` so the tray
    // accumulates — the next call to clearActiveDice (next roll) wipes
    // everything.
    const spawnLane = async (
      faces: ReadonlyArray<Face>,
      skins: RollDispatch['attackerSkins'],
    ): Promise<THREE_NS.Object3D[]> => {
      const objs: THREE_NS.Object3D[] = [];
      for (let i = 0; i < faces.length; i++) {
        const skin = skins?.[i];
        const obj = engine.cloneDie(skin);
        // The GLB is in meters (~3cm); scale so each edge ≈ 1 scene unit.
        obj.scale.setScalar(1 / 0.03);
        engine.scene.addDie(obj);
        engine.physics.addDie(obj, focus, cameraXZ, throwCfg, performance.now());
        this.activeDice.push(obj);
        objs.push(obj);
        if (i < faces.length - 1 && throwCfg.staggerMs > 0) {
          await delay(throwCfg.staggerMs);
        }
      }
      return objs;
    };

    // --- Phase 1: attacker ----------------------------------------------
    const attackerObjs = await spawnLane(dispatch.attacker, dispatch.attackerSkins);
    if (attackerObjs.length > 0) {
      await engine.physics.whenAllSettled();
      // Read the faces the physics actually settled on — these ARE the roll.
      // In physics-as-truth mode the caller relays them back to the engine
      // (via roll_response) so the hit/miss verdict is computed from exactly
      // the dice the player watched land. No snap, no predetermined face.
      onLaneSettled?.('attacker', readLaneFaces(engine, attackerObjs));
    }

    // --- Phase 2: defender (if any) ------------------------------------
    if (dispatch.defender.length > 0) {
      await delay(BETWEEN_LANES_MS);
      const defenderObjs = await spawnLane(dispatch.defender, dispatch.defenderSkins);
      await engine.physics.whenAllSettled();
      onLaneSettled?.('defender', readLaneFaces(engine, defenderObjs));
    }

    // Hold the settled tray on-screen long enough for the verdict reveal
    // (DiceHUD shows SUCCESS/FAIL 900ms after the defender lane settles)
    // and a brief read window, then fade the canvas out so the board is
    // visible again. Without this hide, the dice tray covers the Pixi
    // board permanently and the game never returns to normal play mode.
    //
    // EXCEPTION — initiative rolls pass `keepVisibleAfterSettle`: the
    // settled dice stay up so the Order-of-Battle reveal renders OVER the
    // 3D dice scene. The host fades them out via `hide()` once that reveal
    // is dismissed.
    await delay(POST_SNAP_HOLD_MS);
    if (!keepVisibleAfterSettle) this.scheduleHide();
  }

  private clearActiveDice(): void {
    const engine = this.engine;
    if (!engine) return;
    engine.physics.clear();
    for (const obj of this.activeDice) {
      // `cloneDie` clones the material so each die has its own — dispose
      // those clones here so per-roll tint variations don't leak memory.
      obj.traverse((child) => {
        const m = (child as { material?: unknown }).material;
        if (m && typeof (m as { dispose?: () => void }).dispose === 'function') {
          (m as { dispose: () => void }).dispose();
        }
      });
      engine.scene.removeDie(obj);
    }
    this.activeDice = [];
  }

  private show(): void {
    if (!this.canvas) return;
    if (this.hideTimer !== null) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    const wasHidden = this.canvas.style.display !== 'block';
    if (wasHidden) {
      this.canvas.style.display = 'block';
      this.syncSize();
      this.engine?.scene.start();
      // Force reflow so the browser registers the display change before we
      // bump opacity — without this the 0→1 transition is skipped.
      void this.canvas.offsetWidth;
    }
    this.canvas.style.opacity = '1';
  }

  private scheduleHide(): void {
    if (!this.canvas) return;
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    // Fade out first; switch display:none only after the transition finishes
    // so the canvas crossfades back to the board instead of snapping out.
    this.canvas.style.opacity = '0';
    this.hideTimer = window.setTimeout(() => {
      if (!this.canvas) return;
      this.canvas.style.display = 'none';
      this.clearActiveDice();
      this.engine?.scene.stop();
    }, CANVAS_FADE_MS);
  }

  private syncSize(): void {
    if (!this.host || !this.engine) return;
    const rect = this.host.getBoundingClientRect();
    this.engine.scene.resize(rect.width, rect.height);
  }

  /**
   * Canvas-independent boot: load module chunks, init Rapier WASM, load the
   * dice GLB. Safe to run before `attach()` and before Pixi mounts.
   */
  private async bootPrewarm(): Promise<PrewarmedModules> {
    const [diceScene, dicePhysics, diceMesh, three] = await Promise.all([
      import('./three/DiceScene.js'),
      import('./three/DicePhysics.js'),
      import('./three/DiceMesh.js'),
      import('three'),
    ]);
    const rapier = await dicePhysics.initPhysics();
    await diceMesh.loadDiceMesh(this.glbUrl);
    return { rapier, diceScene, dicePhysics, diceMesh, three };
  }

  /**
   * Canvas-dependent boot: instantiate the three.js renderer and Rapier world
   * once both the prewarm and the canvas are ready. Resolves `enginePromise`
   * so queued rolls flush.
   */
  private async bootRenderer(): Promise<void> {
    if (!this.canvas) throw new Error('bootRenderer called without a canvas');
    const mods = await this.prewarm();
    const scene = new mods.diceScene.DiceScene(this.canvas);
    const physics = new mods.dicePhysics.DicePhysics(mods.rapier);
    scene.setOnFrame((dt) => physics.step(dt, performance.now()));
    const engine: Engine = {
      THREE: mods.three,
      scene,
      physics,
      loadDiceMesh: mods.diceMesh.loadDiceMesh,
      cloneDie: mods.diceMesh.cloneDie,
    };
    this.engine = engine;
    if (this.pendingConfig) {
      this.applyEngineConfig(engine, this.pendingConfig);
      this.pendingConfig = null;
    } else {
      this.syncSize();
    }
    this.engineResolve?.(engine);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the up-facing face of every die in a lane, preserving spawn order. */
const readLaneFaces = (engine: Engine, objs: ReadonlyArray<THREE_NS.Object3D>): Face[] =>
  objs.map((o) => engine.physics.readFaceUp(o));
