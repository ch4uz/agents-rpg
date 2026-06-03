/**
 * "Order of Battle" reveal — fired after the initiative dice settle, it
 * labels each settled die with a small callout naming who rolled it and
 * what initiative slot they landed in, then fades back out to hand the
 * board back to the looping `turnOrderBar`.
 *
 * Design (reworked 2026-05-31):
 *
 *   - NO centred plaque, NO backdrop blur. The 3D dice scene stays sharp
 *     behind the overlay (the dice are kept on-screen by the initiative
 *     roll's `keepVisibleAfterSettle`).
 *   - One tooltip-shaped BADGE per combatant: the character's portrait coin
 *     plus its turn-order rank (`#1`, `#2`, …), a dark body with a
 *     kind-tinted border (gold for heroes, red for monsters), and a small
 *     downward tail that points at the die.
 *   - Each badge is anchored over the screen position of the 3D die that
 *     character rolled (`positions[characterId]`, in PERCENT of the board
 *     stage). When no positions are supplied (e.g. before the live-game
 *     projection is wired, or in tests) the badges fall back to an evenly
 *     spaced row across the centre so the overlay still reads.
 *
 * Motion is a single opacity cross-fade applied to the whole overlay —
 * fade in, hold, fade out — driven by the CSS keyframes in `main.css`.
 *
 * Keyed on the initiative `t` so a fresh combat in the same session tears
 * down the previous DOM tree and replays the fade-in from frame 0.
 */
import { html, type TemplateResult } from 'lit-html';
import { keyed } from 'lit-html/directives/keyed.js';
import type { InitiativeRollEntry, InitiativeSummary } from './InitiativePanel.js';

const ASSETS_BASE = '/assets';

/** English ordinal for a 1-based turn-order rank: 1→"1st", 2→"2nd", 3→"3rd",
 *  4→"4th", 11→"11th", 21→"21st", … */
const ordinal = (n: number): string => {
  const tens = n % 100;
  const ones = n % 10;
  const suffix =
    tens >= 11 && tens <= 13 ? 'th'
    : ones === 1 ? 'st'
    : ones === 2 ? 'nd'
    : ones === 3 ? 'rd'
    : 'th';
  return `${n}${suffix}`;
};

/** Screen position of a combatant's die, in PERCENT of the board stage
 *  (0–100 on each axis). The badge's tail points at this point. */
export interface BadgeAnchor {
  x: number;
  y: number;
}

/** characterId → die screen anchor. Supplied by the live game (projected
 *  from the 3D dice) or the preview harness. Missing ids fall back to a row. */
export type BadgeAnchors = Readonly<Record<string, BadgeAnchor>>;

const avatarUrl = (
  kind: 'hero' | 'monster',
  archetype: string | null,
  sprite: string | null,
): string | null => {
  if (kind === 'hero' && archetype) return `${ASSETS_BASE}/heroes/${archetype}/south.png`;
  if (kind === 'monster' && sprite) return `${ASSETS_BASE}/monsters/${sprite}/south.png`;
  return null;
};

/**
 * Resolve each combatant's badge anchor. Uses the supplied `positions` map
 * where present; any combatant without an explicit position is laid out in
 * an evenly spaced fallback row at mid-height (so the overlay never collapses
 * to nothing when the live projection isn't available).
 */
const resolveAnchors = (
  order: ReadonlyArray<InitiativeRollEntry>,
  positions: BadgeAnchors | undefined,
): BadgeAnchor[] => {
  const n = order.length;
  return order.map((entry, i) => {
    const p = positions?.[entry.characterId];
    if (p) return p;
    // Fallback row: spread across the middle 64% of the stage.
    const x = n <= 1 ? 50 : 18 + (64 * i) / (n - 1);
    return { x, y: 50 };
  });
};

/**
 * A single combatant's callout badge — portrait coin + turn-order rank,
 * anchored (bottom-tail) over its die at `anchor`.
 *
 * The top three slots additionally carry a `--rank1/2/3` podium modifier
 * that scales the badge up (1st biggest) so the head of the order reads at
 * a glance off the dice; 4th and beyond stay at the base size.
 */
const badgeTpl = (
  entry: InitiativeRollEntry,
  rank: number,
  anchor: BadgeAnchor,
): TemplateResult => {
  const bg = avatarUrl(entry.kind, entry.archetype, entry.sprite);
  const podium = rank <= 3 ? ` battle-order-badge--rank${rank}` : '';
  const classes = `battle-order-badge battle-order-badge--${entry.kind}${podium}`;
  const style = `left: ${anchor.x}%; top: ${anchor.y}%`;
  return html`
    <div
      class=${classes}
      style=${style}
      role="listitem"
      aria-label=${`${ordinal(rank)} ${entry.name}`}
    >
      <div class="battle-order-badge-body">
        ${bg
          ? html`<span
              class="battle-order-badge-avatar"
              role="img"
              aria-label=${entry.name}
              style="background-image: url('${bg}')"
            ></span>`
          : html`<span class="battle-order-badge-avatar battle-order-badge-avatar--placeholder" aria-hidden="true"></span>`}
        <span class="battle-order-badge-rank">${ordinal(rank)}</span>
      </div>
      <span class="battle-order-badge-tail" aria-hidden="true"></span>
    </div>
  `;
};

/**
 * Render the reveal. Returns an empty template when there is no summary (or
 * no combatants) so the slot collapses cleanly.
 *
 * @param positions  characterId → die screen anchor (PERCENT of the stage).
 *                   Optional — omitted callers get the fallback row layout.
 *
 * `dismissing` adds the `.is-dismissing` modifier so the CSS fade-out kicks
 * in; while false the overlay holds at opacity 1 after its fade-in.
 *
 * `keyed(summary.t, …)` makes a second combat in the same session tear down
 * the previous DOM tree and replay the fade-in from frame 0.
 */
export const battleOrderReveal = (
  summary: InitiativeSummary | null,
  dismissing: boolean = false,
  positions?: BadgeAnchors,
): TemplateResult => {
  if (!summary) return html``;
  const order = summary.order;
  if (order.length === 0) return html``;
  const classes = dismissing
    ? 'battle-order-reveal is-dismissing'
    : 'battle-order-reveal';
  const anchors = resolveAnchors(order, positions);
  return html`${keyed(
    summary.t,
    html`
      <div
        class=${classes}
        role="list"
        aria-live="polite"
        aria-label="Order of battle"
        data-reveal-t=${summary.t}
      >
        ${order.map((entry, i) => badgeTpl(entry, i + 1, anchors[i]!))}
      </div>
    `,
  )}`;
};

/** Total on-screen lifetime of the reveal in AUTO-SKIP mode, in ms.
 *
 *  Sequence (auto mode):
 *       0 –  300ms  overlay fades in (opacity 0 → 1)
 *     300 – 2600ms  hold (player reads the order)
 *    2600 – 3000ms  overlay fades out (opacity 1 → 0)
 *
 *  In MANUAL mode (the default) the overlay mounts with the same fade-in
 *  but then holds at opacity 1 indefinitely — Layout waits for the Skip
 *  click before applying the `.is-dismissing` modifier that triggers
 *  the fade-out. The matching CSS keyframes in `main.css` must stay in
 *  sync — search for `--- "Order of Battle" reveal`. */
export const BATTLE_ORDER_REVEAL_MS = 3000;

/** Duration of the closing fade-out triggered by Skip / auto-dismiss.
 *  Matches the CSS `battle-order-fade-out` keyframe length. */
export const BATTLE_ORDER_REVEAL_FADE_OUT_MS = 400;
