import type {
  CharacterId,
  ItemId,
  EquipmentId,
  BoonId,
  SkillId,
  EffectId,
} from './ids.js';
import type { Square } from './primitives.js';

export type Archetype =
  | 'warrior'
  | 'hunter'
  | 'healer'
  | 'warlock'
  | 'rogue'
  | 'knight'
  | 'brute';

export type AttackKind = 'melee' | 'ranged' | 'magic';

export interface AttackSpec {
  kind: AttackKind;
  name: string;
  /** Melee=1, ranged=6, magic=4. Per-character override allowed. */
  range: number;
  /** 0 for default 1-damage attacks. */
  damageMod: number;
}

export interface SpecialSpec {
  id: EffectId;       // resolved against the effects registry
  name: string;
  description: string;
}

export interface BonusSpec {
  id: EffectId;       // passive trigger
  name: string;
  description: string;
}

export interface ItemStack {
  itemId: ItemId;
  count: number;
}

export interface Character {
  id: CharacterId;
  name: string;
  kind: 'hero' | 'monster' | 'npc';
  archetype?: Archetype;
  sprite?: string;

  pools: {
    melee: number;
    ranged: number;
    magic: number;
    armor: number;
  };
  /** Dexterity modifier added to the initiative d6 at combat start. Defaults
   *  to 0 if absent — kept optional so older fixtures and tests still
   *  satisfy the type without an explicit value. */
  dex?: number;
  health: {
    total: number;
    damage: number;
    /**
     * `immobilized` is a non-KO condition: the character is on the board, can be
     * targeted and damaged, but cannot move or take a turn until an ally frees
     * them (`free_ally`). `applyDamage`/`healDamage` preserve it (only lethal
     * damage flips it to `KO`), so a bound captive can be hurt — even killed —
     * before rescue. Cleared back to `normal` when freed.
     */
    status: 'normal' | 'prone' | 'KO' | 'immobilized';
  };
  pos: Square | null;

  normalAttack: AttackSpec;
  specialAction: SpecialSpec;
  bonusAbility: BonusSpec;

  equipped?: EquipmentId;
  inventory: ItemStack[];
  boons: BoonId[];
  skills: SkillId[];

  persona?: string;
}

export const isKO = (c: Character): boolean => c.health.status === 'KO';

export const applyDamage = (c: Character, amount: number): Character => {
  if (amount <= 0) return c;
  const newDamage = Math.min(c.health.total, c.health.damage + amount);
  const status: Character['health']['status'] = newDamage >= c.health.total ? 'KO' : c.health.status;
  return {
    ...c,
    health: { ...c.health, damage: newDamage, status },
  };
};

export const healDamage = (c: Character, amount: number): Character => {
  if (amount <= 0) return c;
  const newDamage = Math.max(0, c.health.damage - amount);
  const status: Character['health']['status'] =
    newDamage < c.health.total && c.health.status === 'KO' ? 'normal' : c.health.status;
  return {
    ...c,
    health: { ...c.health, damage: newDamage, status },
  };
};
