/**
 * Standalone preview for the in-world THOUGHT BALLOON (see
 * `components/ThoughtBalloon.ts`). Two hero tokens on a fake stone floor:
 * the warrior's balloon receives a fake `thinking_delta` stream (word chunks
 * every ~120ms, like a live Gemini/Anthropic stream), the warlock's holds a
 * finished thought. Hover a cloud to expand it and read the text.
 *
 * Open `http://localhost:5174/thought-test.html` (with `npm run dev:web`
 * running). Hero sprites come from the repo's `assets/` dir, served by the
 * dev middleware — no WS server needed.
 */
import { spawnThoughtBalloon, type ThoughtBalloonHandle } from './components/ThoughtBalloon.js';

const host = document.getElementById('board-host');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');
if (!host || !overlay || !statusEl || !controlsEl) throw new Error('thought-test: missing DOM nodes');

const setStatus = (s: string): void => { statusEl.textContent = s; };

// --- Two hero tokens -------------------------------------------------------
interface Seat { id: string; sprite: string; x: number; y: number; label: string }
const SEATS: Seat[] = [
  { id: 'warrior', sprite: '/assets/heroes/warrior/south.png', x: 220, y: 330, label: 'Gareth (full lifecycle: fade in → stream → fade out)' },
  { id: 'warlock', sprite: '/assets/heroes/warlock/south.png', x: 500, y: 330, label: 'Kael (persistent — hover to inspect)' },
];
for (const seat of SEATS) {
  const img = document.createElement('img');
  img.className = 'hero';
  img.src = seat.sprite;
  img.alt = seat.id;
  img.style.left = `${seat.x}px`;
  img.style.top = `${seat.y}px`;
  // Fallback so the preview still works without the asset middleware: a
  // plain token square in the hero's rough palette.
  img.onerror = () => {
    const ph = document.createElement('div');
    ph.className = 'hero';
    ph.style.left = `${seat.x}px`;
    ph.style.top = `${seat.y}px`;
    ph.style.background = seat.id === 'warrior' ? '#7a5a3a' : '#4a3a6a';
    ph.style.border = '2px solid #1c1814';
    img.replaceWith(ph);
  };
  host.appendChild(img);
  const label = document.createElement('div');
  label.className = 'hero-label';
  label.textContent = seat.label;
  label.style.left = `${seat.x}px`;
  label.style.top = `${seat.y + 8}px`;
  host.appendChild(label);
}

// --- Balloons ---------------------------------------------------------------
/** Anchor the balloon just above-right of a hero's head. */
const positionAbove = (el: HTMLElement, seat: Seat): void => {
  el.style.left = `${seat.x + 26}px`;
  el.style.top = `${seat.y - 72}px`;
};

const balloons = new Map<string, ThoughtBalloonHandle>();
const spawnFor = (seat: Seat): ThoughtBalloonHandle => {
  const handle = spawnThoughtBalloon({ overlayLayer: overlay });
  positionAbove(handle.el, seat);
  balloons.set(seat.id, handle);
  return handle;
};

// --- Fake streams -----------------------------------------------------------
const SHORT_THOUGHT =
  'The rat at (7,3) is closest — two squares. If I move to (6,3) I can flank it with Kael ' +
  'and the Teamwork bonus gives me an extra die. Move, attack, end turn.';
const LONG_THOUGHT =
  'The breach wall is solid: stalagmites take two hits each, but the rubble pile at (6,5) only one. ' +
  'Elara is bound at (11,8) past the wall and the pack will fixate on her from the next round — we ' +
  'cannot waste turns. Best play: I smash the rubble while Kael readies flame-burst for the opening, ' +
  'and Bran holds the lane so nothing slips through. If the smash fails I should call the play aloud ' +
  'so someone else queues on the weak point. Cheese from the chest could pull the pack off her if it ' +
  'gets bad. Smash first — everything else follows.';

let streamTimer: number | null = null;
let disposeTimer: number | null = null;
const stopStream = (): void => {
  if (streamTimer !== null) { window.clearInterval(streamTimer); streamTimer = null; }
  if (disposeTimer !== null) { window.clearTimeout(disposeTimer); disposeTimer = null; }
};
/** How long the finished thought lingers before the balloon fades away —
 *  in-game this is the gap until `thinking_done` lands. */
const HOLD_AFTER_STREAM_MS = 1500;
/** Feed `text` into the warrior's balloon in word chunks, like a live stream;
 *  when it finishes, hold briefly then FADE OUT + dispose (the in-game
 *  thinking_done behaviour: the balloon does not outlive the thought). */
const startStream = (text: string): void => {
  stopStream();
  // Respawn the warrior's balloon if a previous lifecycle disposed it.
  let warrior = balloons.get('warrior');
  if (!warrior || !warrior.el.isConnected) warrior = spawnFor(SEATS[0]!);
  const words = text.split(' ');
  let i = 0;
  warrior.setText('');
  streamTimer = window.setInterval(() => {
    i += 1;
    warrior.setText(words.slice(0, i).join(' '));
    setStatus(`streaming… ${i}/${words.length} words (hover the cloud to read along)`);
    if (i >= words.length) {
      stopStream();
      setStatus('stream finished — fading out shortly (thinking_done)…');
      disposeTimer = window.setTimeout(() => {
        balloons.get('warrior')?.dispose();
        balloons.delete('warrior');
        setStatus('balloon gone — Restart stream to run the lifecycle again.');
      }, HOLD_AFTER_STREAM_MS);
    }
  }, 120);
};

// --- Boot -------------------------------------------------------------------
let thinking = true;
const boot = (): void => {
  for (const h of balloons.values()) h.dispose();
  balloons.clear();
  for (const seat of SEATS) spawnFor(seat);
  balloons.get('warlock')!.setText(SHORT_THOUGHT);
  startStream(SHORT_THOUGHT);
};
boot();

controlsEl.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const action = target.dataset['action'];
  if (!action) return;
  switch (action) {
    case 'restart': if (!thinking) { thinking = true; boot(); } else startStream(SHORT_THOUGHT); break;
    case 'long':    if (!thinking) { thinking = true; boot(); } startStream(LONG_THOUGHT); break;
    case 'empty': {
      stopStream();
      balloons.get('warrior')?.setText('');
      setStatus('dots only — hover shows nothing until text streams in.');
      break;
    }
    case 'toggle': {
      thinking = !thinking;
      if (thinking) { boot(); setStatus('thinking ON'); }
      else {
        stopStream();
        for (const h of balloons.values()) h.dispose();
        balloons.clear();
        setStatus('thinking OFF — balloons disposed (what thinking_done does in-game).');
      }
      break;
    }
  }
});
