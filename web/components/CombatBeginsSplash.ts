import { html, type TemplateResult } from 'lit-html';
import { t } from '../i18n.js';

/**
 * Transient "To Arms!" combat-begins splash. Mounted into `.board-stage` for
 * one tick (~1.66s) right after the engine emits `combat_started` — before
 * the initiative dice physics dispatch fires. Stays scoped to the board area
 * (the parent stage is `position: relative`) so it lands centered over the
 * canvas, not the full viewport.
 *
 * Visual language matches the on-board HIT!/MISS flashRoll callout
 * (`web/components/RollOverlay.ts`): Jersey 10 pixel font, italic skew,
 * yellow→orange→red fire gradient, heavy black "stamped" outline + drop
 * shadow, KoF-style pop-overshoot-settle scale curve. Reads as a
 * bigger-budget sibling of the HIT! that fires on a successful attack.
 */
export const combatBeginsSplash = (): TemplateResult => html`
  <div class="combat-begins" role="status" aria-live="polite">
    <h2 class="combat-begins-title">${t('combat.toArms')}</h2>
    <p class="combat-begins-sub">${t('combat.rollInitiative')}</p>
  </div>
`;

/** Total on-screen lifetime of the splash, in ms. Layout unmounts the
 *  splash this long after promoting the initiative item. The CSS keyframes
 *  share the same total — keep them in sync. */
export const COMBAT_BEGINS_SPLASH_MS = 1660;

/** Offset (relative to promote) at which Layout fires the dice dispatch.
 *  Tuned so the splash has finished its pop + brief steady hold (~720ms)
 *  before the dice canvas starts fading in. The canvas fade-in itself is
 *  ~600ms (Dice3DOverlay's `CANVAS_FADE_MS`), so the dice are fully visible
 *  at ~1320ms — leaving the final ~340ms of splash lifetime to fade out
 *  on top of the already-visible dice scene. Net effect: the splash bridges
 *  the entire "engine has decided combat is happening → dice are on screen
 *  and rolling" transition without any visual gap. */
export const COMBAT_BEGINS_DISPATCH_AT_MS = 720;
