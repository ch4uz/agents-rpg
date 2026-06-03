import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HeroEntrySchema,
  MonsterEntrySchema,
  NpcEntrySchema,
  ItemEntrySchema,
  EquipmentEntrySchema,
  BoonEntrySchema,
  type HeroEntry,
  type MonsterEntry,
  type NpcEntry,
  type ItemEntry,
  type EquipmentEntry,
  type BoonEntry,
} from './catalogs.js';

export interface Catalogs {
  heroes: Map<string, HeroEntry>;
  monsters: Map<string, MonsterEntry>;
  npcs: Map<string, NpcEntry>;
  items: Map<string, ItemEntry>;
  equipment: Map<string, EquipmentEntry>;
  boons: Map<string, BoonEntry>;
}

const indexById = <T extends { id: string }>(entries: T[], label: string): Map<string, T> => {
  const out = new Map<string, T>();
  for (const e of entries) {
    if (out.has(e.id)) throw new Error(`Duplicate ${label} id: ${e.id}`);
    out.set(e.id, e);
  }
  return out;
};

const readJson = async <T>(filePath: string, schema: z.ZodSchema<T[]>): Promise<T[]> => {
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid catalog at ${filePath}: ${result.error.message}`);
  }
  return result.data;
};

export const loadCatalogs = async (dataDir: string): Promise<Catalogs> => {
  const heroes = indexById(
    await readJson(path.join(dataDir, 'heroes.json'), z.array(HeroEntrySchema)),
    'hero',
  );
  const monsters = indexById(
    await readJson(path.join(dataDir, 'monsters.json'), z.array(MonsterEntrySchema)),
    'monster',
  );
  const npcs = indexById(
    await readJson(path.join(dataDir, 'npcs.json'), z.array(NpcEntrySchema)),
    'npc',
  );
  const items = indexById(
    await readJson(path.join(dataDir, 'items.json'), z.array(ItemEntrySchema)),
    'item',
  );
  const equipment = indexById(
    await readJson(path.join(dataDir, 'equipment.json'), z.array(EquipmentEntrySchema)),
    'equipment',
  );
  const boons = indexById(
    await readJson(path.join(dataDir, 'boons.json'), z.array(BoonEntrySchema)),
    'boon',
  );

  // Cross-ref validation: every hero's defaultInventory.itemId must exist.
  for (const hero of heroes.values()) {
    for (const stack of hero.defaultInventory) {
      if (!items.has(stack.itemId)) {
        throw new Error(`Hero "${hero.id}" references unknown item id: ${stack.itemId}`);
      }
    }
    if (hero.defaultEquipped && !equipment.has(hero.defaultEquipped)) {
      throw new Error(`Hero "${hero.id}" references unknown equipment id: ${hero.defaultEquipped}`);
    }
  }

  return { heroes, monsters, npcs, items, equipment, boons };
};
