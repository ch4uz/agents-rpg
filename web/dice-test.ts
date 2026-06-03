/**
 * Standalone test page for the 3D dice overlay. Boots a Dice3DOverlay without
 * any of the WS/Pixi machinery, attaches it to a faux `.canvas-wrapper`, and
 * exposes buttons that trigger rolls of different pool sizes.
 *
 * Open `http://localhost:5174/dice-test.html` (with `npm run dev:web` running)
 * to use. No WS server required — the GLB is imported through Vite's `?url`
 * loader so the asset is served by Vite directly.
 */
import * as THREE from 'three';
import { Dice3DOverlay } from './components/Dice3DOverlay.js';
import type { RollDispatch } from './components/three/DiceDispatcher.js';
import { skinForCharacter, type DiceSkin } from './components/three/DiceSkins.js';
import type { Face } from './components/three/DiceMesh.js';
import * as SceneConfig from './components/three/SceneConfig.js';
import diceGlbUrl from '../assets/dice/perfect_little_dice_3cm.glb?url';

// Mock avatars — south-facing portraits of the in-game heroes/monsters.
import hunterAvatar    from '../assets/heroes/hunter/south.png?url';
import warriorAvatar   from '../assets/heroes/warrior/south.png?url';
import warlockAvatar   from '../assets/heroes/warlock/south.png?url';
import healerAvatar    from '../assets/heroes/healer/south.png?url';
import giantRatAvatar  from '../assets/monsters/giant-rat/south.png?url';
import kingRatAvatar   from '../assets/monsters/king-rat/south.png?url';

// Top-view dice face sprites (PixelLab → cropped via bin/inspect-dice-glb's
// sibling Python script). Each is a centered 64×64 PNG of one pip count.
// When a lane settles, the combat HUD picks the matching face and paints
// it with the unit's skin tint via `mix-blend-mode: multiply`.
import diceFace1 from '../assets/dice-sprites/d6-face-1.png?url';
import diceFace2 from '../assets/dice-sprites/d6-face-2.png?url';
import diceFace3 from '../assets/dice-sprites/d6-face-3.png?url';
import diceFace4 from '../assets/dice-sprites/d6-face-4.png?url';
import diceFace5 from '../assets/dice-sprites/d6-face-5.png?url';
import diceFace6 from '../assets/dice-sprites/d6-face-6.png?url';
const FACE_IMG: Record<Face, string> = {
  1: diceFace1, 2: diceFace2, 3: diceFace3,
  4: diceFace4, 5: diceFace5, 6: diceFace6,
};

const host = document.getElementById('dice-host');
const statusEl = document.getElementById('status');
const controlsEl = document.getElementById('controls');
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const combatHeaderEl    = document.getElementById('combat-header');
const combatLeftEl      = document.getElementById('combat-left');
const combatRightEl     = document.getElementById('combat-right');
const combatVerdictEl   = document.getElementById('combat-verdict');
const initiativeOverlay = document.getElementById('initiative-overlay');
const initiativeList    = document.getElementById('initiative-list');
if (!host || !statusEl || !controlsEl) throw new Error('dice-test: missing DOM nodes');

// ----------------------------------------------------------------------
// Mock combat header — front-end-only scaffold for the "Frame: avatar +
// name + dice-sprite" HUD that will eventually be driven by the game's
// resolution / combat_started events. Each preset gets a scenario so the
// header changes per roll.
// ----------------------------------------------------------------------

interface UnitMock {
  name:      string;
  kind:      'hero' | 'monster' | 'dm';
  archetype: string | null;
  avatarUrl: string | null;
}

const HUNTER:    UnitMock = { name: 'Bran',     kind: 'hero',    archetype: 'hunter',  avatarUrl: hunterAvatar };
const WARRIOR:   UnitMock = { name: 'Gareth',   kind: 'hero',    archetype: 'warrior', avatarUrl: warriorAvatar };
const WARLOCK:   UnitMock = { name: 'Kael',     kind: 'hero',    archetype: 'warlock', avatarUrl: warlockAvatar };
const HEALER:    UnitMock = { name: 'Mira',     kind: 'hero',    archetype: 'healer',  avatarUrl: healerAvatar };
const GIANT_RAT: UnitMock = { name: 'Giant Rat', kind: 'monster', archetype: null,     avatarUrl: giantRatAvatar };
const KING_RAT:  UnitMock = { name: 'King Rat',  kind: 'monster', archetype: null,     avatarUrl: kingRatAvatar };
const DM:        UnitMock = { name: 'The Trial',     kind: 'dm', archetype: null,     avatarUrl: null };

interface Scenario {
  left:  UnitMock;
  right: UnitMock;
}

/** One combatant in an initiative roll — one die each, ordered by spawn. */
interface InitiativeCombatant {
  unit: UnitMock;
  skin: DiceSkin;
}

const SCENARIOS: Record<string, Scenario> = {
  '1':          { left: HUNTER,  right: DM },
  '2':          { left: HUNTER,  right: DM },
  '3':          { left: WARLOCK, right: DM },
  '4':          { left: HEALER,  right: DM },
  'duel':       { left: WARRIOR, right: GIANT_RAT },
  'duel-big':   { left: WARLOCK, right: KING_RAT },
  'initiative': { left: WARRIOR, right: KING_RAT },
  'max':        { left: WARRIOR, right: KING_RAT },
};

const hexOf = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/** Subtitle text for the carved nameplate — archetype for heroes, role
 *  for monsters / non-opponent challenges. Renders as small-caps
 *  gold-trim under the main name. */
const subtitleFor = (unit: UnitMock): string => {
  if (unit.kind === 'hero' && unit.archetype) return unit.archetype;
  if (unit.kind === 'monster')                 return 'foe';
  if (unit.kind === 'dm')                      return 'skill check';
  return '';
};

/** Clear the stamped-in result number AND all pip children on a frame
 *  (called at the start of every new roll so old values don't linger). */
const clearResult = (frame: HTMLElement | null): void => {
  if (!frame) return;
  const slot   = frame.querySelector('.dice-slot') as HTMLElement | null;
  const result = frame.querySelector('.combat-result') as HTMLElement | null;
  const row    = frame.querySelector('.dice-faces') as HTMLElement | null;
  if (slot)   slot.dataset.resultActive = 'false';
  if (result) {
    result.dataset.active = 'false';
    result.textContent = '';
  }
  if (row) row.replaceChildren();
};

/** Stamp a top-face number into a frame's result slot. Fires the CSS
 *  scale-overshoot animation; also dims the dice emblem behind. */
const showResult = (frame: HTMLElement | null, topFace: Face): void => {
  if (!frame) return;
  const slot   = frame.querySelector('.dice-slot') as HTMLElement | null;
  const result = frame.querySelector('.combat-result') as HTMLElement | null;
  if (!slot || !result) return;
  result.textContent = String(topFace);
  // Restart the keyframe even if the same value gets stamped twice.
  result.dataset.active = 'false';
  // Force reflow so dataset toggle re-triggers the animation.
  void result.offsetWidth;
  result.dataset.active = 'true';
  slot.dataset.resultActive = 'true';
};

/** Tint color used by a unit's dice pips. Reused by `applyUnit` (initial
 *  paint) and `setRolledFaces` (per-pip paint). */
const tintForUnit = (unit: UnitMock): number => {
  const skin = skinForCharacter(unit.kind, unit.archetype);
  return skin.iconTint ?? skin.tint;
};

const applyUnit = (frame: HTMLElement, unit: UnitMock): void => {
  const avatarEl   = frame.querySelector('.combat-avatar') as HTMLElement | null;
  const nameEl     = frame.querySelector('.combat-name') as HTMLElement | null;
  const subtitleEl = frame.querySelector('.combat-subtitle') as HTMLElement | null;
  if (!avatarEl || !nameEl || !subtitleEl) return;

  if (unit.avatarUrl) {
    avatarEl.style.backgroundImage = `url("${unit.avatarUrl}")`;
    avatarEl.dataset.empty = 'false';
  } else {
    avatarEl.style.backgroundImage = 'none';
    avatarEl.dataset.empty = 'true';
  }
  nameEl.textContent = unit.name;
  nameEl.dataset.kind = unit.kind;
  subtitleEl.textContent = subtitleFor(unit);
};

/** Sizing constants for the rolled-dice row. `MAX_ROW_PX` matches the
 *  `max-width: 92px` rule on `.dice-faces` so JS and CSS agree. */
const MAX_ROW_PX = 92;
const MAX_PIP_PX = 28;
const PIP_GAP_PX = 2;

/** Render N face-PNG pips inside `frame`'s `.dice-faces` row, sized down
 *  to fit `MAX_ROW_PX` if the lane has many dice. Each pip is painted in
 *  the unit's tint via CSS `mix-blend-mode: multiply`. */
const setRolledFaces = (
  frame: HTMLElement | null,
  unit: UnitMock,
  faces: ReadonlyArray<Face>,
): void => {
  if (!frame) return;
  const slot = frame.querySelector('.dice-slot') as HTMLElement | null;
  const row  = frame.querySelector('.dice-faces') as HTMLElement | null;
  if (!slot || !row) return;

  const n = faces.length;
  // Available width = max row width minus the gaps between pips.
  const availableForPips = Math.max(1, MAX_ROW_PX - PIP_GAP_PX * Math.max(0, n - 1));
  const pipSize = Math.max(8, Math.min(MAX_PIP_PX, Math.floor(availableForPips / Math.max(1, n))));

  // Inform the slot how many pips so its width clamp matches the row.
  slot.style.setProperty('--lane-dice-count', String(n));

  const tint = hexOf(tintForUnit(unit));

  // Reuse existing children where possible to avoid layout thrash.
  while (row.children.length > n) row.removeChild(row.lastChild!);
  while (row.children.length < n) {
    const pip = document.createElement('div');
    pip.className = 'dice-pip';
    row.appendChild(pip);
  }
  for (let i = 0; i < n; i++) {
    const pip = row.children[i] as HTMLElement;
    pip.style.setProperty('--pip-size', `${pipSize}px`);
    pip.style.setProperty('--face-img', `url("${FACE_IMG[faces[i]!]}")`);
    pip.style.setProperty('--dice-tint', tint);
  }
};

const setCombatHeader = (scenario: Scenario | null): void => {
  if (!combatHeaderEl) return;
  if (!scenario) {
    combatHeaderEl.dataset.active = 'false';
    return;
  }
  if (combatLeftEl)  applyUnit(combatLeftEl,  scenario.left);
  if (combatRightEl) applyUnit(combatRightEl, scenario.right);
  combatHeaderEl.dataset.active = 'true';
};

const showVerdict = (outcome: 'success' | 'fail'): void => {
  if (!combatVerdictEl) return;
  const text = combatVerdictEl.querySelector('.combat-verdict-text');
  if (!text) return;
  text.textContent = outcome === 'success' ? 'SUCCESS' : 'FAIL';
  combatVerdictEl.dataset.outcome = outcome;
  // Restart the animation by toggling the attribute.
  combatVerdictEl.dataset.active = 'false';
  void combatVerdictEl.offsetWidth;
  combatVerdictEl.dataset.active = 'true';
};

const clearVerdict = (): void => {
  if (!combatVerdictEl) return;
  combatVerdictEl.dataset.active = 'false';
  delete combatVerdictEl.dataset.outcome;
  const text = combatVerdictEl.querySelector('.combat-verdict-text');
  if (text) text.textContent = '';
};

const markLoser = (loserFrame: HTMLElement | null): void => {
  if (combatLeftEl)  delete combatLeftEl.dataset.loser;
  if (combatRightEl) delete combatRightEl.dataset.loser;
  if (loserFrame) loserFrame.dataset.loser = 'true';
};

const clearInitiative = (): void => {
  if (!initiativeOverlay || !initiativeList) return;
  initiativeOverlay.dataset.active = 'false';
  initiativeList.replaceChildren();
};

/** Build and animate in the initiative result list, sorted desc by value. */
const showInitiativeList = async (
  combatants: InitiativeCombatant[],
  faces: ReadonlyArray<Face>,
): Promise<void> => {
  if (!initiativeOverlay || !initiativeList) return;

  // Pair combatant + rolled value then sort descending.
  const entries = combatants.map((c, i) => ({ c, value: faces[i] ?? (1 as Face) }));
  entries.sort((a, b) => b.value - a.value);

  // Show the overlay immediately (dice are still on screen as backdrop).
  initiativeOverlay.dataset.active = 'true';

  for (let i = 0; i < entries.length; i++) {
    const { c, value } = entries[i]!;
    const rank = i + 1;
    const skin = c.skin;
    const tint = hexOf(skin.iconTint ?? skin.tint);
    const card = document.createElement('div');
    card.className = 'initiative-card';
    card.dataset.rank = String(rank);
    card.dataset.kind = c.unit.kind;

    // Rank number
    const rankEl = document.createElement('span');
    rankEl.className = 'initiative-rank';
    rankEl.textContent = `${rank}.`;

    // Avatar
    const avatarEl = document.createElement('span');
    avatarEl.className = 'initiative-avatar';
    if (c.unit.avatarUrl) avatarEl.style.backgroundImage = `url("${c.unit.avatarUrl}")`;

    // Name + subtitle
    const metaEl = document.createElement('div');
    metaEl.className = 'initiative-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'initiative-name';
    nameEl.dataset.kind = c.unit.kind;
    nameEl.textContent = c.unit.name;
    const subEl = document.createElement('div');
    subEl.className = 'initiative-sub';
    subEl.textContent = subtitleFor(c.unit);
    metaEl.append(nameEl, subEl);

    // Single die pip (one die per combatant in initiative)
    const diceRow = document.createElement('div');
    diceRow.className = 'initiative-dice';
    const pip = document.createElement('div');
    pip.className = 'initiative-pip';
    pip.style.setProperty('--face-img', `url("${FACE_IMG[value]}")`);
    pip.style.setProperty('--dice-tint', tint);
    diceRow.appendChild(pip);

    // Numeric value with flowing gradient
    const valueEl = document.createElement('div');
    valueEl.className = 'initiative-value';
    valueEl.textContent = String(value);

    card.append(rankEl, avatarEl, metaEl, diceRow, valueEl);
    initiativeList.appendChild(card);

    // Stagger: trigger animation slightly offset per card.
    await delay(60);
    card.classList.add('show');
  }
};

/** Pull the skin a lane should use from the scenario's character mock. */
const skinFromScenario = (scenario: Scenario, side: 'left' | 'right'): DiceSkin =>
  skinForCharacter(scenario[side].kind, scenario[side].archetype);

const overlay = new Dice3DOverlay({ glbUrl: diceGlbUrl });

const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

const formatResult = (label: string, faces: number[]): string => {
  if (faces.length === 0) return `${label}: —`;
  const top = Math.max(...faces);
  return `${label}: [${faces.join(', ')}]  top=${top}`;
};

/**
 * Build a duel-style RollDispatch from the preset's scenario. The attacker
 * lane gets the left unit's skin and the defender lane gets the right unit's
 * skin, so the 3D dice physically match the units in the combat header.
 * Face values themselves are ignored — physics drives the outcome.
 */
const buildDispatch = (scenario: Scenario, attackerCount: number, defenderCount: number): RollDispatch => {
  const faces = (n: number): Face[] => Array(n).fill(1) as Face[];
  const attackerFaces = faces(attackerCount);
  const defenderFaces = faces(defenderCount);
  const aSkin = skinFromScenario(scenario, 'left');
  const dSkin = defenderCount > 0 ? skinFromScenario(scenario, 'right') : null;
  return {
    t: Date.now(),
    attacker: attackerFaces,
    defender: defenderFaces,
    attackerSkins: attackerFaces.map(() => aSkin),
    ...(dSkin && { defenderSkins: defenderFaces.map(() => dSkin) }),
  };
};

interface PresetResult {
  dispatch: RollDispatch;
  attackerCount: number;
  defenderCount: number;
  scenario: Scenario;
  mode: 'duel' | 'initiative';
  /** Populated only when mode === 'initiative', in spawn order. */
  initiativeCombatants?: InitiativeCombatant[];
}

const ROLL_PRESETS: Record<string, () => PresetResult> = {
  '1':        () => ({ mode: 'duel', scenario: SCENARIOS['1']!,        attackerCount: 1, defenderCount: 0, dispatch: buildDispatch(SCENARIOS['1']!,        1, 0) }),
  '2':        () => ({ mode: 'duel', scenario: SCENARIOS['2']!,        attackerCount: 2, defenderCount: 0, dispatch: buildDispatch(SCENARIOS['2']!,        2, 0) }),
  '3':        () => ({ mode: 'duel', scenario: SCENARIOS['3']!,        attackerCount: 3, defenderCount: 0, dispatch: buildDispatch(SCENARIOS['3']!,        3, 0) }),
  '4':        () => ({ mode: 'duel', scenario: SCENARIOS['4']!,        attackerCount: 4, defenderCount: 0, dispatch: buildDispatch(SCENARIOS['4']!,        4, 0) }),
  'duel':     () => ({ mode: 'duel', scenario: SCENARIOS['duel']!,     attackerCount: 3, defenderCount: 2, dispatch: buildDispatch(SCENARIOS['duel']!,     3, 2) }),
  'duel-big': () => ({ mode: 'duel', scenario: SCENARIOS['duel-big']!, attackerCount: 5, defenderCount: 3, dispatch: buildDispatch(SCENARIOS['duel-big']!, 5, 3) }),
  'initiative': () => {
    const combatants: InitiativeCombatant[] = [
      { unit: WARRIOR,   skin: skinForCharacter('hero',    'warrior') },
      { unit: HUNTER,    skin: skinForCharacter('hero',    'hunter')  },
      { unit: WARLOCK,   skin: skinForCharacter('hero',    'warlock') },
      { unit: HEALER,    skin: skinForCharacter('hero',    'healer')  },
      { unit: GIANT_RAT, skin: skinForCharacter('monster', null)      },
      { unit: GIANT_RAT, skin: skinForCharacter('monster', null)      },
      { unit: GIANT_RAT, skin: skinForCharacter('monster', null)      },
      { unit: KING_RAT,  skin: skinForCharacter('monster', null)      },
    ];
    const faces = Array(combatants.length).fill(1) as Face[];
    const skins = combatants.map((c) => c.skin);
    return {
      mode: 'initiative',
      dispatch: { t: Date.now(), attacker: faces, defender: [], attackerSkins: skins },
      attackerCount: combatants.length,
      defenderCount: 0,
      scenario: SCENARIOS['initiative']!,
      initiativeCombatants: combatants,
    };
  },
  'max':      () => ({ mode: 'duel', scenario: SCENARIOS['max']!,      attackerCount: 6, defenderCount: 6, dispatch: buildDispatch(SCENARIOS['max']!,      6, 6) }),
};

const buttons = Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('button[data-action]'));
const setButtonsDisabled = (disabled: boolean): void => {
  for (const b of buttons) b.disabled = disabled;
};

const onClick = async (action: string): Promise<void> => {
  const preset = ROLL_PRESETS[action];
  if (!preset) return;
  const { dispatch, attackerCount, defenderCount, scenario, mode, initiativeCombatants } = preset();
  setButtonsDisabled(true);
  setStatus(`Rolling ${attackerCount}${defenderCount > 0 ? ` vs ${defenderCount}` : ''}…`);

  // Reset all overlays before starting.
  clearVerdict();
  markLoser(null);
  clearInitiative();

  if (mode === 'initiative') {
    // Initiative: hide the VS header entirely — the list will be the whole UI.
    if (combatHeaderEl) combatHeaderEl.dataset.active = 'false';
  } else {
    setCombatHeader(scenario);
    clearResult(combatLeftEl);
    clearResult(combatRightEl);
  }

  try {
    const startedAt = performance.now();
    let attackerTop = 0;
    let defenderTop = 0;
    let settledFaces: Face[] = [];

    await overlay.roll(dispatch, (lane, faces) => {
      if (mode === 'initiative') {
        // Collect all rolled faces; list rendered after settle.
        settledFaces = faces;
        return;
      }
      // Duel / ability-test mode.
      const frame = lane === 'attacker' ? combatLeftEl : combatRightEl;
      const unit  = lane === 'attacker' ? scenario.left : scenario.right;
      setRolledFaces(frame, unit, faces);
      const topFace = faces.reduce((m, f) => (f > m ? f : m), 1 as Face);
      showResult(frame, topFace);
      if (lane === 'attacker') attackerTop = topFace;
      else defenderTop = topFace;
    });

    if (mode === 'initiative') {
      await delay(400);
      await showInitiativeList(initiativeCombatants ?? [], settledFaces);
    } else {
      // Show the outcome verdict once both sides have settled.
      const hasDefender = defenderCount > 0;
      const success = hasDefender
        ? attackerTop >= defenderTop
        : attackerTop >= 4;
      await delay(900);
      showVerdict(success ? 'success' : 'fail');
      markLoser(success ? combatRightEl : combatLeftEl);
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
    const faces = overlay.getCurrentFaces();
    const attackerFaces = faces.slice(0, attackerCount);
    const defenderFaces = faces.slice(attackerCount, attackerCount + defenderCount);
    const lines = [
      `Settled in ${elapsed}s`,
      formatResult('attacker', attackerFaces),
    ];
    if (defenderCount > 0) lines.push(formatResult('defender', defenderFaces));
    setStatus(lines.join('\n'));
  } catch (e) {
    setStatus(`Roll failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setButtonsDisabled(false);
  }
};

for (const b of buttons) {
  b.addEventListener('click', () => {
    void onClick(b.dataset.action ?? '');
  });
}

// --- Calibration buttons -----------------------------------------------
// Spawn a single die oriented so FACE_NORMALS[N] faces +Y. The visible pip
// count on top is the GLB's TRUE face for axis N. If it doesn't match the
// button label, the entry for N in FACE_NORMALS (DiceMesh.ts) is wrong.
const calibrationButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('button[data-calibrate]'),
);
for (const b of calibrationButtons) {
  b.addEventListener('click', () => {
    const face = parseInt(b.dataset.calibrate ?? '1', 10) as Face;
    setStatus(`Calibration: requested face ${face} up. Visible pips = TRUE value of face ${face}.`);
    setCombatHeader(null);
    void overlay.showFaceForCalibration(face);
  });
}

overlay.attach(host);

// ----------------------------------------------------------------------
// Live camera controls. The page mirrors SceneConfig.CAMERA into a mutable
// `liveCamera` record; each slider/number input mutates it and pushes a
// composed config into the overlay. The snippet panel keeps a SceneConfig-
// ready code fragment in sync so it can be copy-pasted back into the source.
// ----------------------------------------------------------------------

interface LiveCamera {
  posX: number; posY: number; posZ: number;
  tgtX: number; tgtY: number; tgtZ: number;
  zoom: number;
}

const defaultCamera = (): LiveCamera => ({
  posX: SceneConfig.CAMERA.position.x,
  posY: SceneConfig.CAMERA.position.y,
  posZ: SceneConfig.CAMERA.position.z,
  tgtX: SceneConfig.CAMERA.target.x,
  tgtY: SceneConfig.CAMERA.target.y,
  tgtZ: SceneConfig.CAMERA.target.z,
  zoom: SceneConfig.CAMERA.zoom,
});

let liveCamera: LiveCamera = defaultCamera();
let baseConfig: typeof SceneConfig = SceneConfig;

// Live dithered-vignette controls — same mirror-and-compose pattern as the
// camera panel. Each field maps 1:1 to SceneConfig.VIGNETTE so the snippet is
// copy-paste-ready.
interface LiveVignette {
  radius: number; softness: number; intensity: number; ditherPx: number;
}

const defaultVignette = (): LiveVignette => ({
  radius:    SceneConfig.VIGNETTE.radius,
  softness:  SceneConfig.VIGNETTE.softness,
  intensity: SceneConfig.VIGNETTE.intensity,
  ditherPx:  SceneConfig.VIGNETTE.ditherPx,
});

let liveVignette: LiveVignette = defaultVignette();

const composedConfig = (): typeof SceneConfig => ({
  ...baseConfig,
  CAMERA: {
    ...baseConfig.CAMERA,
    position: new THREE.Vector3(liveCamera.posX, liveCamera.posY, liveCamera.posZ),
    target:   new THREE.Vector3(liveCamera.tgtX, liveCamera.tgtY, liveCamera.tgtZ),
    zoom:     liveCamera.zoom,
  },
  VIGNETTE: {
    ...baseConfig.VIGNETTE,
    radius:    liveVignette.radius,
    softness:  liveVignette.softness,
    intensity: liveVignette.intensity,
    ditherPx:  liveVignette.ditherPx,
  },
});

const applyLive = (): void => {
  overlay.applyConfig(composedConfig());
  refreshUI();
};

const f2 = (n: number): string => n.toFixed(2);

const snippetText = (): string =>
  [
    `position: new THREE.Vector3(${f2(liveCamera.posX)}, ${f2(liveCamera.posY)}, ${f2(liveCamera.posZ)}),`,
    `target:   new THREE.Vector3(${f2(liveCamera.tgtX)}, ${f2(liveCamera.tgtY)}, ${f2(liveCamera.tgtZ)}),`,
    `zoom:     ${f2(liveCamera.zoom)},`,
  ].join('\n');

// SceneConfig.VIGNETTE-ready fragment. ditherPx prints as an integer (it's an
// RT-pixel count) while the rest keep 2 decimals.
const vigSnippetText = (): string =>
  [
    `radius:    ${f2(liveVignette.radius)},`,
    `softness:  ${f2(liveVignette.softness)},`,
    `intensity: ${f2(liveVignette.intensity)},`,
    `ditherPx:  ${liveVignette.ditherPx},`,
  ].join('\n');

const snippetEl = document.getElementById('config-snippet');
const copyBtn   = document.getElementById('copy-btn');
const resetBtn  = document.getElementById('reset-btn');
const copyToast = document.getElementById('copy-toast');

const vigSnippetEl = document.getElementById('vig-snippet');
const vigCopyBtn   = document.getElementById('vig-copy-btn');
const vigResetBtn  = document.getElementById('vig-reset-btn');
const vigCopyToast = document.getElementById('vig-copy-toast');

const CTRL_KEYS: Record<string, keyof LiveCamera> = {
  'pos.x': 'posX', 'pos.y': 'posY', 'pos.z': 'posZ',
  'tgt.x': 'tgtX', 'tgt.y': 'tgtY', 'tgt.z': 'tgtZ',
  'zoom':  'zoom',
};

// data-vig attribute value === LiveVignette key, so no remap table is needed.
const VIG_KEYS: ReadonlyArray<keyof LiveVignette> = ['radius', 'softness', 'intensity', 'ditherPx'];

const refreshUI = (): void => {
  for (const [ctrl, key] of Object.entries(CTRL_KEYS)) {
    const v = liveCamera[key];
    document.querySelectorAll<HTMLInputElement>(`input[data-ctrl="${ctrl}"]`).forEach((el) => {
      if (document.activeElement === el) return;
      el.value = String(v);
    });
  }
  for (const key of VIG_KEYS) {
    const v = liveVignette[key];
    document.querySelectorAll<HTMLInputElement>(`input[data-vig="${key}"]`).forEach((el) => {
      if (document.activeElement === el) return;
      el.value = String(v);
    });
  }
  if (snippetEl) snippetEl.textContent = snippetText();
  if (vigSnippetEl) vigSnippetEl.textContent = vigSnippetText();
};

for (const input of document.querySelectorAll<HTMLInputElement>('input[data-ctrl]')) {
  input.addEventListener('input', () => {
    const ctrl = input.dataset.ctrl ?? '';
    const key = CTRL_KEYS[ctrl];
    if (!key) return;
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) {
      liveCamera[key] = v;
      applyLive();
    }
  });
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[data-vig]')) {
  input.addEventListener('input', () => {
    const key = input.dataset.vig as keyof LiveVignette | undefined;
    if (!key || !VIG_KEYS.includes(key)) return;
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) {
      liveVignette[key] = v;
      applyLive();
    }
  });
}

copyBtn?.addEventListener('click', () => {
  void navigator.clipboard.writeText(snippetText()).then(() => {
    if (copyToast) {
      copyToast.classList.add('show');
      setTimeout(() => copyToast.classList.remove('show'), 1200);
    }
  });
});

resetBtn?.addEventListener('click', () => {
  liveCamera = defaultCamera();
  applyLive();
});

vigCopyBtn?.addEventListener('click', () => {
  void navigator.clipboard.writeText(vigSnippetText()).then(() => {
    if (vigCopyToast) {
      vigCopyToast.classList.add('show');
      setTimeout(() => vigCopyToast.classList.remove('show'), 1200);
    }
  });
});

vigResetBtn?.addEventListener('click', () => {
  liveVignette = defaultVignette();
  applyLive();
});

refreshUI();
applyLive();

void overlay.prewarm().then(
  () => setStatus('Ready. Click a button to roll.'),
  (err) => setStatus(`Init failed: ${err instanceof Error ? err.message : String(err)}`),
);

// Vite HMR — when `SceneConfig.ts` is edited, re-apply the new module to the
// live scene without losing the renderer / physics world / GLB. The UI's
// camera AND vignette overrides survive: we swap in the new module as the base
// but keep the user's current panel tuning (composedConfig re-layers it).
if (import.meta.hot) {
  import.meta.hot.accept('./components/three/SceneConfig.ts', (newMod) => {
    if (newMod) {
      baseConfig = newMod as typeof SceneConfig;
      applyLive();
      // eslint-disable-next-line no-console
      console.log('[HMR] SceneConfig re-applied (camera + vignette overrides preserved)');
    }
  });
}
