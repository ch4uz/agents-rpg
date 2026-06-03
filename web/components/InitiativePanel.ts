import { html, type TemplateResult } from 'lit-html';
import { keyed } from 'lit-html/directives/keyed.js';
import type { ChatEntry } from '../store.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { displayName } from './names.js';

const ASSETS_BASE = '/assets';

/**
 * Total visible time for the initiative panel. Longer than the attack-roll
 * panel (5000ms) because there's more to read — every combatant's d6 + DEX
 * + total plus the full interleaved turn-order chain. The matching
 * `animation-duration` override on `.roll-panel--initiative` in main.css
 * keeps the CSS `roll-show` entrance/hold/fade aligned with this window.
 * Consumed by Layout.ts (QUEUE_MIN_MS.initiative).
 */
export const INITIATIVE_PANEL_MS = 4500;

/** One character's initiative result. */
export interface InitiativeRollEntry {
  characterId: string;
  name: string;
  archetype: string | null;
  sprite: string | null;
  kind: 'hero' | 'monster';
  d6: number;
  dex: number;
  total: number;
}

export interface InitiativeSummary {
  /** Logical step counter from the combat_started event — lit-html key so a
   *  new initiative roll always tears down the old DOM node and restarts the
   *  CSS show/spin/reveal animation from frame 0. */
  t: number;
  /** Heroes sorted by total descending — used for the left column. */
  heroes: InitiativeRollEntry[];
  /** Monsters sorted by total descending — used for the right column. */
  monsters: InitiativeRollEntry[];
  /** Full combined turn order. order[0] acts first. Sort = total desc,
   *  heroes win ties, same-side ties keep declaration order. */
  order: InitiativeRollEntry[];
}

interface AnyEvent {
  t?: number;
  type?: string;
  heroSide?: unknown[];
  monsterSide?: unknown[];
  order?: unknown[];
  rolls?: {
    hero?: Record<string, unknown>;
    monster?: Record<string, unknown>;
  };
}

const isInitiativeRollObject = (
  v: unknown,
): v is { d6: number; dex: number; total: number } =>
  typeof v === 'object'
  && v !== null
  && typeof (v as { d6?: unknown }).d6 === 'number'
  && typeof (v as { dex?: unknown }).dex === 'number'
  && typeof (v as { total?: unknown }).total === 'number';

const buildEntry = (
  id: string,
  raw: { d6: number; dex: number; total: number },
  kind: 'hero' | 'monster',
  byId: Map<string, RedactedCharacter>,
): InitiativeRollEntry => {
  const c = byId.get(id);
  return {
    characterId: id,
    name: c ? displayName(c.name) : displayName(id),
    archetype: c?.archetype ?? null,
    sprite: c?.sprite ?? null,
    kind,
    d6: raw.d6,
    dex: raw.dex,
    total: raw.total,
  };
};

/**
 * Pure: build an InitiativeSummary from the `combat_started` event at chat
 * index `idx`, or null if that index isn't a usable initiative event. Expects
 * the engine's per-character roll shape `{ d6, dex, total }` keyed by
 * characterId on each side, and reuses the `order` array the engine already
 * computed (falling back to a local sort when the event predates it).
 */
export const initiativeSummaryAt = (
  chat: ReadonlyArray<ChatEntry>,
  idx: number,
  characters: ReadonlyArray<RedactedCharacter>,
): InitiativeSummary | null => {
  if (idx < 0 || idx >= chat.length) return null;
  const e = chat[idx]!.event as AnyEvent;
  if (e.type !== 'combat_started') return null;
  const heroRolls = e.rolls?.hero;
  const monsterRolls = e.rolls?.monster;
  if (!heroRolls || !monsterRolls
      || typeof heroRolls !== 'object'
      || typeof monsterRolls !== 'object') return null;

  const byId = new Map<string, RedactedCharacter>();
  for (const c of characters) byId.set(String(c.id), c);

  // Build entry lists per side in catalog/declaration order.
  const heroesRaw: InitiativeRollEntry[] = [];
  const monstersRaw: InitiativeRollEntry[] = [];
  for (const [id, val] of Object.entries(heroRolls)) {
    if (!isInitiativeRollObject(val)) continue;
    heroesRaw.push(buildEntry(id, val, 'hero', byId));
  }
  for (const [id, val] of Object.entries(monsterRolls)) {
    if (!isInitiativeRollObject(val)) continue;
    monstersRaw.push(buildEntry(id, val, 'monster', byId));
  }
  if (heroesRaw.length === 0 && monstersRaw.length === 0) return null;

  // Each side column shows entries sorted by total desc — best roll on top.
  const heroes = [...heroesRaw].sort((a, b) => b.total - a.total);
  const monsters = [...monstersRaw].sort((a, b) => b.total - a.total);

  // Combined turn order: prefer the engine-provided `order` array; fall back
  // to a local recomputation if absent (defensive — older events).
  const byCharId = new Map<string, InitiativeRollEntry>();
  for (const h of heroesRaw) byCharId.set(h.characterId, h);
  for (const m of monstersRaw) byCharId.set(m.characterId, m);

  let order: InitiativeRollEntry[];
  const eventOrder = Array.isArray(e.order) ? e.order.map(String) : null;
  if (eventOrder && eventOrder.every((id) => byCharId.has(id))) {
    order = eventOrder.map((id) => byCharId.get(id)!);
  } else {
    // Defensive fallback for events that predate the engine `order` field.
    // Mirror the engine rule: sort by the rolled d6 alone (highest first),
    // NOT by d6+dex total, and with no heroes-first bias — a stable sort
    // keeps declaration order on a tie.
    order = [...heroesRaw, ...monstersRaw].sort((a, b) => b.d6 - a.d6);
  }

  return {
    t: typeof e.t === 'number' ? e.t : idx,
    heroes,
    monsters,
    order,
  };
};

const avatarUrl = (
  kind: 'hero' | 'monster',
  archetype: string | null,
  sprite: string | null,
): string | null => {
  if (kind === 'hero' && archetype) return `${ASSETS_BASE}/heroes/${archetype}/south.png`;
  if (kind === 'monster' && sprite) return `${ASSETS_BASE}/monsters/${sprite}/south.png`;
  return null;
};

const formatDex = (dex: number): string => {
  if (dex === 0) return '';
  return dex > 0 ? ` +${dex}` : ` ${dex}`;
};

const entryRow = (entry: InitiativeRollEntry): TemplateResult => {
  const bg = avatarUrl(entry.kind, entry.archetype, entry.sprite);
  const nameClass = entry.kind === 'hero'
    ? 'roll-side-name roll-side-name--hero'
    : 'roll-side-name roll-side-name--enemy';
  return html`
    <div class=${`initiative-entry initiative-entry--${entry.kind}`}>
      ${bg
        ? html`<span
            class=${`roll-avatar roll-avatar--${entry.kind}`}
            role="img"
            aria-label=${entry.name}
            style="background-image: url('${bg}')"
          ></span>`
        : html`<span class="roll-avatar roll-avatar--placeholder" aria-hidden="true"></span>`}
      <span
        class=${nameClass}
        ?data-archetype=${entry.archetype !== null}
        data-archetype-value=${entry.archetype ?? ''}
      >${entry.name}</span>
      <span class="roll-die">
        <span class="roll-die-emoji" aria-hidden="true">🎲</span><span class="roll-die-number">${entry.d6}</span>
      </span>
      <span
        class="initiative-dex"
        ?data-dex-zero=${entry.dex === 0}
        aria-label=${`dex modifier ${entry.dex}`}
      >${formatDex(entry.dex)}</span>
      <span class="initiative-total" aria-label="total">= ${entry.total}</span>
    </div>
  `;
};

/**
 * Initiative panel rendered in the same slot as the regular dice roll panel
 * when combat starts. Each character gets their own d6 + DEX modifier and
 * each side's column is sorted by total descending.
 *
 * Returns an empty template when `summary` is null so the slot collapses.
 */
export const initiativePanel = (summary: InitiativeSummary | null): TemplateResult => {
  if (!summary) return html``;
  return keyed(summary.t, html`
    <div
      class="roll-panel roll-panel--initiative"
      role="status"
      aria-live="polite"
      data-roll-t=${summary.t}
    >
      <div class="initiative-header" aria-hidden="true">⚔ Initiative</div>
      <div class="roll-arena initiative-arena">
        <div class="roll-side initiative-side initiative-side--heroes" aria-label="Heroes">
          ${summary.heroes.map((h) => entryRow(h))}
        </div>
        <div class="roll-side initiative-side initiative-side--monsters" aria-label="Monsters">
          ${summary.monsters.map((m) => entryRow(m))}
        </div>
      </div>
    </div>
  `) as TemplateResult;
};
