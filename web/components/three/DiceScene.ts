/**
 * three.js renderer for the 3D dice overlay. Renders the scene to a low-res
 * `WebGLRenderTarget`, then upscales to the on-screen canvas using a
 * full-screen quad with `magFilter = NEAREST`. The result fuses with the Pixi
 * board's pixel-art look (which uses CSS `image-rendering: pixelated` and
 * nearest-neighbor texture filtering).
 *
 * Camera + lights + floor surface are sourced from `SceneConfig.ts` and can
 * be hot-swapped via `applyConfig()` — Vite HMR handlers in `dice-test.ts`
 * and `main.ts` forward SceneConfig edits to live scene instances.
 *
 * Lifecycle:
 *   const scene = new DiceScene(canvas);
 *   scene.start();
 *   scene.resize(w, h);
 *   scene.addDie(obj); scene.removeDie(obj);
 *   scene.applyConfig(newConfig);   // live re-apply
 *   scene.dispose();
 */
import * as THREE from 'three';
import * as DefaultConfig from './SceneConfig.js';
import type { SceneConfigModule } from './SceneConfig.js';

export class DiceScene {
  readonly scene: THREE.Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.OrthographicCamera;
  private readonly rt: THREE.WebGLRenderTarget;
  /** Dice-only coverage mask (same low-res grid as `rt`). Rendered each frame
   *  with the floor hidden, so its alpha channel marks which RT pixels belong
   *  to a die. The upscale shader reads it to keep the dice IMMUNE to the
   *  vignette dithering — the ink frames the wood tray but never the dice. */
  private readonly diceMaskRt: THREE.WebGLRenderTarget;
  private readonly upscaleScene: THREE.Scene;
  private readonly upscaleCam: THREE.OrthographicCamera;
  private readonly upscaleQuad: THREE.Mesh;
  private readonly upscaleMat: THREE.ShaderMaterial;
  /** Strongly-typed handle on the upscale shader's uniforms. Referenced
   *  directly (instead of `upscaleMat.uniforms.X`, whose index signature
   *  widens each lookup to `IUniform | undefined` under
   *  `noUncheckedIndexedAccess`). */
  private readonly upscaleUniforms: {
    tex: { value: THREE.Texture };
    uMask: { value: THREE.Texture };
    uRtSize: { value: THREE.Vector2 };
    uVigRadius: { value: number };
    uVigSoft: { value: number };
    uVigInt: { value: number };
    uDitherPx: { value: number };
  };
  private readonly floor: THREE.Mesh;
  private lights: THREE.Light[] = [];
  private cameraZoom: number;
  private pixelScale: number;
  private floorSize: number;
  /** Currently-loaded floor texture (if any) keyed by URL via userData. */
  private floorTexture: THREE.Texture | null = null;
  private animHandle: number | null = null;
  private onFrame: ((dtSeconds: number) => void) | null = null;
  private lastFrameTimeMs: number | null = null;
  private widthPx = 1;
  private heightPx = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, config: SceneConfigModule = DefaultConfig) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    // Orthographic camera — sized by `config.CAMERA.zoom` on every resize.
    // Initial frustum is a placeholder; `resize()` recomputes it.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, config.CAMERA.near, config.CAMERA.far);
    this.cameraZoom = config.CAMERA.zoom;
    this.pixelScale = Math.max(1, config.PIXELATION.scale);

    // Floor — a single MeshStandardMaterial whose color/roughness/metalness/
    // texture are all swappable via applyConfig. Sized large so the iso
    // camera never sees past the edge — the wood fills the whole scene.
    const floorMat = new THREE.MeshStandardMaterial({
      color:     config.FLOOR.color,
      roughness: config.FLOOR.roughness,
      metalness: config.FLOOR.metalness,
    });
    this.floorSize = config.FLOOR.size;
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(this.floorSize, this.floorSize),
      floorMat,
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0;
    this.scene.add(this.floor);
    this.applyFloorTexture(config.FLOOR);

    // Lights — start from defaults; applyConfig swaps them at runtime.
    this.applyLights(config.buildLights());
    this.applyCamera(config.CAMERA);

    // Low-res render target + nearest-neighbor upscale pass. Camera-agnostic.
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    // Dice-only coverage mask at the same low-res grid (alpha = die present).
    this.diceMaskRt = new THREE.WebGLRenderTarget(1, 1, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });

    this.upscaleScene = new THREE.Scene();
    this.upscaleCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.upscaleUniforms = {
      tex:        { value: this.rt.texture },
      uMask:      { value: this.diceMaskRt.texture },
      uRtSize:    { value: new THREE.Vector2(1, 1) },
      uVigRadius: { value: config.VIGNETTE.radius },
      uVigSoft:   { value: config.VIGNETTE.softness },
      uVigInt:    { value: config.VIGNETTE.intensity },
      uDitherPx:  { value: config.VIGNETTE.ditherPx },
    };
    this.upscaleMat = new THREE.ShaderMaterial({
      uniforms: this.upscaleUniforms,
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      // Dithered black vignette — the same ordered-dither (4x4 Bayer) halftone
      // the Pixi board uses (web/components/Lighting.ts VIGNETTE_FRAGMENT), so
      // the dice tray frames into matching ink dots rather than a smooth fade.
      // The RECTANGULAR coverage is computed on the low-res RT pixel grid (so
      // the fade steps align with the pixelation blocks) and the Bayer
      // threshold is sampled per RT pixel — one ink dot per pixelation block,
      // as chunky as the pixel-art upscale instead of a finer screen-space
      // dither. Sampling the RT colour itself uses native vUv to preserve the
      // nearest-neighbor upscale from the texture's own filter setting.
      fragmentShader: `
        uniform sampler2D tex;
        uniform sampler2D uMask;
        uniform vec2  uRtSize;
        uniform float uVigRadius;
        uniform float uVigSoft;
        uniform float uVigInt;
        uniform float uDitherPx;
        varying vec2 vUv;

        // 4x4 ordered Bayer matrix — identical to the board's vignette/lighting
        // dither so both surfaces share the same ink-dot pattern.
        float bayer2(vec2 a) {
          a = floor(a);
          return fract(a.x / 2.0 + a.y * a.y * 0.75);
        }
        float bayer4(vec2 a) {
          return bayer2(0.5 * a) * 0.25 + bayer2(a);
        }

        void main() {
          vec4 color = texture2D(tex, vUv);
          // Integer RT-pixel coordinate — drives both the snapped rectangular
          // fade and the per-block Bayer threshold.
          vec2 px = floor(vUv * uRtSize);
          // Snap UV to the RT pixel grid (center of each texel).
          vec2 pUv = (px + 0.5) / uRtSize;
          // Chebyshev (square) distance from centre: 0 at centre, 1 on the
          // frame edge. max() instead of length() makes the iso-coverage
          // contours axis-aligned RECTANGLES — a rect vignette framing the
          // tray, not a circular/elliptical one.
          vec2 d = abs(pUv - vec2(0.5)) * 2.0;
          float dist = max(d.x, d.y);
          // Coverage 0..1: 0 in the bright centre rectangle, rising to uVigInt
          // by the edges — the fraction of pixels turned to black ink.
          float cov = smoothstep(uVigRadius, uVigRadius + uVigSoft, dist) * uVigInt;
          float thr = bayer4(px / max(uDitherPx, 1.0));
          // Strict '>' (vs the board's inclusive step) keeps the cov==0 centre
          // free of stray ink dots on the brighter wood tray.
          float ink = cov > thr ? 1.0 : 0.0;
          // Dice are IMMUNE to the vignette: where the dice-only mask covers
          // this pixel (alpha > 0), suppress the ink so the die stays at full
          // brightness even when it lands in a dithered corner. Sampled at the
          // snapped texel centre to align with the per-pixel ink decision.
          float die = texture2D(uMask, pUv).a;
          ink *= (1.0 - step(0.5, die));
          color.rgb *= (1.0 - ink);
          gl_FragColor = color;
        }
      `,
      transparent: true,
    });
    this.upscaleQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.upscaleMat);
    this.upscaleScene.add(this.upscaleQuad);
  }

  /**
   * Re-apply a SceneConfig module. Use after a Vite HMR update of
   * `SceneConfig.ts` to refresh camera, lighting, and floor without
   * rebuilding the renderer or the physics world.
   */
  applyConfig(config: SceneConfigModule): void {
    this.pixelScale = Math.max(1, config.PIXELATION.scale);
    this.applyCamera(config.CAMERA);
    this.applyLights(config.buildLights());

    // Floor geometry — rebuild if size changed.
    if (config.FLOOR.size !== this.floorSize) {
      (this.floor.geometry as THREE.BufferGeometry).dispose();
      this.floor.geometry = new THREE.PlaneGeometry(config.FLOOR.size, config.FLOOR.size);
      this.floorSize = config.FLOOR.size;
    }

    const mat = this.floor.material as THREE.MeshStandardMaterial;
    mat.color.setHex(config.FLOOR.color);
    mat.roughness = config.FLOOR.roughness;
    mat.metalness = config.FLOOR.metalness;
    mat.needsUpdate = true;

    this.applyFloorTexture(config.FLOOR);

    // Vignette uniforms — pushed straight to the upscale shader.
    this.upscaleUniforms.uVigRadius.value = config.VIGNETTE.radius;
    this.upscaleUniforms.uVigSoft.value   = config.VIGNETTE.softness;
    this.upscaleUniforms.uVigInt.value    = config.VIGNETTE.intensity;
    this.upscaleUniforms.uDitherPx.value  = config.VIGNETTE.ditherPx;

    // Re-apply the current canvas size so the RT picks up the new pixelScale.
    this.resize(this.widthPx, this.heightPx);
  }

  /**
   * Load and bind the floor texture asynchronously. If the texture URL is
   * unchanged from the currently-loaded one, just refresh the repeat count.
   * If it's null, strip the existing texture so the material falls back to
   * the flat color.
   */
  private applyFloorTexture(floorCfg: SceneConfigModule['FLOOR']): void {
    const mat = this.floor.material as THREE.MeshStandardMaterial;
    const url = floorCfg.texture;
    if (!url) {
      if (mat.map) {
        mat.map = null;
        mat.needsUpdate = true;
      }
      if (this.floorTexture) {
        this.floorTexture.dispose();
        this.floorTexture = null;
      }
      return;
    }
    // Same texture URL already loaded? Just retune the repeat count.
    if (this.floorTexture && this.floorTexture.userData.sourceUrl === url) {
      this.floorTexture.repeat.set(floorCfg.textureRepeat, floorCfg.textureRepeat);
      this.floorTexture.needsUpdate = true;
      return;
    }
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (this.disposed) { tex.dispose(); return; }
        tex.userData.sourceUrl = url;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(floorCfg.textureRepeat, floorCfg.textureRepeat);
        // Filter choice:
        //  - texturePixelated=true: nearest-neighbor sampling on the texture
        //    itself so wood texels render as crisp blocks, stacking with the
        //    screen-space pixelation pass. Mipmaps still generated and
        //    selected by nearest (not blended) so heavily-minified samples
        //    don't shimmer/aliase but stay blocky.
        //  - texturePixelated=false: classic smooth photographic sampling,
        //    pixelation only applied at the post-process stage.
        if (floorCfg.texturePixelated) {
          tex.generateMipmaps = true;
          tex.minFilter = THREE.NearestMipmapNearestFilter;
          tex.magFilter = THREE.NearestFilter;
        } else {
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        const prev = this.floorTexture;
        this.floorTexture = tex;
        mat.map = tex;
        mat.needsUpdate = true;
        if (prev) prev.dispose();
      },
      undefined,
      (err) => {
        // eslint-disable-next-line no-console
        console.warn('Floor texture load failed:', err);
      },
    );
  }

  private applyCamera(cfg: SceneConfigModule['CAMERA']): void {
    this.cameraZoom = cfg.zoom;
    this.camera.near = cfg.near;
    this.camera.far = cfg.far;
    this.camera.position.copy(cfg.position);
    this.camera.lookAt(cfg.target);
    this.camera.up.set(0, 1, 0);
    // Frustum sized from current viewport — resize() refreshes too.
    this.refreshFrustum();
  }

  private refreshFrustum(): void {
    const lowW = Math.max(1, Math.floor(this.widthPx / this.pixelScale));
    const lowH = Math.max(1, Math.floor(this.heightPx / this.pixelScale));
    const aspect = lowW / lowH;
    const z = this.cameraZoom;
    this.camera.left = -z * aspect;
    this.camera.right = z * aspect;
    this.camera.top = z;
    this.camera.bottom = -z;
    this.camera.updateProjectionMatrix();
  }

  private applyLights(lights: THREE.Light[]): void {
    for (const old of this.lights) this.scene.remove(old);
    this.lights = lights;
    for (const l of this.lights) this.scene.add(l);
  }

  setOnFrame(fn: ((dtSeconds: number) => void) | null): void {
    this.onFrame = fn;
  }

  addDie(obj: THREE.Object3D): void { this.scene.add(obj); }
  removeDie(obj: THREE.Object3D): void { this.scene.remove(obj); }

  /**
   * Where the camera's center ray hits the floor (y=0). This is the
   * geometric center of the visible region on the floor — NOT the same as
   * the camera's look-at target's X/Z projection unless the target itself
   * sits on the floor. Used by the throw to aim dice at the on-screen
   * center, regardless of how the look-at target was authored.
   */
  getViewportFloorCenter(): { x: number; z: number } | null {
    const view = new THREE.Vector3();
    this.camera.getWorldDirection(view);
    if (Math.abs(view.y) < 1e-6) return null;
    const origin = this.camera.position;
    const t = -origin.y / view.y;
    return {
      x: origin.x + t * view.x,
      z: origin.z + t * view.z,
    };
  }

  /**
   * Project a WORLD-space point through the camera to its position on the
   * displayed canvas, expressed as PERCENT (0–100) on each axis with the
   * origin at the top-left. Used to anchor the Order-of-Battle badges over
   * each settled die. Clamped to [0,100] so an off-frame die still resolves
   * to an edge anchor rather than flying off the overlay.
   */
  projectToStagePercent(world: THREE.Vector3): { x: number; y: number } {
    const ndc = world.clone().project(this.camera); // -1..1 on each axis
    const clamp = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);
    return {
      x: clamp(((ndc.x + 1) / 2) * 100),
      y: clamp(((1 - ndc.y) / 2) * 100), // flip Y — NDC +up vs screen +down
    };
  }

  /**
   * Project the orthographic frustum onto the floor (y=0) and return the
   * four corners of the visible region in world XZ coordinates. Used by
   * Dice3DOverlay to position viewport-edge collision walls so dice bounce
   * back into view if they would otherwise escape the camera's frame.
   *
   * Returned in screen-corner order: top-right, top-left, bottom-left,
   * bottom-right.
   */
  getViewportFloorCorners(): Array<{ x: number; z: number }> {
    const view = new THREE.Vector3();
    this.camera.getWorldDirection(view); // normalized toward target
    if (Math.abs(view.y) < 1e-6) return [];

    const right = new THREE.Vector3().crossVectors(view, this.camera.up).normalize();
    const screenUp = new THREE.Vector3().crossVectors(right, view).normalize();

    const halfV = this.cameraZoom;
    const halfH = halfV * (this.widthPx / Math.max(1, this.heightPx));

    const out: Array<{ x: number; z: number }> = [];
    const screenCorners: Array<[number, number]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (const [sx, sy] of screenCorners) {
      const rayOrigin = this.camera.position.clone()
        .addScaledVector(right, sx * halfH)
        .addScaledVector(screenUp, sy * halfV);
      const t = -rayOrigin.y / view.y;
      out.push({
        x: rayOrigin.x + t * view.x,
        z: rayOrigin.z + t * view.z,
      });
    }
    return out;
  }

  resize(widthPx: number, heightPx: number): void {
    this.widthPx = Math.max(1, Math.floor(widthPx));
    this.heightPx = Math.max(1, Math.floor(heightPx));
    this.renderer.setSize(this.widthPx, this.heightPx, false);
    const lowW = Math.max(1, Math.floor(this.widthPx / this.pixelScale));
    const lowH = Math.max(1, Math.floor(this.heightPx / this.pixelScale));
    this.rt.setSize(lowW, lowH);
    this.diceMaskRt.setSize(lowW, lowH);
    // Vignette quantizes UV to this resolution so its step transitions
    // line up with the pixelation grid.
    this.upscaleUniforms.uRtSize.value.set(lowW, lowH);
    this.refreshFrustum();
  }

  start(): void {
    if (this.animHandle !== null || this.disposed) return;
    const loop = (timeMs: number): void => {
      if (this.disposed) return;
      const dt = this.lastFrameTimeMs === null ? 1 / 60 : Math.min(0.05, (timeMs - this.lastFrameTimeMs) / 1000);
      this.lastFrameTimeMs = timeMs;
      if (this.onFrame) this.onFrame(dt);

      this.renderer.setRenderTarget(this.rt);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);

      // Dice-only coverage pass: hide the floor so only the dice render, and
      // the mask RT's alpha channel marks the die pixels the upscale shader
      // exempts from the vignette ink. Restored immediately after.
      this.floor.visible = false;
      this.renderer.setRenderTarget(this.diceMaskRt);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.floor.visible = true;

      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.upscaleScene, this.upscaleCam);

      this.animHandle = requestAnimationFrame(loop);
    };
    this.animHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.animHandle !== null) {
      cancelAnimationFrame(this.animHandle);
      this.animHandle = null;
    }
    this.lastFrameTimeMs = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.rt.dispose();
    this.diceMaskRt.dispose();
    (this.upscaleQuad.material as THREE.ShaderMaterial).dispose();
    (this.upscaleQuad.geometry as THREE.BufferGeometry).dispose();
    (this.floor.material as THREE.MeshStandardMaterial).dispose();
    (this.floor.geometry as THREE.BufferGeometry).dispose();
    if (this.floorTexture) {
      this.floorTexture.dispose();
      this.floorTexture = null;
    }
    this.renderer.dispose();
  }
}
