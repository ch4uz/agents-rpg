import type { Character } from '../../../engine/character.js';
import type { EmojiProp } from '../../../engine/snapshot.js';

export interface PlayerStateBlockCtx {
  character: Character;
  /** Other heroes on the board (live HP / position / status) so this hero can
   *  reason about the team — cover the wounded, flank together, divide work.
   *  Public info (minis + health boxes are visible at the table). */
  party?: ReadonlyArray<Character>;
  /** Living + downed foes on the board (live HP / position) so this hero can
   *  focus-fire the right target and judge who is about to gang up on whom. */
  foes?: ReadonlyArray<Character>;
  props?: ReadonlyArray<EmojiProp>;
  obstacles?: ReadonlyArray<{ type: string; x: number; y: number; durability?: number; remaining?: number; explosive?: boolean; cover?: boolean; attackProof?: boolean; pushable?: boolean }>;
}

export interface DmStateBlockCtx {
  party: Character[];
  monstersInScene: Character[];
  props?: ReadonlyArray<EmojiProp>;
}

const renderPropsLines = (props: ReadonlyArray<EmojiProp> | undefined): string => {
  if (!props || props.length === 0) return '  (none)';
  return props.map((p) => {
    const desc = p.description ? ` — ${p.description}` : '';
    // A CHEST is lootable: stand adjacent and open_chest to take its item. A
    // BAIT (thrown cheese, a shiny coin, …) is a lure: greedy foes break off to
    // scramble for it.
    let tag = '';
    if (p.chest) {
      tag = ` [CHEST — stand ADJACENT (within 1 square) and open_chest with chestId="${p.id}" to take ${p.chest.contents} into your inventory]`;
    } else if (p.bait) {
      tag = ` [BAIT — greedy foes abandon the heroes and rush this cell; the first to reach it grabs it. Use it to pull a pack off a wounded ally or clear a lane]`;
    }
    return `  - ${p.id} ${p.emoji} "${p.name}" pos=(${p.pos.x},${p.pos.y})${desc}${tag}`;
  }).join('\n');
};

const hp = (c: Character): string => `${c.health.total - c.health.damage}/${c.health.total}`;
const at = (c: Character): string => (c.pos ? `(${c.pos.x},${c.pos.y})` : 'unplaced');

/** The attack a character leads with, e.g. "melee 2d6 reach 1" / "ranged 2d6 reach 6". */
const attackOf = (c: Character): string => {
  const kind = c.normalAttack.kind;
  return `${kind} ${c.pools[kind]}d6 reach ${c.normalAttack.range}`;
};

const renderPartyLines = (party: ReadonlyArray<Character> | undefined): string => {
  if (!party || party.length === 0) return '  (you are on your own here)';
  return party.map((c) => {
    const arch = c.archetype ? ` the ${c.archetype}` : '';
    // A bound teammate is a rescue objective: foes can hurt or kill them while
    // they're helpless, so flag it loudly with the action that frees them.
    const bound = c.health.status === 'immobilized'
      ? ` — IMMOBILIZED! reach them (stand adjacent) and free_ally to cut them loose; foes can hurt them while bound`
      : ` — ${attackOf(c)}; special: ${c.specialAction.name}`;
    return `  - ${c.id} (${c.name}${arch}) HP ${hp(c)} ${at(c)} status=${c.health.status}` + bound;
  }).join('\n');
};

const renderFoeLines = (foes: ReadonlyArray<Character> | undefined): string => {
  if (!foes || foes.length === 0) return '  (none in sight)';
  // Living foes first (the threats you act on), downed ones last (corpses —
  // don't target them, but they do NOT block movement: walk straight through).
  const ordered = [...foes].sort((a, b) =>
    Number(a.health.status === 'KO') - Number(b.health.status === 'KO'));
  return ordered.map((m) => {
    const down = m.health.status === 'KO' ? ' (DOWN — a corpse; do not target it, but its square is passable: you can walk through or even end on it)' : '';
    return `  - ${m.id} (${m.name}) HP ${hp(m)} ${at(m)} status=${m.health.status}` +
           ` — ${attackOf(m)}${down}`;
  }).join('\n');
};

const renderObstacleLines = (
  obstacles: PlayerStateBlockCtx['obstacles'],
): string => {
  if (!obstacles || obstacles.length === 0) return '  (none)';
  return obstacles.map((o) => {
    // A multi-hit obstacle shows its live durability so the hero knows how many
    // more attack_object hits it will take to break.
    const tough = o.durability && o.durability > 1
      ? ` durability=${o.remaining ?? o.durability}/${o.durability} (needs ${o.remaining ?? o.durability} more hit(s) to break)`
      : '';
    // An explosive obstacle is a coordination opportunity: smashing it bursts
    // and hits EVERY creature adjacent — foes and heroes alike. The play is to
    // herd enemies next to it, then detonate with no ally (and ideally a ranged
    // hero, since a melee smasher stands adjacent and catches its own blast).
    const boom = o.explosive
      ? ` — EXPLOSIVE: smashing it bursts and damages every creature adjacent (FOES and HEROES, including the smasher). Lure rats next to it, then pop it with a hero who is NOT adjacent (ranged) — a coordinated detonation. Its blast ALSO shatters attack-proof stalagmites in range, so push it flush against a stalagmite wall and detonate to blow a breach.`
      : '';
    // A pushable obstacle (e.g. an oil cask) can be shoved one cell with the
    // roll-less push_object action — reposition an explosive next to a wall or
    // a cluster of foes before detonating it.
    const shove = o.pushable
      ? ` — PUSHABLE: stand adjacent and push_object to shove it ONE cell straight away from you into empty floor (no roll, costs your action).`
      : '';
    // An ATTACK-PROOF stalagmite (cave stone) cannot be smashed by attacks or
    // spells — do NOT attack_object it (it will be rejected). The ONLY way
    // through is an explosion (detonate a cask beside it).
    if (o.attackProof) {
      return `  - ${o.type} at (${o.x},${o.y}) [ATTACK-PROOF STALAGMITE — blocks movement AND line of sight; CANNOT be smashed by attacks/spells. The ONLY way to clear it is an EXPLOSION: push an oil cask next to it and detonate the cask.]`;
    }
    // COVER obstacles block movement (you can't walk through a barrel stack) but
    // let a ranged/magic shot pass for the +1-armor cover bonus. BARRIERS (the
    // default) block sight too. Either way: go around, smash, or squeeze past.
    const kind = o.cover
      ? ` [COVER — blocks movement (you CANNOT walk through it), but you CAN shoot a foe behind it; the foe gets +1 armor die]`
      : ` [BARRIER — blocks movement AND line of sight; shots cannot pass]`;
    return `  - ${o.type} at (${o.x},${o.y})${tough}${boom}${shove}${kind}`;
  }).join('\n');
};

export const renderPlayerStateBlock = (ctx: PlayerStateBlockCtx): string => {
  const c = ctx.character;
  const inv = c.inventory.length === 0
    ? '(empty)'
    : c.inventory.map((s) => `${s.itemId}×${s.count}`).join(', ');
  const posStr = c.pos ? `(${c.pos.x}, ${c.pos.y})` : 'unplaced';
  return `CURRENT STATE — you are ${c.id} (${c.name})
  Position: ${posStr}     Health: ${c.health.total - c.health.damage}/${c.health.total} (${c.health.status})
  Inventory: ${inv}
YOUR PARTY (live — these are your teammates; coordinate with them):
${renderPartyLines(ctx.party)}
FOES (live — focus your fire; a foe at 1 HP still bites at full strength):
${renderFoeLines(ctx.foes)}
PROPS ON THE GRID:
${renderPropsLines(ctx.props)}
OBSTACLES ON THE GRID (inanimate Things; each tagged COVER or BARRIER below):
${renderObstacleLines(ctx.obstacles)}
  A BARRIER blocks movement AND line of sight — to get past it you can either
  (a) attack_object it to smash it (tough ones take several hits, shown above as
  durability) or (b) ability_test (Dexterity/Strength) to climb/squeeze past it.
  An ATTACK-PROOF STALAGMITE wall is different: attacks and spells do NOTHING to
  it — the ONLY way through is an EXPLOSION. Push a PUSHABLE oil cask flush
  against it (push_object), then have a hero who is NOT adjacent detonate the
  cask (attack_object) so the blast shatters the stalagmites and opens a breach.
  COVER also blocks movement (you CANNOT walk through it), but unlike a BARRIER
  it does NOT block line of sight: you can still fire a ranged/magic attack at a
  foe behind it (the foe just gains +1 armor die). To physically get past a COVER
  obstacle, smash it (attack_object) or squeeze past (ability_test). Both
  attack_object and ability_test roll dice; push_object does not.`;
};

/** `p1_warrior (Gareth)` — id for tool params, name for narration. Without the
 *  name the DM improvises one from the id (a name-bearing id `p1_anwen` once
 *  read as "Anwen" live); skip the parens when the name IS the id (fixtures). */
const idAndName = (c: Character): string =>
  (c.name && c.name !== c.id ? `${c.id} (${c.name})` : c.id);

export const renderDmStateBlock = (ctx: DmStateBlockCtx): string => {
  const partyLines = ctx.party.map(
    (c) => `  - ${idAndName(c)} HP ${c.health.total - c.health.damage}/${c.health.total} pos=(${c.pos?.x},${c.pos?.y}) status=${c.health.status}`,
  ).join('\n');
  const monsterLines = ctx.monstersInScene.map(
    (m) => `  - ${idAndName(m)} HP ${m.health.total - m.health.damage}/${m.health.total} pos=(${m.pos?.x},${m.pos?.y}) status=${m.health.status}`,
  ).join('\n') || '  (none placed yet)';
  return `CURRENT STATE
PARTY:
${partyLines}
MONSTERS PRESENT:
${monsterLines}
PROPS ON THE GRID:
${renderPropsLines(ctx.props)}`;
};
