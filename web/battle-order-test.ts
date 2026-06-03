/**
 * Rework playground for `BattleOrderReveal`.
 *
 * Recreates the REAL context the reveal now renders in: the settled 3D dice
 * scene (the dice-table wood texture + one die per combatant) with NO blur.
 * Over each die it mounts the reworked per-combatant BADGE (portrait +
 * turn-order `#rank`, tail pointing at the die). Edit `BattleOrderReveal.ts`
 * or the `.battle-order-*` rules in `main.css`; Vite HMR refreshes this page
 * so the rework iterates live.
 *
 * The mock dice are placed at fixed `DICE_SLOTS`; the badge positions handed
 * to `battleOrderReveal` are derived from those same slots, so a badge always
 * sits over the die it labels — exactly as the live wiring will do once each
 * settled 3D die is projected to a screen point.
 *
 * Controls:
 *   - Cast       — swap the mock initiative roster (re-pins it).
 *   - Backdrop   — dice scene / neutral dark / hard stripes.
 *   - ▶ Replay   — full fade-in → hold → fade-out, matching Layout's timing.
 *   - 📌 Pin     — mount fresh and HOLD open (no auto-dismiss) for tweaking.
 *   - ✕ Dismiss  — trigger the fade-out from a held overlay.
 */
import { render, html } from 'lit-html';
import {
  battleOrderReveal,
  BATTLE_ORDER_REVEAL_MS,
  BATTLE_ORDER_REVEAL_FADE_OUT_MS,
  type BadgeAnchors,
} from './components/BattleOrderReveal.js';
import type {
  InitiativeRollEntry,
  InitiativeSummary,
} from './components/InitiativePanel.js';

const DIE_SPRITE = '/assets/dice-sprites/d6-iso.png';

/** Tiny factory so each roster entry stays a one-liner below. */
const heroEntry = (
  id: string,
  name: string,
  archetype: string,
  d6: number,
  dex = 0,
): InitiativeRollEntry => ({
  characterId: id,
  name,
  archetype,
  sprite: null,
  kind: 'hero',
  d6,
  dex,
  total: d6 + dex,
});

const monsterEntry = (
  id: string,
  name: string,
  sprite: string,
  d6: number,
  dex = 0,
): InitiativeRollEntry => ({
  characterId: id,
  name,
  archetype: null,
  sprite,
  kind: 'monster',
  d6,
  dex,
  total: d6 + dex,
});

/** Build a sorted `InitiativeSummary` — matches the engine's `combat_started`
 *  shape (total-desc, heroes win ties). A fresh `t` per mount makes lit-html's
 *  `keyed` tear down + replay the fade from frame 0. */
const buildSummary = (
  t: number,
  raw: ReadonlyArray<InitiativeRollEntry>,
): InitiativeSummary => {
  const heroes   = raw.filter((e) => e.kind === 'hero')
                      .slice().sort((a, b) => b.total - a.total);
  const monsters = raw.filter((e) => e.kind === 'monster')
                      .slice().sort((a, b) => b.total - a.total);
  const order = raw.slice().sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.kind !== b.kind)   return a.kind === 'hero' ? -1 : 1;
    return 0;
  });
  return { t, heroes, monsters, order };
};

type RosterKey = 'duo' | 'quartet' | 'rats' | 'full';

/** Canonical archetype/sprite names — match `/assets/heroes/<archetype>/south.png`
 *  and `/assets/monsters/<sprite>/south.png` so portraits resolve. */
const ROSTERS: Record<RosterKey, () => ReadonlyArray<InitiativeRollEntry>> = {
  duo: () => [
    heroEntry('h1', 'Kael',  'warrior', 5),
    monsterEntry('r1', 'Giant Rat', 'giant-rat', 3),
  ],
  quartet: () => [
    heroEntry('h1', 'Kael',  'warrior', 6),
    heroEntry('h2', 'Lyra',  'hunter',  4, 1),
    monsterEntry('r1', 'Giant Rat',  'giant-rat',  3),
    monsterEntry('r2', 'Giant Rat',  'giant-rat',  2),
  ],
  rats: () => [
    heroEntry('h1', 'Bran', 'warlock', 5, 1),
    monsterEntry('r1', 'Giant Rat', 'giant-rat', 6),
    monsterEntry('r2', 'Giant Rat', 'giant-rat', 4),
    monsterEntry('r3', 'Giant Rat', 'giant-rat', 3),
    monsterEntry('r4', 'King Rat',  'king-rat',  2),
  ],
  full: () => [
    heroEntry('h1', 'Kael',  'warrior', 6),
    heroEntry('h2', 'Lyra',  'hunter',  5, 1),
    heroEntry('h3', 'Mira',  'healer',  4),
    heroEntry('h4', 'Bran',  'warlock', 3, 1),
    monsterEntry('r1', 'King Rat',  'king-rat',  5),
    monsterEntry('r2', 'Giant Rat', 'giant-rat', 4),
    monsterEntry('r3', 'Giant Rat', 'giant-rat', 2),
  ],
};

type BgKey = 'dice' | 'dark' | 'stripes';

/** Mock die positions (CENTRE of each die, in % of the stage) + a little
 *  scatter rotation/scale so the tray reads like settled physics dice.
 *  Indexed by turn-order position; supports up to a 7-combatant roster. */
interface DieSlot { x: number; y: number; rot: number; scale: number; }
const DICE_SLOTS: ReadonlyArray<DieSlot> = [
  { x: 26, y: 60, rot: -14, scale: 1.0 },
  { x: 44, y: 67, rot:   8, scale: 1.1 },
  { x: 60, y: 61, rot:  20, scale: 0.95 },
  { x: 74, y: 64, rot:  -6, scale: 0.85 },
  { x: 34, y: 46, rot:  16, scale: 0.8 },
  { x: 66, y: 47, rot: -20, scale: 0.78 },
  { x: 50, y: 52, rot:   5, scale: 0.9 },
];

const stage      = document.getElementById('stage')!;
const sceneLayer = document.getElementById('scene-layer')!;
const stageFrame = document.getElementById('stage-frame')!;
const status     = document.getElementById('status')!;

let mountCount = 0;
let currentRoster: RosterKey = 'duo';
let currentBg: BgKey = 'dice';
let currentSummary: InitiativeSummary | null = null;
let mode: 'pinned' | 'replay' | 'dismissed' | 'empty' = 'empty';

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let unmountTimer: ReturnType<typeof setTimeout> | null = null;

const clearTimers = (): void => {
  if (dismissTimer !== null) { clearTimeout(dismissTimer); dismissTimer = null; }
  if (unmountTimer !== null) { clearTimeout(unmountTimer); unmountTimer = null; }
};

/** Drop one mock die per combatant onto the table at its turn-order slot. */
const renderScene = (order: ReadonlyArray<InitiativeRollEntry>): void => {
  sceneLayer.replaceChildren();
  order.forEach((_entry, i) => {
    const slot = DICE_SLOTS[i % DICE_SLOTS.length]!;
    const die = document.createElement('img');
    die.className = 'scene-die';
    die.src = DIE_SPRITE;
    die.alt = '';
    die.style.left = `${slot.x}%`;
    die.style.top = `${slot.y}%`;
    die.style.transform =
      `translate(-50%, -50%) rotate(${slot.rot}deg) scale(${slot.scale})`;
    sceneLayer.appendChild(die);
  });
};
const clearScene = (): void => sceneLayer.replaceChildren();

/** Badge anchors = each die's CENTRE (same slots). The badge floats above it
 *  via the CSS `--badge-lift`, exactly like the live wiring (which passes the
 *  projected die centre). */
const anchorsFor = (order: ReadonlyArray<InitiativeRollEntry>): BadgeAnchors => {
  const out: Record<string, { x: number; y: number }> = {};
  order.forEach((entry, i) => {
    const slot = DICE_SLOTS[i % DICE_SLOTS.length]!;
    out[entry.characterId] = { x: slot.x, y: slot.y };
  });
  return out;
};

const renderBadges = (summary: InitiativeSummary, dismissing: boolean): void => {
  render(battleOrderReveal(summary, dismissing, anchorsFor(summary.order)), stage);
};

const renderEmpty = (): void => {
  currentSummary = null;
  mode = 'empty';
  clearScene();
  render(html`<span class="stage-hint">Stage clear — Pin or Replay a roster.</span>`, stage);
  printStatus();
};

/** Fresh summary (new `t`) + matching mock dice. */
const buildCurrent = (): InitiativeSummary => {
  mountCount += 1;
  const summary = buildSummary(mountCount, ROSTERS[currentRoster]());
  renderScene(summary.order);
  return summary;
};

const printStatus = (): void => {
  if (!currentSummary) {
    status.innerHTML = `<span class="muted">Stage clear. Pick a roster (pins it) or hit ▶ Replay.</span>`;
    return;
  }
  const lines = currentSummary.order.map((e, i) => {
    const tag = e.kind === 'hero' ? 'HERO' : 'MON ';
    const dex = e.dex === 0 ? '   ' : (e.dex > 0 ? ` +${e.dex}` : ` ${e.dex}`);
    return `  #${i + 1} [${tag}] ${e.name.padEnd(11)} d6=${e.d6}${dex} = ${e.total}`;
  }).join('\n');
  const modeLabel =
    mode === 'replay'      ? `auto-dismissing in ${BATTLE_ORDER_REVEAL_MS}ms`
    : mode === 'pinned'    ? 'pinned (held — hit ✕ Dismiss to fade out)'
    : mode === 'dismissed' ? `fading out (${BATTLE_ORDER_REVEAL_FADE_OUT_MS}ms)`
    : 'idle';
  status.innerHTML =
    `<span class="label">${currentRoster} · t=${currentSummary.t} · backdrop=${currentBg}</span>
<span class="muted">${modeLabel} · one badge per die, in turn order</span>

${lines}`;
};

/** Mount fresh and HOLD open (forwards fill keeps opacity 1). */
const pin = (): void => {
  clearTimers();
  currentSummary = buildCurrent();
  mode = 'pinned';
  renderBadges(currentSummary, false);
  printStatus();
};

/** Full cycle: fade-in → hold → fade-out → unmount (Layout's auto timing). */
const replay = (): void => {
  clearTimers();
  currentSummary = buildCurrent();
  mode = 'replay';
  renderBadges(currentSummary, false);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (currentSummary) { mode = 'dismissed'; renderBadges(currentSummary, true); printStatus(); }
  }, Math.max(0, BATTLE_ORDER_REVEAL_MS - BATTLE_ORDER_REVEAL_FADE_OUT_MS));
  unmountTimer = setTimeout(() => {
    unmountTimer = null;
    renderEmpty();
  }, BATTLE_ORDER_REVEAL_MS);
  printStatus();
};

/** Fade out a currently-held overlay (no-op if nothing is mounted). */
const dismissNow = (): void => {
  if (!currentSummary) return;
  clearTimers();
  mode = 'dismissed';
  renderBadges(currentSummary, true);
  unmountTimer = setTimeout(() => {
    unmountTimer = null;
    renderEmpty();
  }, BATTLE_ORDER_REVEAL_FADE_OUT_MS);
  printStatus();
};

const setActive = (selector: string, attr: string, value: string): void => {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(selector)) {
    btn.dataset.active = (btn.dataset[attr] === value) ? 'true' : 'false';
  }
};

const setBackdrop = (key: BgKey): void => {
  currentBg = key;
  stageFrame.dataset.bg = key;
  setActive('[data-bg]', 'bg', key);
  printStatus();
};

// --- Wire controls --------------------------------------------------------
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-roster]')) {
  btn.addEventListener('click', () => {
    currentRoster = btn.dataset.roster as RosterKey;
    setActive('[data-roster]', 'roster', currentRoster);
    pin();
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-bg]')) {
  btn.addEventListener('click', () => setBackdrop(btn.dataset.bg as BgKey));
}
document.getElementById('replay')!.addEventListener('click', replay);
document.getElementById('pin')!.addEventListener('click', pin);
document.getElementById('dismiss')!.addEventListener('click', dismissNow);

// --- Initial state: dice backdrop, duo pinned over the dice scene. --------
setBackdrop('dice');
pin();
