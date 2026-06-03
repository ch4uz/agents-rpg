/**
 * Physics layer for the 3D dice overlay. Wraps `@dimforge/rapier3d-compat`
 * (WASM, async init) and owns the rigid bodies for each rolling die.
 *
 * The simulation is the source of truth for the visible roll outcome — there
 * is NO snap to a pre-determined face. Each die spawns with random linear
 * and angular velocity, falls into the tray, bounces against walls and other
 * dice, and comes to rest on whatever face the physics settles on. The
 * caller reads `readFaceUp(die)` after the all-settled promise resolves to
 * learn the result of each die.
 *
 * Determinism note: Rapier's WASM build is NOT seeded, and the simulation
 * trajectory will vary across browsers and frame rates. That's intentional —
 * the engine's state (HP, damage, hit/miss verdict on the board) is driven
 * separately by the deterministic mulberry32 dice in `src/engine/dice.ts`,
 * so the replay invariant is preserved regardless of what the visible dice
 * land on.
 */
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { FACE_NORMALS, type Face } from './DiceMesh.js';
import type { ThrowConfig } from './SceneConfig.js';

/** Half-extent of a die collider in scene units (dice are 1u cubes). */
const DIE_HALF = 0.5;

/** Wall geometry. Walls hug the viewport edges via setViewportWalls — the
 *  inner-tray X/Z values are no longer hardcoded; they come from the
 *  camera's orthographic frustum projection onto the floor. */
const WALL_HEIGHT = 3.5;
const WALL_THICK = 1.5;

/** Settle thresholds: a die is "at rest" when linear AND angular velocity
 *  fall below these and stay below for SETTLE_FRAMES consecutive steps. */
const SETTLE_LINVEL = 0.04;
const SETTLE_ANGVEL = 0.25;
const SETTLE_FRAMES = 18;

/** Max free-physics duration before forcing a settle (defensive — should not
 *  trigger in practice unless a die wedges against a wall). */
const ROLL_TIMEOUT_MS = 6000;

/** Hard cap on simultaneous dice — initiative is worst case ~10. */
const MAX_DICE = 12;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface DieEntry {
  obj: THREE.Object3D;
  body: RAPIER_NS.RigidBody;
  settleCount: number;
  startedAtMs: number;
  settled: boolean;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

let RAPIER: typeof RAPIER_NS | null = null;
let initPromise: Promise<typeof RAPIER_NS> | null = null;

/** Pre-warm the WASM. Idempotent. */
export const initPhysics = async (): Promise<typeof RAPIER_NS> => {
  if (RAPIER) return RAPIER;
  if (!initPromise) {
    initPromise = (async () => {
      // The package's named `init` re-export isn't surfaced on the dynamic-
      // import namespace under NodeNext; it lives on the default export
      // (`RAPIER.init()`, the documented entrypoint), which is also the
      // `typeof RAPIER_NS` shape this function returns.
      const mod = await import('@dimforge/rapier3d-compat');
      await mod.default.init();
      RAPIER = mod.default;
      return mod.default;
    })();
  }
  return initPromise;
};

export class DicePhysics {
  private readonly world: RAPIER_NS.World;
  private dice: DieEntry[] = [];
  private allSettledResolve: (() => void) | null = null;
  /** Wall bodies currently in the world. Rebuilt every `setViewportWalls`. */
  private wallBodies: RAPIER_NS.RigidBody[] = [];
  /** AABB of the current viewport on the floor — used by the safety-net
   *  clamp. ±Infinity until `setViewportWalls` has been called at least
   *  once. */
  private boundXMin = -Infinity;
  private boundXMax = Infinity;
  private boundZMin = -Infinity;
  private boundZMax = Infinity;

  constructor(rapier: typeof RAPIER_NS) {
    this.world = new rapier.World({ x: 0, y: -28, z: 0 });
    this.world.timestep = 1 / 60;

    // Floor: thick enough that no plausible fall velocity can clear it in a
    // single physics step (10-unit-thick slab gives ~25 steps of safety
    // margin even at 30 m/s impact). Also widened to 100×100 to match the
    // visual floor in DiceScene — a die that for any reason ends up past
    // the walls still has solid ground beneath it instead of falling into
    // the void. Top surface stays at y=0; the collider extends deeper.
    const floorDesc = rapier.RigidBodyDesc.fixed();
    const floor = this.world.createRigidBody(floorDesc);
    this.world.createCollider(
      rapier.ColliderDesc.cuboid(50, 5, 50).setTranslation(0, -5, 0),
      floor,
    );
    // Walls are set up via setViewportWalls() once the host knows where the
    // camera's viewport projects onto the floor.
  }

  /**
   * Wrap the camera's visible footprint on the floor with 4 rotated wall
   * colliders so dice that would otherwise escape the viewport bounce back
   * in. `corners` are the four projected viewport corners on the floor
   * (y=0) in screen-corner order. The walls are rotated cuboids whose inner
   * faces sit exactly on each parallelogram edge.
   *
   * Idempotent: called once at boot AND on every camera-config change
   * (live UI controls or HMR). Old walls are removed before new ones are
   * created so the wrap always matches the current camera framing.
   */
  setViewportWalls(corners: Array<{ x: number; z: number }>): void {
    if (!RAPIER) return;
    if (corners.length !== 4) return;
    const rapier = RAPIER;

    // Remove existing wall bodies.
    for (const w of this.wallBodies) this.world.removeRigidBody(w);
    this.wallBodies = [];

    // Determine winding (CCW vs CW) so we know which side is "inside" the
    // parallelogram. Shoelace formula: positive = CCW looking down +Y.
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      area += a.x * b.z - b.x * a.z;
    }
    const ccw = area > 0;

    const xAxis = new THREE.Vector3(1, 0, 0);
    const tmpEdge = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const A = corners[i]!;
      const B = corners[(i + 1) % 4]!;
      const midX = (A.x + B.x) / 2;
      const midZ = (A.z + B.z) / 2;
      const edgeX = B.x - A.x;
      const edgeZ = B.z - A.z;
      const length = Math.hypot(edgeX, edgeZ);
      if (length < 0.01) continue;

      // Outward normal in the floor plane. For a CCW polygon, rotating the
      // edge -90° around +Y points outward; for CW, +90°.
      const outX = ccw ? (edgeZ / length) : (-edgeZ / length);
      const outZ = ccw ? (-edgeX / length) : (edgeX / length);

      // Wall center: edge midpoint pushed outward by WALL_THICK so the
      // inner face of the cuboid sits exactly on the parallelogram edge.
      const wallX = midX + outX * WALL_THICK;
      const wallZ = midZ + outZ * WALL_THICK;

      // Rotate the cuboid's local +X axis onto the edge direction. Since
      // both vectors lie in the XZ plane this is a pure Y-axis rotation.
      tmpEdge.set(edgeX / length, 0, edgeZ / length);
      const q = new THREE.Quaternion().setFromUnitVectors(xAxis, tmpEdge);

      // Slight overlap at corners (+ WALL_THICK on each end) so adjacent
      // walls join without a seam Rapier might miss.
      const halfLen = length / 2 + WALL_THICK;

      const wallDesc = rapier.RigidBodyDesc.fixed()
        .setTranslation(wallX, WALL_HEIGHT, wallZ)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      const body = this.world.createRigidBody(wallDesc);
      this.world.createCollider(
        rapier.ColliderDesc.cuboid(halfLen, WALL_HEIGHT, WALL_THICK),
        body,
      );
      this.wallBodies.push(body);
    }

    // AABB clamp bounds for the safety net in step().
    const xs = corners.map((c) => c.x);
    const zs = corners.map((c) => c.z);
    this.boundXMin = Math.min(...xs);
    this.boundXMax = Math.max(...xs);
    this.boundZMin = Math.min(...zs);
    this.boundZMax = Math.max(...zs);
  }

  /**
   * Add a die to the world with a human-style throw.
   *
   * Each die spawns at a random point along an arc on the floor centered on
   * the "away-from-camera" direction (so the spawn projects to the top half
   * of the viewport — never below the focus). The radius is large enough to
   * be off-camera. The die starts above the floor with a random orientation,
   * gets a horizontal velocity aimed back at `focus` (plus scatter), a
   * downward initial velocity, and heavy spin on all three axes. The result
   * of a multi-die roll is dice fanning in from various top-half angles.
   *
   * `camera` is the camera's position projected onto the floor (XZ only) —
   * needed to compute which floor-plane direction faces the camera (= the
   * viewport's bottom) and which is away (= top).
   *
   * All throw parameters come from the live SceneConfig — tweak them in
   * `SceneConfig.ts` and they're picked up on the next roll (HMR-friendly).
   */
  addDie(
    obj: THREE.Object3D,
    focus: { x: number; z: number },
    camera: { x: number; z: number },
    throwCfg: ThrowConfig,
    nowMs: number,
  ): void {
    if (this.dice.length >= MAX_DICE) throw new Error(`DicePhysics: exceeded MAX_DICE (${MAX_DICE})`);
    if (!RAPIER) throw new Error('DicePhysics: rapier not initialized');
    const rapier = RAPIER;

    // Azimuth in the floor plane that points AWAY from the camera. This
    // direction projects to the top-center of the viewport (the camera is
    // looking through the focus toward its opposite side).
    const awayAz = Math.atan2(focus.z - camera.z, focus.x - camera.x);
    // Sample within a configurable arc centered on `awayAz`. Limiting to
    // the upper half (or a narrower cone) guarantees the spawn never lands
    // on the camera-facing side, i.e. never at the bottom of the viewport.
    const arcRad = (throwCfg.entryArcDegrees * Math.PI) / 180;
    const azimuth = awayAz + (Math.random() - 0.5) * arcRad;
    const radius = lerp(throwCfg.spawnDistance.min, throwCfg.spawnDistance.max, Math.random());
    const x = focus.x + Math.cos(azimuth) * radius;
    const z = focus.z + Math.sin(azimuth) * radius;
    const y = lerp(throwCfg.startHeight.min, throwCfg.startHeight.max, Math.random());

    // Aim back at the focus — toward-center velocity plus per-axis scatter
    // so no two throws are identical even from the same angle.
    const dirX = focus.x - x;
    const dirZ = focus.z - z;
    const dist = Math.max(0.001, Math.hypot(dirX, dirZ));
    const speed = lerp(throwCfg.throwSpeed.min, throwCfg.throwSpeed.max, Math.random());
    const scatter = throwCfg.lateralScatter;
    const vx = (dirX / dist) * speed + (Math.random() - 0.5) * 2 * scatter;
    const vz = (dirZ / dist) * speed + (Math.random() - 0.5) * 2 * scatter;
    const vy = -lerp(throwCfg.fallSpeed.min, throwCfg.fallSpeed.max, Math.random());

    // Random initial orientation — no preferred face on spawn.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ));

    // Heavy spin on all axes — the die should be a blur in flight.
    const spinMag = lerp(throwCfg.spin.min, throwCfg.spin.max, Math.random());
    const sx = (Math.random() - 0.5) * 2 * spinMag;
    const sy = (Math.random() - 0.5) * 2 * spinMag;
    const sz = (Math.random() - 0.5) * 2 * spinMag;

    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(vx, vy, vz)
      .setAngvel({ x: sx, y: sy, z: sz })
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = rapier.ColliderDesc.cuboid(DIE_HALF, DIE_HALF, DIE_HALF)
      .setRestitution(0.32)
      .setFriction(0.55)
      .setDensity(1.0);
    this.world.createCollider(colDesc, body);

    obj.position.set(x, y, z);
    obj.quaternion.copy(q);
    this.dice.push({
      obj,
      body,
      settleCount: 0,
      startedAtMs: nowMs,
      settled: false,
    });
  }

  /** Promise that resolves when every die has come to rest. */
  whenAllSettled(): Promise<void> {
    if (this.dice.length === 0 || this.dice.every((d) => d.settled)) {
      return Promise.resolve();
    }
    return new Promise<void>((res) => { this.allSettledResolve = res; });
  }

  /** Advance physics by `dtSeconds` and update each die's Object3D transform. */
  step(dtSeconds: number, nowMs: number): void {
    if (!RAPIER) return;
    const subSteps = Math.max(1, Math.min(3, Math.round(dtSeconds / (1 / 60))));
    for (let i = 0; i < subSteps; i++) this.world.step();

    // Safety net: any die that has descended below wall-top height but
    // ended up outside the viewport AABB (because Rapier resolved a wall
    // collision imperfectly, die-to-die impacts shoved it past a wall, or
    // any other edge case) gets clamped back inside and its outward
    // velocity zeroed. Airborne dice (y above WALL_TOP) are NOT clamped —
    // they're still mid-throw, flying in from off-camera. Bounds come from
    // setViewportWalls; ±Infinity until that's been called.
    const WALL_TOP = WALL_HEIGHT * 2;
    const xMin = this.boundXMin + DIE_HALF;
    const xMax = this.boundXMax - DIE_HALF;
    const zMin = this.boundZMin + DIE_HALF;
    const zMax = this.boundZMax - DIE_HALF;
    for (const d of this.dice) {
      const tr = d.body.translation();
      if (tr.y > WALL_TOP) continue;
      let cx = tr.x;
      let cz = tr.z;
      let clamped = false;
      if (cx > xMax) { cx = xMax; clamped = true; }
      if (cx < xMin) { cx = xMin; clamped = true; }
      if (cz > zMax) { cz = zMax; clamped = true; }
      if (cz < zMin) { cz = zMin; clamped = true; }
      if (clamped) {
        d.body.setTranslation({ x: cx, y: tr.y, z: cz }, true);
        const lv = d.body.linvel();
        // Zero any outward-pointing horizontal velocity so the die doesn't
        // immediately try to escape again. Keep vertical motion intact.
        const newVx = (tr.x !== cx) ? 0 : lv.x;
        const newVz = (tr.z !== cz) ? 0 : lv.z;
        d.body.setLinvel({ x: newVx, y: lv.y, z: newVz }, true);
      }
    }

    for (const d of this.dice) {
      const tr = d.body.translation();
      const rt = d.body.rotation();
      d.obj.position.set(tr.x, tr.y, tr.z);
      d.obj.quaternion.set(rt.x, rt.y, rt.z, rt.w);

      if (d.settled) continue;

      const lv = d.body.linvel();
      const av = d.body.angvel();
      const linMag = Math.hypot(lv.x, lv.y, lv.z);
      const angMag = Math.hypot(av.x, av.y, av.z);
      const expired = nowMs - d.startedAtMs > ROLL_TIMEOUT_MS;
      if ((linMag < SETTLE_LINVEL && angMag < SETTLE_ANGVEL) || expired) {
        d.settleCount++;
        if (d.settleCount >= SETTLE_FRAMES || expired) {
          d.settled = true;
        }
      } else {
        d.settleCount = 0;
      }
    }

    if (this.allSettledResolve && this.dice.every((d) => d.settled)) {
      const r = this.allSettledResolve;
      this.allSettledResolve = null;
      r();
    }
  }

  /**
   * Read which face is currently up (closest to world +Y) for a given die.
   * Compares each of the 6 face normals against world +Y after the die's
   * current rotation and returns the maximum-dot face.
   *
   * IMPORTANT: `FACE_NORMALS` is calibrated against the actual MESH's local
   * frame inside the GLB, not the top-level Object3D physics drives. GLB
   * scenes often place the geometry under a child with its own rotation
   * (Y-up vs Z-up conventions, exporter quirks, etc.), so reading the
   * top-level quaternion drops that offset and reports the wrong face.
   * Use the mesh's WORLD quaternion (which composes parent + local) so the
   * face we report matches the pips the player actually sees.
   */
  readFaceUp(obj: THREE.Object3D): Face {
    // Find the first Mesh inside the dice's hierarchy. The dice GLB always
    // resolves to a single Mesh under one or more wrappers; we use that
    // mesh's world quaternion to capture any nested local rotation.
    let mesh: THREE.Object3D = obj;
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh && mesh === obj) mesh = c;
    });
    mesh.updateWorldMatrix(true, false);
    const worldQ = new THREE.Quaternion();
    mesh.getWorldQuaternion(worldQ);

    const faces: Face[] = [1, 2, 3, 4, 5, 6];
    let best: Face = 1;
    let bestDot = -Infinity;
    const tmp = new THREE.Vector3();
    for (const f of faces) {
      tmp.copy(FACE_NORMALS[f]).applyQuaternion(worldQ);
      const d = tmp.dot(WORLD_UP);
      if (d > bestDot) { bestDot = d; best = f; }
    }
    return best;
  }

  /** Remove all dice (their bodies and external Object3Ds). The caller is
   *  responsible for removing the Object3Ds from the three.js scene. */
  clear(): void {
    for (const d of this.dice) {
      this.world.removeRigidBody(d.body);
    }
    this.dice = [];
    this.allSettledResolve = null;
  }

  /** Iterate dice for the host to remove their Object3D from the scene. */
  getObjects(): THREE.Object3D[] {
    return this.dice.map((d) => d.obj);
  }
}
