/**
 * DiceHUD — manages the combat header and verdict overlay that sit inside
 * `.canvas-wrapper` during attack rolls. Injected into the game's existing
 * board DOM by `main.ts` after `mountBoard` attaches the Pixi canvas wrapper.
 *
 *  - `buildDuelContext(summary)` — for attack/ability rolls. Returns a
 *    `LaneSettledHandler` that populates the left/right frames as each lane
 *    of dice settles, then shows the verdict.
 *  - `buildInitiativeContext(summary)` — kept for API symmetry but does
 *    nothing visible. Initiative rolls render their reveal through the
 *    top-of-board InitiativeBar component instead of a HUD overlay.
 *
 * CSS lives in `web/styles/dice-hud.css`, imported via Vite below.
 */
import '../styles/dice-hud.css';
import { t, translateArchetype } from '../i18n.js';
import type { LaneSettledHandler } from './Dice3DOverlay.js';
import type { RollSummary } from './RollPanel.js';
import type { InitiativeSummary } from './InitiativePanel.js';
import type { Face } from './three/DiceMesh.js';
import { skinForCharacter } from './three/DiceSkins.js';

import f1 from '../../assets/dice-sprites/d6-face-1.png?url';
import f2 from '../../assets/dice-sprites/d6-face-2.png?url';
import f3 from '../../assets/dice-sprites/d6-face-3.png?url';
import f4 from '../../assets/dice-sprites/d6-face-4.png?url';
import f5 from '../../assets/dice-sprites/d6-face-5.png?url';
import f6 from '../../assets/dice-sprites/d6-face-6.png?url';
const FACE_IMG: Record<Face, string> = { 1:f1, 2:f2, 3:f3, 4:f4, 5:f5, 6:f6 };

const MAX_ROW_PX = 92;
const MAX_PIP_PX = 28;
const PIP_GAP_PX = 2;

const hexOf = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

const avatarUrl = (
  kind: 'hero' | 'monster' | 'npc' | 'dm',
  archetype: string | null,
  sprite: string | null,
): string | null => {
  if (kind === 'hero' && archetype) return `/assets/heroes/${archetype}/south.png`;
  if (kind === 'npc' && sprite) return `/assets/npcs/${sprite}/south.png`;
  if (kind === 'monster' && sprite) return `/assets/monsters/${sprite}/south.png`;
  return null;
};

const subtitleFor = (
  kind: 'hero' | 'monster' | 'npc' | 'dm',
  archetype: string | null,
): string => {
  if (kind === 'hero' && archetype) return translateArchetype(archetype);
  if (kind === 'monster' || kind === 'npc') return t('dice.foe');
  if (kind === 'dm') return t('dice.skillCheck');
  return '';
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Identity for one side of a duel frame — enough to render the avatar,
 *  nameplate, and per-die skin tint. */
export interface DuelFrameInfo {
  name: string;
  kind: 'hero' | 'monster' | 'npc' | 'dm';
  archetype: string | null;
  sprite: string | null;
}

/**
 * Pure: map an engine `hit` boolean to the duel verdict label.
 *
 * The SUCCESS/FAIL stamp always reads from the LEFT frame's point of view.
 * The left frame is always the attacker (see `beginDuel`), and `hit` is true
 * exactly when the attacker won the roll, so the verdict is a direct mapping:
 * the left unit won → SUCCESS, the left unit lost → FAIL. This holds no matter
 * who the left unit is — when a monster attacks a hero (monster on the left)
 * and its swing lands, the stamp shows SUCCESS, because the left unit won the
 * duel. Earlier this inverted to the party's perspective, which read backwards
 * whenever an enemy occupied the left frame.
 */
export const duelVerdict = (hit: boolean): 'success' | 'fail' =>
  hit ? 'success' : 'fail';

export class DiceHUD {
  private root: HTMLElement | null = null;
  private header: HTMLElement | null = null;
  private leftFrame: HTMLElement | null = null;
  private rightFrame: HTMLElement | null = null;
  private verdict: HTMLElement | null = null;
  private verdictText: HTMLElement | null = null;
  private initiativeOverlay: HTMLElement | null = null;
  private initiativeList: HTMLElement | null = null;

  attach(wrapper: HTMLElement): void {
    if (this.root) return; // already attached
    const root = document.createElement('div');
    root.className = 'dice-hud-root';
    root.dataset.active = 'false';
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:29;';
    root.innerHTML = `
      <div class="combat-header" data-active="false">
        <div class="combat-frame combat-frame--left" id="dice-hud-left">
          <span class="combat-avatar" data-empty="false"></span>
          <div class="combat-meta">
            <span class="combat-name"></span>
            <span class="combat-subtitle"></span>
          </div>
          <div class="dice-slot" data-result-active="false">
            <div class="dice-faces"></div>
            <div class="combat-result-wrap">
              <span class="combat-result" data-active="false"></span>
            </div>
          </div>
        </div>
        <span class="vs-divider">VS</span>
        <div class="combat-frame combat-frame--right" id="dice-hud-right">
          <span class="combat-avatar" data-empty="false"></span>
          <div class="combat-meta">
            <span class="combat-name"></span>
            <span class="combat-subtitle"></span>
          </div>
          <div class="dice-slot" data-result-active="false">
            <div class="dice-faces"></div>
            <div class="combat-result-wrap">
              <span class="combat-result" data-active="false"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="combat-verdict">
        <span class="combat-verdict-text"></span>
      </div>
      <div class="initiative-overlay">
        <div class="initiative-list"></div>
      </div>
    `;
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
    wrapper.appendChild(root);

    this.root             = root;
    this.header           = root.querySelector('.combat-header');
    this.leftFrame        = root.querySelector('#dice-hud-left');
    this.rightFrame       = root.querySelector('#dice-hud-right');
    this.verdict          = root.querySelector('.combat-verdict');
    this.verdictText      = root.querySelector('.combat-verdict-text');
    this.initiativeOverlay = root.querySelector('.initiative-overlay');
    this.initiativeList   = root.querySelector('.initiative-list');
  }

  /** Hide all overlay elements and reset state. Called before every new roll
   *  and again after the roll resolves, so the root fade-out fires at the
   *  same moment the 3D canvas hides. */
  clear(): void {
    if (this.root)             this.root.dataset.active = 'false';
    if (this.header)           this.header.dataset.active = 'false';
    if (this.verdict)          { this.verdict.dataset.active = 'false'; delete this.verdict.dataset.outcome; }
    if (this.verdictText)      this.verdictText.textContent = '';
    if (this.initiativeOverlay) this.initiativeOverlay.dataset.active = 'false';
    if (this.initiativeList)   this.initiativeList.replaceChildren();
    this.clearFrame(this.leftFrame);
    this.clearFrame(this.rightFrame);
    if (this.leftFrame)  delete this.leftFrame.dataset.loser;
    if (this.rightFrame) delete this.rightFrame.dataset.loser;
  }

  // ── Duel mode ───────────────────────────────────────────────────────────

  /**
   * Set up the VS header for an attack/ability roll and return a
   * `LaneSettledHandler` that populates each frame as its lane of dice
   * settles. Does NOT show the verdict — the caller decides when the
   * SUCCESS/FAIL stamp appears via `showDuelVerdict`. This split exists so
   * physics-as-truth mode (where hit/miss isn't known until the dice land)
   * can compute the verdict from the settled faces, while the legacy
   * resolution-driven path (`buildDuelContext`) schedules it from a known
   * `summary.hit`.
   *
   * For a skill check (ability test / object smash / free-ally) pass `check`
   * with the DC. The right frame is then the *target* to beat, not a rolling
   * opponent (its lane has 0 dice). Instead of spelling the DC into the
   * nameplate, we render it as a die icon + number in the right frame's dice
   * slot — the same visual the hero/enemy frames use for their rolled result —
   * so the DC reads consistently with the rest of the HUD.
   */
  beginDuel(
    attacker: DuelFrameInfo,
    defender: DuelFrameInfo,
    check?: { difficulty: number },
  ): LaneSettledHandler {
    this.clear();
    this.populateFrame(this.leftFrame, 'left', attacker);
    this.populateFrame(this.rightFrame, 'right', defender);
    if (this.header) this.header.dataset.active = 'true';
    if (this.root)   this.root.dataset.active   = 'true';
    if (check) this.showCheckTarget(this.rightFrame, check.difficulty);

    return (_lane, faces) => {
      const isAttacker = _lane === 'attacker';
      const frame = isAttacker ? this.leftFrame : this.rightFrame;
      const info = isAttacker ? attacker : defender;
      const skin = skinForCharacter(info.kind, info.archetype);
      const tint = hexOf(skin.iconTint ?? skin.tint);
      this.setRolledFaces(frame, tint, faces);
      const top = faces.reduce<Face>((m, f) => (f > m ? f : m), 1 as Face);
      this.showResult(frame, top);
    };
  }

  /**
   * Show the SUCCESS/FAIL stamp for the current duel. The label reads from the
   * left frame's perspective (see `duelVerdict`) — the left unit is always the
   * attacker, so `hit` (attacker won) maps straight to SUCCESS. The mechanical
   * loser frame is the defender on a hit / the attacker on a miss.
   */
  showDuelVerdict(hit: boolean): void {
    this.showVerdict(duelVerdict(hit));
    this.markLoser(hit ? this.rightFrame : this.leftFrame);
  }

  /**
   * Legacy resolution-driven duel: hit/miss is already known from the engine
   * (`summary.hit`), so schedule the verdict 900ms after the deciding lane
   * settles. Used when dice are NOT physics-authoritative (rollProvider off,
   * or a roll that fell back to seeded engine dice).
   */
  buildDuelContext(summary: RollSummary): LaneSettledHandler {
    const base = this.beginDuel(
      {
        name:      summary.attackerName,
        kind:      summary.attackerKind,
        archetype: summary.attackerArchetype,
        sprite:    summary.attackerSprite,
      },
      {
        name:      summary.targetName,
        kind:      summary.targetKind,
        archetype: summary.targetArchetype,
        sprite:    summary.targetSprite,
      },
    );
    const hit = summary.hit;
    return (lane, faces) => {
      base(lane, faces);
      // After the defender lane settles (or immediately for ability tests
      // where there is no defender lane), show the verdict.
      if (lane === 'defender' || summary.defenderArmorPool === 0) {
        void delay(900).then(() => this.showDuelVerdict(hit));
      }
    };
  }

  // ── Initiative mode ─────────────────────────────────────────────────────

  /**
   * Initiative no longer renders any HUD overlay — the top-of-board
   * InitiativeBar component carries the full reveal (per-combatant dice
   * icon + value) on its own. We still return a `LaneSettledHandler` so
   * the caller's signature stays uniform with `buildDuelContext`, but
   * `clear()` is the only side-effect: dice-hud-root stays inactive, the
   * VS header stays hidden, and the per-lane callback is a no-op.
   */
  buildInitiativeContext(_summary: InitiativeSummary): LaneSettledHandler {
    this.clear();
    if (this.header) this.header.dataset.active = 'false';
    return () => {};
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private populateFrame(
    frame: HTMLElement | null,
    _side: 'left' | 'right',
    unit: { name: string; kind: 'hero'|'monster'|'npc'|'dm'; archetype: string|null; sprite: string|null },
  ): void {
    if (!frame) return;
    const av = frame.querySelector('.combat-avatar') as HTMLElement | null;
    const nameEl = frame.querySelector('.combat-name') as HTMLElement | null;
    const subEl = frame.querySelector('.combat-subtitle') as HTMLElement | null;
    const avUrl = avatarUrl(unit.kind, unit.archetype, unit.sprite);
    if (av) {
      av.style.backgroundImage = avUrl ? `url("${avUrl}")` : 'none';
      av.dataset.empty = avUrl ? 'false' : 'true';
    }
    if (nameEl) { nameEl.textContent = unit.name; nameEl.dataset.kind = unit.kind; }
    if (subEl) subEl.textContent = subtitleFor(unit.kind, unit.archetype);
  }

  private clearFrame(frame: HTMLElement | null): void {
    if (!frame) return;
    const slot = frame.querySelector('.dice-slot') as HTMLElement | null;
    const result = frame.querySelector('.combat-result') as HTMLElement | null;
    const row = frame.querySelector('.dice-faces') as HTMLElement | null;
    if (slot)   slot.dataset.resultActive = 'false';
    if (result) { result.dataset.active = 'false'; result.textContent = ''; }
    if (row)    row.replaceChildren();
  }

  private setRolledFaces(frame: HTMLElement | null, tint: string, faces: ReadonlyArray<Face>): void {
    if (!frame) return;
    const slot = frame.querySelector('.dice-slot') as HTMLElement | null;
    const row  = frame.querySelector('.dice-faces') as HTMLElement | null;
    if (!slot || !row) return;
    const n = faces.length;
    const pipSize = Math.max(8, Math.min(MAX_PIP_PX, Math.floor(
      Math.max(1, MAX_ROW_PX - PIP_GAP_PX * Math.max(0, n - 1)) / Math.max(1, n),
    )));
    slot.style.setProperty('--lane-dice-count', String(n));
    while (row.children.length > n) row.removeChild(row.lastChild!);
    while (row.children.length < n) { const p = document.createElement('div'); p.className = 'dice-pip'; row.appendChild(p); }
    for (let i = 0; i < n; i++) {
      const pip = row.children[i] as HTMLElement;
      pip.style.setProperty('--pip-size', `${pipSize}px`);
      pip.style.setProperty('--face-img', `url("${FACE_IMG[faces[i]!]}")`);
      pip.style.setProperty('--dice-tint', tint);
    }
  }

  /**
   * Render the DC of a skill check on a frame as a die icon + number, matching
   * the hero/enemy rolled-result look. The die face shows the DC value (clamped
   * to a valid d6 face for the icon image) tinted with the DM "skill check"
   * skin, and the result number reads the DC. Unlike a real roll this is shown
   * eagerly (the frame has no settling lane), so the target-to-beat is on screen
   * before the attacker's dice fly.
   */
  private showCheckTarget(frame: HTMLElement | null, difficulty: number): void {
    if (!frame) return;
    const skin = skinForCharacter('dm', null);
    const tint = hexOf(skin.iconTint ?? skin.tint);
    const face = Math.min(6, Math.max(1, Math.round(difficulty))) as Face;
    this.setRolledFaces(frame, tint, [face]);
    this.showResult(frame, face);
  }

  private showResult(frame: HTMLElement | null, top: Face): void {
    if (!frame) return;
    const slot = frame.querySelector('.dice-slot') as HTMLElement | null;
    const result = frame.querySelector('.combat-result') as HTMLElement | null;
    if (!slot || !result) return;
    result.textContent = String(top);
    result.dataset.active = 'false';
    void result.offsetWidth;
    result.dataset.active = 'true';
    slot.dataset.resultActive = 'true';
  }

  private showVerdict(outcome: 'success' | 'fail'): void {
    if (!this.verdict || !this.verdictText) return;
    this.verdictText.textContent = outcome === 'success' ? 'SUCCESS' : 'FAIL';
    this.verdict.dataset.outcome = outcome;
    this.verdict.dataset.active = 'false';
    void this.verdict.offsetWidth;
    this.verdict.dataset.active = 'true';
  }

  private markLoser(loser: HTMLElement | null): void {
    if (this.leftFrame)  delete this.leftFrame.dataset.loser;
    if (this.rightFrame) delete this.rightFrame.dataset.loser;
    if (loser) loser.dataset.loser = 'true';
  }
}
