import type { ToolSchema, ParsedToolUse } from '../llm/llm-client.js';
import type { PlayerAction, DmAction } from '../../engine/action.js';
import {
  asCharacterId,
  asItemId,
  asBoonId,
  asEquipmentId,
  asSceneId,
  asSkillId,
} from '../../engine/ids.js';

const square = {
  type: 'object',
  properties: {
    x: { type: 'integer' }, y: { type: 'integer' },
  },
  required: ['x', 'y'],
} as const;

export const PLAYER_TOOLS: ToolSchema[] = [
  {
    name: 'move',
    description: 'Move along a path of adjacent squares. path[0] must be your current position.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'array', items: square, minItems: 2 } },
      required: ['path'],
    },
  },
  {
    name: 'normal_attack',
    description: 'Make a normal attack against the target character.',
    input_schema: {
      type: 'object',
      properties: { targetId: { type: 'string' } },
      required: ['targetId'],
    },
  },
  {
    name: 'special_action',
    description: 'Use your character special action. targetIds and params are action-specific.',
    input_schema: {
      type: 'object',
      properties: {
        targetIds: { type: 'array', items: { type: 'string' } },
        params: {
          type: 'object',
          description: 'Optional structured parameters. For whirlwind / split-shot, supply diceSplit; for healing-touch and other single-target effects, this can be omitted.',
          properties: {
            diceSplit: {
              type: 'object',
              description: "For whirlwind-attack and split-shot: maps each targetId to the number of dice (positive integer) used against that target. The values must sum to the actor's relevant dice pool (melee for whirlwind, ranged for split-shot).",
              additionalProperties: { type: 'integer', minimum: 1 },
            },
          },
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: 'use_item',
    description: 'Use a consumable item from your inventory.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, targetId: { type: 'string' } },
      required: ['itemId'],
    },
  },
  {
    name: 'use_boon',
    description: 'Spend a one-shot boon. Can be played on any turn.',
    input_schema: {
      type: 'object',
      properties: { boonId: { type: 'string' }, targetId: { type: 'string' } },
      required: ['boonId'],
    },
  },
  {
    name: 'equip',
    description: 'Swap the equipped item. Out-of-combat only.',
    input_schema: {
      type: 'object',
      properties: { equipmentId: { type: 'string' } },
      required: ['equipmentId'],
    },
  },
  {
    name: 'ability_test',
    description: 'Attempt an ability test. Difficulty: 4 easy, 5 normal, 6 hard.',
    input_schema: {
      type: 'object',
      properties: {
        characteristic: { type: 'string', enum: ['melee', 'ranged', 'magic'] },
        difficulty: { type: 'integer', enum: [4, 5, 6] },
        describe: { type: 'string' },
        skillId: { type: 'string' },
        itemId: { type: 'string' },
      },
      required: ['characteristic', 'difficulty', 'describe'],
    },
  },
  {
    name: 'attack_object',
    description:
      'Attack an inanimate Thing on the grid — a scene obstacle (barrel, ' +
      'crate, oil cask) or a DM-spawned emoji prop sitting on a cell. ' +
      'Triggers a dice roll: rolls your normal-attack pool, any die ≥ ' +
      'difficulty is a successful hit. Most things break in one hit, but ' +
      'TOUGH obstacles have durability > 1 (shown in OBSTACLES ON THE GRID) ' +
      'and take that many successful hits to break — each hit drains one ' +
      'point; the obstacle only opens up when durability reaches 0. NOTE: ' +
      'ATTACK-PROOF stalagmites cannot be smashed this way (the swing is ' +
      'rejected) — only an explosion clears them. Range and line-of-sight ' +
      'follow your normal attack. Counts as your main action. Use to smash, ' +
      'shatter, or topple things to clear a path, spill what is inside, or ' +
      'DETONATE an explosive cask.',
    input_schema: {
      type: 'object',
      properties: {
        pos:        { ...square, description: 'Grid cell containing the obstacle / prop.' },
        difficulty: { type: 'integer', enum: [4, 5, 6], description: 'DC for the swing. OMIT to use the easy default (3) — most things should break readily. Only set this for genuinely tough targets: 4 easy / 5 normal / 6 hard.' },
      },
      required: ['pos'],
    },
  },
  {
    name: 'push_object',
    description:
      'Shove an ADJACENT pushable obstacle (e.g. an oil cask, flagged ' +
      'PUSHABLE in OBSTACLES ON THE GRID) ONE cell directly AWAY from you ' +
      'into an empty floor cell. NO dice roll — it always works when the ' +
      'cell beyond is clear floor. Direction is fixed: the obstacle moves to ' +
      '(its cell) + (its cell − your cell), so stand on the opposite side ' +
      'from where you want it to go. Counts as your main action. Use to ' +
      'reposition an explosive cask: push it flush against an ATTACK-PROOF ' +
      'stalagmite wall (or next to a cluster of foes), then have a hero who ' +
      'is NOT adjacent detonate it with attack_object — the blast shatters ' +
      'the stalagmites and blows a breach. (Detonating the cask BEFORE it is ' +
      'adjacent to the wall wastes it — the blast will not reach.)',
    input_schema: {
      type: 'object',
      properties: {
        pos: { ...square, description: 'Current grid cell of the obstacle to push.' },
      },
      required: ['pos'],
    },
  },
  {
    name: 'free_ally',
    description:
      'Free an ADJACENT immobilized teammate (a bound / trapped ally, flagged ' +
      'IMMOBILIZED in YOUR PARTY). You must be standing next to them (1 square). ' +
      'Triggers a dice roll: rolls your chosen characteristic pool (+1 if you ' +
      'have a matching skill), any die ≥ difficulty frees them — they regain ' +
      'their status and can move + fight on their next turn. Counts as your main ' +
      'action whether or not it works. A bound ally can be HURT or KILLED by ' +
      'foes before you reach them, so get to them fast.',
    input_schema: {
      type: 'object',
      properties: {
        targetId:       { type: 'string', description: 'CharacterId of the immobilized teammate.' },
        characteristic: { type: 'string', enum: ['melee', 'ranged', 'magic'], description: 'Pool to roll (melee = brute strength to snap the bonds; default melee).' },
        difficulty:     { type: 'integer', enum: [4, 5, 6], description: 'DC. 4 easy (default) / 5 / 6.' },
        skillId:        { type: 'string', description: 'Optional skill that fits (e.g. a knowledge of knots) for +1 die.' },
      },
      required: ['targetId'],
    },
  },
  {
    name: 'open_chest',
    description:
      'Open an ADJACENT closed chest (shown in PROPS ON THE GRID with a 📦 and ' +
      'tagged CHEST) to loot its contents into your inventory. Stand within 1 ' +
      'square of it. NO dice roll — it always works in range. Counts as your ' +
      'main action. The chest is emptied and removed once opened.',
    input_schema: {
      type: 'object',
      properties: {
        chestId: { type: 'string', description: 'The id of the chest prop (e.g. "supply-chest").' },
      },
      required: ['chestId'],
    },
  },
  {
    name: 'throw_item',
    description:
      'Throw an item onto a nearby EMPTY floor cell — up to 4 squares away — ' +
      'where it lands on the grid. The item must be AVAILABLE to you: either ' +
      'carried in your inventory (it is consumed) OR lying on the ground right ' +
      'next to you (within 1 square; it is relocated). Pass the item id (e.g. ' +
      '"cheese") — for a ground item, its id is shown in PROPS ON THE GRID. ' +
      'THROWING CHEESE makes BAIT: the rats ABANDON the heroes and scramble ' +
      'toward the nearest wheel, and the FIRST rat to reach it stops to eat it ' +
      '(the cheese is then gone). Use cheese to lure a pack off a wounded ally, ' +
      'break up a gang-up, or buy a turn to reposition or breach — aim it AWAY ' +
      'from your party and toward where you want the rats to go. NO dice roll. ' +
      'Counts as your main action.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Id of the item to throw (e.g. "cheese"). Must be in your inventory, or a prop on the ground within 1 square of you.' },
        pos:    { ...square, description: 'Empty floor cell to toss it onto (within 4 squares, no creature on it).' },
      },
      required: ['itemId', 'pos'],
    },
  },
  {
    name: 'say',
    description: 'Say something out loud. Heard by everyone in the scene.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'emote',
    description:
      "Flash a single FACE emoji over your hero's head. Pick from the bucket " +
      'that matches the beat:\n' +
      '  ANGRY:     😠 😡 🤬 😤 😾\n' +
      '  SCARED:    😨 😱 😰 😖\n' +
      '  SAD:       😢 😭 😞 😔 🥺\n' +
      '  SURPRISED: 😲 😮 🤯 😦\n' +
      '  CONFUSED:  🤔 🤨 😕 😶\n' +
      '  HAPPY:     😄 😁 😆 🥰 😍 🤩\n' +
      '  SMUG/COOL: 😏 😎 😈\n' +
      '  AWKWARD:   😬 😅 🙄\n' +
      '  DISGUST:   🤢 🤮 😒\n' +
      '  HURT/KO:   😵 😵‍💫 🤕\n' +
      '  OTHER:     😴 😇 🙀 👻 🤡\n' +
      'ALWAYS choose an emoji with a face (or a face-bearing creature like ' +
      '🙀 👻 🤡). Abstract emojis like ✨ 🎉 ❤️ do NOT read as feelings — ' +
      'never use them. Pure flavour — no game effect. Free action: does not ' +
      'consume your main action or move. Use SPARINGLY — only when a beat ' +
      'genuinely warrants reacting. Never every turn.',
    input_schema: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description:
            'A single face emoji from the buckets in this tool description ' +
            '(😠 😡 😨 😱 😢 😲 🤔 😄 😏 😬 🤢 😵 etc.).',
        },
      },
      required: ['emoji'],
    },
  },
  {
    name: 'end_turn',
    description: 'End your turn. Required at the end of every turn.',
    input_schema: { type: 'object', properties: {} },
  },
];

/**
 * The tools an AI hero may use to REACT to a teammate's party message off-turn:
 * a short spoken line and/or a face emoji. A subset of PLAYER_TOOLS — no
 * movement, attacks, or turn-consuming actions, since a reaction is pure banter
 * (it neither uses the turn nor mutates rule state). Replying with no tool call
 * means "stay silent." */
export const PARTY_REACT_TOOLS: ToolSchema[] =
  PLAYER_TOOLS.filter((t) => t.name === 'say' || t.name === 'emote');

/**
 * The tool the DM uses to VOICE an enemy's off-turn reaction to something that
 * just happened (a hero blowing themselves up, a teammate freed, a kill). The
 * DM may call it 0+ times in one reaction round (allowParallelTools) — once per
 * monster it wants to react, or not at all (stay silent). Each call carries the
 * reacting monster's id plus a SHORT line and/or a face emoji; the orchestrator
 * broadcasts them off-turn as that monster's `say` / `emote` (pure banter — no
 * turn consumed, no rule state mutated). Monsters have no LLM of their own, so
 * the DM is their voice. NOT part of DM_TOOLS — used only by `reactAsMonsters`. */
export const MONSTER_REACT_TOOLS: ToolSchema[] = [
  {
    name: 'voice_monster',
    description:
      'Voice ONE enemy reacting to what just happened — WITHOUT taking a turn or ' +
      'any action (pure flavour). The line is shown to players as THAT MONSTER\'S ' +
      'OWN speech bubble (its name + portrait as the speaker), so write the SOUND ' +
      'OR WORDS THE CREATURE ITSELF MAKES, in the FIRST PERSON — a screech, hiss, ' +
      'snarl, wordless cry, or a snarled taunt. Write what it UTTERS, e.g. ' +
      '"Skreeeee!" or "Your warlock falls, little heroes!" — NEVER a third-person ' +
      'description of it like "The King Rat squeaks in triumph." (rats screech/' +
      'squeal more than they speechify, so a wordless "Screeeee!" is perfect). ' +
      'Supply the reacting monster\'s id and a SHORT utterance and/or a single ' +
      'face emoji. Call once per monster you want to react; call it zero times ' +
      'to keep the enemies silent. Only living monsters already on the board may ' +
      'react, and never the monster that just acted.',
    input_schema: {
      type: 'object',
      properties: {
        monsterId: { type: 'string', description: 'CharacterId of the reacting monster (a living foe on the board).' },
        text:      { type: 'string', description: 'Optional SHORT first-person utterance — the sound or words the creature itself makes (e.g. "Skreeee!", "Your warlock falls!"). NOT a third-person description ("The King Rat squeaks…").' },
        emoji:     { type: 'string', description: 'Optional single face emoji (😾 😡 🙀 😈 etc.).' },
      },
      required: ['monsterId'],
    },
  },
];

export const DM_TOOLS: ToolSchema[] = [
  { name: 'narrate', description: 'Narrate to the players.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'set_scene', description: 'Move the party into a scene.', input_schema: { type: 'object', properties: { sceneId: { type: 'string' } }, required: ['sceneId'] } },
  { name: 'start_combat', description: 'Begin combat between the listed sides; engine rolls initiative.', input_schema: { type: 'object', properties: { heroSide: { type: 'array', items: { type: 'string' } }, monsterSide: { type: 'array', items: { type: 'string' } } }, required: ['heroSide', 'monsterSide'] } },
  { name: 'end_combat', description: 'End the current combat.', input_schema: { type: 'object', properties: {} } },
  { name: 'request_action', description: 'Hand the turn to the named character (out of combat).', input_schema: { type: 'object', properties: { actorId: { type: 'string' } }, required: ['actorId'] } },
  { name: 'reveal_monster', description: 'Place a new monster on the grid.', input_schema: { type: 'object', properties: { monsterTypeId: { type: 'string' }, characterId: { type: 'string' }, pos: square }, required: ['monsterTypeId', 'characterId', 'pos'] } },
  { name: 'environmental', description: 'Apply an environmental effect to a target square or character.', input_schema: { type: 'object', properties: { effect: { type: 'string', enum: ['push', 'pull', 'hazard'] }, params: { type: 'object', additionalProperties: true } }, required: ['effect', 'params'] } },
  {
    name: 'spawn_prop',
    description:
      'Drop an imagined object onto a grid cell, rendered to humans as an emoji. ' +
      'Use this to materialize anything a player creatively discovers, crafts, ' +
      'or throws (cheese, a chalk mark, a torch, a thrown bone). REQUIRES a ' +
      'preceding successful ability_test — never spawn loot or tools without ' +
      'a dice roll deciding the outcome. Props do not block movement and have ' +
      'no stats; they are narrative anchors. Choose a stable, snake-case id ' +
      '(e.g. "cheese-1") so later actions can reference + remove it.',
    input_schema: {
      type: 'object',
      properties: {
        id:          { type: 'string', description: 'Unique kebab-case id, e.g. "cheese-1" or "chalk-mark-2".' },
        emoji:       { type: 'string', description: 'Single Unicode emoji (no other text). Examples: 🧀 🔥 🕯️ ❤️ 🦴.' },
        name:        { type: 'string', description: 'Short human-readable label, e.g. "Wheel of cheese".' },
        pos:         { ...square, description: 'Grid cell to place the prop on.' },
        description: { type: 'string', description: 'Optional one-line flavor description.' },
      },
      required: ['id', 'emoji', 'name', 'pos'],
    },
  },
  {
    name: 'remove_prop',
    description:
      'Remove a previously spawned prop from the grid (it was picked up, ' +
      'consumed, kicked away, or destroyed). Use after a player successfully ' +
      'interacts with it.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  { name: 'offer_rest', description: 'Offer the party a rest opportunity.', input_schema: { type: 'object', properties: {} } },
  { name: 'end_adventure', description: 'Conclude the adventure.', input_schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failure'] } }, required: ['outcome'] } },
  {
    name: 'npc_action',
    description: 'Apply a player-style action (move, normal_attack, say, emote, ability_test, end_turn, skip_turn) on behalf of an NPC the DM controls.',
    input_schema: {
      type: 'object',
      properties: {
        npcId:  { type: 'string', description: 'CharacterId of the NPC.' },
        action: { type: 'object', description: 'PlayerAction shape — see PLAYER_TOOLS subset.' },
      },
      required: ['npcId', 'action'],
    },
  },
  {
    name: 'monster_action',
    description: "On a MONSTER's combat turn (you will be told whose turn it is), act for that monster: move it toward the heroes and attack, or use its special ability. Same action shapes as a player (move, normal_attack, special_action, ability_test, end_turn, skip_turn). Finish the monster's turn by calling this with end_turn.",
    input_schema: {
      type: 'object',
      properties: {
        monsterId: { type: 'string', description: 'CharacterId of the monster whose turn it is (the active combatant).' },
        action:    { type: 'object', description: 'PlayerAction shape — see PLAYER_TOOLS subset.' },
      },
      required: ['monsterId', 'action'],
    },
  },
  {
    name: 'reveal_npc',
    description: 'Spawn a new NPC on the grid mid-scene. Use sparingly — scene-declared NPCs auto-reveal on set_scene.',
    input_schema: {
      type: 'object',
      properties: {
        npcTypeId:   { type: 'string' },
        pos:         { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
        characterId: { type: 'string' },
        allegiance:  { type: 'string', enum: ['ally', 'hostile', 'neutral'] },
      },
      required: ['npcTypeId', 'pos', 'characterId', 'allegiance'],
    },
  },
];

/**
 * Single-purpose tool offered only when the DM is answering an out-of-character
 * (OOC) question from the human. We isolate this from DM_TOOLS so the regular
 * DM ReACT loop and react step can't accidentally call it, and so the OOC path
 * can't accidentally emit an in-fiction action (narrate, request_action, ...).
 * The reply text never alters engine state.
 */
export const OOC_REPLY_TOOL: ToolSchema = {
  name: 'ooc_reply',
  description:
    'Answer an out-of-character question from the human player. Reply to them ' +
    'as the DM (rules clarification, scene description, what they can see from ' +
    'where they are, etc.). DO NOT advance the story, narrate new events, ' +
    'change NPC dispositions, or mutate the world — this is a meta sidebar. ' +
    'Keep replies under 2 sentences.',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`expected string for ${name}, got ${typeof v}`);
  return v;
};

export const decodePlayerToolUse = (tu: ParsedToolUse): PlayerAction => {
  const i = tu.input;
  switch (tu.name) {
    case 'move':
      return { kind: 'move', path: (i['path'] as Array<{ x: number; y: number }>) };
    case 'normal_attack':
      return { kind: 'normal_attack', targetId: asCharacterId(str(i['targetId'], 'targetId')) };
    case 'special_action': {
      const tids = (i['targetIds'] as string[] | undefined)?.map(asCharacterId);
      return {
        kind: 'special_action',
        ...(tids && { targetIds: tids }),
        ...(i['params'] !== undefined && { params: i['params'] as Record<string, unknown> }),
      };
    }
    case 'use_item':
      return {
        kind: 'use_item',
        itemId: asItemId(str(i['itemId'], 'itemId')),
        ...(i['targetId'] !== undefined && { targetId: asCharacterId(str(i['targetId'], 'targetId')) }),
      };
    case 'use_boon':
      return {
        kind: 'use_boon',
        boonId: asBoonId(str(i['boonId'], 'boonId')),
        ...(i['targetId'] !== undefined && { targetId: asCharacterId(str(i['targetId'], 'targetId')) }),
      };
    case 'equip':
      return { kind: 'equip', equipmentId: asEquipmentId(str(i['equipmentId'], 'equipmentId')) };
    case 'ability_test':
      return {
        kind: 'ability_test',
        characteristic: i['characteristic'] as 'melee' | 'ranged' | 'magic',
        difficulty: i['difficulty'] as 4 | 5 | 6,
        describe: str(i['describe'], 'describe'),
        ...(i['skillId'] !== undefined && { skillId: asSkillId(str(i['skillId'], 'skillId')) }),
        ...(i['itemId'] !== undefined && { itemId: asItemId(str(i['itemId'], 'itemId')) }),
      };
    case 'attack_object':
      return {
        kind: 'attack_object',
        pos: i['pos'] as { x: number; y: number },
        ...(i['difficulty'] !== undefined && { difficulty: i['difficulty'] as 4 | 5 | 6 }),
      };
    case 'push_object':
      return { kind: 'push_object', pos: i['pos'] as { x: number; y: number } };
    case 'free_ally':
      return {
        kind: 'free_ally',
        targetId: asCharacterId(str(i['targetId'], 'targetId')),
        characteristic: (i['characteristic'] as 'melee' | 'ranged' | 'magic' | undefined) ?? 'melee',
        ...(i['difficulty'] !== undefined && { difficulty: i['difficulty'] as 4 | 5 | 6 }),
        ...(i['skillId'] !== undefined && { skillId: asSkillId(str(i['skillId'], 'skillId')) }),
      };
    case 'open_chest':
      return { kind: 'open_chest', chestId: str(i['chestId'], 'chestId') };
    case 'throw_item':
      return {
        kind: 'throw_item',
        itemId: asItemId(str(i['itemId'], 'itemId')),
        pos: i['pos'] as { x: number; y: number },
      };
    case 'say':
      return { kind: 'say', text: str(i['text'], 'text') };
    case 'emote':
      return { kind: 'emote', emoji: str(i['emoji'], 'emoji') };
    case 'end_turn':
      return { kind: 'end_turn' };
    default:
      throw new Error(`unknown player tool: ${tu.name}`);
  }
};

export const decodeDmToolUse = (tu: ParsedToolUse): DmAction => {
  const i = tu.input;
  switch (tu.name) {
    case 'narrate':       return { kind: 'narrate', text: str(i['text'], 'text') };
    case 'set_scene':     return { kind: 'set_scene', sceneId: asSceneId(str(i['sceneId'], 'sceneId')) };
    case 'start_combat':  return {
      kind: 'start_combat',
      heroSide:    (i['heroSide']    as string[]).map(asCharacterId),
      monsterSide: (i['monsterSide'] as string[]).map(asCharacterId),
    };
    case 'end_combat':    return { kind: 'end_combat' };
    case 'request_action':return { kind: 'request_action', actorId: asCharacterId(str(i['actorId'], 'actorId')) };
    case 'reveal_monster':return {
      kind: 'reveal_monster',
      monsterTypeId: str(i['monsterTypeId'], 'monsterTypeId'),
      characterId:   asCharacterId(str(i['characterId'], 'characterId')),
      pos:           i['pos'] as { x: number; y: number },
    };
    case 'environmental': return {
      kind: 'environmental',
      effect: i['effect'] as 'push' | 'pull' | 'hazard',
      params: i['params'] as Record<string, unknown>,
    };
    case 'spawn_prop':    return {
      kind: 'spawn_prop',
      id:    str(i['id'],    'id'),
      emoji: str(i['emoji'], 'emoji'),
      name:  str(i['name'],  'name'),
      pos:   i['pos'] as { x: number; y: number },
      ...(i['description'] !== undefined && { description: str(i['description'], 'description') }),
    };
    case 'remove_prop':   return { kind: 'remove_prop', id: str(i['id'], 'id') };
    case 'offer_rest':    return { kind: 'offer_rest' };
    case 'end_adventure': return { kind: 'end_adventure', outcome: i['outcome'] as 'success' | 'failure' };
    case 'npc_action':
      return {
        kind: 'npc_action',
        npcId: asCharacterId(str(i['npcId'], 'npcId')),
        action: i['action'] as PlayerAction,
      };
    case 'monster_action':
      return {
        kind: 'monster_action',
        monsterId: asCharacterId(str(i['monsterId'], 'monsterId')),
        action: i['action'] as PlayerAction,
      };
    case 'reveal_npc':
      return {
        kind: 'reveal_npc',
        npcTypeId: str(i['npcTypeId'], 'npcTypeId'),
        pos: i['pos'] as { x: number; y: number },
        characterId: asCharacterId(str(i['characterId'], 'characterId')),
        allegiance: str(i['allegiance'], 'allegiance') as 'ally' | 'hostile' | 'neutral',
      };
    default:              throw new Error(`unknown dm tool: ${tu.name}`);
  }
};

/**
 * Convenience wrapper around `decodeDmToolUse` for callers that have the
 * tool name and input object as separate values (e.g. tests, manual dispatch).
 */
export const parseDmToolInput = (name: string, input: Record<string, unknown>): DmAction =>
  decodeDmToolUse({ name, input });
