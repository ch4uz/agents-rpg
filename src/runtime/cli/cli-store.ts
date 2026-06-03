import type { Event } from '../../log/events.js';
import type { Character } from '../../engine/character.js';
import type { Scene } from '../../engine/adventure.js';
import type { CharacterId } from '../../engine/ids.js';
import type { Grid } from '../../engine/grid.js';
import type { EmojiProp } from '../../engine/snapshot.js';
import type { ActorDisplay } from './glyphs.js';

export type DisplayFor = (id: CharacterId | 'dm') => ActorDisplay;

export interface CliSnapshot {
  scene: Scene | null;
  grid: Grid | null;
  characters: Character[];
  /** DM-summoned emoji props on the grid. Rendered in unoccupied cells. */
  props: EmojiProp[];
  activeActor: CharacterId | 'dm' | null;
  chat: ChatEntry[];
  /** True iff the human's seat is locked open for input. */
  inputUnlocked: boolean;
  ended: { outcome: 'success' | 'failure' | 'aborted' } | null;
}

export interface ChatEntry {
  t: number;
  who: string;            // "DM", actor name, or "system"
  emoji: string;          // emoji glyph for the actor
  color: string;          // Ink color for the actor
  /** Plain-text fallback. Always populated even when segments are present —
   *  used by snapshot tests and future replay tooling. */
  text: string;
  /** Optional styled segments. When present, the renderer uses these instead
   *  of `text` so individual words (e.g. HIT, MISS) can be coloured. */
  segments?: ChatSegment[];
  kind: 'narrate' | 'say' | 'action' | 'resolution' | 'system';
}

export interface ChatSegment {
  text: string;
  /** Ink color name. */
  color?: string;
  bold?: boolean;
  /** True → render dimmed (grey). */
  dim?: boolean;
}

type Listener = () => void;

export class CliStore {
  private snap: CliSnapshot = {
    scene: null,
    grid: null,
    characters: [],
    props: [],
    activeActor: null,
    chat: [],
    inputUnlocked: false,
    ended: null,
  };
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getSnapshot(): CliSnapshot { return this.snap; }

  private commit(next: CliSnapshot): void {
    this.snap = next;
    for (const l of this.listeners) l();
  }

  setScene(scene: Scene, grid: Grid): void {
    this.commit({ ...this.snap, scene, grid });
  }
  setCharacters(cs: Character[]): void {
    this.commit({ ...this.snap, characters: cs });
  }
  setActive(actor: CharacterId | 'dm' | null): void {
    this.commit({ ...this.snap, activeActor: actor });
  }
  unlockInput(unlocked: boolean): void {
    this.commit({ ...this.snap, inputUnlocked: unlocked });
  }
  end(outcome: 'success' | 'failure' | 'aborted'): void {
    this.commit({ ...this.snap, ended: { outcome }, inputUnlocked: false });
  }

  ingest(ev: Event, displayFor: DisplayFor): void {
    if (ev.type === 'narrate') {
      const d = displayFor('dm');
      this.appendChat({ t: ev.t, who: d.who, emoji: d.emoji, color: d.color, text: ev.text, kind: 'narrate' });
    } else if (ev.type === 'action' && (ev.action as { kind: string }).kind === 'say') {
      const text = (ev.action as { kind: 'say'; text: string }).text;
      const d = displayFor(ev.actorId);
      this.appendChat({ t: ev.t, who: d.who, emoji: d.emoji, color: d.color, text, kind: 'say' });
    } else if (ev.type === 'action' && (ev.action as { kind: string }).kind === 'emote') {
      // Render as an ambient single-glyph chat line. The browser renders a
      // floating balloon; the CLI just surfaces the glyph next to the actor.
      const emoji = (ev.action as { kind: 'emote'; emoji: string }).emoji;
      const d = displayFor(ev.actorId);
      this.appendChat({ t: ev.t, who: d.who, emoji: d.emoji, color: d.color, text: emoji, kind: 'say' });
    } else if (ev.type === 'action') {
      const action = ev.action as Record<string, unknown> & { kind: string };
      const k = action.kind;
      // end_turn is a structural turn-end signal, not narrative content —
      // hide it from the chat log so the user only sees actions that
      // actually moved the fiction forward.
      if (k === 'end_turn') return;
      // Reconcile prop list on spawn/remove so the grid renderer sees them.
      if (k === 'spawn_prop' && typeof action['id'] === 'string') {
        const prop: EmojiProp = {
          id: action['id'] as string,
          emoji: (action['emoji'] as string) ?? '?',
          name: (action['name'] as string) ?? '',
          pos: action['pos'] as { x: number; y: number },
          ...(typeof action['description'] === 'string' && { description: action['description'] as string }),
        };
        if (!this.snap.props.some((p) => p.id === prop.id)) {
          this.commit({ ...this.snap, props: [...this.snap.props, prop] });
        }
      } else if (k === 'remove_prop' && typeof action['id'] === 'string') {
        const id = action['id'] as string;
        if (this.snap.props.some((p) => p.id === id)) {
          this.commit({ ...this.snap, props: this.snap.props.filter((p) => p.id !== id) });
        }
      }
      const d = displayFor(ev.actorId);
      this.appendChat({ t: ev.t, who: d.who, emoji: d.emoji, color: d.color, text: `→ ${k}`, kind: 'action' });
    } else if (ev.type === 'resolution') {
      const pub = ev.public as Record<string, unknown>;
      const d = displayFor(ev.actorId);
      const { text, segments } = formatResolution(pub);
      this.appendChat({
        t: ev.t, who: d.who, emoji: d.emoji, color: d.color,
        text, kind: 'resolution',
        ...(segments !== undefined && { segments }),
      });
    } else if (ev.type === 'human_input') {
      // Render the raw free-text under a separate "Player" identity so the user
      // sees what they typed (player-voice, meta) distinct from the DM's
      // in-character interpretation that follows (Bran's say/move/attack).
      this.appendChat({
        t: ev.t,
        who: 'Player',
        emoji: '👤',
        color: 'gray',
        text: ev.text,
        kind: 'say',
      });
    } else if (ev.type === 'adventure_ended') {
      this.end(ev.outcome);
    }
  }

  private appendChat(entry: ChatEntry): void {
    this.commit({ ...this.snap, chat: [...this.snap.chat, entry].slice(-50) });
  }
}

/**
 * Render a resolution event's public payload as a human-readable line prefixed
 * with 🎲. For attack and ability_test outcomes the function also returns
 * styled segments so the outcome word (HIT, MISS, SUCCESS, FAILED) renders in
 * caps + bold colour while the surrounding metadata stays dim.
 *
 * Known shapes (engine emit sites):
 *   - normal_attack:  { hit, damage, attackerTop, defenderTop }
 *   - ability_test:   { success, top, difficulty }
 *   - special_action: { narration, changes? }
 */
const formatResolution = (
  pub: Record<string, unknown>,
): { text: string; segments?: ChatSegment[] } => {
  if ('hit' in pub && 'attackerTop' in pub && 'defenderTop' in pub) {
    const hit = pub['hit'] as boolean;
    const damage = pub['damage'] as number;
    const a = pub['attackerTop'] as number;
    const d = pub['defenderTop'] as number;
    if (hit) {
      const tail = ` ${damage} damage (attack ${a} vs armor ${d})`;
      return {
        text: `🎲 HIT!${tail}`,
        segments: [
          { text: '🎲 ', dim: true },
          { text: 'HIT!', color: 'greenBright', bold: true },
          { text: tail, dim: true },
        ],
      };
    }
    const tail = ` (attack ${a} vs armor ${d})`;
    return {
      text: `🎲 MISS${tail}`,
      segments: [
        { text: '🎲 ', dim: true },
        { text: 'MISS', color: 'redBright', bold: true },
        { text: tail, dim: true },
      ],
    };
  }
  if ('success' in pub && 'top' in pub && 'difficulty' in pub) {
    const success = pub['success'] as boolean;
    const top = pub['top'] as number;
    const dc = pub['difficulty'] as number;
    const tail = ` (rolled ${top} vs DC ${dc})`;
    if (success) {
      return {
        text: `🎲 SUCCESS${tail}`,
        segments: [
          { text: '🎲 ', dim: true },
          { text: 'SUCCESS', color: 'greenBright', bold: true },
          { text: tail, dim: true },
        ],
      };
    }
    return {
      text: `🎲 FAILED${tail}`,
      segments: [
        { text: '🎲 ', dim: true },
        { text: 'FAILED', color: 'redBright', bold: true },
        { text: tail, dim: true },
      ],
    };
  }
  if ('narration' in pub) {
    const n = pub['narration'];
    return { text: typeof n === 'string' && n.length > 0 ? `🎲 ${n}` : '🎲 special action resolved' };
  }
  // Fallback for unknown shapes — still nicer than raw JSON
  const summary = Object.entries(pub)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
  return { text: `🎲 ${summary}` };
};
