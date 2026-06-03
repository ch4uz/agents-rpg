import { Application, Assets, Sprite, Container, Texture, Rectangle, Graphics, FillGradient } from 'pixi.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { AssetManifest, AnimationStrip } from '../../src/runtime/ws/manifest.js';
import type { Store, StoreState } from '../store.js';
import { flashRoll } from './RollOverlay.js';
import { triggerExplosion } from './Explosion.js';
import { triggerProjectile, computeFlightMs, type AttackKind } from './Projectile.js';
import { waitForRollResolved } from './roll-events.js';
import { chooseTileBox, cellKey, loadTilesetMetadata, type TilesetMetadata } from './TileMap.js';
import { resolvePropPlacements } from './Props.js';
import { detectPushedObstacle } from './prop-slide.js';
import { LightingLayer, lightingTune } from './Lighting.js';
import {
  HERO_TORCH, BOSS_GLOW,
  FIRE_BOLT_LIGHT, FIRE_IMPACT_LIGHT, FLAME_BURST_LIGHT, EXPLOSION_LIGHT,
  type LightSource,
} from './light-field.js';
import { createMiniBarEl, updateMiniBarEl, createDurabilityBarEl, updateDurabilityBarEl } from './MiniBar.js';
import {
  spawnEmojiBalloon,
  type EmojiBalloonHandle,
} from './EmojiBalloon.js';
import {
  spawnThoughtBalloon,
  reconcileThoughtBalloons,
  type ThoughtBalloonHandle,
} from './ThoughtBalloon.js';
import type { SelectionOverlay } from './ActionButtons.js';
import type { RefTarget } from './refs.js';
import {
  DEFAULT_FACING,
  facingChangeFromEvent,
  facingFromMovePath,
  type Facing,
} from './Facing.js';
import {
  computeFrameIndex,
  animationDurationMs,
  type ActiveAnimation,
  type AnimKind,
} from './Animation.js';

export const CELL_PX = 64;

/**
 * Delay (ms after the explosion is triggered) before the blast's cleared cells —
 * the cask + the stalagmites it shattered — are actually removed from the board.
 * Tuned to land just past the fireball's pop-in (Explosion `POP_FRAC` of ~620ms),
 * so the wall crumbles WITH the boom instead of before it.
 */
const EXPLOSION_DEMOLISH_DELAY_MS = 120;

/**
 * Pure: the dialogue-reference highlight ring colour for a creature, keyed off
 * its faction. Mirrors the `.dlg-ref--creature` chip hexes in main.css
 * (hero #ffcf7a, monster #ff8f7a, npc #8fe0a0) so the in-game ring is the SAME
 * hue as the wording in the text. Unknown kinds fall back to the bare-chip
 * gold (#ffe85c). Keep in sync with the CSS faction tints.
 */
export const creatureRingColor = (kind: string): number => {
  switch (kind) {
    case 'hero':    return 0xffcf7a;
    case 'monster': return 0xff8f7a;
    case 'npc':     return 0x8fe0a0;
    default:        return 0xffe85c;
  }
};

/**
 * Pure: stacking order for a character token within the (sortable) token layer,
 * keyed off health status. KO'd corpses sit on a lower band than every living
 * token, so a hero/monster overlapping a corpse cell always renders ON TOP of
 * the body — never hidden under it. All living statuses (incl. a bound captive)
 * share one band; Pixi's stable zIndex sort preserves insertion order within it.
 */
export const tokenZIndex = (status: RedactedCharacter['health']['status']): number =>
  status === 'KO' ? 0 : 1;

/** Convention: maps `exits[].to` (next-scene id) → prop id used to render the exit cell. */
const EXIT_TO_PROP: Record<string, string> = {};

/** Pure: given a character list and cell size, return id→pixel position. */
export const computeTokenPositions = (
  chars: readonly RedactedCharacter[],
  cell: number,
): Map<string, { x: number; y: number }> => {
  const out = new Map<string, { x: number; y: number }>();
  for (const c of chars) {
    if (c.pos) out.set(String(c.id), { x: c.pos.x * cell, y: c.pos.y * cell });
  }
  return out;
};

/**
 * Pure: choose a *pixel-art friendly* render size for a (texW × texH) sprite
 * inside a (cell × cell) tile. Fractional scales kill pixel-art crispness —
 * nearest-neighbor scaling at e.g. 0.94× produces uneven pixel widths that
 * read as blurry under the canvas's CSS upscale. The rules:
 *   - Sprite smaller than the cell  → upscale by an INTEGER factor.
 *   - Sprite near cell size (≤ 125%)→ render at NATIVE; slight overflow OK.
 *   - Sprite much bigger            → downscale by 1/k for the smallest k
 *                                     that fits, so pixel groupings stay
 *                                     uniform.
 */
export const fitTokenScale = (
  texW: number,
  texH: number,
  cell: number,
): { w: number; h: number } => {
  if (texW <= 0 || texH <= 0) return { w: cell, h: cell };
  const maxDim = Math.max(texW, texH);
  if (maxDim < cell) {
    const factor = Math.max(1, Math.floor(cell / maxDim));
    return { w: texW * factor, h: texH * factor };
  }
  if (maxDim <= cell * 1.25) {
    return { w: texW, h: texH };
  }
  const k = Math.ceil(maxDim / cell);
  return { w: Math.round(texW / k), h: Math.round(texH / k) };
};

/**
 * Resolve a character's sprite asset id from the manifest.
 * Falls back through: explicit sprite > archetype > kind. If none resolves,
 * returns null (the renderer will then skip drawing the token).
 *
 * Returned tuple: `[manifestKey, manifestValue]`. The manifestKey is the same
 * id we look up animations under (`animations[manifestKey]`); the value is
 * either a `.png` path (legacy single sprite) or a folder path (directional).
 */
export const resolveCharacterSprite = (
  c: RedactedCharacter,
  manifest: AssetManifest,
): { id: string; value: string } | null => {
  const group = c.kind === 'hero' ? manifest.heroes
              : c.kind === 'npc'  ? manifest.npcs
              : manifest.monsters;
  const candidates = [c.sprite, c.archetype, c.kind].filter((v): v is string => typeof v === 'string');
  // A bound captive prefers a dedicated "<id>-bound" sprite (e.g. a healer tied
  // up on the ground) when the manifest provides one — falling back to the
  // normal sprite otherwise. The board swaps back to the base sprite when the
  // status clears (freed). See the immobilized-transition handling below.
  if (c.health.status === 'immobilized') {
    for (const id of candidates) {
      const boundId = `${id}-bound`;
      if (group[boundId]) return { id: boundId, value: group[boundId]! };
    }
  }
  for (const id of candidates) {
    if (group[id]) return { id, value: group[id]! };
  }
  return null;
};

/**
 * Resolve a sprite manifest value to the absolute path of one directional
 * static rotation. Legacy `.png` values are returned as-is for any facing
 * (no rotation exists). Folder values append `<facing>.png`.
 */
const resolveStaticDirectional = (
  manifestValue: string,
  facing: Facing,
  assetsBase: string,
): string => {
  if (manifestValue.endsWith('.png')) return `${assetsBase}/${manifestValue}`;
  return `${assetsBase}/${manifestValue}/${facing}.png`;
};

/**
 * Build a Wang-tile floor layer for a (gridW × gridH) scene by indexing into
 * the spritesheet's sub-rects. Each cell becomes one Pixi Sprite scaled to
 * CELL_PX × CELL_PX.
 */
const mountTilemap = async (
  parent: Container,
  spritesheetPath: string,
  meta: TilesetMetadata,
  gridW: number,
  gridH: number,
  walls: boolean,
  wallCells: ReadonlyArray<{ x: number; y: number }>,
): Promise<Container> => {
  const layer = new Container();
  const sheet = await Assets.load(spritesheetPath) as Texture;
  // Pixel-art tiles need nearest-neighbor filtering — Pixi 8 defaults to
  // linear, which blurs pixel art when scaled.
  sheet.source.scaleMode = 'nearest';
  // When the scene declares explicit rock cells, carve the cave outline from
  // that mask (marching squares); otherwise fall back to the perimeter ring.
  const wallMask = wallCells.length > 0
    ? new Set(wallCells.map((c) => cellKey(c.x, c.y)))
    : undefined;
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const bbox = chooseTileBox(cx, cy, gridW, gridH, meta, walls, wallMask);
      const subTex = new Texture({
        source: sheet.source,
        frame: new Rectangle(bbox.x, bbox.y, bbox.width, bbox.height),
      });
      const tile = new Sprite(subTex);
      tile.x = cx * CELL_PX;
      tile.y = cy * CELL_PX;
      tile.width = CELL_PX;
      tile.height = CELL_PX;
      layer.addChild(tile);
    }
  }
  parent.addChild(layer);
  return layer;
};

/**
 * Build a prop layer (decorations + obstacles + exits) for the given scene.
 * Each placement becomes one Pixi Sprite anchored bottom-center, scaled with
 * fitTokenScale, positioned at its cell.
 */
const mountProps = async (
  parent: Container,
  scene: NonNullable<StoreState['scene']>,
  manifest: AssetManifest,
  assetsBase: string,
): Promise<Container> => {
  const layer = new Container();
  const placements = resolvePropPlacements(scene, manifest.props, EXIT_TO_PROP);
  for (const p of placements) {
    const tex = await Assets.load(`${assetsBase}/${p.assetRel}`) as Texture;
    tex.source.scaleMode = 'nearest';
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1.0);
    const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
    sprite.width = fit.w;
    sprite.height = fit.h;
    sprite.x = p.x * CELL_PX + CELL_PX / 2;
    sprite.y = p.y * CELL_PX + CELL_PX;
    // Tag with layer + grid cell so a slide tween can find a specific sprite
    // (e.g. the cask just pushed to this cell) after a prop-layer rebuild.
    sprite.label = `${p.layer}:${p.x},${p.y}`;
    layer.addChild(sprite);
  }
  parent.addChild(layer);
  return layer;
};

export interface ClickTarget {
  pos: { x: number; y: number };
  /** When the click landed on a character's tile, the character id (else null). */
  actorId: string | null;
}

export interface MountBoardOptions {
  assetsBase?: string;
  /** Fired on canvas click with the resolved grid cell + occupant (if any). */
  onCanvasClick?: (target: ClickTarget) => void;
  /** Fired on canvas right-click (contextmenu) with the resolved cell +
   *  occupant. Used to remove a die from a target mid split-special. The
   *  default context menu is suppressed. */
  onCanvasRightClick?: (target: ClickTarget) => void;
  /** Fired whenever the set of actors currently animating a move changes.
   *  Layout uses this to hold the turn-order cursor on a combatant while
   *  their move sprite is still sliding across the board — without it the
   *  bar would advance the instant the WS `turn_started` for the next
   *  combatant arrives, even though the previous one is still visibly
   *  walking. The set is a fresh snapshot each call (safe to keep). */
  onMovingActorsChange?: (actorIds: ReadonlySet<string>) => void;
}

export interface BoardApi {
  /** Replace the selection overlay (highlighted cells / target tokens + cursor visibility). */
  setSelectionOverlay(state: SelectionOverlay): void;
  /** Highlight (pulsing ring) the cell or creature(s) referenced by a dialogue
   *  chip the user is hovering, or clear the highlight with `null`. */
  setHoverHighlight(target: RefTarget | null): void;
  /** Spawn an emoji balloon over `actorId`'s current cell. Driven by Layout's
   *  `onEmote` callback when an `emote` beat is promoted in the playback queue
   *  (so the balloon fires in dialogue order, not on raw WS arrival). The
   *  actor's position is resolved from the LIVE snapshot at call time; an
   *  off-board / position-less actor is silently skipped (no anchor). */
  spawnEmote(actorId: string, emoji: string): void;
}

/**
 * Floating dev control panel for dialling in the lighting look live (enabled
 * with `?lighttune=1`). Mutates the shared `lightingTune` object and re-applies
 * via `layer.refresh()` so every change shows on the board immediately.
 */
const mountLightingTunePanel = (layer: LightingLayer): void => {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:99999;background:rgba(18,16,26,0.94);' +
    'color:#eee;font:12px/1.4 system-ui,sans-serif;padding:12px 14px;border-radius:10px;' +
    'box-shadow:0 4px 18px rgba(0,0,0,0.65);width:220px;user-select:none';

  const title = document.createElement('div');
  title.textContent = '💡 Lighting tune';
  title.style.cssText = 'font-weight:700;margin-bottom:8px';
  panel.appendChild(title);

  const status = document.createElement('div');
  status.style.cssText = 'margin-top:8px;opacity:0.75;font-variant-numeric:tabular-nums';
  const sync = (): void => {
    status.textContent =
      `dither=${lightingTune.ditherPx}px  levels=${lightingTune.levels}  ` +
      `glow=${lightingTune.glowScale.toFixed(2)}  tint=${lightingTune.tintAmt.toFixed(2)}`;
  };

  const apply = (): void => {
    layer.refresh();
    sync();
  };

  const buttonRow = (
    label: string,
    values: number[],
    key: 'ditherPx' | 'levels' | 'sub',
  ): HTMLElement => {
    const row = document.createElement('div');
    row.style.margin = '6px 0';
    const lab = document.createElement('div');
    lab.textContent = label;
    lab.style.cssText = 'opacity:0.7;margin-bottom:3px';
    row.appendChild(lab);
    for (const v of values) {
      const b = document.createElement('button');
      b.textContent = String(v);
      b.style.cssText =
        'margin:2px;padding:3px 9px;cursor:pointer;background:#3a3550;color:#fff;' +
        'border:1px solid #5a5478;border-radius:5px';
      b.addEventListener('click', () => {
        (lightingTune as unknown as Record<string, number>)[key] = v;
        apply();
      });
      row.appendChild(b);
    }
    return row;
  };

  panel.appendChild(buttonRow('Dither dot size (px — lower = finer)', [1, 2, 3, 4, 6], 'ditherPx'));
  panel.appendChild(buttonRow('Levels (1 = on/off halftone)', [1, 2, 3, 4], 'levels'));
  panel.appendChild(buttonRow('Light map res (sub)', [4, 6, 8], 'sub'));

  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
  ): HTMLElement => {
    const row = document.createElement('div');
    row.style.margin = '8px 0 2px';
    const lab = document.createElement('div');
    lab.textContent = label;
    lab.style.cssText = 'opacity:0.7;margin-bottom:3px';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    input.style.width = '100%';
    input.addEventListener('input', () => {
      set(parseFloat(input.value));
      apply();
    });
    row.appendChild(lab);
    row.appendChild(input);
    return row;
  };

  panel.appendChild(
    slider('Glow brightness', 0.4, 2.0, 0.05, () => lightingTune.glowScale, (v) => { lightingTune.glowScale = v; }),
  );
  panel.appendChild(
    slider('Colour tint', 0, 1, 0.05, () => lightingTune.tintAmt, (v) => { lightingTune.tintAmt = v; }),
  );
  panel.appendChild(
    slider('Vignette depth', 0, 0.4, 0.01, () => lightingTune.vignetteDepth, (v) => { lightingTune.vignetteDepth = v; }),
  );
  panel.appendChild(
    slider('Vignette strength', 0, 1, 0.05, () => lightingTune.vignetteStrength, (v) => { lightingTune.vignetteStrength = v; }),
  );
  panel.appendChild(
    slider('Vignette corners (round → circle)', 0, 1, 0.05, () => lightingTune.vignetteCorner, (v) => { lightingTune.vignetteCorner = v; }),
  );

  // On/off toggle (master — flips both the light map AND the vignette).
  const toggle = document.createElement('button');
  toggle.textContent = 'Toggle lighting on/off';
  toggle.style.cssText =
    'margin-top:8px;width:100%;padding:5px;cursor:pointer;background:#4a3550;color:#fff;' +
    'border:1px solid #6a5478;border-radius:5px';
  let on = layer.enabled;
  toggle.addEventListener('click', () => {
    on = !on;
    layer.setEnabled(on);
  });
  panel.appendChild(toggle);

  // Light-map-only toggle: kills the dithered-shading light/shadow pass while
  // leaving the edge vignette in place, so you can inspect the vignette frame
  // against an evenly-lit board.
  const lightOnlyToggle = document.createElement('button');
  const lightOnlyLabel = (lit: boolean): string =>
    lit ? 'Lighting: ON (vignette stays)' : 'Lighting: OFF (vignette stays)';
  let lit = layer.lightingEnabled;
  lightOnlyToggle.textContent = lightOnlyLabel(lit);
  lightOnlyToggle.style.cssText =
    'margin-top:6px;width:100%;padding:5px;cursor:pointer;background:#3a3550;color:#fff;' +
    'border:1px solid #5a5478;border-radius:5px';
  lightOnlyToggle.addEventListener('click', () => {
    lit = !lit;
    layer.setLightingEnabled(lit);
    lightOnlyToggle.textContent = lightOnlyLabel(lit);
  });
  panel.appendChild(lightOnlyToggle);

  // Shading-style toggle: dithered halftone (the game look) ⇄ smooth "standard"
  // multiply lighting. Only the light-map pass changes — the vignette keeps its
  // own dithering.
  const ditherToggle = document.createElement('button');
  const ditherLabel = (dithered: boolean): string =>
    dithered ? 'Lighting: dithered (halftone)' : 'Lighting: standard (smooth)';
  let dithered = layer.ditheringEnabled;
  ditherToggle.textContent = ditherLabel(dithered);
  ditherToggle.style.cssText =
    'margin-top:6px;width:100%;padding:5px;cursor:pointer;background:#35404a;color:#fff;' +
    'border:1px solid #54786a;border-radius:5px';
  ditherToggle.addEventListener('click', () => {
    dithered = !dithered;
    layer.setDithering(dithered);
    ditherToggle.textContent = ditherLabel(dithered);
  });
  panel.appendChild(ditherToggle);

  // Enlarge the board canvas to inspect the dither up close (the preview's
  // narrator window otherwise keeps it small). Forces native-aspect display.
  const zoom = document.createElement('button');
  zoom.textContent = 'Enlarge board (inspect)';
  zoom.style.cssText =
    'margin-top:6px;width:100%;padding:5px;cursor:pointer;background:#35404a;color:#fff;' +
    'border:1px solid #54786a;border-radius:5px';
  let big = false;
  zoom.addEventListener('click', () => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)[0];
    if (!c) return;
    big = !big;
    if (big) {
      c.style.setProperty('width', `${c.width}px`, 'important');
      c.style.setProperty('height', `${c.height}px`, 'important');
      c.style.setProperty('max-width', 'none', 'important');
      c.style.setProperty('max-height', 'none', 'important');
      c.style.imageRendering = 'pixelated';
      c.scrollIntoView({ block: 'center' });
    } else {
      c.style.removeProperty('width');
      c.style.removeProperty('height');
      c.style.removeProperty('max-width');
      c.style.removeProperty('max-height');
    }
  });
  panel.appendChild(zoom);

  // Copy ALL current lighting params to the clipboard as JSON — paste it back to
  // me and I'll bake the values in as the light-field.ts defaults. Captures every
  // lightingTune field (dither/levels/sub, glow, tint, all 3 vignette knobs, and
  // both ambient colours).
  const copy = document.createElement('button');
  const copyLabel = 'Copy parameters (JSON)';
  copy.textContent = copyLabel;
  copy.style.cssText =
    'margin-top:6px;width:100%;padding:5px;cursor:pointer;background:#3a4a35;color:#fff;' +
    'border:1px solid #6a7854;border-radius:5px';
  copy.addEventListener('click', async () => {
    const json = JSON.stringify(lightingTune, null, 2);
    const flash = (msg: string): void => {
      copy.textContent = msg;
      window.setTimeout(() => { copy.textContent = copyLabel; }, 1500);
    };
    try {
      await navigator.clipboard.writeText(json);
      flash('✓ Copied!');
    } catch {
      // Fallback when the async clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) flash('✓ Copied!');
      else { window.prompt('Copy these lighting params:', json); flash('see dialog'); }
    }
  });
  panel.appendChild(copy);

  panel.appendChild(status);
  sync();
  document.body.appendChild(panel);
};

export const mountBoard = async (
  el: HTMLElement,
  store: Store,
  options: MountBoardOptions = {},
): Promise<BoardApi> => {
  const assetsBase = options.assetsBase ?? '/assets';
  const onCanvasClick = options.onCanvasClick;
  const onCanvasRightClick = options.onCanvasRightClick;
  const onMovingActorsChange = options.onMovingActorsChange;
  const app = new Application();
  // Initial size is a placeholder; the renderer is resized to gridW×gridH×CELL_PX
  // on the first scene update, so the canvas matches the actual board geometry.
  // Force WebGL so the lighting filter only needs a single GLSL program (no WGSL).
  await app.init({ width: CELL_PX, height: CELL_PX, background: 0x5a4a35, antialias: false, preference: 'webgl' });
  // Wrap the canvas + HTML overlay layer in a relative container so HTML
  // mini bars can be absolute-positioned over the canvas at the right scale.
  // The canvas itself is CSS-scaled with image-rendering: pixelated, which
  // would blur Pixi-rendered text — using DOM elements keeps the text crisp
  // at the browser's actual rendering resolution.
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrapper';
  canvasWrap.appendChild(app.canvas);
  const overlayLayer = document.createElement('div');
  overlayLayer.className = 'mini-bar-layer';
  canvasWrap.appendChild(overlayLayer);
  el.appendChild(canvasWrap);

  // Toggle the WHOLE board's visibility — the Pixi canvas AND the DOM overlay
  // layer (HP bars, props, balloons) — in one place. Uses CSS `visibility`
  // rather than `display:none` so the canvas keeps its box and the
  // absolute-position math (which reads the canvas's bounding rect) still works
  // while it's hidden. Used to blank the board during a scene change so the
  // teardown → async-mount flicker (stale tokens over cleared ground, the
  // resize jump) never reaches the player.
  const setBoardVisible = (visible: boolean): void => {
    canvasWrap.style.visibility = visible ? '' : 'hidden';
  };

  // Grid-coordinate label that follows the hover cursor. Rendered as a DOM
  // node (not in Pixi) so the text stays crisp under the canvas's CSS
  // pixelated upscale.
  const coordLabel = document.createElement('div');
  coordLabel.className = 'hover-coord';
  coordLabel.style.display = 'none';
  overlayLayer.appendChild(coordLabel);

  /** Convert a DOM mouse event into a snapped grid cell, or null when out of bounds. */
  const eventToCell = (event: MouseEvent): { x: number; y: number } | null => {
    const rect = app.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / app.canvas.width : 1;
    if (scale <= 0) return null;
    const px = (event.clientX - rect.left) / scale;
    const py = (event.clientY - rect.top) / scale;
    const gx = Math.floor(px / CELL_PX);
    const gy = Math.floor(py / CELL_PX);
    const snap = store.getSnapshot();
    if (!snap.scene) return null;
    if (gx < 0 || gx >= snap.scene.gridW || gy < 0 || gy >= snap.scene.gridH) return null;
    return { x: gx, y: gy };
  };

  const resolveClickTarget = (event: MouseEvent): ClickTarget | null => {
    const cell = eventToCell(event);
    if (!cell) return null;
    const snap = store.getSnapshot();
    const occupant = snap.characters.find((c) =>
      c.pos != null && c.pos.x === cell.x && c.pos.y === cell.y && c.health.status !== 'KO',
    );
    return { pos: cell, actorId: occupant ? String(occupant.id) : null };
  };

  if (onCanvasClick) {
    app.canvas.addEventListener('click', (event) => {
      const target = resolveClickTarget(event);
      if (target) onCanvasClick(target);
    });
  }
  if (onCanvasRightClick) {
    app.canvas.addEventListener('contextmenu', (event) => {
      const target = resolveClickTarget(event);
      // Suppress the browser menu only when the click lands on the board, so a
      // right-click off-grid still behaves normally.
      if (!target) return;
      event.preventDefault();
      onCanvasRightClick(target);
    });
  }

  // Position the DOM coord label at the top-left of a grid cell, in CSS
  // coords. Uses canvasW (native pixel width) vs the canvas's displayed
  // width to derive the upscale factor.
  const positionCoordLabel = (gridX: number, gridY: number): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    coordLabel.style.left = `${(canvasRect.left - wrapRect.left) + gridX * CELL_PX * scale}px`;
    coordLabel.style.top  = `${(canvasRect.top  - wrapRect.top)  + gridY * CELL_PX * scale}px`;
  };

  // Idle hover: orange gradient stroke that sweeps diagonally across the cell,
  // recomputed every frame by the ticker for a flowing-shimmer effect.
  const HOVER_GRADIENT_PERIOD_MS = 1400;
  const drawIdleHoverCursor = (): void => {
    const inset = 2;
    const x = mouseCell!.x * CELL_PX + inset;
    const y = mouseCell!.y * CELL_PX + inset;
    const w = CELL_PX - inset * 2;
    const h = CELL_PX - inset * 2;
    // Phase ∈ [0,1) — animate the gradient endpoints sliding along the
    // box's diagonal so the bright band travels across the stroke.
    const phase = (performance.now() % HOVER_GRADIENT_PERIOD_MS) / HOVER_GRADIENT_PERIOD_MS;
    const span = w + h;
    const off = (phase * 2 - 1) * span;   // -span … +span
    const grad = new FillGradient(x + off, y, x + off + span, y + h);
    grad.addColorStop(0.0, 0xc24a08);   // burnt orange
    grad.addColorStop(0.5, 0xffb84d);   // bright amber
    grad.addColorStop(1.0, 0xc24a08);
    cursorGfx.clear();
    cursorGfx.roundRect(x, y, w, h, 6)
      .stroke({ fill: grad, width: 2.5, alignment: 0.5, alpha: 0.95 });
    cursorGfx.visible = true;
  };

  // Hover cursor: always visible while the mouse is over the board. In idle
  // mode it's an animated orange gradient (drawn by the ticker); in a
  // target-picking overlay it's the yellow target cursor.
  const drawCursor = () => {
    // Reveal/hide obstacle durability bars to match the hovered cell. Funnelled
    // here because drawCursor() is the single sink for every hover-state change.
    updateDurabilityVisibility();
    if (!mouseCell) {
      cursorGfx.clear();
      cursorGfx.visible = false;
      coordLabel.style.display = 'none';
      return;
    }
    if (overlay.mode === 'idle') {
      drawIdleHoverCursor();   // ticker keeps re-running this each frame
    } else {
      cursorGfx.clear();
      cursorGfx.rect(mouseCell.x * CELL_PX, mouseCell.y * CELL_PX, CELL_PX, CELL_PX)
        .stroke({ color: 0xffe85c, width: 3, alignment: 0.5, alpha: 0.95 })
        .fill({ color: 0xffe85c, alpha: 0.18 });
      cursorGfx.visible = true;
    }
    coordLabel.textContent = `${mouseCell.x},${mouseCell.y}`;
    coordLabel.style.display = 'block';
    positionCoordLabel(mouseCell.x, mouseCell.y);
  };
  app.canvas.addEventListener('mousemove', (event) => {
    const cell = eventToCell(event);
    if (!cell) {
      if (mouseCell) { mouseCell = null; drawCursor(); }
      return;
    }
    if (mouseCell && mouseCell.x === cell.x && mouseCell.y === cell.y) return;
    mouseCell = cell;
    drawCursor();
  });
  app.canvas.addEventListener('mouseleave', () => {
    if (mouseCell !== null) { mouseCell = null; drawCursor(); }
  });

  const drawOverlayCells = () => {
    overlayCells.clear();
    if (overlay.mode === 'move') {
      for (const c of overlay.reachable) {
        overlayCells
          .rect(c.x * CELL_PX, c.y * CELL_PX, CELL_PX, CELL_PX)
          .fill({ color: 0x4dff8a, alpha: 0.22 })
          .stroke({ color: 0x4dff8a, width: 1, alignment: 1, alpha: 0.6 });
      }
    } else if (overlay.mode === 'attack' || overlay.mode === 'special') {
      const snap = store.getSnapshot();
      const tint = overlay.mode === 'attack' ? 0xff5a5a : 0xffaf6a;
      // Targets a split special has dice on get a brighter, thicker ring so the
      // player can see at a glance which foes are already in the volley.
      const assigned = new Set((overlay.allocations ?? []).map((a) => a.id));
      for (const id of overlay.targets) {
        const ch = snap.characters.find((c) => String(c.id) === id);
        if (!ch?.pos) continue;
        const hot = assigned.has(id);
        overlayCells
          .rect(ch.pos.x * CELL_PX, ch.pos.y * CELL_PX, CELL_PX, CELL_PX)
          .fill({ color: hot ? 0xffe85c : tint, alpha: hot ? 0.4 : 0.28 })
          .stroke({ color: hot ? 0xffe85c : tint, width: hot ? 3 : 2, alignment: 1, alpha: hot ? 1 : 0.85 });
      }
      // Inanimate Things highlight with the same tint at lower saturation so
      // the player can tell living vs. inert targets apart at a glance.
      for (const cell of overlay.objectTargets ?? []) {
        overlayCells
          .rect(cell.x * CELL_PX, cell.y * CELL_PX, CELL_PX, CELL_PX)
          .fill({ color: tint, alpha: 0.18 })
          .stroke({ color: tint, width: 2, alignment: 1, alpha: 0.6 });
      }
    }
  };

  // Reconcile the "×N" split-allocation badges to the current overlay: one
  // per target with dice assigned, positioned over its cell's top-right corner.
  // Cleared whole when the overlay isn't a split-special selection.
  const updateSplitBadges = (): void => {
    const allocs = overlay.mode === 'special' ? (overlay.allocations ?? []) : [];
    const byId = new Map(allocs.map((a) => [a.id, a.dice]));
    const snap = store.getSnapshot();
    for (const [id, el] of splitBadges) {
      if (!byId.has(id)) { el.remove(); splitBadges.delete(id); }
    }
    for (const [id, dice] of byId) {
      const ch = snap.characters.find((c) => String(c.id) === id);
      if (!ch?.pos) {
        const stale = splitBadges.get(id);
        if (stale) { stale.remove(); splitBadges.delete(id); }
        continue;
      }
      let el = splitBadges.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'split-die-badge';
        Object.assign(el.style, {
          position: 'absolute', pointerEvents: 'none', zIndex: '6',
          transform: 'translate(-50%, -50%)', minWidth: '16px', height: '18px',
          padding: '0 4px', borderRadius: '9px', background: 'rgba(255, 232, 92, 0.96)',
          color: '#3a2a05', font: '700 12px/18px "Times New Roman", Times, serif',
          textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.55)',
        } as Partial<CSSStyleDeclaration>);
        overlayLayer.appendChild(el);
        splitBadges.set(id, el);
      }
      el.textContent = `×${dice}`;
      positionSplitBadge(el, ch.pos.x, ch.pos.y);
    }
  };

  const setSelectionOverlay: BoardApi['setSelectionOverlay'] = (state) => {
    overlay = state;
    drawOverlayCells();
    updateSplitBadges();
    drawCursor();
  };

  const board = new Container();
  app.stage.addChild(board);

  // World container: floor tiles + props + character tokens. The dithered-
  // shading lighting FILTER is applied here, so the rendered world is darkened
  // into the 8-bit halftone shadow — while the UI overlays added to `board`
  // ABOVE it (selection cells, cursor, dialogue ring) stay fully bright. The
  // DOM HUD (HP bars, balloons, coord label) is outside the canvas regardless.
  const worldContainer = new Container();
  board.addChild(worldContainer);

  // Ground container: floor tiles + props. The VIGNETTE filter is applied HERE
  // (not on the whole world), so the edge/corner darkening covers the
  // environment but NEVER the character tokens — those live in tokenLayer, a
  // sibling kept above this. The lighting filter still wraps the whole world, so
  // heroes/monsters are lit; they just escape the vignette. The tile + prop
  // layers are (re)mounted into here on scene change / obstacle smash.
  const groundContainer = new Container();
  worldContainer.addChild(groundContainer);

  // Character sprites live in their OWN layer, kept on top WITHIN the world
  // container (above the ground container, which is rebuilt on scene
  // change / obstacle smash). hoistOverlays() restacks it after any rebuild.
  // Sortable so KO'd corpses (zIndex via tokenZIndex) always render BELOW
  // living tokens regardless of insertion order.
  const tokenLayer = new Container();
  tokenLayer.sortableChildren = true;
  worldContainer.addChild(tokenLayer);

  // Highlight layer for the action-mode overlay (walkable cells, valid targets)
  // and a cursor square that follows the mouse. Lives on `board` ABOVE the
  // filtered world so selection feedback + the cursor never dim into shadow.
  const highlightLayer = new Container();
  const overlayCells = new Graphics();   // walkable / target tinted cells
  const cursorGfx    = new Graphics();   // 1-cell square under the mouse
  highlightLayer.addChild(overlayCells);
  highlightLayer.addChild(cursorGfx);
  board.addChild(highlightLayer);
  cursorGfx.visible = false;

  // Dialogue-reference highlight: a pulsing ring framing a hovered creature (or
  // marking a hovered coordinate). Above everything, unlit, so it always reads.
  const refHighlightLayer = new Container();
  const refHighlightGfx = new Graphics();
  refHighlightLayer.addChild(refHighlightGfx);
  board.addChild(refHighlightLayer);
  refHighlightGfx.visible = false;
  let hoverTarget: RefTarget | null = null;

  // Lighting: a fragment-shader filter (dithered shading) applied to the world
  // container. Disable with `?lights=0`.
  const lighting = new LightingLayer();
  lighting.setEnabled(new URLSearchParams(location.search).get('lights') !== '0');
  lighting.attachTo(worldContainer);
  lighting.attachVignetteTo(groundContainer);
  // Dev affordance: live-tune the lighting from the console / automation —
  //   window.__lighting.tune.ditherPx = 2; window.__lighting.refresh()
  (window as unknown as { __lighting?: unknown }).__lighting = {
    tune: lightingTune,
    refresh: () => lighting.refresh(),
    setEnabled: (b: boolean) => lighting.setEnabled(b),
    // Drop only the light-map shading; keep the edge vignette.
    setLightingEnabled: (b: boolean) => lighting.setLightingEnabled(b),
    setVignetteEnabled: (b: boolean) => lighting.setVignetteEnabled(b),
    // Switch the light-map pass between dithered halftone and smooth shading.
    setDithering: (b: boolean) => lighting.setDithering(b),
    layer: lighting,
  };
  // Floating dev panel (?lighttune=1) to click through dither alternatives live.
  if (new URLSearchParams(location.search).get('lighttune') === '1') {
    mountLightingTunePanel(lighting);
  }

  const hoistOverlays = (): void => {
    // Tokens stay on top within the (filtered) world; UI overlays stay on top
    // of the world, unfiltered, so they're never dimmed by the lighting.
    worldContainer.addChild(tokenLayer);
    board.addChild(highlightLayer);
    board.addChild(refHighlightLayer);
  };

  /** Draw / pulse the dialogue-reference highlight. Called every ticker frame
   *  while a chip is hovered; cleared (and hidden) otherwise. Cells glow cyan
   *  (matching the coordinate chip); a creature glows in ITS OWN faction colour
   *  — the same hue as the `.dlg-ref` chip in the text (heroes amber, monsters
   *  salmon-red, npcs green) — so the in-game ring matches the wording. A
   *  grouped creature ref (a shared name, e.g. "Giant Rat") rings every
   *  matching live token, each in its faction colour. */
  const drawRefHighlight = (nowMs: number): void => {
    refHighlightGfx.clear();
    if (!hoverTarget) { refHighlightGfx.visible = false; return; }
    refHighlightGfx.visible = true;
    const phase = (Math.sin(nowMs / 380) + 1) / 2;   // 0..1 breathing pulse
    const alpha = 0.5 + phase * 0.45;
    const inset = 3;
    const ring = (cx: number, cy: number, color: number): void => {
      const x = cx * CELL_PX + inset;
      const y = cy * CELL_PX + inset;
      const w = CELL_PX - inset * 2;
      const h = CELL_PX - inset * 2;
      refHighlightGfx.roundRect(x, y, w, h, 7)
        .fill({ color, alpha: 0.1 + phase * 0.14 })
        .stroke({ color, width: 3, alignment: 0.5, alpha });
    };
    if (hoverTarget.kind === 'cell') {
      ring(hoverTarget.x, hoverTarget.y, 0x6ad0ff);
    } else {
      const snap = store.getSnapshot();
      for (const id of hoverTarget.ids) {
        const ch = snap.characters.find((c) => String(c.id) === id);
        if (ch?.pos) ring(ch.pos.x, ch.pos.y, creatureRingColor(ch.kind));
      }
    }
  };

  const setHoverHighlight: BoardApi['setHoverHighlight'] = (target) => {
    hoverTarget = target;
    if (!target) {
      refHighlightGfx.clear();
      refHighlightGfx.visible = false;
      return;
    }
    // Paint immediately so the ring appears on the hovered frame; the ticker
    // then keeps it pulsing.
    drawRefHighlight(performance.now());
  };

  let overlay: SelectionOverlay = { mode: 'idle', reachable: [], targets: [] };
  let mouseCell: { x: number; y: number } | null = null;

  const tokens = new Map<string, Sprite>();
  /**
   * Per-character render state outside the snapshot: which direction the
   * sprite faces and which animation (if any) is currently playing. Survives
   * snapshot reconciliation; cleaned up when the token is removed.
   */
  interface TokenRenderState {
    facing: Facing;
    /** Manifest key (warrior, hunter, giant-rat, ...) — used to look up animations. */
    manifestKey: string;
    /** Raw manifest value (folder path or .png). */
    manifestValue: string;
    /** Cached per-direction static textures, lazily loaded. */
    staticTex: Partial<Record<Facing, Texture>>;
    /** Cached per-(animation, direction) frame textures, indexed by frame number. */
    animFrames: Partial<Record<AnimKind, Partial<Record<Facing, Texture[]>>>>;
    /** In-flight animation, if any. */
    active: ActiveAnimation | null;
    /** Last frame index we painted — skip texture swap when unchanged. */
    lastFrameIndex: number;
    /** Last facing we painted — skip texture swap when unchanged. */
    lastPaintedFacing: Facing | null;
    /** Last anim kind we painted — distinguishes idle vs. animation source. */
    lastPaintedKind: AnimKind | null;
    /** True when the character is KO'd. Suppresses idle so the corpse pose
     *  (death's last frame, or static facing when no death anim exists)
     *  stays frozen instead of bobbing. */
    isKO: boolean;
    /** True when the character is immobilized (a bound captive). Like `isKO`,
     *  it freezes the sprite on its static texture (here the dedicated "bound"
     *  sprite) with no idle bob. Cleared — and the sprite swapped back — when
     *  the captive is freed. */
    isImmobilized: boolean;
  }
  const tokenStates = new Map<string, TokenRenderState>();

  /** Look up an animation strip for `state.manifestKey`. Returns null when
   *  the manifest has no entry for that (character, kind) pair. Idle strips
   *  are optional — when absent, the renderer falls back to the static
   *  per-facing PNG. */
  const animStripFor = (
    manifest: AssetManifest,
    state: TokenRenderState,
    kind: AnimKind,
  ): AnimationStrip | null => {
    const anims = manifest.animations[state.manifestKey];
    if (!anims) return null;
    const strip = anims[kind];
    return strip ?? null;
  };

  /**
   * Start (or restart) the idle loop on the token. No-op when the character
   * has no idle strip registered — paintSpriteFrame will then render the
   * static facing PNG. Called on first sight, after a one-shot finishes,
   * and whenever facing changes mid-idle.
   */
  const startIdleLoop = (
    state: TokenRenderState,
    manifest: AssetManifest,
  ): void => {
    const strip = animStripFor(manifest, state, 'idle');
    if (!strip) { state.active = null; return; }
    state.active = {
      kind: 'idle',
      facing: state.facing,
      startMs: performance.now(),
      spec: { frames: strip.frames, fps: strip.fps },
      loop: true,
      holdLastFrame: false,
    };
  };

  /**
   * Lazy texture loader. Static rotation textures are cached on the state;
   * each (animation, direction) strip is also cached. Returns null if the
   * texture fails to load — caller should fall back to whichever texture is
   * already mounted on the sprite.
   */
  const loadStaticTexture = async (
    state: TokenRenderState,
    facing: Facing,
  ): Promise<Texture | null> => {
    if (state.staticTex[facing]) return state.staticTex[facing]!;
    const path = resolveStaticDirectional(state.manifestValue, facing, assetsBase);
    try {
      const tex = await Assets.load(path) as Texture;
      tex.source.scaleMode = 'nearest';
      state.staticTex[facing] = tex;
      return tex;
    } catch { return null; }
  };
  /**
   * Lazy frame loader: each (animation, direction) is a folder of N PNGs at
   * `<strip.path>/<facing>/<i>.png`. Frames are loaded on demand and cached.
   * Returns the frame Texture for `frameIdx`, or null on load failure.
   */
  const loadAnimFrame = async (
    state: TokenRenderState,
    kind: AnimKind,
    facing: Facing,
    frameIdx: number,
    strip: AnimationStrip,
  ): Promise<Texture | null> => {
    let byDir = state.animFrames[kind];
    if (!byDir) { byDir = {}; state.animFrames[kind] = byDir; }
    let frames = byDir[facing];
    if (!frames) { frames = []; byDir[facing] = frames; }
    if (frames[frameIdx]) return frames[frameIdx]!;
    const path = `${assetsBase}/${strip.path}/${facing}/${frameIdx}.png`;
    try {
      const tex = await Assets.load(path) as Texture;
      tex.source.scaleMode = 'nearest';
      frames[frameIdx] = tex;
      return tex;
    } catch { return null; }
  };

  /**
   * Set the sprite's texture to the appropriate static or animation frame
   * based on the token's render state. Async because textures may not have
   * been preloaded — caller is expected not to await (best-effort paint).
   */
  const paintSpriteFrame = async (
    sprite: Sprite,
    state: TokenRenderState,
    nowMs: number,
    manifest: AssetManifest,
  ): Promise<void> => {
    // Resolve the active animation kind. One-shots that finished (and don't
    // hold the last frame) auto-clear so the renderer falls through to idle.
    let frame = 0;
    let kind: AnimKind = 'idle';
    if (state.active) {
      const r = computeFrameIndex(state.active, nowMs);
      if (r.done && !state.active.holdLastFrame) {
        state.active = null;
      } else {
        kind = state.active.kind;
        frame = r.frame;
      }
    }

    // No in-flight animation → try idle strip; if no idle strip, fall back
    // to static facing PNG. KO'd characters skip idle entirely: their corpse
    // either stays on the held death frame (handled by branch 1 above) or,
    // when no death anim is registered, freezes on the static facing PNG.
    if (!state.active) {
      // KO'd corpses AND bound captives freeze on their static texture (no idle
      // bob). For a captive that texture is the "bound" sprite resolved above.
      if (state.isKO || state.isImmobilized) {
        if (state.lastPaintedFacing === state.facing && state.lastPaintedKind === 'idle') return;
        const tex = await loadStaticTexture(state, state.facing);
        if (!tex) return;
        sprite.texture = tex;
        sprite.scale.x = Math.abs(sprite.scale.x);
        const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
        sprite.width = fit.w;
        sprite.height = fit.h;
        state.lastPaintedFacing = state.facing;
        state.lastPaintedKind = 'idle';
        state.lastFrameIndex = 0;
        return;
      }
      const idleStrip = animStripFor(manifest, state, 'idle');
      if (idleStrip) {
        // Start the idle loop. state.active is only null transiently
        // (between a one-shot finishing and idle starting, OR on first
        // paint for characters without a spawn strip) — the next tick
        // takes branch 1 above, so startMs is assigned once per
        // transition, not reset every frame.
        startIdleLoop(state, manifest);
        if (state.active) {
          const r = computeFrameIndex(state.active, nowMs);
          kind = 'idle';
          frame = r.frame;
        }
      } else {
        // Static facing fallback — repaint only on facing change.
        if (state.lastPaintedFacing === state.facing && state.lastPaintedKind === 'idle') return;
        const tex = await loadStaticTexture(state, state.facing);
        if (!tex) return;
        sprite.texture = tex;
        sprite.scale.x = Math.abs(sprite.scale.x);
        const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
        sprite.width = fit.w;
        sprite.height = fit.h;
        state.lastPaintedFacing = state.facing;
        state.lastPaintedKind = 'idle';
        state.lastFrameIndex = 0;
        return;
      }
    }

    const strip = animStripFor(manifest, state, kind);
    if (!strip) {
      // Animation requested but no asset registered — fall back to static facing.
      const tex = await loadStaticTexture(state, state.facing);
      if (!tex) return;
      sprite.texture = tex;
      state.lastPaintedKind = 'idle';
      return;
    }
    // Skip texture rebuild when nothing changed (same anim, frame, facing).
    if (
      state.lastPaintedKind === kind &&
      state.lastFrameIndex === frame &&
      state.lastPaintedFacing === state.facing
    ) return;
    const tex = await loadAnimFrame(state, kind, state.facing, frame, strip);
    if (!tex) return;
    sprite.texture = tex;
    const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
    sprite.width = fit.w;
    sprite.height = fit.h;
    state.lastPaintedFacing = state.facing;
    state.lastPaintedKind = kind;
    state.lastFrameIndex = frame;
  };

  /** Start a one-shot animation if the strip exists. */
  const playAnimation = (
    state: TokenRenderState,
    manifest: AssetManifest,
    kind: AnimKind,
    opts: { holdLastFrame?: boolean; loop?: boolean } = {},
  ): void => {
    const strip = animStripFor(manifest, state, kind);
    if (!strip) return;  // graceful — leave state.active as-is so idle renders
    state.active = {
      kind,
      facing: state.facing,
      startMs: performance.now(),
      spec: { frames: strip.frames, fps: strip.fps },
      loop: opts.loop ?? false,
      holdLastFrame: opts.holdLastFrame ?? false,
    };
  };
  // HTML mini HP/name bars rendered above hero tokens. Lifecycle is parallel
  // to `tokens`: created on first sight, updated in-place, removed when the
  // character disappears, stops being a hero, or is KO'd.
  const miniBars = new Map<string, HTMLDivElement>();
  // "×N" dice badges over each target a split special has assigned dice to,
  // keyed by character id. Transient: created/updated/removed as the player
  // allocates during special mode, all cleared once the overlay leaves split.
  const splitBadges = new Map<string, HTMLDivElement>();
  // Durability pip bars for damageable obstacles (durability > 1), keyed by
  // `${x},${y}`. Lifecycle parallel to miniBars: created on first sight,
  // updated as hits drain pips, removed when the obstacle breaks or the scene
  // changes.
  const durabilityBars = new Map<string, HTMLDivElement>();
  // Durability bars are hidden by default (CSS `display: none`) and revealed
  // only while the cursor hovers that obstacle's own cell. Shows the matching
  // bar, hides every other. Driven by the mousemove/mouseleave handlers and
  // re-asserted after each reconciliation pass (so a freshly-created bar
  // respects the current hover, and a just-hidden one doesn't linger).
  const updateDurabilityVisibility = (): void => {
    const key = mouseCell ? `${mouseCell.x},${mouseCell.y}` : null;
    for (const [k, bar] of durabilityBars) {
      bar.style.display = k === key ? 'block' : 'none';
    }
  };
  // DOM emoji overlays for DM-spawned ad-hoc props. One <div> per prop id;
  // lifecycle parallel to miniBars, reconciled in `update()` against snap.props.
  const propEls = new Map<string, HTMLDivElement>();
  // Transient emoji balloons fired by `emote` actions. Per-actor stacks so
  // simultaneous balloons fan instead of overlapping. Each handle removes
  // itself from this stack on dispose. Bounded at 3 per actor — older balloons
  // get force-disposed when a 4th lands.
  const emoteBalloons = new Map<string, EmojiBalloonHandle[]>();
  const MAX_EMOTE_STACK = 3;
  // Persistent thought balloons — one per actively-thinking on-board actor
  // (streamed LLM turns): pulsing dots over the head, hover to read the live
  // streamed thought. Spawned/fed/disposed by reconcileThoughtBalloons on
  // every store notify; faded out when the actor's thinking ends.
  //
  // DISABLED for now by user decision (2026-06-03) — flip the flag to bring
  // them back. The component, styles, and the /thought-test.html preview all
  // remain intact; with the flag off the map stays empty, so the reposition
  // sites (snapshot teleports / move ticker / resize) are no-ops.
  const THOUGHT_BALLOONS_ENABLED = false;
  const thoughtBalloons = new Map<string, ThoughtBalloonHandle>();
  // Tilemap + prop layer path — every scene renders from a Wang tileset.
  let tileLayer: Container | null = null;
  let propLayer: Container | null = null;
  let lastSceneId: string | null = null;
  /**
   * Number of obstacles that were already destroyed at the last prop-layer
   * mount. We re-mount the prop layer whenever this changes within a scene,
   * since `resolvePropPlacements` filters out destroyed cells — a freshly
   * smashed barrel should disappear from the board on the next snapshot.
   */
  let lastDestroyedCount = 0;
  /**
   * Join of all live obstacle cells (`"x,y|x,y|…"`) at the last prop-layer mount.
   * A push_object RELOCATES an obstacle without changing `destroyedObstacles`, so
   * the destroyed-count trigger alone would miss it; we also re-mount when this
   * position key changes so a shoved cask redraws at its new cell.
   */
  let lastObstacleKey = '';
  /** Live obstacle cells (`"x,y"`) at the last prop-layer mount, for diffing a
   *  push (one cell out + one cell in, not destroyed) to drive a slide tween. */
  let lastObstacleCells = new Set<string>();
  /**
   * In-flight prop slide tweens — a pushed cask gliding from its old cell to its
   * new one. Each references a CURRENT prop-layer sprite; the ticker lerps it and
   * drops the entry on completion (or if a rebuild has destroyed the sprite).
   */
  const propSlides: { sprite: Sprite; fromX: number; fromY: number; toX: number; toY: number; startMs: number }[] = [];
  const PUSH_SLIDE_MS = 220;
  // Camera shake — a decaying random jitter applied to the whole `board` on a
  // blast, driven by the ticker. `startCameraShake` (re)arms it; a new explosion
  // mid-shake just restarts it. Magnitude scales slightly with blast radius and
  // is capped so the canvas edges (brown frame background) barely show.
  let shakeStartMs = 0;
  let shakeUntilMs = 0;
  let shakeAmp = 0;
  const SHAKE_MS = 320;
  const startCameraShake = (radius = 1): void => {
    shakeStartMs = performance.now();
    shakeUntilMs = shakeStartMs + SHAKE_MS;
    shakeAmp = Math.min(7 + (radius - 1) * 3, 12);
  };
  let canvasW = CELL_PX;
  let canvasH = CELL_PX;
  // Monotonic mount sequence — incremented on each scene-build branch entry,
  // checked after every await so a superseding mount can short-circuit a
  // stale in-flight one before it double-mounts layers.
  let mountSeq = 0;

  // Smooth movement: when an `action.move` event arrives we capture the path,
  // and on the next snapshot reconciliation we kick off a per-step animation
  // along it. The snapshot already reflects the destination — the animation
  // walks the sprite (and its mini bar) from path[0] to path[N] over
  // MOVE_MS_PER_STEP × (steps) ms. While an animation is active the
  // reconciliation does NOT touch the sprite/bar position.
  interface MoveAnimation {
    path: ReadonlyArray<{ x: number; y: number }>;
    startTime: number;
    msPerStep: number;
  }
  // Slower, more readable cadence — at ~220ms per cell, a hero crossing 3
  // squares takes the better part of a second, giving viewers time to follow
  // the action. With the walk animation running at ~8 fps, each cell traversed
  // is roughly two animation frames, keeping feet visibly in sync with motion.
  const MOVE_MS_PER_STEP = 220;
  const pendingPaths = new Map<string, ReadonlyArray<{ x: number; y: number }>>();
  const moveAnimations = new Map<string, MoveAnimation>();

  // Notify subscribers (Layout) whenever the set of currently-animating actors
  // changes. Fires only on add/remove — not on per-frame ticker updates — so
  // Layout re-renders at most twice per move (start + finish). The snapshot is
  // a fresh Set each time so callers can keep the reference if they want.
  const emitMovingActors = (): void => {
    if (!onMovingActorsChange) return;
    onMovingActorsChange(new Set(moveAnimations.keys()));
  };

  const update = async (snap: StoreState) => {
    const manifest = snap.manifest;
    if (!manifest || !snap.scene) return;

    // Resize the canvas to the scene's grid extents on first scene + on scene change.
    const sceneChanged = snap.scene.id !== lastSceneId;
    if (sceneChanged) {
      canvasW = snap.scene.gridW * CELL_PX;
      canvasH = snap.scene.gridH * CELL_PX;
      app.renderer.resize(canvasW, canvasH);
      // Expose native canvas dimensions to CSS so the .board canvas rule can
      // upscale by integer multiples while staying within viewport bounds.
      // Also set on :root so siblings (e.g. .narrator-window) can use the
      // same values to anchor themselves relative to the canvas.
      el.style.setProperty('--canvas-native-w', `${canvasW}px`);
      el.style.setProperty('--canvas-native-h', `${canvasH}px`);
      document.documentElement.style.setProperty('--canvas-native-w', `${canvasW}px`);
      document.documentElement.style.setProperty('--canvas-native-h', `${canvasH}px`);
    }

    const ts = manifest.tilesets[snap.scene.assetId];
    // (Re)build the floor + prop layers whenever the scene changes, or when
    // the tile layer isn't mounted yet for the current scene.
    const destroyedCountChanged =
      snap.scene.destroyedObstacles.length !== lastDestroyedCount;
    // A push relocates an obstacle (same count, new cell) — detect via a hash of
    // current obstacle positions so the prop layer re-mounts and the cask moves.
    const obstacleKey = snap.scene.obstacles.map((o) => `${o.x},${o.y}`).join('|');
    const obstaclesMoved = obstacleKey !== lastObstacleKey;
    const rebuildScene = sceneChanged || (!!ts && !tileLayer);
    if (rebuildScene) {
      // Blank the board for the whole teardown + (async) rebuild so the player
      // never sees the half-built intermediate scene. Revealed again at the
      // tail of this same update() once the new scene is fully reconciled.
      // Scoped to a true scene rebuild — the obstacle-smash branch below leaves
      // the board visible so a single smash doesn't flicker the entire map.
      setBoardVisible(false);
      // Tear down the prior scene's layers. Tile sub-textures are owned by the
      // tile layer (constructed fresh in mountTilemap), so destroy them. Prop
      // textures come from Assets.load and are cache-owned, so destroy children.
      if (tileLayer) {
        groundContainer.removeChild(tileLayer);
        tileLayer.destroy({ children: true, texture: true });
        tileLayer = null;
      }
      if (propLayer) {
        groundContainer.removeChild(propLayer);
        propLayer.destroy({ children: true });
        propLayer = null;
      }

      const myMount = ++mountSeq;

      if (ts) {
        const metaRaw = await fetch(`${assetsBase}/${ts.metadata}`).then((r) => r.json()) as unknown;
        if (myMount !== mountSeq) return;
        const meta = loadTilesetMetadata(metaRaw);
        tileLayer = await mountTilemap(
          groundContainer,
          `${assetsBase}/${ts.image}`,
          meta,
          snap.scene.gridW,
          snap.scene.gridH,
          snap.scene.walls,
          snap.scene.wallCells ?? [],
        );
        if (myMount !== mountSeq) return;
        propLayer = await mountProps(groundContainer, snap.scene, manifest, assetsBase);
        if (myMount !== mountSeq) return;
      } else {
        console.warn(
          `[board] no tileset for scene assetId="${snap.scene.assetId}" — every scene must have a manifest.tilesets entry`,
        );
      }
      lastSceneId = snap.scene.id;
      lastDestroyedCount = snap.scene.destroyedObstacles.length;
      lastObstacleKey = obstacleKey;
      lastObstacleCells = new Set(snap.scene.obstacles.map((o) => `${o.x},${o.y}`));
      // Re-stack the highlight layer + character tokens above the freshly-
      // rebuilt tile/prop layers so neither overlay cells nor heroes/monsters
      // end up hidden under the new tile sprites.
      hoistOverlays();
      // Rebuild scene-static lighting (ambient, glowing props, occluder mask)
      // and resize the light map to the new grid.
      lighting.configure(snap.scene);
    } else if ((destroyedCountChanged || obstaclesMoved) && propLayer) {
      // Same scene, but an obstacle was just destroyed OR pushed to a new cell —
      // rebuild ONLY the prop layer so the smashed sprite disappears / the shoved
      // cask redraws at its new position. Tile layer + bg stay.
      groundContainer.removeChild(propLayer);
      propLayer.destroy({ children: true });
      propLayer = null;
      const myMount = ++mountSeq;
      propLayer = await mountProps(groundContainer, snap.scene, manifest, assetsBase);
      if (myMount !== mountSeq) return;
      // A push relocates exactly one obstacle (one cell out — NOT destroyed —
      // and one cell in). When that's the case, start the freshly-mounted sprite
      // at its OLD cell and tween it to the new one so the shove reads as a glide,
      // not a snap. A destruction (cell out AND destroyed) yields no such pair.
      const pushed = detectPushedObstacle(
        lastObstacleCells, snap.scene.obstacles, snap.scene.destroyedObstacles,
      );
      if (pushed) {
        const sprite = propLayer.children.find(
          (ch) => (ch as { label?: string }).label === `obstacle:${pushed.to.x},${pushed.to.y}`,
        ) as Sprite | undefined;
        if (sprite) {
          const fromX = pushed.from.x * CELL_PX + CELL_PX / 2;
          const fromY = pushed.from.y * CELL_PX + CELL_PX;
          const toX = pushed.to.x * CELL_PX + CELL_PX / 2;
          const toY = pushed.to.y * CELL_PX + CELL_PX;
          sprite.x = fromX;
          sprite.y = fromY;
          propSlides.push({ sprite, fromX, fromY, toX, toY, startMs: performance.now() });
        }
      }
      lastDestroyedCount = snap.scene.destroyedObstacles.length;
      lastObstacleKey = obstacleKey;
      lastObstacleCells = new Set(snap.scene.obstacles.map((o) => `${o.x},${o.y}`));
      hoistOverlays();
      // An obstacle was smashed — the occluder set changed (e.g. the breach
      // wall opened), so torchlight should now flood through the new gap.
      lighting.configure(snap.scene);
    }

    // Tokens — scale each sprite to fit one cell, preserving aspect ratio.
    const positions = computeTokenPositions(snap.characters, CELL_PX);
    for (const c of snap.characters) {
      const id = String(c.id);
      const pos = positions.get(id);
      if (!pos) continue;

      let token = tokens.get(id);
      let state = tokenStates.get(id);
      const isNew = !token;
      if (!token) {
        const resolved = resolveCharacterSprite(c, manifest);
        if (!resolved) continue;
        state = {
          facing: DEFAULT_FACING,
          manifestKey: resolved.id,
          manifestValue: resolved.value,
          staticTex: {},
          animFrames: {},
          active: null,
          lastFrameIndex: -1,
          lastPaintedFacing: null,
          lastPaintedKind: null,
          isKO: c.health.status === 'KO',
          isImmobilized: c.health.status === 'immobilized',
        };
        tokenStates.set(id, state);
        const tex = await loadStaticTexture(state, DEFAULT_FACING);
        if (!tex) { tokenStates.delete(id); continue; }
        token = new Sprite(tex);
        token.anchor.set(0.5, 1.0);
        const fit = fitTokenScale(tex.width, tex.height, CELL_PX);
        token.width = fit.w;
        token.height = fit.h;
        state.lastPaintedFacing = DEFAULT_FACING;
        state.lastPaintedKind = 'idle';
        tokens.set(id, token);
        tokenLayer.addChild(token);
        // First sight: hold the death pose if already KO'd; freeze on the bound
        // sprite (no spawn) if immobilized; otherwise play the spawn pop.
        if (c.health.status === 'KO') {
          playAnimation(state, manifest, 'death', { holdLastFrame: true });
        } else if (c.health.status !== 'immobilized') {
          playAnimation(state, manifest, 'spawn');
        }
      }
      // Track KO state every tick so the renderer can freeze the corpse and
      // a (hypothetical) revive re-enables idle. On the KO transition, play
      // death once; when no death strip exists for this character, clear any
      // residual loop so paintSpriteFrame's isKO branch freezes the sprite
      // on the static facing PNG.
      if (state) {
        state.isKO = c.health.status === 'KO';
        if (
          state.isKO &&
          state.lastPaintedKind !== 'death' &&
          (!state.active || state.active.kind !== 'death')
        ) {
          playAnimation(state, manifest, 'death', { holdLastFrame: true });
          if (!state.active || state.active.kind !== 'death') {
            state.active = null;
          }
        }
      }
      // Track immobilized state every tick. On a transition (bound→free when a
      // teammate's free_ally lands, or free→bound), re-resolve the sprite —
      // swapping between the dedicated "bound" sprite and the normal one — and
      // reset the render caches so paintSpriteFrame repaints with it. Freeing
      // also plays the spawn "pop" as she springs up.
      if (state) {
        const nowImmobile = c.health.status === 'immobilized';
        if (nowImmobile !== state.isImmobilized) {
          state.isImmobilized = nowImmobile;
          const resolved = resolveCharacterSprite(c, manifest);
          if (resolved && resolved.value !== state.manifestValue) {
            state.manifestKey = resolved.id;
            state.manifestValue = resolved.value;
            state.staticTex = {};
            state.animFrames = {};
            state.lastPaintedFacing = null;
            state.lastPaintedKind = null;
            state.lastFrameIndex = -1;
            state.active = null;
          }
          if (!nowImmobile) playAnimation(state, manifest, 'spawn');
        }
      }
      // Corpse fallback: characters with NO death animation (e.g. quadrupeds
      // like giant-rat) need a clear visual cue that they're KO'd. Halve the
      // alpha and rotate 90° so the sprite reads as a fallen body. The fade
      // also stays in effect for characters WITH a death anim, after the
      // animation lands on its hold-last-frame.
      // A lying corpse (KO'd quadruped with no death anim) is rotated 90°. We
      // pivot around the sprite's CENTER and rest it at the cell center —
      // rotating around the default bottom-center anchor would swing the corpse
      // out of its cell.
      let lyingCorpse = false;
      if (token) {
        // KO'd corpses fade to 0.5; a bound (immobilized) captive renders at
        // full alpha — the dedicated "bound" sprite (tied up on the ground)
        // carries the cue, so no dimming is needed.
        token.alpha = c.health.status === 'KO' ? 0.5 : 1.0;
        // Corpses drop below the living (tokenLayer is sortable); re-derived
        // every reconciliation so the KO transition reorders immediately.
        token.zIndex = tokenZIndex(c.health.status);
        lyingCorpse = c.health.status === 'KO' && !animStripFor(manifest, state!, 'death');
        if (lyingCorpse) {
          token.anchor.set(0.5, 0.5);
          token.rotation = Math.PI / 2;  // tip-over: lying on its side
        } else {
          token.anchor.set(0.5, 1.0);
          token.rotation = 0;
        }
      }
      // Resting y: lying corpses center in the cell (anchor 0.5,0.5); standing
      // tokens rest their feet on the cell's bottom edge (anchor 0.5,1.0).
      const restY = lyingCorpse ? pos.y + CELL_PX / 2 : pos.y + CELL_PX;
      if (isNew) {
        // First sight — snap to current position.
        token.x = pos.x + CELL_PX / 2;
        token.y = restY;
      } else if (moveAnimations.has(id)) {
        // Animation owns the position; the ticker is updating x/y per frame.
      } else {
        // Existing sprite, no in-flight animation. If we captured a `move`
        // path that lands on the snapshot's current pos, animate along it.
        const path = pendingPaths.get(id);
        const last = path && path.length > 0 ? path[path.length - 1] : null;
        if (path && path.length >= 2 && c.pos && last && last.x === c.pos.x && last.y === c.pos.y) {
          // Place the sprite at the path's start so frame-1 of the animation
          // doesn't visibly jump from the previous reconciliation pos.
          const start = path[0]!;
          token.x = start.x * CELL_PX + CELL_PX / 2;
          token.y = start.y * CELL_PX + CELL_PX;
          moveAnimations.set(id, { path, startTime: performance.now(), msPerStep: MOVE_MS_PER_STEP });
          emitMovingActors();
          // Face the direction of the last step and start the walk loop. The
          // walk loop is cleared in the ticker when the move animation finishes.
          if (state) {
            const f = facingFromMovePath(path);
            if (f) state.facing = f;
            playAnimation(state, manifest, 'walk', { loop: true });
          }
          pendingPaths.delete(id);
        } else {
          // No path captured — covers reveal_monster, KO repositioning, etc.
          token.x = pos.x + CELL_PX / 2;
          token.y = restY;
        }
      }
    }
    // Remove tokens for characters absent from the snapshot. KO'd characters
    // KEEP their token (corpse) so the death animation can hold its last frame.
    const charById = new Map<string, typeof snap.characters[number]>();
    for (const c of snap.characters) charById.set(String(c.id), c);
    for (const [id, token] of tokens) {
      const c = charById.get(id);
      const shouldRemove = !c;
      if (shouldRemove) {
        tokenLayer.removeChild(token);
        token.destroy();
        tokens.delete(id);
        tokenStates.delete(id);
        const wasAnimating = moveAnimations.delete(id);
        pendingPaths.delete(id);
        if (wasAnimating) emitMovingActors();
      }
    }
    // HTML mini bars: reconcile per live, non-KO'd character on the board.
    // Bars are positioned in displayed-pixel space (which differs from the
    // canvas's native pixel size due to image-rendering: pixelated CSS scaling).
    const seenMiniBars = new Set<string>();
    for (const c of snap.characters) {
      if (c.health.status === 'KO' || !c.pos) continue;
      const id = String(c.id);
      seenMiniBars.add(id);
      let bar = miniBars.get(id);
      if (!bar) {
        bar = createMiniBarEl(c);
        overlayLayer.appendChild(bar);
        miniBars.set(id, bar);
      } else {
        updateMiniBarEl(bar, c);
      }
      // Skip when animating — the ticker tracks the bar to the moving sprite.
      if (!moveAnimations.has(id)) {
        positionMiniBar(bar, c.pos.x, c.pos.y);
      }
    }
    for (const [id, bar] of miniBars) {
      if (!seenMiniBars.has(id)) {
        bar.remove();
        miniBars.delete(id);
      }
    }

    // Emoji prop reconciliation. Each prop becomes one absolutely-positioned
    // <div> in the same overlay layer as the mini bars. Pointer-events: none
    // so clicks pass through to the canvas (the engine cares about cell
    // occupancy by characters, not by props — props don't block movement or
    // targeting).
    const seenProps = new Set<string>();
    for (const p of snap.props) {
      seenProps.add(p.id);
      let el = propEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'emoji-prop';
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.zIndex = '4';
        propEls.set(p.id, el);
        overlayLayer.appendChild(el);
      }
      // A prop may declare a `spriteId` (e.g. a chest) — when the manifest has
      // that prop sprite, render it as a pixel-art image instead of the emoji,
      // sized to one cell (consistent with the scene's tileset props). The
      // emoji stays the fallback for plain props (e.g. thrown cheese) and when
      // the sprite is missing from the manifest.
      const spriteRel = p.spriteId ? manifest?.props?.[p.spriteId] : undefined;
      if (spriteRel) {
        const url = spriteRel.endsWith('.png')
          ? `${assetsBase}/${spriteRel}`
          : `${assetsBase}/${spriteRel}/south.png`;
        el.textContent = '';
        el.style.backgroundImage = `url("${url}")`;
        el.style.backgroundSize = 'contain';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = 'center';
        el.style.imageRendering = 'pixelated';
      } else {
        el.textContent = p.emoji;
        el.style.backgroundImage = '';
      }
      el.title = p.description ? `${p.name} — ${p.description}` : p.name;
      positionProp(el, p.pos.x, p.pos.y, !!spriteRel);
    }
    for (const [id, el] of propEls) {
      if (!seenProps.has(id)) {
        el.remove();
        propEls.delete(id);
      }
    }

    // Obstacle durability pips. One bar per damageable obstacle (durability > 1)
    // that isn't yet destroyed. Drains a pip as `remaining` drops; removed when
    // the obstacle breaks (lands in destroyedObstacles) or the scene changes.
    const seenDura = new Set<string>();
    const destroyedSet = new Set(
      (snap.scene.destroyedObstacles ?? []).map((d) => `${d.x},${d.y}`),
    );
    for (const o of snap.scene.obstacles) {
      if (o.durability === undefined || o.durability <= 1) continue;
      const k = `${o.x},${o.y}`;
      if (destroyedSet.has(k)) continue;
      const remaining = o.remaining ?? o.durability;
      if (remaining <= 0) continue;
      seenDura.add(k);
      let bar = durabilityBars.get(k);
      if (!bar) {
        bar = createDurabilityBarEl(remaining, o.durability);
        overlayLayer.appendChild(bar);
        durabilityBars.set(k, bar);
      } else {
        updateDurabilityBarEl(bar, remaining, o.durability);
      }
      positionDuraBar(bar, o.x, o.y);
    }
    for (const [k, bar] of durabilityBars) {
      if (!seenDura.has(k)) {
        bar.remove();
        durabilityBars.delete(k);
      }
    }
    // A bar created this pass starts hidden (CSS default); reveal it if the
    // cursor already sits on its cell.
    updateDurabilityVisibility();

    // Reposition any in-flight emote balloons whose actor moved without an
    // animation (e.g., teleport from set_scene). The ticker handles smooth
    // moves; this handles snapshot-only updates.
    for (const [actorId, stack] of emoteBalloons) {
      if (moveAnimations.has(actorId)) continue;
      const c = snap.characters.find((ch) => String(ch.id) === actorId);
      if (!c?.pos) continue;
      for (const h of stack) positionBalloon(h.el, c.pos.x, c.pos.y);
    }
    for (const [actorId, h] of thoughtBalloons) {
      if (moveAnimations.has(actorId)) continue;
      const c = snap.characters.find((ch) => String(ch.id) === actorId);
      if (!c?.pos) continue;
      positionThoughtBalloon(h.el, c.pos.x, c.pos.y);
    }

    // The new scene is fully built + reconciled — reveal the board again. (If a
    // newer scene change superseded this mount mid-flight we returned early
    // above with the board still hidden; that newer update reveals it instead.)
    if (rebuildScene) setBoardVisible(true);
  };

  // Convert (gridX, gridY) to displayed pixel coords above the canvas,
  // accounting for the canvas's current CSS size (which may differ from its
  // native pixel size due to image-rendering: pixelated upscaling). The
  // returned coords place the mini bar's bottom-center anchor (CSS transform
  // translate(-50%, -100%)) at the top-center of the cell. Accepts fractional
  // gridX/gridY so the smooth-movement ticker can drive sub-cell positions.
  const positionMiniBar = (
    el: HTMLDivElement, gridX: number, gridY: number,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    const x = (canvasRect.left - wrapRect.left) + (gridX + 0.5) * CELL_PX * scale;
    const y = (canvasRect.top - wrapRect.top) + gridY * CELL_PX * scale;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  };

  // Split-allocation "×N" badge: anchored (CSS translate(-50%,-50%)) at the
  // cell's top-right so it clears the centered mini HP bar above the sprite.
  const positionSplitBadge = (
    el: HTMLDivElement, gridX: number, gridY: number,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    const x = (canvasRect.left - wrapRect.left) + (gridX + 0.82) * CELL_PX * scale;
    const y = (canvasRect.top - wrapRect.top) + (gridY + 0.2) * CELL_PX * scale;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  };

  // Durability pips for an obstacle: lifted above the cell top by ~0.4 cell so
  // they clear the tall obstacle sprite (which overflows above its cell).
  const positionDuraBar = (
    el: HTMLDivElement, gridX: number, gridY: number,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    el.style.left = `${(canvasRect.left - wrapRect.left) + (gridX + 0.5) * CELL_PX * scale}px`;
    el.style.top  = `${(canvasRect.top  - wrapRect.top)  + (gridY * CELL_PX - CELL_PX * 0.4) * scale}px`;
  };

  // Emoji prop: anchored at the cell's CENTER so the glyph sits squarely on
  // the floor like a dropped object, regardless of viewport scale.
  const positionProp = (
    el: HTMLDivElement, gridX: number, gridY: number, isSprite = false,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    const cssCell = CELL_PX * scale;
    el.style.left = `${(canvasRect.left - wrapRect.left) + (gridX + 0.5) * cssCell}px`;
    el.style.top  = `${(canvasRect.top  - wrapRect.top)  + (gridY + 0.5) * cssCell}px`;
    if (isSprite) {
      // A sprite prop fills ~one cell; the emoji-glyph sizing does not apply.
      const size = Math.round(cssCell);
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
    } else {
      // Scale emoji glyph with cell size so it stays readable at any viewport.
      el.style.fontSize = `${Math.round(cssCell * 0.6)}px`;
      el.style.lineHeight = '1';
    }
  };

  // Emote balloon: anchored ABOVE the hero's head, lifted ~one cell's worth
  // beyond the mini-bar so it reads as a thought floating clear of the
  // sprite. Scales with cssCell like the prop emoji.
  const positionBalloon = (
    el: HTMLDivElement, gridX: number, gridY: number,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    const cssCell = CELL_PX * scale;
    el.style.left = `${(canvasRect.left - wrapRect.left) + (gridX + 0.5) * cssCell}px`;
    // Top edge of the cell minus ~half a cell of lift — places the disc
    // a clear margin above the mini bar.
    el.style.top  = `${(canvasRect.top  - wrapRect.top)  + (gridY * cssCell) - cssCell * 0.45}px`;
    el.style.setProperty('--cell', `${cssCell}px`);
  };

  // Thought balloon: bottom-left anchored just above-right of the actor's
  // head (the trail blobs hang from the anchor toward the sprite). Near the
  // board's right edge the hover expansion (240px, rightward) would overflow,
  // so the balloon flips to grow LEFTWARD instead (`--flip` pins the
  // bottom-RIGHT corner; the collapsed cloud renders at the same spot either
  // way — see thought-balloon.css).
  const positionThoughtBalloon = (
    el: HTMLDivElement, gridX: number, gridY: number,
  ): void => {
    const canvasRect = app.canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = canvasW > 0 ? canvasRect.width / canvasW : 1;
    const cssCell = CELL_PX * scale;
    const x = (canvasRect.left - wrapRect.left) + (gridX + 0.68) * cssCell;
    el.style.left = `${x}px`;
    el.style.top  = `${(canvasRect.top - wrapRect.top) + (gridY * cssCell) - cssCell * 0.55}px`;
    el.classList.toggle(
      'thought-balloon--flip',
      x + 236 > (canvasRect.left - wrapRect.left) + canvasRect.width,
    );
  };

  // Per-frame ticker: drives in-flight move animations. Walks the sprite
  // (and its mini bar) from path[0] to path[N] by interpolating along
  // consecutive segments. When the animation finishes, the entry is dropped
  // and the next snapshot reconciliation owns position.
  // Creature lights for this frame: a warm torch on every living hero (a faint
  // cool beacon while immobilized so the captive is findable), and a menacing
  // red glow on the king rat lurking in the dark. Positions read from the live
  // token sprite when one exists (so the light stays glued to a hero sliding
  // mid-move) and fall back to the snapshot cell otherwise. KO'd actors emit
  // nothing.
  const buildDynamicLights = (snap: StoreState): LightSource[] => {
    const out: LightSource[] = [];
    for (const c of snap.characters) {
      const status = c.health.status;
      if (status === 'KO') continue;
      const token = tokens.get(String(c.id));
      let lx: number;
      let ly: number;
      if (token) {
        // token.x is the cell-centre px; token.y is the feet (bottom) px.
        lx = token.x / CELL_PX;
        ly = token.y / CELL_PX - 0.5;
      } else if (c.pos) {
        lx = c.pos.x + 0.5;
        ly = c.pos.y + 0.5;
      } else {
        continue;
      }
      if (c.kind === 'hero') {
        // Every hero carries a torch (the bound captive included, so she's lit
        // like the rest of the party rather than a faint beacon).
        out.push({ x: lx, y: ly, ...HERO_TORCH });
      } else if (c.kind === 'monster') {
        const tag = `${c.sprite ?? ''} ${c.name ?? ''}`.toLowerCase();
        if (tag.includes('king')) {
          // The king rat's sprite brandishes a lit torch on a staff, so it
          // carries a warm torch like the party — layered under its menacing
          // red boss glow.
          out.push({ x: lx, y: ly, ...HERO_TORCH });
          out.push({ x: lx, y: ly, ...BOSS_GLOW });
        }
      }
    }
    return out;
  };

  // Emit transient warm lights for fire attacks: a light streaking along the
  // bolt in flight, plus a flash where it lands. `flame-burst` is AoE (no bolt)
  // so it only flashes at the target. Non-fire attacks (melee / arrows) emit
  // nothing. Pixel coords in; converted to cell units (px / CELL_PX).
  const emitFireLights = (
    kind: AttackKind | undefined,
    specialEffectId: string | undefined,
    hit: boolean,
    fromX: number, fromY: number, toX: number, toY: number,
    flightMs: number,
  ): void => {
    const isFire = kind === 'magic' || specialEffectId === 'flame-burst';
    if (!isFire) return;
    const fx = fromX / CELL_PX, fy = fromY / CELL_PX;
    const tx = toX / CELL_PX, ty = toY / CELL_PX;
    if (specialEffectId !== 'flame-burst') {
      lighting.emitLight({
        x: fx, y: fy, x1: tx, y1: ty, travelMs: flightMs, ttlMs: flightMs + 80,
        ...FIRE_BOLT_LIGHT,
      });
    }
    if (hit) {
      const spec = specialEffectId === 'flame-burst' ? FLAME_BURST_LIGHT : FIRE_IMPACT_LIGHT;
      const delay = specialEffectId === 'flame-burst' ? 0 : flightMs;
      window.setTimeout(() => {
        lighting.emitLight({
          x: tx, y: ty, radius: spec.radius, color: spec.color,
          intensity: spec.intensity, ttlMs: spec.ttlMs, attackMs: 25,
        });
      }, delay);
    }
  };

  app.ticker.add(() => {
    const nowMs = performance.now();
    for (const [actorId, anim] of [...moveAnimations]) {
      const totalMs = (anim.path.length - 1) * anim.msPerStep;
      const t = totalMs > 0 ? Math.min(1, (nowMs - anim.startTime) / totalMs) : 1;
      const seg = t * (anim.path.length - 1);
      const segIdx = Math.min(Math.floor(seg), anim.path.length - 2);
      const segT = seg - segIdx;
      const a = anim.path[segIdx]!;
      const b = anim.path[segIdx + 1]!;
      const gx = a.x + (b.x - a.x) * segT;
      const gy = a.y + (b.y - a.y) * segT;
      const token = tokens.get(actorId);
      if (token) {
        token.x = gx * CELL_PX + CELL_PX / 2;
        token.y = gy * CELL_PX + CELL_PX;
      }
      const bar = miniBars.get(actorId);
      if (bar) positionMiniBar(bar, gx, gy);
      const balloonStack = emoteBalloons.get(actorId);
      if (balloonStack) {
        for (const h of balloonStack) positionBalloon(h.el, gx, gy);
      }
      const thought = thoughtBalloons.get(actorId);
      if (thought) positionThoughtBalloon(thought.el, gx, gy);
      if (t >= 1) {
        moveAnimations.delete(actorId);
        emitMovingActors();
        // Stop the walk loop now that the sprite reached its destination;
        // paintSpriteFrame will revert to idle on the next ticker pass.
        const st = tokenStates.get(actorId);
        if (st?.active?.kind === 'walk' && st.active.loop) {
          st.active = null;
        }
      }
    }
    // Prop slides — a pushed cask gliding to its new cell (easeOut). Drop the
    // entry on completion, or if a rebuild has already destroyed the sprite.
    for (let i = propSlides.length - 1; i >= 0; i--) {
      const s = propSlides[i]!;
      if (s.sprite.destroyed) { propSlides.splice(i, 1); continue; }
      const t = Math.min(1, (nowMs - s.startMs) / PUSH_SLIDE_MS);
      const e = 1 - Math.pow(1 - t, 3);
      s.sprite.x = s.fromX + (s.toX - s.fromX) * e;
      s.sprite.y = s.fromY + (s.toY - s.fromY) * e;
      if (t >= 1) { s.sprite.x = s.toX; s.sprite.y = s.toY; propSlides.splice(i, 1); }
    }
    // Camera shake — offset the whole board by a decaying random jitter. The
    // amplitude falls off quadratically over SHAKE_MS; once done, snap back to 0.
    if (nowMs < shakeUntilMs) {
      const k = 1 - (nowMs - shakeStartMs) / SHAKE_MS;
      const damp = k * k;
      board.x = (Math.random() * 2 - 1) * shakeAmp * damp;
      board.y = (Math.random() * 2 - 1) * shakeAmp * damp;
    } else if (board.x !== 0 || board.y !== 0) {
      board.x = 0;
      board.y = 0;
    }
    if (mouseCell && overlay.mode === 'idle') drawIdleHoverCursor();
    if (hoverTarget) drawRefHighlight(nowMs);

    // Per-token animation painting. Cheap when nothing has changed —
    // paintSpriteFrame compares lastFrameIndex/lastPaintedFacing/lastPaintedKind
    // and bails before doing any texture work.
    const snap = store.getSnapshot();
    const manifest = snap.manifest;
    if (manifest) {
      for (const [id, sprite] of tokens) {
        const st = tokenStates.get(id);
        if (!st) continue;
        void paintSpriteFrame(sprite, st, nowMs, manifest);
      }
    }

    // Re-render the lighting last so it reflects this frame's live token
    // positions (and the flicker). configure() seeds the static state; this
    // only folds in creature lights + flicker and re-uploads the light map.
    lighting.render(nowMs, buildDynamicLights(snap));
  });

  // Reposition all mini bars on viewport resize, since the canvas's displayed
  // size (and therefore the scale factor) is driven by CSS clamp/max-height.
  // Skip animating actors: the ticker owns their position and will pick up
  // the new scale on its next frame.
  const onResize = (): void => {
    const snap = store.getSnapshot();
    for (const c of snap.characters) {
      if (!c.pos) continue;
      const id = String(c.id);
      if (moveAnimations.has(id)) continue;
      const bar = miniBars.get(id);
      if (bar) positionMiniBar(bar, c.pos.x, c.pos.y);
    }
    for (const p of snap.props) {
      const el = propEls.get(p.id);
      if (el) positionProp(el, p.pos.x, p.pos.y);
    }
    for (const o of snap.scene?.obstacles ?? []) {
      const bar = durabilityBars.get(`${o.x},${o.y}`);
      if (bar) positionDuraBar(bar, o.x, o.y);
    }
    for (const [actorId, stack] of emoteBalloons) {
      const ch = snap.characters.find((c) => String(c.id) === actorId);
      if (!ch?.pos) continue;
      if (moveAnimations.has(actorId)) continue;
      for (const h of stack) positionBalloon(h.el, ch.pos.x, ch.pos.y);
    }
    for (const [actorId, h] of thoughtBalloons) {
      const ch = snap.characters.find((c) => String(c.id) === actorId);
      if (!ch?.pos || moveAnimations.has(actorId)) continue;
      positionThoughtBalloon(h.el, ch.pos.x, ch.pos.y);
    }
    if (mouseCell) positionCoordLabel(mouseCell.x, mouseCell.y);
  };
  window.addEventListener('resize', onResize);

  // Mirror the canvas's ACTUAL displayed (CSS-pixel) size into root-level
  // custom properties. main.css uses clamp() to scale the canvas inside
  // viewport caps, so the resolved size isn't predictable from
  // --canvas-native-* alone. Siblings below the board (narrator-window,
  // roll-panel) anchor off --canvas-displayed-h so they always sit just
  // under the actual canvas regardless of which clamp branch won. ResizeObserver fires on layout changes too,
  // so this catches CSS-driven reflows that `window.resize` alone misses
  // (e.g. font load, scrollbar appearing, devtools opening).
  const writeDisplayedSize = (): void => {
    const rect = app.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    document.documentElement.style.setProperty('--canvas-displayed-w', `${rect.width}px`);
    document.documentElement.style.setProperty('--canvas-displayed-h', `${rect.height}px`);
  };
  // The Pixi canvas is CSS-upscaled (image-rendering: pixelated) from its small
  // framebuffer; feed the lighting layer the displayed-device-px ÷ framebuffer-px
  // ratio so the Bayer dither cell grows on hi-dpi / large screens instead of
  // beating against the non-integer upscale into a noisy moiré speckle.
  const updateLightingScale = (): void => {
    const rect = app.canvas.getBoundingClientRect();
    if (rect.width <= 0 || app.canvas.width <= 0) return;
    lighting.setViewportScale((rect.width * (window.devicePixelRatio || 1)) / app.canvas.width);
  };
  const canvasResizeObserver = new ResizeObserver(() => {
    writeDisplayedSize();
    updateLightingScale();
    onResize();
  });
  canvasResizeObserver.observe(app.canvas);
  // Seed initial values before the first ResizeObserver tick — keeps the
  // narrator anchor right on the very first paint instead of waiting for
  // the observer's first delivery.
  writeDisplayedSize();
  updateLightingScale();

  // Spawn an emoji balloon over an actor's CURRENT cell. Invoked by Layout's
  // `onEmote` callback when an `emote` beat is promoted in the playback queue,
  // so the balloon appears in dialogue order (after the speech / dice beats it
  // accompanies) instead of the instant the WS event landed. The newest
  // balloon is index 0 in the per-actor stack; older balloons fan upward so
  // they stay visible. Off-board / position-less actors silently skip.
  const spawnEmote = (actorId: string, emoji: string): void => {
    if (!emoji) return;
    const ch = store.getSnapshot().characters.find((c) => String(c.id) === actorId);
    if (!ch?.pos) return;
    let stack = emoteBalloons.get(actorId);
    if (!stack) {
      stack = [];
      emoteBalloons.set(actorId, stack);
    }
    // Bound the stack — force-dispose the oldest if at capacity.
    while (stack.length >= MAX_EMOTE_STACK) {
      const oldest = stack.shift();
      oldest?.dispose();
    }
    // Existing balloons "age": shift their stack offset by one so the new
    // arrival sits at index 0 and older ones fan upward.
    for (let s = 0; s < stack.length; s += 1) {
      const old = stack[s]!.el;
      const newIdx = s + 1;
      old.style.setProperty('--stack-x', `${newIdx * 14}px`);
      old.style.setProperty('--stack-y', `${newIdx * -10}px`);
    }
    const handle = spawnEmojiBalloon({
      overlayLayer,
      emoji,
      gridX: ch.pos.x,
      gridY: ch.pos.y,
      positionAt: positionBalloon,
      stackIndex: 0,
    });
    stack.unshift(handle);
    // Self-cleanup when the balloon's own timer removes it.
    const lifetimeMs = 3500;
    window.setTimeout(() => {
      const cur = emoteBalloons.get(actorId);
      if (!cur) return;
      const idx = cur.indexOf(handle);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) emoteBalloons.delete(actorId);
    }, lifetimeMs);
  };

  let lastChatLen = 0;
  // Serialize update() calls so async awaits inside update (Assets.load,
  // fetch) can't interleave and recreate tokens that a later update has
  // already cleaned up. Each chained update reads the LATEST snapshot when
  // it runs, so intermediate states coalesce naturally.
  let updateQueue: Promise<void> = Promise.resolve();
  const scheduleUpdate = (): void => {
    updateQueue = updateQueue
      .then(() => update(store.getSnapshot()))
      .catch((e) => { console.error('Board update failed:', e); });
  };

  store.subscribe(() => {
    // Read snapshot synchronously for chat / flashRoll dispatch (these don't
    // need to wait for the rendering update to finish).
    const snap = store.getSnapshot();
    scheduleUpdate();
    // Thought balloons reconcile synchronously (cheap DOM, no Pixi) so the
    // streamed thinking text updates at delta rate without waiting on the
    // queued async update pass. (Currently gated off — see the flag.)
    if (THOUGHT_BALLOONS_ENABLED) reconcileThoughtBalloons({
      thinking: new Set([...snap.thinking].map(String)),
      thinkingText: new Map([...snap.thinkingText].map(([k, v]) => [String(k), v])),
      hasToken: (actorId) => {
        const c = snap.characters.find((ch) => String(ch.id) === actorId);
        return !!c?.pos;
      },
      balloons: thoughtBalloons,
      spawn: (actorId) => {
        const handle = spawnThoughtBalloon({ overlayLayer });
        const c = snap.characters.find((ch) => String(ch.id) === actorId);
        if (c?.pos) positionThoughtBalloon(handle.el, c.pos.x, c.pos.y);
        return handle;
      },
    });
    for (let i = lastChatLen; i < snap.chat.length; i += 1) {
      const msg = snap.chat[i];
      if (!msg) continue;
      const e = (msg.event as {
        t?: number;
        type?: string;
        actorId?: string;
        public?: {
          hit?: boolean;
          targetId?: string;
          attackKind?: AttackKind;
          specialEffectId?: string;
          // attack_object resolutions: target is an obstacle/prop cell, not
          // a character — engine emits `success`/`pos` instead of `hit`/`targetId`.
          success?: boolean;
          pos?: { x: number; y: number };
          targetKind?: 'obstacle' | 'prop' | 'hero' | 'monster';
          // The destroyed obstacle's cell (the cask itself). On an explosion this
          // is removed by the Board (markDestroyed) when the fireball lands, not
          // by the store — so the cask + wall vanish together with the boom.
          obstacleDestroyed?: { x: number; y: number };
          // Explosive obstacle (oil cask) breaking hit: the inflicted area, so
          // the board can fire an explosion over every cell within `radius`.
          // `demolished` are the attack-proof stalagmite cells the blast cleared.
          blast?: { pos: { x: number; y: number }; damage?: number; radius: number; victimIds?: string[]; demolished?: { x: number; y: number }[] };
        };
      });
      if (
        e.type === 'resolution' &&
        e.actorId &&
        e.public &&
        typeof e.public.hit === 'boolean'
      ) {
        const targetId = e.public.targetId ?? '';
        const positions = computeTokenPositions(snap.characters, CELL_PX);
        const targetPos = positions.get(targetId);
        const attackerPos = positions.get(e.actorId);
        const labelAnchor = targetPos ?? attackerPos;
        // For ranged / magic attacks we have a manifest entry — launch a bolt
        // from the attacker token, and delay the HIT/MISS label so it pops at
        // the moment of impact instead of when the attacker pulls the trigger.
        //
        // Visual effects are gated on `waitForRollResolved(t)` — the signal
        // Layout fires when the Dice3DOverlay's roll promise settles (physics
        // done, verdict shown, canvas hide scheduled). Event-driven, not a
        // fixed delay: the dice take as long as they take, and the board
        // effects fire only after the player has watched the verdict.
        const kind = e.public.attackKind;
        const manifest = snap.manifest;
        const canProject =
          (kind === 'ranged' || kind === 'magic') &&
          targetPos != null && attackerPos != null && manifest != null;
        const rollKey = typeof e.t === 'number' ? e.t : i;
        if (canProject) {
          const fromX = attackerPos.x + CELL_PX / 2;
          const fromY = attackerPos.y + CELL_PX / 2;
          const toX   = targetPos.x   + CELL_PX / 2;
          const toY   = targetPos.y   + CELL_PX / 2;
          // Capture `e.public.hit` and `e.public.specialEffectId` now — the
          // event object is reused/cleared by the time the signal fires.
          const hit = e.public.hit;
          const specialEffectId = e.public.specialEffectId;
          const localPos = targetPos;
          void waitForRollResolved(rollKey).then(() => {
            triggerProjectile(board, {
              fromX, fromY, toX, toY,
              attackKind: kind,
              hit,
              ...(specialEffectId !== undefined ? { specialEffectId } : {}),
            }, manifest, assetsBase);
            const flightMs = computeFlightMs(toX - fromX, toY - fromY);
            emitFireLights(kind, specialEffectId, hit, fromX, fromY, toX, toY, flightMs);
            window.setTimeout(() => {
              flashRoll(board, localPos.x + CELL_PX / 2, localPos.y, hit);
            }, flightMs);
          });
        } else if (labelAnchor) {
          const hit = e.public.hit;
          const anchor = labelAnchor;
          void waitForRollResolved(rollKey).then(() => {
            flashRoll(board, anchor.x + CELL_PX / 2, anchor.y, hit);
          });
        }
      }

      // Capture move paths so the next snapshot reconciliation can animate
      // the sprite along them instead of teleporting to the destination.
      const ev = msg.event as { type?: string; actorId?: string; action?: { kind?: string; emoji?: string; path?: ReadonlyArray<{ x: number; y: number }> } };
      if (
        ev.type === 'action' &&
        ev.action?.kind === 'move' &&
        Array.isArray(ev.action.path) &&
        ev.action.path.length >= 2 &&
        typeof ev.actorId === 'string'
      ) {
        pendingPaths.set(ev.actorId, ev.action.path.map((p) => ({ x: p.x, y: p.y })));
      }

      // Emote balloons are NOT spawned here on WS arrival anymore — they're
      // sequenced through Layout's playback queue and spawned via the `onEmote`
      // callback → `spawnEmote` when their beat is promoted, so the balloon
      // lands in dialogue order instead of racing ahead of the speech / dice
      // beats it accompanies. See QueueItem 'emote' in Layout.ts.

      // Facing updates from movement / attack events. Uses current snapshot
      // positions to derive direction; falls back to last facing if the event
      // carries no direction (e.g. say / narrate).
      const posLookup = (id: string): { x: number; y: number } | null => {
        const ch = snap.characters.find((c) => String(c.id) === id);
        return ch?.pos ?? null;
      };
      const change = facingChangeFromEvent(msg.event, posLookup);
      if (change) {
        const st = tokenStates.get(change.actorId);
        if (st) st.facing = change.facing;
      }

      // Attack animation: triggered on resolution events. Gated on
      // `waitForRollResolved(t)` — the swing plays as soon as the dice
      // overlay finishes (physics + verdict + canvas hide scheduled),
      // event-driven rather than a fixed delay.
      if (
        e.type === 'resolution' &&
        e.actorId &&
        e.public &&
        typeof e.public.hit === 'boolean'
      ) {
        const attackerId = e.actorId;
        const targetId = e.public.targetId ?? null;
        const rollKey = typeof e.t === 'number' ? e.t : i;
        void waitForRollResolved(rollKey).then(() => {
          const st = tokenStates.get(attackerId);
          const m = store.getSnapshot().manifest;
          if (!st || !m) return;
          // Re-face the attacker at the target NOW (the snapshot may have
          // settled after the deferred state_change) — this catches the case
          // where the target moved before the resolution applied.
          if (targetId) {
            const snapNow = store.getSnapshot();
            const tch = snapNow.characters.find((c) => String(c.id) === targetId);
            const ach = snapNow.characters.find((c) => String(c.id) === attackerId);
            if (tch?.pos && ach?.pos) {
              const dx = tch.pos.x - ach.pos.x;
              const dy = tch.pos.y - ach.pos.y;
              if (dx !== 0 || dy !== 0) {
                st.facing = Math.abs(dx) >= Math.abs(dy)
                  ? (dx >= 0 ? 'east' : 'west')
                  : (dy >= 0 ? 'south' : 'north');
              }
            }
          }
          playAnimation(st, m, 'attack');
        });
      }

      // attack_object resolution → projectile, swing animation, HIT/MISS
      // flash + explosion. Mirrors the character-attack path above but anchors
      // on the target CELL (e.public.pos) instead of a target character, and
      // uses `success` as the hit boolean. These fire on event ARRIVAL rather
      // than gating on waitForRollResolved here — for physics rolls ws-deferred
      // already HOLDS the whole resolution (sprite removal + this VFX) until the
      // dice settle, so by the time this event lands the dice are done and the
      // flash/explosion are correctly timed; for seeded/non-physics smashes
      // there is no dice overlay to wait for.
      if (
        e.type === 'resolution' &&
        e.actorId &&
        e.public &&
        typeof e.public.hit !== 'boolean' &&
        typeof e.public.success === 'boolean' &&
        e.public.pos &&
        (e.public.targetKind === 'obstacle' || e.public.targetKind === 'prop') &&
        (e.public.attackKind === 'melee' || e.public.attackKind === 'ranged' || e.public.attackKind === 'magic')
      ) {
        const attackerId = e.actorId;
        const cell = e.public.pos;
        const kind = e.public.attackKind;
        const hit = e.public.success;
        const manifest = snap.manifest;
        const positions = computeTokenPositions(snap.characters, CELL_PX);
        const attackerPos = positions.get(attackerId);
        const targetPxX = cell.x * CELL_PX;
        const targetPxY = cell.y * CELL_PX;
        // An explosive obstacle (oil cask) carries a `blast` on its breaking
        // hit — fire a fireball + per-cell ember flash over the inflicted area,
        // timed with the HIT flash (after the projectile lands for ranged).
        const blast = e.public.blast as
          | { pos: { x: number; y: number }; radius: number; demolished?: { x: number; y: number }[] }
          | undefined;
        const caskCell = e.public.obstacleDestroyed;
        const fireExplosion = (): void => {
          if (!blast || !snap.scene) return;
          triggerExplosion(board, {
            pos: blast.pos,
            radius: blast.radius ?? 1,
            cellPx: CELL_PX,
            gridW: snap.scene.gridW,
            gridH: snap.scene.gridH,
          });
          // Shake the camera on the blast — punchier for a bigger radius.
          startCameraShake(blast.radius ?? 1);
          // Bright white-hot flash light over the blast, spilling a couple cells
          // past the inflicted area, fading over the explosion's lifetime.
          lighting.emitLight({
            x: blast.pos.x + 0.5, y: blast.pos.y + 0.5,
            radius: (blast.radius ?? 1) + 2.6,
            color: EXPLOSION_LIGHT.color, intensity: EXPLOSION_LIGHT.intensity,
            ttlMs: EXPLOSION_LIGHT.ttlMs, attackMs: 30,
          });
          // NOW remove the obstacles the blast cleared — the cask + the
          // stalagmites it shattered — a short beat after the fireball pops
          // (its ~POP peak), so the wall crumbles WITH the boom rather than
          // before it. The store deferred these cells to us for this reason.
          const cleared = [
            ...(caskCell ? [caskCell] : []),
            ...(blast.demolished ?? []),
          ];
          if (cleared.length > 0) {
            window.setTimeout(() => store.markDestroyed(cleared), EXPLOSION_DEMOLISH_DELAY_MS);
          }
        };
        if (manifest && attackerPos && (kind === 'ranged' || kind === 'magic')) {
          const fromX = attackerPos.x + CELL_PX / 2;
          const fromY = attackerPos.y + CELL_PX / 2;
          const toX = targetPxX + CELL_PX / 2;
          const toY = targetPxY + CELL_PX / 2;
          triggerProjectile(board, {
            fromX, fromY, toX, toY,
            attackKind: kind,
            hit,
          }, manifest, assetsBase);
          const flightMs = computeFlightMs(toX - fromX, toY - fromY);
          // A fire bolt streaking to the cask gets a travelling light; its impact
          // flash is the explosion above, so suppress the bolt's own (hit=false).
          emitFireLights(kind, undefined, false, fromX, fromY, toX, toY, flightMs);
          window.setTimeout(() => {
            flashRoll(board, targetPxX + CELL_PX / 2, targetPxY, hit);
            fireExplosion();
          }, flightMs);
        } else {
          flashRoll(board, targetPxX + CELL_PX / 2, targetPxY, hit);
          fireExplosion();
        }
        // Attack swing on the attacker. Re-face at the cell so the sprite
        // looks the right way before the animation plays.
        const st = tokenStates.get(attackerId);
        const ach = snap.characters.find((c) => String(c.id) === attackerId);
        if (st && manifest && ach?.pos) {
          const dx = cell.x - ach.pos.x;
          const dy = cell.y - ach.pos.y;
          if (dx !== 0 || dy !== 0) {
            st.facing = Math.abs(dx) >= Math.abs(dy)
              ? (dx >= 0 ? 'east' : 'west')
              : (dy >= 0 ? 'south' : 'north');
          }
          playAnimation(st, manifest, 'attack');
        }
      }
    }
    lastChatLen = snap.chat.length;
  });
  scheduleUpdate();

  return { setSelectionOverlay, setHoverHighlight, spawnEmote };
};
