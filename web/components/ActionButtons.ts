import { html, type TemplateResult } from 'lit-html';
import { t } from '../i18n.js';

export type SelectionMode = 'idle' | 'attack' | 'move' | 'special';

/**
 * What Board needs to draw the selection overlay. Layout computes this from
 * the current snapshot + active mode and pushes it into Board via the
 * BoardApi. Empty arrays + mode === 'idle' clear the overlay.
 */
export interface SelectionOverlay {
  mode: SelectionMode;
  /** Cells the player can move to this turn (mode === 'move'). */
  reachable: ReadonlyArray<{ x: number; y: number }>;
  /** Character ids the player can target (mode === 'attack' | 'special'). */
  targets: ReadonlyArray<string>;
  /**
   * Inanimate Things the player can target in attack mode — scene obstacles
   * or DM-spawned emoji props. Identified by cell (the engine's
   * attack_object payload). Empty outside attack mode.
   */
  objectTargets?: ReadonlyArray<{ x: number; y: number }>;
  /**
   * Multi-target split-special (whirlwind / split-shot) allocation in progress:
   * per-target dice the player has assigned so far. Present only while a split
   * session is active (mode === 'special'); drives the bright "assigned" ring +
   * the on-board ×N badge. Empty/absent for single-click specials.
   */
  allocations?: ReadonlyArray<{ id: string; dice: number }>;
  /** Split-special dice still to assign (present only during a split session). */
  budgetLeft?: number;
}

export interface ActionButtonsProps {
  mode: SelectionMode;
  /** Toggle a target-picking mode. Same mode passed twice cancels (returns to idle). */
  onMode(m: SelectionMode): void;
  onEndTurn(): void;
  /** HeroKids: 1 move per turn — hide Move once used. */
  canMove: boolean;
  /** HeroKids: 1 main action per turn — hide Attack/Special once used. */
  canAct: boolean;
}

const cls = (active: boolean) => `act-btn${active ? ' act-btn-active' : ''}`;

export const actionButtons = (p: ActionButtonsProps): TemplateResult => html`
  <div class="action-buttons" role="toolbar" aria-label=${t('act.toolbarAria')}>
    ${p.canAct  ? html`<button class=${cls(p.mode === 'attack')}  type="button" @click=${() => p.onMode('attack')} >${t('act.attack')}</button>`  : ''}
    ${p.canAct  ? html`<button class=${cls(p.mode === 'special')} type="button" @click=${() => p.onMode('special')}>${t('act.special')}</button>` : ''}
    ${p.canMove ? html`<button class=${cls(p.mode === 'move')}    type="button" @click=${() => p.onMode('move')}   >${t('act.move')}</button>`    : ''}
    <button class="act-btn act-btn-end" type="button" @click=${p.onEndTurn}>${t('act.endTurn')}</button>
  </div>
`;

/** The active hero's special action (name + flavour), used to describe what
 *  Special does instead of a generic "click a target" prompt. */
export interface SpecialHint {
  name: string;
  description: string;
}

export const selectionHint = (mode: SelectionMode, special?: SpecialHint | null): string => {
  switch (mode) {
    case 'attack':  return t('hint.attack');
    case 'special': {
      if (special?.name) {
        const desc = special.description ? ` — ${special.description}` : '';
        return t('hint.specialNamed', { name: special.name, desc });
      }
      return t('hint.special');
    }
    case 'move':    return t('hint.move');
    default:        return '';
  }
};
