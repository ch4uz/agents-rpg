import type { PlayerAction } from '../../engine/action.js';
import { asCharacterId, asItemId, asEquipmentId, asSkillId } from '../../engine/ids.js';

export type ParsedInput =
  | { kind: 'free_text'; text: string }
  | { kind: 'structured_action'; action: PlayerAction }
  | { kind: 'skip' }
  | { kind: 'help' }
  | { kind: 'parse_error'; message: string };

const parseSquare = (s: string): { x: number; y: number } | null => {
  const m = s.match(/^(\d+)\s*,\s*(\d+)$/);
  if (!m) return null;
  return { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10) };
};

const parsePath = (rest: string): Array<{ x: number; y: number }> | null => {
  const parts = rest.split(/\s+via\s+|\s*;\s*/i).map((s) => s.trim()).filter(Boolean);
  const out: Array<{ x: number; y: number }> = [];
  for (const p of parts) {
    const sq = parseSquare(p);
    if (!sq) return null;
    out.push(sq);
  }
  return out.length >= 1 ? out : null;
};

export const parseLine = (raw: string): ParsedInput => {
  const line = raw.trim();
  if (line.length === 0) return { kind: 'free_text', text: '' };
  if (!line.startsWith('/')) return { kind: 'free_text', text: line };

  const [head, ...rest] = line.slice(1).split(/\s+/);
  if (!head) return { kind: 'parse_error', message: 'empty command' };
  const tail = line.slice(1 + head.length).trim();

  switch (head) {
    case 'help': return { kind: 'help' };
    case 'skip': return { kind: 'skip' };
    case 'end':  return { kind: 'structured_action', action: { kind: 'end_turn' } };
    case 'say':  return { kind: 'structured_action', action: { kind: 'say', text: tail } };
    case 'attack': {
      const target = rest[0];
      if (!target) return { kind: 'parse_error', message: '/attack requires a targetId' };
      return { kind: 'structured_action', action: { kind: 'normal_attack', targetId: asCharacterId(target) } };
    }
    case 'move': {
      const path = parsePath(tail);
      if (!path) return { kind: 'parse_error', message: '/move requires "x,y[ via x,y; ...]"' };
      return { kind: 'structured_action', action: { kind: 'move', path } };
    }
    case 'use': {
      const itemId = rest[0];
      if (!itemId) return { kind: 'parse_error', message: '/use requires <itemId> [<targetId>]' };
      const targetId = rest[1];
      return { kind: 'structured_action', action: {
        kind: 'use_item',
        itemId: asItemId(itemId),
        ...(targetId && { targetId: asCharacterId(targetId) }),
      } };
    }
    case 'equip': {
      const eq = rest[0];
      if (!eq) return { kind: 'parse_error', message: '/equip requires <equipmentId>' };
      return { kind: 'structured_action', action: { kind: 'equip', equipmentId: asEquipmentId(eq) } };
    }
    case 'special': {
      // /special [target=ID] [k=v ...]
      const params: Record<string, string> = {};
      let target: string | undefined;
      for (const tok of rest) {
        const eq = tok.indexOf('=');
        if (eq <= 0) continue;
        const k = tok.slice(0, eq); const v = tok.slice(eq + 1);
        if (k === 'target') target = v;
        else params[k] = v;
      }
      return { kind: 'structured_action', action: {
        kind: 'special_action',
        ...(target && { targetIds: [asCharacterId(target)] }),
        ...(Object.keys(params).length > 0 && { params }),
      } };
    }
    case 'test': {
      // /test <melee|ranged|magic> <4|5|6> [skill=<id>] [item=<id>] -- <describe>
      const dashIdx = tail.indexOf('--');
      const headerParts = (dashIdx === -1 ? tail : tail.slice(0, dashIdx)).trim().split(/\s+/);
      const describe = dashIdx === -1 ? '' : tail.slice(dashIdx + 2).trim();
      const characteristic = headerParts[0] as 'melee' | 'ranged' | 'magic' | undefined;
      const difficulty = headerParts[1] ? parseInt(headerParts[1], 10) : NaN;
      if (!characteristic || (difficulty !== 4 && difficulty !== 5 && difficulty !== 6) || !describe) {
        return { kind: 'parse_error', message: '/test <melee|ranged|magic> <4|5|6> [skill=...] [item=...] -- <describe>' };
      }
      let skillId: string | undefined; let itemId: string | undefined;
      for (let i = 2; i < headerParts.length; i++) {
        const tok = headerParts[i]!;
        if (tok.startsWith('skill=')) skillId = tok.slice('skill='.length);
        else if (tok.startsWith('item=')) itemId = tok.slice('item='.length);
      }
      return { kind: 'structured_action', action: {
        kind: 'ability_test', characteristic, difficulty,
        describe,
        ...(skillId && { skillId: asSkillId(skillId) }),
        ...(itemId  && { itemId: asItemId(itemId) }),
      } };
    }
    default:
      return { kind: 'parse_error', message: `unknown command: /${head}` };
  }
};

export const HELP_TEXT = `Available commands:
  /move x,y[ via x,y; ...]     Move along a path
  /attack <targetId>           Normal attack
  /special [target=ID] [k=v ...]  Special action
  /use <itemId> [<targetId>]   Use a consumable
  /equip <equipmentId>         Swap equipment (out of combat)
  /test <melee|ranged|magic> <4|5|6> [skill=ID] [item=ID] -- <describe>
  /say <text>                  Say something out loud
  /skip                        Skip your turn
  /end                         End your turn
  /help                        This message
Or just type free text — the DM will interpret.`;
