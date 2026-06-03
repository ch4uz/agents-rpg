/**
 * Standalone preview for the pixel-art explosion VFX. Boots a bare Pixi app
 * with a dark stone-floor backdrop and fires `triggerExplosion` over it, so the
 * 16-bit fire/smoke animation can be hot-iterated without the WS server, the
 * engine, or an attack to smash a cask.
 *
 * Open `http://localhost:5174/explosion-test.html` (with `npm run dev:web`
 * running). No assets or WS server required — pure Pixi Graphics.
 */
import { Application, Container, Graphics } from 'pixi.js';
import { triggerExplosion } from './components/Explosion.js';

const CELL_PX = 48;
const GRID_W = 11;
const GRID_H = 9;

const host = document.getElementById('board-host');
const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');
if (!host || !statusEl || !controlsEl) throw new Error('explosion-test: missing DOM nodes');

const app = new Application();
await app.init({
  width: GRID_W * CELL_PX,
  height: GRID_H * CELL_PX,
  background: 0x161210,
  antialias: false,
  preference: 'webgl',
});
app.canvas.style.imageRendering = 'pixelated';
app.canvas.style.width = `${GRID_W * CELL_PX * 1.6}px`;
app.canvas.style.height = `${GRID_H * CELL_PX * 1.6}px`;
host.appendChild(app.canvas);

// --- Dark dungeon-floor backdrop so the fire has something to sit over. A
//     coarse checker of stone tiles with mortar gaps, in the project's muted
//     palette, drawn once. ---
const board = new Container();
app.stage.addChild(board);
const floor = new Graphics();
for (let y = 0; y < GRID_H; y++) {
  for (let x = 0; x < GRID_W; x++) {
    const shade = (x + y) % 2 === 0 ? 0x2a2620 : 0x231f1a;
    floor.rect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX).fill({ color: shade });
    // mortar gap
    floor.rect(x * CELL_PX, y * CELL_PX, CELL_PX, 2).fill({ color: 0x14110e });
    floor.rect(x * CELL_PX, y * CELL_PX, 2, CELL_PX).fill({ color: 0x14110e });
  }
}
board.addChild(floor);

const setStatus = (text: string): void => { statusEl.textContent = text; };

const center = { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) };

// Slow-mo stretches the same stepped animation over a long window so each of
// the discrete frames holds long enough to screenshot during dev iteration.
let slow = false;

const fire = (radius: number): void => {
  triggerExplosion(board, {
    pos: center,
    radius,
    cellPx: CELL_PX,
    gridW: GRID_W,
    gridH: GRID_H,
    ...(slow && { durationMs: 6000 }),
  });
  setStatus(`Boom — radius ${radius} at (${center.x}, ${center.y})${slow ? ' [slow-mo]' : ''}.`);
};

let loopTimer: number | null = null;
const stopLoop = (): void => {
  if (loopTimer !== null) { window.clearInterval(loopTimer); loopTimer = null; }
};

const buttons = Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('button[data-action]'));
for (const b of buttons) {
  b.addEventListener('click', () => {
    const action = b.dataset.action ?? '';
    if (action === 'slow') {
      slow = !slow;
      b.textContent = slow ? 'Slow-mo ✓' : 'Slow-mo';
      setStatus(`Slow-mo ${slow ? 'on (6s)' : 'off'}.`);
      return;
    }
    if (action === 'loop') {
      if (loopTimer !== null) { stopLoop(); setStatus('Loop stopped.'); b.textContent = 'Loop ▶'; return; }
      fire(1);
      loopTimer = window.setInterval(() => fire(1 + Math.floor(Math.random() * 2)), 1100);
      b.textContent = 'Loop ⏹';
      setStatus('Looping…');
      return;
    }
    stopLoop();
    const loopBtn = buttons.find((x) => x.dataset.action === 'loop');
    if (loopBtn) loopBtn.textContent = 'Loop ▶';
    fire(parseInt(action, 10) || 1);
  });
}

setStatus('Ready. Click a radius to detonate.');
