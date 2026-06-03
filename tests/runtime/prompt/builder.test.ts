import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../../src/runtime/prompt/builder.js';
import { renderDmSystem } from '../../../src/runtime/prompt/templates/dm-system.js';
import { renderPlayerSystem } from '../../../src/runtime/prompt/templates/player-system.js';
import { asCharacterId, asEffectId, asSceneId, asAdventureId } from '../../../src/engine/ids.js';
import type { Character } from '../../../src/engine/character.js';
import type { Adventure } from '../../../src/engine/adventure.js';
import type { Event } from '../../../src/log/events.js';

const character = (id: string): Character => ({
  id: asCharacterId(id), name: id, kind: 'hero', archetype: 'warrior',
  pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
  health: { total: 3, damage: 0, status: 'normal' },
  pos: { x: 0, y: 0 },
  normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
  specialAction: {
    id: asEffectId('whirlwind-attack'),
    name: 'Whirlwind Attack',
    description: 'Strike all adjacent enemies (1 melee die per target).',
  },
  bonusAbility: { id: asEffectId('teamwork'), name: 'TW', description: '' },
  inventory: [], boons: [], skills: [],
});

const stubHero = (): Character => character('p1');

const adventure: Adventure = {
  id: asAdventureId('a'), title: 'A',
  estimatedDurationMin: 30,
  scenes: [{
    id: asSceneId('s'),
    intro: 'You enter.', conclusion: 'It ends.',
    tactics: '',
    map: { width: 6, height: 6, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
    monsters: [], abilityTests: [], transitions: [],
  }],
};

describe('PromptBuilder', () => {
  it('player band 1 (system) is cacheable and includes character sheet + persona', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'I am cautious.',
      partyDescription: '  - p2 (warlock, AI)\n  - h1 (hunter, human)',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
    });
    expect(out.system).toHaveLength(1);
    expect(out.system[0]!.cacheable).toBe(true);
    expect(out.system[0]!.text).toMatch(/PERSONA/);
    expect(out.system[0]!.text).toMatch(/I am cautious\./);
    expect(out.system[0]!.text).toMatch(/Melee 2d6/);
  });

  it('history is partitioned into a cacheable snapshot prefix and an uncacheable tail', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });

    const events: Event[] = Array.from({ length: 12 }, (_, i) =>
      ({ t: i + 1, type: 'narrate', actorId: 'dm', text: `event ${i + 1}` } as Event),
    );

    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: events,
      observation: { kind: 'fresh_turn' },
      currentTurnIdx: 6,    // 6 turns past — two snapshot points should have elapsed (at 3 and 6)
    });

    // First message is the cacheable history snapshot, second is the uncacheable tail.
    expect(out.messages.length).toBeGreaterThanOrEqual(2);
    const first = out.messages[0]!;
    const last  = out.messages[out.messages.length - 1]!;
    expect(first.content[0]!.cacheable).toBe(true);
    expect(last.content[last.content.length - 1]!.cacheable).toBe(false);
  });

  it('drops thought events from the cacheable snapshot band but keeps them in the recent tail', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });

    // No request_action markers → raw index partition: with currentTurnIdx 6,
    // events 1..6 land in the cacheable snapshot band, 7..12 in the tail.
    const events: Event[] = Array.from({ length: 12 }, (_, i) => {
      const t = i + 1;
      return (t % 2 === 1
        ? { t, type: 'thought', actorId: 'p1', text: `private plan ${t}` }
        : { t, type: 'narrate', actorId: 'dm', text: `scene beat ${t}` }) as Event;
    });

    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: events,
      observation: { kind: 'fresh_turn' },
      currentTurnIdx: 6,
    });

    const snapshot = out.messages[0]!.content[0]!;
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(snapshot.cacheable).toBe(true);
    // Old thoughts (t=1,3,5) are dropped from the snapshot — they were 85% of
    // history growth and stale; the public record (t=2,4,6) stays.
    expect(snapshot.text).not.toMatch(/private plan [135]/);
    expect(snapshot.text).toMatch(/scene beat 2/);
    expect(snapshot.text).toMatch(/scene beat 6/);
    // Recent thoughts (t=7,9,11) survive in the volatile tail for continuity.
    expect(tail).toMatch(/private plan 7/);
    expect(tail).toMatch(/private plan 11/);
  });

  it('player state block lists grid obstacles with durability so the hero knows what is breakable', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
      obstacles: [
        { type: 'barrel-stack', x: 5, y: 3, durability: 2, remaining: 2 },
        { type: 'barrel-stack', x: 5, y: 4, durability: 2, remaining: 1 },
      ],
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toMatch(/OBSTACLES ON THE GRID/);
    expect(tail).toMatch(/barrel-stack at \(5,3\) durability=2\/2/);
    expect(tail).toMatch(/barrel-stack at \(5,4\) durability=1\/2 \(needs 1 more hit/);
    // And the hero is told how to get past them (attack_object / ability_test).
    expect(tail).toMatch(/attack_object/);
    expect(tail).toMatch(/ability_test/);
  });

  it('player state block flags an ATTACK-PROOF stalagmite (no durability bar) and a PUSHABLE cask, teaching the push-and-detonate breach', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
      obstacles: [
        { type: 'stalagmite', x: 6, y: 5, attackProof: true },
        { type: 'oil-cask', x: 4, y: 5, explosive: true, pushable: true },
      ],
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    // The stalagmite is flagged attack-proof — no durability bar, and the hero is
    // told the only way through is an explosion.
    expect(tail).toMatch(/stalagmite at \(6,5\).*ATTACK-PROOF/);
    expect(tail).not.toMatch(/stalagmite at \(6,5\).*durability=/);
    // The cask is pushable and the doctrine ties it to the stalagmite breach.
    expect(tail).toMatch(/oil-cask at \(4,5\).*PUSHABLE/);
    expect(tail).toMatch(/push_object/);
  });

  it('player state block flags an explosive obstacle as a coordinated-detonation opportunity', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
      obstacles: [{ type: 'oil-cask', x: 7, y: 7, explosive: true }],
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toMatch(/oil-cask at \(7,7\)/);
    expect(tail).toMatch(/EXPLOSIVE/);
    // The doctrine: it hits foes AND heroes, so lure rats next to it and pop it from range.
    expect(tail).toMatch(/FOES and HEROES/);
    expect(tail).toMatch(/ranged/);
  });

  it('player state block flags a CHEST as lootable and a BAIT prop, and teaches the lure doctrine', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
      props: [
        { id: 'supply-chest', emoji: '📦', name: 'Old chest', pos: { x: 3, y: 3 }, chest: { contents: 'cheese' as Character['inventory'][number]['itemId'] } },
        { id: 'cheese-1', emoji: '🧀', name: 'Cheese', pos: { x: 8, y: 5 }, bait: true },
      ],
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    // The chest is flagged lootable with its open_chest hint + contents.
    expect(tail).toMatch(/supply-chest.*CHEST.*open_chest.*cheese/);
    // The ground cheese is flagged as bait that greedy foes rush.
    expect(tail).toMatch(/cheese-1.*BAIT/);
    // The COORDINATE doctrine (system band) teaches the cheese lure tactic.
    const system = out.system.map((s) => s.text).join('\n');
    expect(system).toMatch(/BAIT THE RATS/);
    expect(system).toMatch(/throw_item/);
  });

  it('player state block renders live PARTY and FOES rosters for coordination', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const mate: Character = {
      ...character('p2'), name: 'Kael', archetype: 'warlock',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 1, status: 'normal' },
      pos: { x: 4, y: 2 },
      normalAttack: { kind: 'magic', name: 'Bolt', range: 4, damageMod: 0 },
      specialAction: { id: asEffectId('flame-burst'), name: 'Flame Burst', description: '' },
    };
    const king: Character = {
      id: asCharacterId('king-rat-1'), name: 'King Rat', kind: 'monster',
      pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
      health: { total: 3, damage: 1, status: 'normal' }, pos: { x: 10, y: 5 },
      normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
      specialAction: { id: asEffectId('pack-attack'), name: 'Pack', description: '' },
      bonusAbility: { id: asEffectId('coward'), name: 'C', description: '' },
      inventory: [], boons: [], skills: [],
    };
    const downRat: Character = {
      ...king, id: asCharacterId('giant-rat-2'), name: 'Giant Rat',
      pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
      health: { total: 1, damage: 1, status: 'KO' }, pos: { x: 9, y: 4 },
    };
    const out = b.buildPlayer({
      character: character('p1'),
      party: [mate],
      foes: [downRat, king],   // KO passed first to prove living-first ordering
      persona: 'p', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toContain('YOUR PARTY');
    expect(tail).toContain('p2 (Kael the warlock) HP 2/3 (4,2) status=normal — magic 2d6 reach 4; special: Flame Burst');
    expect(tail).toContain('FOES');
    expect(tail).toContain('king-rat-1 (King Rat) HP 2/3 (10,5) status=normal — melee 2d6 reach 1');
    expect(tail).toContain('giant-rat-2');
    expect(tail).toContain('DOWN'); // KO'd foe is flagged
    // Living foe listed before the downed one.
    expect(tail.indexOf('king-rat-1')).toBeLessThan(tail.indexOf('giant-rat-2'));
  });

  it('flags an immobilized teammate as a rescue objective in the PARTY block', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const bound: Character = {
      ...character('p3'), name: 'Elara', archetype: 'healer',
      pools: { melee: 0, ranged: 0, magic: 2, armor: 1 },
      health: { total: 3, damage: 0, status: 'immobilized' },
      pos: { x: 11, y: 8 },
    };
    const out = b.buildPlayer({
      character: character('p1'),
      party: [bound],
      foes: [],
      persona: 'p', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toContain('status=immobilized');
    expect(tail).toContain('IMMOBILIZED');
    expect(tail).toContain('free_ally');
  });

  it('player state block shows solo/empty fallbacks when alone with no foes', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'), party: [], foes: [],
      persona: 'p', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toContain('you are on your own here');
    expect(tail).toContain('none in sight');
  });

  it('observation kinds render distinct closing prompts', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const baseArgs = {
      character: character('p1'),
      persona: 'p',
      partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [],
      currentTurnIdx: 0,
    };
    const fresh = b.buildPlayer({ ...baseArgs, observation: { kind: 'fresh_turn' } });
    const violation = b.buildPlayer({ ...baseArgs, observation: { kind: 'rule_violation', reason: 'out-of-range' } });
    const resolved = b.buildPlayer({ ...baseArgs, observation: { kind: 'public_resolution', summary: 'Hit for 1.' } });

    const tail = (msgs: typeof fresh.messages): string =>
      msgs[msgs.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail(fresh.messages)).toMatch(/your turn/i);
    expect(tail(violation.messages)).toMatch(/rule violation: out-of-range/i);
    expect(tail(resolved.messages)).toMatch(/Hit for 1\./);
  });

  it('between_turns observation renders with appropriate prefix (F27)', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = builder.buildDm({
      party: [character('p1')],
      monstersInScene: [],
      persona: 'p',
      adventure, activeScene: adventure.scenes[0]!,
      observation: { kind: 'between_turns', summary: 'React with one tool call.' },
      history: [], currentTurnIdx: 0,
    });
    const tailMsg = out.messages[out.messages.length - 1]!;
    const tailText = tailMsg.content.map((c) => c.text).join('\n');
    expect(tailText).toMatch(/Between turns: React with one tool call\./);
    expect(tailText).not.toMatch(/Result of your last action: React/);
  });
});

const monster = (id: string): Character => ({
  id: asCharacterId(id), name: id, kind: 'monster', archetype: 'brute',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 0 },
  health: { total: 1, damage: 0, status: 'normal' },
  pos: { x: 5, y: 5 },
  normalAttack: { kind: 'melee', name: 'Bite', range: 1, damageMod: 0 },
  specialAction: { id: asEffectId('pack-attack'), name: 'Pack Attack', description: '' },
  bonusAbility: { id: asEffectId('vermin'), name: 'Vermin', description: '' },
  inventory: [], boons: [], skills: [],
});

describe('DM system prompt', () => {
  it('mentions PLAYER_TOOLS when documenting human-input interpretation', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'persona body',
    });
    expect(text).toMatch(/PLAYER_TOOLS|player tool/i);
    // PLAYER_TOOLS includes move/normal_attack/say/use_item etc.; verify at least one is named.
    expect(text).toMatch(/move|normal_attack|use_item|say/);
  });

  it('does not include literal `...` placeholder in start_combat example', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1'), character('p2')],
      monstersInScene: [monster('m1'), monster('m2')],
      persona: 'p',
    });
    // The bad pattern: heroSide=["xxx", ... or heroSide=["xxx", …
    expect(text).not.toMatch(/heroSide=\["[^"]+"\s*,\s*(?:\.\.\.|…)/);
    expect(text).not.toMatch(/monsterSide=\["[^"]+"\s*,\s*(?:\.\.\.|…)/);
  });

  it('names the heroes and monsters in the roster — bare ids leak improvised names', () => {
    // The DM narrates from what it sees. Before this fix its system prompt and
    // state block carried ONLY ids, so it never saw the word "Gareth" anywhere
    // and improvised "Anwen" from the old name-bearing id p1_anwen in live narration.
    const gareth = { ...character('p1_warrior'), name: 'Gareth' };
    const rat = { ...monster('giant-rat-1'), name: 'Giant Rat' };
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [gareth],
      monstersInScene: [rat],
      persona: 'p',
    });
    expect(text).toContain('p1_warrior (Gareth)');
    expect(text).toContain('giant-rat-1 (Giant Rat)');
    // And an explicit rule: speak names, never ids — never guess a name from an id.
    expect(text).toMatch(/SPEAK NAMES, NOT IDS/);
  });

  it('DM state block carries names next to ids', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const gareth = { ...character('p1_warrior'), name: 'Gareth' };
    const rat = { ...monster('giant-rat-1'), name: 'Giant Rat' };
    const out = b.buildDm({
      party: [gareth],
      monstersInScene: [rat],
      persona: 'p',
      adventure, activeScene: adventure.scenes[0]!,
      observation: { kind: 'between_turns', summary: 'React.' },
      history: [], currentTurnIdx: 0,
    });
    const tail = out.messages[out.messages.length - 1]!.content.map((c) => c.text).join('\n');
    expect(tail).toContain('p1_warrior (Gareth)');
    expect(tail).toContain('giant-rat-1 (Giant Rat)');
  });

  it('forbids the DM from narrating initiative rolls or turn order', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'p',
    });
    expect(text.toLowerCase()).toContain('per character');
    expect(text).toMatch(/forbidden/i);
    // Both the team-based and per-character "X goes/acts first" phrasings
    // must be listed so the DM doesn't reintroduce either form.
    expect(text).toContain('Heroes goes first');
    expect(text).toContain('heroes go first');
    expect(text).toMatch(/goes first.*forbidden|forbidden.*goes first/is);
  });

  it('includes a CONCLUSION block referenced for combat end', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'p',
    });
    expect(text).toMatch(/CONCLUSION/);
    expect(text).toMatch(/combat end|combat ends|when combat ends/i);
  });

  it('clarifies that scene monsters are auto-revealed (F23)', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'p',
    });
    expect(text.toLowerCase()).toMatch(/auto-?placed|auto-?reveal|auto-?revealed/);
    expect(text).toMatch(/do NOT call reveal_monster/i);
  });

  it('reads the INTRO box on scene entry', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'p',
    });
    expect(text).toMatch(/INTRO \(read or paraphrase/);
    expect(text).toContain('You enter.');
  });

  it('renders SCENE FLOW listing every scene id, marking the active one, and showing transitions', () => {
    const multiSceneAdventure: Adventure = {
      id: asAdventureId('chain'), title: 'Chain',
      estimatedDurationMin: 30,
      scenes: [
        { id: asSceneId('one'),   intro: 'i', conclusion: 'c', tactics: '',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
          monsters: [], abilityTests: [],
          transitions: [{ to: 'two', trigger: 'all-monsters-ko' }] },
        { id: asSceneId('two'),   intro: 'i', conclusion: 'c', tactics: '',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
          monsters: [], abilityTests: [],
          transitions: [
            { to: 'three',  trigger: 'manual' },
            { to: 'detour', trigger: 'manual' },
          ] },
        { id: asSceneId('three'), intro: 'i', conclusion: 'c', tactics: '',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
          monsters: [], abilityTests: [],
          transitions: [{ to: 'END', trigger: 'all-monsters-ko' }] },
        { id: asSceneId('detour'), intro: 'i', conclusion: 'c', tactics: '',
          map: { width: 5, height: 5, background: 'bg', obstacles: [], decorations: [], exits: [], walls: true, npcs: [] },
          monsters: [], abilityTests: [],
          transitions: [{ to: 'three', trigger: 'manual' }] },
      ],
    };
    const text = renderDmSystem({
      adventure: multiSceneAdventure,
      activeScene: multiSceneAdventure.scenes[1]!,  // "two"
      party: [character('p1')],
      monstersInScene: [],
      persona: 'p',
    });
    expect(text).toMatch(/SCENE FLOW/);
    // Active scene is marked with *.
    expect(text).toMatch(/\* two:/);
    // Non-active scenes are listed but unmarked.
    expect(text).toMatch(/ {2}one:/);
    expect(text).toMatch(/ {2}three:/);
    expect(text).toMatch(/ {2}detour:/);
    // Transitions render with trigger→destination.
    expect(text).toMatch(/all-monsters-ko→two/);
    expect(text).toMatch(/manual→three/);
    expect(text).toMatch(/manual→detour/);
    expect(text).toMatch(/all-monsters-ko→END/);
    // DM is told to call set_scene on a transition.
    expect(text).toMatch(/set_scene/);
  });
});

describe('player system prompt — specialAction description', () => {
  it('includes specialAction.description in the rendered text', () => {
    // Reuse the file's existing stubHero/character helper. The hero's specialAction.description
    // should be 'Strike all adjacent enemies (1 melee die per target).' or similar — make sure
    // the helper sets it to a non-empty string.
    const text = renderPlayerSystem({
      character: stubHero(),
      persona: 'persona body',
      partyDescription: 'a party',
    });
    expect(text).toMatch(/Whirlwind Attack/); // name still present
    expect(text).toMatch(/Strike all adjacent enemies/); // description surfaced
  });

  it('falls back to "(no description)" when specialAction.description is empty', () => {
    const c = stubHero();
    c.specialAction = { ...c.specialAction, description: '' };
    const text = renderPlayerSystem({
      character: c, persona: '', partyDescription: '',
    });
    expect(text).toMatch(/Special action:[^\n]*\(no description\)/);
  });
});

describe('PromptBuilder — system text invariance under state changes (F12)', () => {
  it('produces identical system text before and after a position change', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const c = stubHero();
    const before = builder.buildPlayer({
      character: c, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const cMoved = { ...c, pos: { x: 5, y: 5 } };
    const after = builder.buildPlayer({
      character: cMoved, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    expect(after.system.map((s) => s.text)).toEqual(before.system.map((s) => s.text));
  });

  it('produces identical system text before and after an HP change', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const c = stubHero();
    const before = builder.buildPlayer({
      character: c, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const cHurt = { ...c, health: { ...c.health, damage: 2 } };
    const after = builder.buildPlayer({
      character: cHurt, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    expect(after.system.map((s) => s.text)).toEqual(before.system.map((s) => s.text));
  });

  it('emits a dynamic state-block message segment that DOES change with state', () => {
    const builder = new PromptBuilder({ snapshotEveryTurns: 3 });
    const c = stubHero();
    const a = builder.buildPlayer({
      character: c, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const cMoved = { ...c, pos: { x: 5, y: 5 } };
    const b = builder.buildPlayer({
      character: cMoved, persona: 'p', partyDescription: 'allies',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    // The state block is somewhere in messages — the user-message segment that
    // contains "CURRENT STATE" should differ between the two snapshots.
    const findStateText = (msgs: typeof a.messages): string | undefined =>
      msgs.flatMap((m) => m.content.map((c) => c.text)).find((t) => t.includes('CURRENT STATE'));
    expect(findStateText(a.messages)).toBeDefined();
    expect(findStateText(b.messages)).toBeDefined();
    expect(findStateText(a.messages)).not.toEqual(findStateText(b.messages));
  });
});

describe('Player system prompt — closing-step + step_budget_exhausted docs (F1, F15)', () => {
  it('contains the CLOSING-STEP RULE', () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/CLOSING-STEP RULE/);
    expect(text).toMatch(/end_turn directly/);
  });

  it('explains step_budget_exhausted', () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/step_budget_exhausted/);
    expect(text).toMatch(/force end_turn|forced end_turn|end_turn for you/);
  });

  it('includes the CLOSING-STEP RULE anti-pattern (F1 followup)', () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/ANTI-PATTERN/);
    expect(text).toMatch(/wasted steps/i);
  });

  it("MOVEMENT RULES clarifies KO'd character behavior (F25)", () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/KO'd|knocked out/i);
    // A corpse is passable: the doctrine must tell heroes they can walk
    // THROUGH a downed character's square (the engine allows it), not route
    // around it. Asserting walk-through guards against the prior bug where the
    // prompt wrongly claimed KO'd squares block movement.
    expect(text).toMatch(/walk (straight )?through|does NOT block|passable/i);
    expect(text).not.toMatch(/route around/i);
  });

  it('REACTIVITY: tells AI agents to adapt to teammate actions, including friendly fire', () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/REACTIVITY/);
    // Three concrete cues an AI agent should react to.
    expect(text.toLowerCase()).toMatch(/hp|health|knocked out|ko'd/);
    expect(text.toLowerCase()).toMatch(/surprising|unusual|retreated/);
    expect(text.toLowerCase()).toMatch(/coordination|hold the|burn the/);
    // Friendly fire from the human is explicitly called out — agents shouldn't
    // be oblivious if Bran shoots them, they should react in dialogue.
    expect(text.toLowerCase()).toMatch(/friendly[- ]fire/);
  });

  it('COORDINATE: teaches the team mechanics (engagement, focus-fire, breach, cover, covering the wounded)', () => {
    const text = renderPlayerSystem({
      character: stubHero(), persona: '', partyDescription: '',
    });
    expect(text).toMatch(/COORDINATE WITH YOUR PARTY/);
    expect(text.toLowerCase()).toMatch(/engaged|gang up/);   // engagement / Teamwork
    expect(text.toLowerCase()).toMatch(/focus fire/);        // concentrate damage
    expect(text.toLowerCase()).toMatch(/cover the wounded|at 1 hp|down/); // protect low allies
    expect(text.toLowerCase()).toMatch(/breach|barrier|chokepoint|gap/);  // split work at a wall
    expect(text).toMatch(/YOUR PARTY|FOES/);                 // points at the awareness blocks
  });

  it('COORDINATE tip is tailored to the hero passive', () => {
    // Warrior (teamwork) → engage-to-buff tip.
    const warrior = renderPlayerSystem({ character: stubHero(), persona: '', partyDescription: '' });
    expect(warrior).toMatch(/Teamwork passive/);

    // Warlock (power-surge / flame-burst) → friendly-fire warning.
    const warlock: Character = {
      ...character('p2'),
      specialAction: { id: asEffectId('flame-burst'), name: 'Flame Burst', description: '' },
      bonusAbility: { id: asEffectId('power-surge'), name: 'Power Surge', description: '' },
    };
    const wlText = renderPlayerSystem({ character: warlock, persona: '', partyDescription: '' });
    expect(wlText).toMatch(/Flame Burst hits/);
    expect(wlText).toMatch(/ALLIES INCLUDED/);

    // Healer (potion-brewer) → pivot-to-lowest tip.
    const healer: Character = {
      ...character('p3'),
      bonusAbility: { id: asEffectId('potion-brewer'), name: 'Potion Brewer', description: '' },
    };
    const hText = renderPlayerSystem({ character: healer, persona: '', partyDescription: '' });
    expect(hText.toLowerCase()).toMatch(/lifeline|lowest/);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('DM template — human-input interpretation guidance (post-audit followups)', () => {
  it('uses `say` (not narrate) for clarifying questions', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [stubHero()],
      monstersInScene: [],
      persona: 'p',
    });
    // The fallback must use `say`, not `narrate`, because narrate isn't in PLAYER_TOOLS
    // (which is what the runtime swaps in during interpretFreeText).
    expect(text).toMatch(/call `?say`?/i);
    // Sanity: in the interpretation block specifically, narrate should NOT appear as
    // the fallback. (It's still allowed elsewhere in the DM prompt.)
    const interpBlock = text.split('INTERPRETING THE HUMAN')[1] ?? '';
    expect(interpBlock.toLowerCase()).not.toMatch(/call narrate instead/);
  });

  it('tells the DM to emit multiple tool calls for multi-action human input', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [stubHero()],
      monstersInScene: [],
      persona: 'p',
    });
    const interpBlock = text.split('INTERPRETING THE HUMAN')[1] ?? '';
    expect(interpBlock).toMatch(/(one tool call per|multiple tool calls|sub-action|two actions)/i);
    // Mention move + attack as the canonical two-action example
    expect(interpBlock.toLowerCase()).toMatch(/move/);
    expect(interpBlock.toLowerCase()).toMatch(/normal_attack|attack/);
  });

  it('NARRATION RULES forbids inventing house-rules in DM narration', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [stubHero()],
      monstersInScene: [],
      persona: 'p',
    });
    expect(text).toMatch(/NARRATION RULES/);
    // The DM is told the engine — not them — decides what's allowed.
    expect(text.toLowerCase()).toMatch(/single source of truth|the engine.*decides|engine is the/);
    // Specifically forbid the lawyer-ban phrasings observed in past runs.
    expect(text).toMatch(/off the table|not a valid action|won't allow/);
    // Agency framing.
    expect(text.toLowerCase()).toMatch(/player agency|player.*paramount|render outcomes/);
  });
});

describe('DM persona — conclusion text rule (F10)', () => {
  it('mentions reading the conclusion faithfully on combat end', () => {
    const personaPath = path.join(__dirname, '../../../personas/dm-default.md');
    const persona = readFileSync(personaPath, 'utf8');
    expect(persona.toLowerCase()).toMatch(/conclusion/);
    expect(persona.toLowerCase()).toMatch(/combat end|combat ends|when combat ends/);
  });

  it('reminds the DM not to call end_combat manually after auto-end', () => {
    const personaPath = path.join(__dirname, '../../../personas/dm-default.md');
    const persona = readFileSync(personaPath, 'utf8');
    expect(persona.toLowerCase()).toMatch(/(do not call end_combat|don't call end_combat|engine has already)/);
  });
});

describe('DM system prompt — creative worldbuilding', () => {
  it('documents spawn_prop, remove_prop, and the dice-roll-first contract', () => {
    const text = renderDmSystem({
      adventure,
      activeScene: adventure.scenes[0]!,
      party: [character('p1')],
      monstersInScene: [monster('m1')],
      persona: 'p',
    });
    expect(text).toMatch(/CREATIVE WORLDBUILDING/);
    expect(text).toMatch(/spawn_prop/);
    expect(text).toMatch(/remove_prop/);
    // Dice rolls are required before spawning.
    expect(text).toMatch(/ability_test/);
    expect(text.toLowerCase()).toMatch(/roll/);
    // Failure path stated.
    expect(text.toLowerCase()).toMatch(/fail/);
  });
});

describe('PromptBuilder — props in state block', () => {
  it('renders the current props list in the DM state block', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildDm({
      party: [character('p1')], monstersInScene: [],
      persona: 'p',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' },
      currentTurnIdx: 0,
      props: [{ id: 'cheese-1', emoji: '🧀', name: 'Wheel of cheese', pos: { x: 2, y: 3 }, description: 'half-nibbled' }],
    });
    const tail = out.messages[out.messages.length - 1]!;
    const text = tail.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/PROPS ON THE GRID/);
    expect(text).toMatch(/cheese-1/);
    expect(text).toMatch(/🧀/);
    expect(text).toMatch(/half-nibbled/);
  });

  it('renders "(none)" when there are no props', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    const out = b.buildPlayer({
      character: character('p1'), persona: 'p', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const tail = out.messages[out.messages.length - 1]!;
    const text = tail.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/PROPS ON THE GRID:\s*\n\s+\(none\)/);
  });
});

describe('PromptBuilder — game language (pt directive)', () => {
  const buildBoth = (b: PromptBuilder) => {
    const player = b.buildPlayer({
      character: character('p1'), persona: 'p', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    const dm = b.buildDm({
      party: [character('p1')], monstersInScene: [], persona: 'p',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    return { player: player.system[0]!.text, dm: dm.system[0]!.text };
  };

  it('default (en) injects NO language directive into either system prompt', () => {
    const { player, dm } = buildBoth(new PromptBuilder({ snapshotEveryTurns: 3 }));
    expect(player).not.toMatch(/IDIOMA/);
    expect(dm).not.toMatch(/IDIOMA/);
  });

  it("language 'pt' injects the pt-BR directive into BOTH system prompts", () => {
    const { player, dm } = buildBoth(new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' }));
    expect(player).toMatch(/IDIOMA — PORTUGUÊS \(BRASIL\)/);
    expect(dm).toMatch(/IDIOMA — PORTUGUÊS \(BRASIL\)/);
    // Tool ids must stay untranslated — the directive says so explicitly.
    expect(player).toMatch(/NUNCA são\s+traduzidos/);
    expect(dm).toMatch(/NUNCA são\s+traduzidos/);
  });

  it('setLanguage() reroutes subsequent builds (the hero-select pick)', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    expect(buildBoth(b).player).not.toMatch(/IDIOMA/);
    b.setLanguage('pt');
    const { player, dm } = buildBoth(b);
    expect(player).toMatch(/IDIOMA — PORTUGUÊS \(BRASIL\)/);
    expect(dm).toMatch(/IDIOMA — PORTUGUÊS \(BRASIL\)/);
    b.setLanguage('en');
    expect(buildBoth(b).dm).not.toMatch(/IDIOMA/);
  });

  it('the directive renders identically across repeated builds (cache-stable)', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' });
    const first = buildBoth(b);
    const second = buildBoth(b);
    expect(second.player).toBe(first.player);
    expect(second.dm).toBe(first.dm);
  });
});

describe('DM system prompt — pt scene prose overlay', () => {
  const ptAdventure: Adventure = {
    ...adventure,
    scenes: [{
      ...adventure.scenes[0]!,
      i18n: { pt: { intro: 'Vocês entram.', conclusion: 'Acaba aqui.' } },
    }],
  };

  const dmSystem = (b: PromptBuilder, adv: Adventure): string =>
    b.buildDm({
      party: [character('p1')], monstersInScene: [], persona: 'p',
      adventure: adv, activeScene: adv.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    }).system[0]!.text;

  it("renders the pt intro/conclusion when the language is 'pt'", () => {
    const text = dmSystem(new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' }), ptAdventure);
    expect(text).toContain('Vocês entram.');
    expect(text).toContain('Acaba aqui.');
    expect(text).not.toContain('You enter.');
    expect(text).not.toContain('It ends.');
  });

  it('keeps English prose for en sessions and for scenes without an overlay', () => {
    const en = dmSystem(new PromptBuilder({ snapshotEveryTurns: 3 }), ptAdventure);
    expect(en).toContain('You enter.');
    expect(en).not.toContain('Vocês entram.');
    // pt session, but the scene has no overlay → English fallback.
    const noOverlay = dmSystem(new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' }), adventure);
    expect(noOverlay).toContain('You enter.');
  });
});

describe('PromptBuilder — localized persona ({ en, pt })', () => {
  const localized = { en: 'I am cautious.', pt: 'Eu sou cauteloso.' };

  const playerSystem = (b: PromptBuilder): string =>
    b.buildPlayer({
      character: character('p1'), persona: localized, partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    }).system[0]!.text;

  const dmSystem = (b: PromptBuilder): string =>
    b.buildDm({
      party: [character('p1')], monstersInScene: [], persona: localized,
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    }).system[0]!.text;

  it('renders the pt persona for a pt session, in BOTH prompts', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' });
    expect(playerSystem(b)).toContain('Eu sou cauteloso.');
    expect(playerSystem(b)).not.toContain('I am cautious.');
    expect(dmSystem(b)).toContain('Eu sou cauteloso.');
    expect(dmSystem(b)).not.toContain('I am cautious.');
  });

  it('renders the en persona for an en session', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    expect(playerSystem(b)).toContain('I am cautious.');
    expect(playerSystem(b)).not.toContain('Eu sou cauteloso.');
  });

  it('falls back to en in a pt session when the persona has no pt variant', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' });
    const out = b.buildPlayer({
      character: character('p1'), persona: { en: 'EN only.' }, partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    expect(out.system[0]!.text).toContain('EN only.');
  });

  it('a plain-string persona keeps working in both languages (legacy shape)', () => {
    const pt = new PromptBuilder({ snapshotEveryTurns: 3, language: 'pt' });
    const out = pt.buildPlayer({
      character: character('p1'), persona: 'Plain string persona.', partyDescription: '',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
    });
    expect(out.system[0]!.text).toContain('Plain string persona.');
  });

  it('setLanguage flips which persona variant subsequent builds render', () => {
    const b = new PromptBuilder({ snapshotEveryTurns: 3 });
    expect(playerSystem(b)).toContain('I am cautious.');
    b.setLanguage('pt');
    expect(playerSystem(b)).toContain('Eu sou cauteloso.');
  });
});

describe('DM system prompt — uiShowsIntro suppression (browser splash owns the intro)', () => {
  const dmSystem = (uiShowsIntro?: boolean): string =>
    new PromptBuilder({ snapshotEveryTurns: 3 }).buildDm({
      party: [character('p1')], monstersInScene: [], persona: 'p',
      adventure, activeScene: adventure.scenes[0]!,
      history: [], observation: { kind: 'fresh_turn' }, currentTurnIdx: 0,
      ...(uiShowsIntro !== undefined ? { uiShowsIntro } : {}),
    }).system[0]!.text;

  it('uiShowsIntro: true renders the do-NOT-narrate block and OMITS the intro text', () => {
    const text = dmSystem(true);
    expect(text).toMatch(/OPENING \(already on screen — do NOT narrate it\)/);
    expect(text).not.toContain('You enter.');
    expect(text).not.toMatch(/INTRO \(read or paraphrase faithfully on entry\)/);
  });

  it('without the flag the DM is told to read the intro (headless / CLI / later scenes)', () => {
    const text = dmSystem();
    expect(text).toMatch(/INTRO \(read or paraphrase faithfully on entry\)/);
    expect(text).toContain('You enter.');
    expect(text).not.toMatch(/do NOT narrate it/);
  });
});
