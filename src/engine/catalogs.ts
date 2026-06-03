import { z } from 'zod';

const PoolsSchema = z.object({
  melee: z.number().int().min(0).max(6),
  ranged: z.number().int().min(0).max(6),
  magic: z.number().int().min(0).max(6),
  armor: z.number().int().min(0).max(6),
});

const AttackSpecSchema = z.object({
  kind: z.enum(['melee', 'ranged', 'magic']),
  name: z.string().min(1),
  range: z.number().int().min(1).max(20),
  damageMod: z.number().int().min(-2).max(5),
});

const NamedEffectSchema = z.object({
  effectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
});

const ItemStackSchema = z.object({
  itemId: z.string().min(1),
  count: z.number().int().min(1),
});

export const HeroEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  archetype: z.enum(['warrior', 'hunter', 'healer', 'warlock', 'rogue', 'knight', 'brute']),
  /** One-line, kid-friendly flavor description shown on the hero-select cards
   *  at game start. Optional: missing entries fall back to a composed summary
   *  (archetype + signature attack) so old fixtures still load unchanged. */
  blurb: z.string().optional(),
  pools: PoolsSchema,
  /** Dexterity modifier added to the initiative d6. Range -2..+5. Optional
   *  in the catalog: missing entries are treated as 0 by consumers so old
   *  fixtures still load without modification. */
  dex: z.number().int().min(-2).max(5).optional(),
  healthTotal: z.number().int().min(1).max(3),  // HeroKids heroes are 3 boxes by default; this scenario tunes some heroes lower
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  defaultInventory: z.array(ItemStackSchema),
  defaultSkills: z.array(z.string()),
  defaultEquipped: z.string().optional(),
  sprite: z.string().min(1),
});

export const MonsterEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pools: PoolsSchema,
  /** Dexterity modifier added to the initiative d6. Range -2..+5. Optional;
   *  missing entries are treated as 0 by consumers. */
  dex: z.number().int().min(-2).max(5).optional(),
  healthTotal: z.number().int().min(1).max(4),  // weak=1, normal=2, tough=3, boss=4
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  sprite: z.string().min(1),
});

export const NpcEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pools: PoolsSchema,
  /** Dexterity modifier added to the initiative d6. Range -2..+5. Optional;
   *  missing entries are treated as 0 by consumers. */
  dex: z.number().int().min(-2).max(5).optional(),
  healthTotal: z.number().int().min(1).max(4),
  normalAttack: AttackSpecSchema,
  specialAction: NamedEffectSchema,
  bonusAbility: NamedEffectSchema,
  sprite: z.string().min(1),
});

export const ItemEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    // 'throwable' items (e.g. cheese bait) are neither used (use_item) nor
    // skill-bonus utilities — they have their own action (throw_cheese), so
    // they need neither consumableEffect nor skillBonus.
    category: z.enum(['consumable', 'utility', 'throwable']),
    consumableEffect: z.string().optional(),
    skillBonus: z.array(z.string()).optional(),
    icon: z.string().min(1),
  })
  .refine(
    (v) => (v.category === 'consumable' ? !!v.consumableEffect : true),
    { message: 'consumable items require consumableEffect' },
  )
  .refine(
    (v) => (v.category === 'utility' ? Array.isArray(v.skillBonus) && v.skillBonus.length > 0 : true),
    { message: 'utility items require non-empty skillBonus' },
  );

export const EquipmentEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  effectId: z.string().min(1),
  icon: z.string().min(1),
});

export const BoonEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  effectId: z.string().min(1),
  icon: z.string().min(1),
});

export type HeroEntry = z.infer<typeof HeroEntrySchema>;
export type MonsterEntry = z.infer<typeof MonsterEntrySchema>;
export type NpcEntry = z.infer<typeof NpcEntrySchema>;
export type ItemEntry = z.infer<typeof ItemEntrySchema>;
export type EquipmentEntry = z.infer<typeof EquipmentEntrySchema>;
export type BoonEntry = z.infer<typeof BoonEntrySchema>;
