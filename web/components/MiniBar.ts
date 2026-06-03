import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { displayName } from './names.js';

/**
 * Pure: format a heart row as a single string of ♥ (full) + ♡ (lost) glyphs.
 * Kept exported because tests pin this contract; the DOM renderer below uses
 * inline-SVG hearts instead so they render crisp at the canvas's CSS upscale.
 */
export const formatHearts = (total: number, damage: number): string => {
  const remaining = Math.max(0, total - damage);
  const lost = Math.max(0, damage);
  return '♥'.repeat(remaining) + '♡'.repeat(lost);
};

/** Build one inline SVG pixel heart. `full` toggles between filled and hollow. */
const heartSvg = (full: boolean): SVGSVGElement => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `mini-heart${full ? '' : ' mini-heart-empty'}`);
  svg.setAttribute('viewBox', '0 0 7 6');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  // 7×6 pixel heart: outline always drawn, fill only when "full".
  // Pixel layout (X = outline, # = fill):
  //  . X X . X X .
  //  X # # X # # X
  //  X # # # # # X
  //  . X # # # X .
  //  . . X # X . .
  //  . . . X . . .
  const path = document.createElementNS(NS, 'path');
  // Outline path.
  path.setAttribute(
    'd',
    'M1,0 h2 v1 h-2 z M4,0 h2 v1 h-2 z M0,1 h1 v2 h-1 z M3,1 h1 v1 h-1 z M6,1 h1 v2 h-1 z M1,3 h1 v1 h-1 z M5,3 h1 v1 h-1 z M2,4 h1 v1 h-1 z M4,4 h1 v1 h-1 z M3,5 h1 v1 h-1 z',
  );
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);
  if (full) {
    const fill = document.createElementNS(NS, 'path');
    fill.setAttribute(
      'd',
      'M1,1 h2 v1 h-2 z M4,1 h2 v1 h-2 z M1,2 h5 v1 h-5 z M2,3 h3 v1 h-3 z M3,4 h1 v1 h-1 z',
    );
    fill.setAttribute('fill', '#ff3a3a');
    svg.appendChild(fill);
  }
  return svg;
};

/** Replace the hearts row with `total` SVG hearts; the first `damage` are empty. */
const renderHearts = (row: HTMLDivElement, total: number, damage: number): void => {
  const remaining = Math.max(0, total - damage);
  const lost = Math.max(0, damage);
  row.replaceChildren();
  for (let i = 0; i < remaining; i++) row.appendChild(heartSvg(true));
  for (let i = 0; i < lost;      i++) row.appendChild(heartSvg(false));
};

/**
 * Build one inline SVG crystal shard pip — the obstacle-durability counterpart
 * to the HP heart. `full` toggles filled (icy-blue rock) vs hollow (shattered).
 * A 6×5 pixel diamond, deliberately a different shape + colour from the heart
 * so durability never reads as HP.
 */
const shardSvg = (full: boolean): SVGSVGElement => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `dura-shard${full ? '' : ' dura-shard-empty'}`);
  svg.setAttribute('viewBox', '0 0 6 5');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  // 6×5 diamond. Outline (X) always drawn; fill (#) only when "full":
  //  . . X X . .
  //  . X # # X .
  //  X # # # # X
  //  . X # # X .
  //  . . X X . .
  const outline = document.createElementNS(NS, 'path');
  outline.setAttribute(
    'd',
    'M2,0 h2 v1 h-2 z M1,1 h1 v1 h-1 z M4,1 h1 v1 h-1 z M0,2 h1 v1 h-1 z M5,2 h1 v1 h-1 z M1,3 h1 v1 h-1 z M4,3 h1 v1 h-1 z M2,4 h2 v1 h-2 z',
  );
  outline.setAttribute('fill', '#0a0d14');
  svg.appendChild(outline);
  // Always paint the centre: bright amber when intact, dim grey when shattered.
  // The near-black inline outline (above) is what keeps the shard legible over
  // bright tiles now that the dark backing pill is gone — the same trick the
  // HP heart uses.
  const fill = document.createElementNS(NS, 'path');
  fill.setAttribute('d', 'M2,1 h2 v1 h-2 z M1,2 h4 v1 h-4 z M2,3 h2 v1 h-2 z');
  fill.setAttribute('fill', full ? '#ffc23c' : '#525a68');
  svg.appendChild(fill);
  return svg;
};

/** Replace the shard row with `max` pips; the first `max - remaining` are empty. */
const renderShards = (row: HTMLDivElement, remaining: number, max: number): void => {
  const full = Math.max(0, Math.min(max, remaining));
  const broken = Math.max(0, max - full);
  row.replaceChildren();
  for (let i = 0; i < broken; i++) row.appendChild(shardSvg(false));
  for (let i = 0; i < full;   i++) row.appendChild(shardSvg(true));
};

/** Durability bar (a row of crystal-shard pips) shown above a damageable obstacle. */
export const createDurabilityBarEl = (remaining: number, max: number): HTMLDivElement => {
  const root = document.createElement('div');
  root.className = 'dura-bar';
  const pips = document.createElement('div');
  pips.className = 'dura-pips';
  pips.dataset.state = `${remaining}/${max}`;
  renderShards(pips, remaining, max);
  root.appendChild(pips);
  return root;
};

export const updateDurabilityBarEl = (el: HTMLDivElement, remaining: number, max: number): void => {
  const pips = el.querySelector('.dura-pips') as HTMLDivElement | null;
  if (!pips) return;
  const next = `${remaining}/${max}`;
  if (pips.dataset.state === next) return;
  pips.dataset.state = next;
  renderShards(pips, remaining, max);
};

export const createMiniBarEl = (c: RedactedCharacter): HTMLDivElement => {
  const root = document.createElement('div');
  root.className = 'mini-bar';

  const name = document.createElement('div');
  name.className = 'mini-name';
  name.textContent = displayName(c.name);
  root.appendChild(name);

  const hearts = document.createElement('div');
  hearts.className = 'mini-hearts';
  hearts.dataset.state = `${c.health.total}/${c.health.damage}`;
  renderHearts(hearts, c.health.total, c.health.damage);
  root.appendChild(hearts);

  return root;
};

export const updateMiniBarEl = (el: HTMLDivElement, c: RedactedCharacter): void => {
  const nameEl = el.querySelector('.mini-name') as HTMLDivElement | null;
  const friendly = displayName(c.name);
  if (nameEl && nameEl.textContent !== friendly) nameEl.textContent = friendly;
  const heartsEl = el.querySelector('.mini-hearts') as HTMLDivElement | null;
  if (!heartsEl) return;
  // Only redraw when the (total, damage) pair actually changed — avoids
  // wiping SVG children every render on snapshots that don't touch HP.
  const next = `${c.health.total}/${c.health.damage}`;
  if (heartsEl.dataset.state === next) return;
  heartsEl.dataset.state = next;
  renderHearts(heartsEl, c.health.total, c.health.damage);
};
