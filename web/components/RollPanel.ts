import { html, type TemplateResult } from 'lit-html';
import { keyed } from 'lit-html/directives/keyed.js';
import type { ChatEntry } from '../store.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { displayName } from './names.js';

export type AttackKind = 'melee' | 'ranged' | 'magic';

const ASSETS_BASE = '/assets';

/**
 * Public roll arrays from the underlying resolution event, when not stripped
 * by visibility filtering. The 3D overlay uses these to land each die on its
 * actual face; when absent, it falls back to filler dice ≤ top deterministic
 * per `t`.
 */
export interface RollArrays {
  attack: ReadonlyArray<number> | null;
  armor: ReadonlyArray<number> | null;
}

export interface RollSummary {
  /** Logical step counter of the resolution event — unique per roll, used as
   *  the lit-html key so a new roll always gets a fresh DOM node and the CSS
   *  show/fade animation restarts from frame 0. */
  t: number;
  attackerName: string;
  attackerArchetype: string | null;
  attackerSprite: string | null;
  attackerKind: 'hero' | 'monster' | 'npc' | 'dm';
  targetName: string;
  targetArchetype: string | null;
  targetSprite: string | null;
  targetKind: 'hero' | 'monster' | 'npc' | 'dm';
  attackKind: AttackKind;
  attackerPool: number;
  attackerTop: number;
  defenderArmorPool: number;
  defenderTop: number;
  hit: boolean;
  damage: number;
  /** When the action that produced this roll was a special action, its name. */
  specialName: string | null;
  /** Actual roll arrays, when present. The 3D overlay reads these to land
   *  each die on its real face. Optional so legacy fixtures predating the
   *  3D overlay still construct a valid RollSummary. */
  rolls?: RollArrays;
}

interface AnyEvent {
  t?: number;
  type?: string;
  actorId?: string;
  public?: {
    hit?: boolean;
    damage?: number;
    attackerTop?: number;
    defenderTop?: number;
    targetId?: string;
  };
  private?: {
    attackRoll?: number[];
    armorRoll?: number[];
  };
  action?: { kind?: string };
}

const ATTACK_KINDS: AttackKind[] = ['melee', 'ranged', 'magic'];

/**
 * Pure: pick the actor's dominant attack pool. HeroKids characters are
 * specced around a single attack stat (warrior=melee, hunter=ranged,
 * warlock/healer=magic, rats=melee), so the largest of melee/ranged/magic
 * is always the kind their normalAttack uses. Ties prefer melee.
 */
const dominantAttackKind = (pools: { melee: number; ranged: number; magic: number }): AttackKind => {
  let best: AttackKind = 'melee';
  for (const k of ATTACK_KINDS) {
    if (pools[k] > pools[best]) best = k;
  }
  return best;
};

/**
 * Pure: build a RollSummary for the `resolution` event at chat index `idx`,
 * or return null if that index isn't a valid resolution. Looks backwards from
 * the resolution to find the action that produced it (special_action vs
 * normal_attack). Used by the playback queue in Layout.ts to feed each
 * resolution event into the dice panel in chat order.
 */
export const rollSummaryAt = (
  chat: ReadonlyArray<ChatEntry>,
  idx: number,
  characters: ReadonlyArray<RedactedCharacter>,
): RollSummary | null => {
  if (idx < 0 || idx >= chat.length) return null;
  const e = chat[idx]!.event as AnyEvent;
  if (e.type !== 'resolution') return null;
  const pub = e.public;
  if (!pub
    || typeof pub.attackerTop !== 'number'
    || typeof pub.defenderTop !== 'number'
    || typeof pub.hit !== 'boolean'
    || typeof pub.damage !== 'number') return null;

  const actorId = e.actorId;
  const targetId = pub.targetId;
  if (!actorId || !targetId) return null;
  const actor  = characters.find((c) => String(c.id) === actorId);
  const target = characters.find((c) => String(c.id) === targetId);
  if (!actor || !target) return null;

  let specialName: string | null = null;
  for (let j = idx - 1; j >= 0; j--) {
    const a = chat[j]!.event as AnyEvent;
    if (a.type === 'action' && a.actorId === actorId) {
      if (a.action?.kind === 'special_action') {
        specialName = actor.specialAction?.name ?? 'Special';
      }
      break;
    }
  }

  const ak = dominantAttackKind(actor.pools);
  return {
    t: typeof e.t === 'number' ? e.t : idx,
    attackerName: displayName(actor.name),
    attackerArchetype: actor.archetype ?? null,
    attackerSprite: actor.sprite ?? null,
    attackerKind: actor.kind,
    targetName: displayName(target.name),
    targetArchetype: target.archetype ?? null,
    targetSprite: target.sprite ?? null,
    targetKind: target.kind,
    attackKind: ak,
    attackerPool: actor.pools[ak],
    attackerTop: pub.attackerTop,
    defenderArmorPool: target.pools.armor,
    defenderTop: pub.defenderTop,
    hit: pub.hit,
    damage: pub.damage,
    specialName,
    rolls: {
      attack: Array.isArray(e.private?.attackRoll) ? e.private!.attackRoll : null,
      armor:  Array.isArray(e.private?.armorRoll)  ? e.private!.armorRoll  : null,
    },
  };
};

/**
 * Pure: walk the chat backward to find the most recent `resolution` event,
 * then walk further back from THAT event to find the action that produced it
 * (so we can detect whether the actor used a special_action vs a
 * normal_attack). Returns null when no resolution has fired yet, or when the
 * event references actors that aren't in the snapshot (defensive).
 */
export const latestRoll = (
  chat: ReadonlyArray<ChatEntry>,
  characters: ReadonlyArray<RedactedCharacter>,
): RollSummary | null => {
  for (let i = chat.length - 1; i >= 0; i--) {
    const r = rollSummaryAt(chat, i, characters);
    if (r) return r;
  }
  return null;
};

/**
 * Resolve an entity's portrait URL. Heroes go through `heroes/<archetype>`,
 * monsters through `monsters/<sprite>`. Returns null when neither is known
 * (e.g. DM-only resolutions, malformed snapshots) — caller renders a
 * placeholder portrait instead.
 */
const avatarUrl = (
  kind: 'hero' | 'monster' | 'npc' | 'dm',
  archetype: string | null,
  sprite: string | null,
): string | null => {
  if (kind === 'hero' && archetype) return `${ASSETS_BASE}/heroes/${archetype}/south.png`;
  if (kind === 'monster' && sprite) return `${ASSETS_BASE}/monsters/${sprite}/south.png`;
  if (kind === 'npc' && sprite) return `${ASSETS_BASE}/npcs/${sprite}/south.png`;
  return null;
};

/**
 * Portrait frame for one side of the duel. Square avatar (or placeholder),
 * name underneath. Hero gets archetype color via `data-archetype`, monsters
 * get an enemy-tinted nameplate.
 */
const portrait = (
  side: 'attacker' | 'defender',
  name: string,
  kind: 'hero' | 'monster' | 'npc' | 'dm',
  archetype: string | null,
  sprite: string | null,
): TemplateResult => {
  const bg = avatarUrl(kind, archetype, sprite);
  const nameClass = kind === 'hero' ? 'roll-side-name roll-side-name--hero'
                  : kind === 'monster' || kind === 'npc' ? 'roll-side-name roll-side-name--enemy'
                  : 'roll-side-name roll-side-name--dm';
  return html`
    <div class=${`roll-side-portrait roll-side-portrait--${side}`}>
      ${bg
        ? html`<span
            class=${`roll-avatar roll-avatar--${kind}`}
            role="img"
            aria-label=${name}
            style="background-image: url('${bg}')"
          ></span>`
        : html`<span class="roll-avatar roll-avatar--placeholder" aria-hidden="true"></span>`}
      <span
        class=${nameClass}
        ?data-archetype=${archetype !== null}
        data-archetype-value=${archetype ?? ''}
      >${name}</span>
    </div>
  `;
};

/**
 * Renders the framed roll-panel below the narrator. Legacy 2D variant kept
 * only for the unit-test fixture in `tests/web/roll-panel.test.ts`; the
 * live UI renders dice through `Dice3DOverlay` + `DiceHUD` instead and does
 * not call this function.
 *
 * When `roll` is null, returns an empty template so the panel doesn't take
 * any layout space.
 *
 * Wrapped in lit-html's `keyed` directive on `roll.t` so a new resolution
 * tears down the old DOM node and mounts a fresh one. That guarantees the
 * CSS show/fade animation restarts from frame 0 every time.
 */
export const rollPanel = (roll: RollSummary | null): TemplateResult => {
  if (!roll) return html``;
  return keyed(roll.t, html`
    <div class="roll-panel roll-panel--3d" role="status" aria-live="polite" data-roll-t=${roll.t}>
      <div class="roll-arena">
        <div class="roll-side roll-side--attacker">
          ${portrait('attacker', roll.attackerName, roll.attackerKind, roll.attackerArchetype, roll.attackerSprite)}
        </div>
        <div class="roll-vs" aria-hidden="true">
          <span class="roll-vs-text">VS</span>
        </div>
        <div class="roll-side roll-side--defender">
          ${portrait('defender', roll.targetName, roll.targetKind, roll.targetArchetype, roll.targetSprite)}
        </div>
      </div>
      <div class=${`roll-line roll-result ${roll.hit ? 'hit' : 'miss'}`}>
        <span class="roll-verdict">${roll.hit ? 'HIT' : 'MISS'}</span>
        ${roll.hit && roll.damage > 0
          ? html`<span class="roll-damage">${roll.damage}&nbsp;damage</span>`
          : ''}
      </div>
    </div>
  `) as TemplateResult;
};
