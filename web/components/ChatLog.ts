import { html, type TemplateResult } from 'lit-html';
import type { ChatEntry } from '../store.js';
import { markdownInline } from './markdown.js';

export type ActorKind = 'hero' | 'monster' | 'dm';
export interface ActorInfo {
  name: string;
  kind: ActorKind;
  /** Hero archetype (warrior | hunter | healer | warlock) for per-hero color. */
  archetype?: string;
}
export type ActorMap = ReadonlyMap<string, ActorInfo>;

export const chatLog = (
  chat: ChatEntry[],
  actors: ActorMap,
): TemplateResult => html`
  <div class="chat">
    ${chat.map((c) => {
      const tpl = formatEntry(c, actors);
      return tpl === '' ? '' : html`<div>${tpl}</div>`;
    })}
  </div>
`;

interface PosLike { x: number; y: number }

interface AnyEvent {
  type?: string;
  actorId?: string;
  /** Recipient on `dm_ooc_reply` events — the player who originally asked. */
  toActorId?: string;
  targetId?: string;
  text?: string;
  sceneId?: string;
  outcome?: string;
  forced?: string;
  heroSide?: unknown[];
  monsterSide?: unknown[];
  rolls?: {
    hero?: Record<string, unknown>;
    monster?: Record<string, unknown>;
  };
  order?: unknown[];
  changes?: Array<{ id: string; damage?: number; status?: string; pos?: PosLike }>;
  action?: {
    kind?: string;
    text?: string;
    targetId?: string;
    targetIds?: string[];
    monsterTypeId?: string;
    characterId?: string;
    pos?: PosLike;
    path?: PosLike[];
    to?: PosLike;
    itemId?: string;
    boonId?: string;
  };
  violation?: { reason?: string };
}

/** Small subdued tag rendered next to a chat speaker's name (e.g. "[to DM]"). */
const targetTag = (label: string): TemplateResult =>
  html`<span class="chat-target-tag">[${label}]</span>`;

const fmtPos = (p?: PosLike): string => (p ? `(${p.x},${p.y})` : '');

/**
 * Wrap an actor name in a coloured/bold span keyed off its kind.
 * Heroes are blue, monsters red, DM grey; unknown ids fall back to a plain
 * span so the raw id still renders (matching the old string-based behaviour).
 */
const nameTpl = (id: string | undefined, actors: ActorMap): TemplateResult => {
  if (id === undefined) return html`<span></span>`;
  const info = actors.get(id);
  if (!info) return html`<span>${id}</span>`;
  if (info.kind === 'hero') {
    const arch = info.archetype ?? '';
    const cls = `hero ${arch}`.trim();
    return html`<span class=${cls}>${info.name}</span>`;
  }
  if (info.kind === 'monster') return html`<span class="enemy">${info.name}</span>`;
  return html`<span class="dm-actor">${info.name}</span>`;
};

type Formatted = TemplateResult | string;

const formatStateChange = (e: AnyEvent, actors: ActorMap): Formatted => {
  const parts = (e.changes ?? []).map((ch) => {
    const bits: string[] = [];
    if (ch.damage !== undefined) bits.push(`dmg=${ch.damage}`);
    if (ch.status !== undefined) bits.push(`status=${ch.status}`);
    if (ch.pos !== undefined)    bits.push(`pos=${fmtPos(ch.pos)}`);
    return html`${nameTpl(ch.id, actors)}: ${bits.join(' ')}`;
  });
  // Interleave with "; " separators between adjacent change entries.
  const separated: Array<TemplateResult | string> = [];
  parts.forEach((p, i) => {
    if (i > 0) separated.push('; ');
    separated.push(p);
  });
  return html`🩹 ${separated}`;
};

const formatAction = (e: AnyEvent, actors: ActorMap): Formatted => {
  const a = e.action ?? {};
  const actorId = e.actorId;
  const actorIsDm = actorId === 'dm';
  switch (a.kind) {
    case 'say':
      if (actorIsDm) {
        return html`💬 ${nameTpl(actorId, actors)}: <em class="dm-text">${markdownInline(a.text ?? '')}</em>`;
      }
      return html`💬 ${nameTpl(actorId, actors)}: ${markdownInline(a.text ?? '')}`;
    case 'skip_turn':
      return html`⏭ ${nameTpl(actorId, actors)} skips turn`;
    case 'end_turn':
      return '';
    case 'move': {
      const dest = a.path && a.path.length > 0 ? a.path[a.path.length - 1] : a.to;
      return html`👣 ${nameTpl(actorId, actors)} moves to ${fmtPos(dest)}`;
    }
    case 'normal_attack':
      return html`⚔ ${nameTpl(actorId, actors)} attacks ${nameTpl(a.targetId, actors)}`;
    case 'special_action': {
      if (a.targetIds && a.targetIds.length > 0) {
        const targetTpls: Array<TemplateResult | string> = [];
        a.targetIds.forEach((t, i) => {
          if (i > 0) targetTpls.push(', ');
          targetTpls.push(nameTpl(t, actors));
        });
        return html`✨ ${nameTpl(actorId, actors)} uses special action → ${targetTpls}`;
      }
      return html`✨ ${nameTpl(actorId, actors)} uses special action`;
    }
    case 'use_item':
      return a.targetId
        ? html`🧪 ${nameTpl(actorId, actors)} uses item ${a.itemId ?? ''} on ${nameTpl(a.targetId, actors)}`
        : html`🧪 ${nameTpl(actorId, actors)} uses item ${a.itemId ?? ''}`;
    case 'use_boon':
      return a.targetId
        ? html`🌟 ${nameTpl(actorId, actors)} uses boon ${a.boonId ?? ''} on ${nameTpl(a.targetId, actors)}`
        : html`🌟 ${nameTpl(actorId, actors)} uses boon ${a.boonId ?? ''}`;
    case 'ability_test':
      return html`🎯 ${nameTpl(actorId, actors)} attempts an ability test`;
    case 'reveal_monster': {
      // If we have a characterId mapped to a friendly name, render the styled
      // span; otherwise fall back to the raw monsterTypeId string so the line
      // still identifies the spawn (e.g. "giant-rat at (7,1)").
      const hasName = a.characterId !== undefined && actors.has(a.characterId);
      const subject = hasName
        ? nameTpl(a.characterId, actors)
        : (a.monsterTypeId ?? a.characterId ?? '');
      return html`👁 reveals ${subject} at ${fmtPos(a.pos)}`;
    }
    case 'set_scene':
      return `🎬 sets scene`;
    case 'start_combat':
      return `⚔ combat begins`;
    case 'end_combat':
      return `🛡 combat ends`;
    case 'request_action':
      return '';
    case 'narrate':
      if (actorIsDm) {
        return html`📖 <em class="dm-text">${markdownInline(a.text ?? '')}</em>`;
      }
      return html`📖 ${markdownInline(a.text ?? '')}`;
    case 'environmental':
      return `🌪 environmental effect`;
    case 'offer_rest':
      return `🛌 offers rest`;
    case 'end_adventure':
      return `🏁 adventure ends`;
    default:
      return html`· ${nameTpl(actorId, actors)} ${a.kind ?? 'action'}`;
  }
};

const formatEntry = (c: ChatEntry, actors: ActorMap): Formatted => {
  const e = c.event as AnyEvent;
  const actorIsDm = e.actorId === 'dm';

  switch (e.type) {
    case 'narration':  // legacy alias seen in tests
    case 'narrate':
      // DM narration is italicised so it reads as in-fiction prose.
      if (actorIsDm || e.actorId === undefined) {
        return html`📖 <em class="dm-text">${markdownInline(e.text ?? '')}</em>`;
      }
      return html`📖 ${markdownInline(e.text ?? '')}`;
    case 'action':
      return formatAction(e, actors);
    case 'resolution':
      return html`🎲 ${nameTpl(e.actorId, actors)}`;
    case 'rule_violation':
      return e.violation?.reason
        ? html`⚠️ ${nameTpl(e.actorId, actors)}: rule violation (${e.violation.reason})`
        : html`⚠️ ${nameTpl(e.actorId, actors)}: rule violation`;
    case 'state_change':
      return formatStateChange(e, actors);
    case 'scene_enter':
      return `🎬 enters scene ${e.sceneId ?? ''}`;
    case 'request_action':
      return '';
    case 'human_input':
      // The default in-character flow — tag it [to Game] so it visually
      // distinguishes from the out-of-character pair below.
      return html`💭 ${nameTpl(e.actorId, actors)} ${targetTag('to Game')}: ${markdownInline(e.text ?? '')}`;
    case 'player_ooc_query':
      return html`💭 ${nameTpl(e.actorId, actors)} ${targetTag('to DM')}: ${markdownInline(e.text ?? '')}`;
    case 'dm_ooc_reply':
      // The DM replies as themselves but inline-tag the recipient so it's
      // clear this isn't broadcast narration.
      return html`💬 <span class="dm-actor">DM</span> ${targetTag(`to ${(actors.get(e.toActorId ?? '')?.name) ?? e.toActorId ?? ''}`.trim())}: <em class="dm-text">${markdownInline(e.text ?? '')}</em>`;
    case 'combat_started': {
      const heroTpls: Array<TemplateResult | string> = [];
      (e.heroSide ?? []).forEach((h, i) => {
        if (i > 0) heroTpls.push(', ');
        heroTpls.push(nameTpl(String(h), actors));
      });
      const monsterTpls: Array<TemplateResult | string> = [];
      (e.monsterSide ?? []).forEach((m, i) => {
        if (i > 0) monsterTpls.push(', ');
        monsterTpls.push(nameTpl(String(m), actors));
      });
      // Per-character initiative drives the interleaved order; the
      // InitiativePanel + EventLog drawer surface the full chain. The chat
      // line stays minimal — just the rosters.
      return html`⚔ combat begins (heroes: ${heroTpls}; monsters: ${monsterTpls})`;
    }
    case 'combat_ended':
      return `🛡 combat ends`;
    case 'rest_offered':
      return `🛌 rest offered`;
    case 'step_budget_exhausted':
      return '';
    case 'adventure_ended':
      return `🏁 adventure ended (${e.outcome ?? ''})`;
    case 'thought':
      // LLM thoughts are private — intentionally render nothing.
      return '';
    default:
      // Short labelled fallback — never dump full JSON, which bloats the log.
      return `· ${e.type ?? 'event'}`;
  }
};
