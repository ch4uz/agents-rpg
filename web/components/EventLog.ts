import { html, type TemplateResult } from 'lit-html';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import type { ChatEntry } from '../store.js';
import { displayName } from './names.js';
import { markdownInline } from './markdown.js';

const ASSETS_BASE = '/assets';

export type Avatar =
  | { kind: 'hero'; archetype: string }
  | { kind: 'monster'; sprite: string }
  | { kind: 'dm' }
  | { kind: 'unknown' };

export interface SayEntry {
  t: number;
  kind: 'say';
  actorId: string;
  actorName: string;
  avatar: Avatar;
  text: string;
}

export interface AttackEntry {
  t: number;
  kind: 'attack';
  actorId: string;
  actorName: string;
  avatar: Avatar;
  targetName: string;
  hit: boolean;
  damage: number;
  attackKind: 'melee' | 'ranged' | 'magic' | 'special';
}

export interface NarrateEntry {
  t: number;
  kind: 'narrate';
  avatar: Avatar;
  text: string;
}

export interface InitiativeRoll {
  characterId: string;
  name: string;
  archetype: string | null;
  sprite: string | null;
  kind: 'hero' | 'monster';
  d6: number;
  dex: number;
  total: number;
}

export interface InitiativeEntry {
  t: number;
  kind: 'initiative';
  avatar: Avatar;
  /** Combined turn order, sorted by total descending; heroes break ties. */
  order: InitiativeRoll[];
}

export interface EmoteEntry {
  t: number;
  kind: 'emote';
  actorId: string;
  actorName: string;
  avatar: Avatar;
  emoji: string;
}

export type EventLogEntry =
  | SayEntry
  | AttackEntry
  | NarrateEntry
  | InitiativeEntry
  | EmoteEntry;

interface AnyEvent {
  t?: number;
  type?: string;
  actorId?: string;
  text?: string;
  action?: { kind?: string; text?: string; emoji?: string; targetId?: string };
  public?: {
    hit?: boolean;
    damage?: number;
    targetId?: string;
    attackKind?: string;
  };
  rolls?: {
    hero?: Record<string, unknown>;
    monster?: Record<string, unknown>;
  };
  order?: unknown[];
}

const avatarFor = (c: RedactedCharacter | undefined): Avatar => {
  if (!c) return { kind: 'unknown' };
  if (c.kind === 'hero' && typeof c.archetype === 'string' && c.archetype.length > 0) {
    return { kind: 'hero', archetype: c.archetype };
  }
  if (c.kind === 'monster') {
    return { kind: 'monster', sprite: c.sprite ?? c.name };
  }
  return { kind: 'unknown' };
};

/**
 * Pure: walk the entire chat in order and emit one entry per
 *   - hero `say` action (heroes only — DM and monsters are filtered out)
 *   - attack `resolution` event with public.hit/damage (any kind of attacker;
 *     monster-on-hero hits are interesting too).
 *
 * Resolutions are paired with the immediately preceding action by the same
 * actor so we can tag the attack kind (special vs normal). Unknown actors are
 * skipped — they'd produce orphan rows.
 */
export const selectEventLog = (
  chat: ReadonlyArray<ChatEntry>,
  characters: ReadonlyArray<RedactedCharacter>,
): EventLogEntry[] => {
  const charById = new Map<string, RedactedCharacter>();
  for (const c of characters) charById.set(String(c.id), c);

  const out: EventLogEntry[] = [];
  for (let i = 0; i < chat.length; i++) {
    const e = chat[i]!.event as AnyEvent;
    const t = typeof e.t === 'number' ? e.t : i;

    // DM narration — `type: 'narrate'` with top-level text, or
    // `type: 'action', actorId: 'dm', action.kind: 'narrate'` with action.text.
    // Matches the rules in NarratorWindow.selectLatestNarration so the event log
    // surfaces the same narration the narrator window already shows.
    if (e.type === 'narrate' && typeof e.text === 'string' && e.text.length > 0) {
      out.push({ t, kind: 'narrate', avatar: { kind: 'dm' }, text: e.text });
      continue;
    }
    if (e.type === 'action' && e.actorId === 'dm' && e.action?.kind === 'narrate'
        && typeof e.action.text === 'string' && e.action.text.length > 0) {
      out.push({ t, kind: 'narrate', avatar: { kind: 'dm' }, text: e.action.text });
      continue;
    }

    if (e.type === 'action' && e.action?.kind === 'say'
        && typeof e.actorId === 'string'
        && typeof e.action.text === 'string') {
      const actor = charById.get(e.actorId);
      if (!actor || actor.kind !== 'hero') continue;
      out.push({
        t,
        kind: 'say',
        actorId: e.actorId,
        actorName: displayName(actor.name),
        avatar: avatarFor(actor),
        text: e.action.text,
      });
      continue;
    }

    // Hero emote — a single emoji reaction. Surfaced as a compact, ambient
    // line so it accumulates in scrollback for later analysis, but the
    // floating balloon on the board is the primary surface.
    if (e.type === 'action' && e.action?.kind === 'emote'
        && typeof e.actorId === 'string'
        && typeof e.action.emoji === 'string'
        && e.action.emoji.length > 0) {
      const actor = charById.get(e.actorId);
      if (!actor || actor.kind !== 'hero') continue;
      out.push({
        t,
        kind: 'emote',
        actorId: e.actorId,
        actorName: displayName(actor.name),
        avatar: avatarFor(actor),
        emoji: e.action.emoji,
      });
      continue;
    }

    if (e.type === 'combat_started' && e.rolls?.hero && e.rolls?.monster) {
      const isRoll = (v: unknown): v is { d6: number; dex: number; total: number } =>
        typeof v === 'object'
        && v !== null
        && typeof (v as { d6?: unknown }).d6 === 'number'
        && typeof (v as { dex?: unknown }).dex === 'number'
        && typeof (v as { total?: unknown }).total === 'number';
      const build = (id: string, val: { d6: number; dex: number; total: number }, kind: 'hero' | 'monster'): InitiativeRoll => {
        const c = charById.get(id);
        return {
          characterId: id,
          name: c ? displayName(c.name) : displayName(id),
          archetype: c?.archetype ?? null,
          sprite: c?.sprite ?? null,
          kind,
          d6: val.d6,
          dex: val.dex,
          total: val.total,
        };
      };
      const heroes: InitiativeRoll[] = [];
      const monsters: InitiativeRoll[] = [];
      for (const [id, val] of Object.entries(e.rolls.hero)) {
        if (!isRoll(val)) continue;
        heroes.push(build(id, val, 'hero'));
      }
      for (const [id, val] of Object.entries(e.rolls.monster)) {
        if (!isRoll(val)) continue;
        monsters.push(build(id, val, 'monster'));
      }
      if (heroes.length === 0 && monsters.length === 0) {
        continue;
      }
      // Sort combined order by total desc, heroes break ties.
      const byCharId = new Map<string, InitiativeRoll>();
      for (const r of [...heroes, ...monsters]) byCharId.set(r.characterId, r);
      const eventOrder = Array.isArray(e.order) ? e.order.map(String) : null;
      const order: InitiativeRoll[] =
        eventOrder && eventOrder.every((id) => byCharId.has(id))
          ? eventOrder.map((id) => byCharId.get(id)!)
          : [...heroes, ...monsters].sort((a, b) => {
              if (b.total !== a.total) return b.total - a.total;
              if (a.kind !== b.kind) return a.kind === 'hero' ? -1 : 1;
              return 0;
            });
      out.push({
        t,
        kind: 'initiative',
        avatar: { kind: 'dm' },
        order,
      });
      continue;
    }

    if (e.type === 'resolution' && e.public
        && typeof e.public.hit === 'boolean'
        && typeof e.public.damage === 'number'
        && typeof e.actorId === 'string'
        && typeof e.public.targetId === 'string') {
      const actor = charById.get(e.actorId);
      const target = charById.get(e.public.targetId);
      if (!actor || !target) continue;
      let attackKind: AttackEntry['attackKind'] = 'melee';
      const rawKind = e.public.attackKind;
      if (rawKind === 'melee' || rawKind === 'ranged' || rawKind === 'magic') {
        attackKind = rawKind;
      }
      for (let j = i - 1; j >= 0; j--) {
        const prev = chat[j]!.event as AnyEvent;
        if (prev.type === 'action' && prev.actorId === e.actorId) {
          if (prev.action?.kind === 'special_action') attackKind = 'special';
          break;
        }
      }
      out.push({
        t,
        kind: 'attack',
        actorId: e.actorId,
        actorName: displayName(actor.name),
        avatar: avatarFor(actor),
        targetName: displayName(target.name),
        hit: e.public.hit,
        damage: e.public.damage,
        attackKind,
      });
    }
  }
  return out;
};

const ATTACK_VERB: Record<AttackEntry['attackKind'], string> = {
  melee: 'attacks',
  ranged: 'shoots',
  magic: 'blasts',
  special: 'unleashes a special on',
};

const avatarBackground = (a: Avatar): string | null => {
  if (a.kind === 'hero') return `${ASSETS_BASE}/heroes/${a.archetype}/south.png`;
  if (a.kind === 'monster') return `${ASSETS_BASE}/monsters/${a.sprite}/south.png`;
  return null;
};

const avatarSpan = (entry: EventLogEntry): TemplateResult => {
  if (entry.kind === 'initiative') {
    return html`<span class="event-avatar event-avatar-initiative" role="img" aria-label="Initiative">⚔️</span>`;
  }
  if (entry.avatar.kind === 'dm') {
    return html`<span class="event-avatar event-avatar-dm" role="img" aria-label="DM">📖</span>`;
  }
  const bg = avatarBackground(entry.avatar);
  if (!bg) {
    return html`<span class="event-avatar event-avatar-placeholder" aria-hidden="true"></span>`;
  }
  const cls = entry.avatar.kind === 'monster'
    ? 'event-avatar event-avatar-monster'
    : 'event-avatar';
  const label = entry.kind === 'narrate' ? 'DM' : entry.actorName;
  return html`<span
    class=${cls}
    role="img"
    aria-label=${label}
    style="background-image: url('${bg}')"
  ></span>`;
};

const bodyFor = (entry: EventLogEntry): TemplateResult => {
  if (entry.kind === 'initiative') {
    const fmtDex = (dex: number): string =>
      dex === 0 ? '' : dex > 0 ? ` +${dex}` : ` ${dex}`;
    return html`<span class="event-body">
      <span class="event-actor">Turn order</span>
      <span class="event-sep">—</span>
      ${entry.order.map((r, i) => html`${i > 0 ? html`<span class="event-sep">→</span>` : ''}<span class=${`event-initiative-roll event-initiative-roll--${r.kind}`}>${r.name} 🎲${r.d6}${fmtDex(r.dex)} = ${r.total}</span>`)}
    </span>`;
  }
  if (entry.kind === 'narrate') {
    return html`<span class="event-body">
      <span class="event-narrate">${markdownInline(entry.text)}</span>
    </span>`;
  }
  if (entry.kind === 'say') {
    return html`<span class="event-body">
      <span class="event-actor">${entry.actorName}</span>
      <span class="event-says">says:</span>
      <span class="event-quote">${markdownInline(entry.text)}</span>
    </span>`;
  }
  if (entry.kind === 'emote') {
    return html`<span class="event-body">
      <span class="event-actor">${entry.actorName}</span>
      <span class="event-emote-glyph">${entry.emoji}</span>
    </span>`;
  }
  const verb = ATTACK_VERB[entry.attackKind];
  const outcome = entry.hit
    ? html`<span class="event-damage">${entry.damage}&nbsp;damage</span>`
    : html`<span class="event-miss">miss</span>`;
  return html`<span class="event-body">
    <span class="event-actor">${entry.actorName}</span>
    <span class="event-verb">${verb}</span>
    <span class="event-target">${entry.targetName}</span>
    <span class="event-sep">—</span>
    ${outcome}
  </span>`;
};

/**
 * Vertical scrolling panel rendered to the right of the board. Each entry is
 * `<avatar> <body>`. Layout owns the auto-scroll-to-bottom after mount.
 */
export const eventLog = (entries: ReadonlyArray<EventLogEntry>): TemplateResult => html`
  <aside class="event-log" role="log" aria-live="polite" aria-label="Event log">
    <header class="event-log-header">Log</header>
    <div class="event-log-scroll">
      ${entries.length === 0
        ? html`<div class="event-log-empty">No events yet.</div>`
        : entries.map((entry) => html`
            <div class=${`event-line event-line--${entry.kind}`}>
              ${avatarSpan(entry)}
              ${bodyFor(entry)}
            </div>
          `)}
    </div>
  </aside>
`;
