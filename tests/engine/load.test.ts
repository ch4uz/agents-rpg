import { describe, it, expect } from 'vitest';
import { loadCatalogs } from '../../src/engine/load.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');

describe('loadCatalogs', () => {
  it('loads all six catalog files without error', async () => {
    const catalogs = await loadCatalogs(DATA_DIR);
    expect(catalogs.heroes.size).toBeGreaterThanOrEqual(4);
    expect(catalogs.monsters.size).toBeGreaterThanOrEqual(2);
    expect(catalogs.items.size).toBeGreaterThanOrEqual(6);
    expect(catalogs.equipment.size).toBeGreaterThanOrEqual(1);
    expect(catalogs.boons.size).toBe(0);
    expect(catalogs.npcs.size).toBe(2);
  });

  it('indexes heroes by id', async () => {
    const c = await loadCatalogs(DATA_DIR);
    const warrior = c.heroes.get('warrior');
    expect(warrior?.archetype).toBe('warrior');
    expect(warrior?.pools.melee).toBe(2);
  });

  it('throws on duplicate hero id', async () => {
    const tmpDir = await makeTmpCatalog({
      'heroes.json': [
        validHero({ id: 'warrior' }),
        validHero({ id: 'warrior' }),
      ],
      'monsters.json': [],
      'npcs.json': [],
      'items.json': [],
      'equipment.json': [],
      'boons.json': [],
    });
    await expect(loadCatalogs(tmpDir)).rejects.toThrow(/duplicate hero id/i);
  });

  it('throws on missing referenced item id in hero defaultInventory', async () => {
    const tmpDir = await makeTmpCatalog({
      'heroes.json': [validHero({ defaultInventory: [{ itemId: 'no-such-item', count: 1 }] })],
      'items.json': [],
      'monsters.json': [],
      'npcs.json': [],
      'equipment.json': [],
      'boons.json': [],
    });
    await expect(loadCatalogs(tmpDir)).rejects.toThrow(/unknown item id/i);
  });
});

// helpers (top-level since `import` not allowed inside `it()`)
async function makeTmpCatalog(files: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-rpg-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(tmp, name), JSON.stringify(content));
  }
  return tmp;
}

function validHero(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'warrior',
    name: 'Warrior',
    archetype: 'warrior',
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    healthTotal: 3,
    normalAttack: { kind: 'melee', name: 'Slash', range: 1, damageMod: 0 },
    specialAction: { effectId: 'whirlwind-attack', name: 'WW', description: '' },
    bonusAbility: { effectId: 'teamwork', name: 'TW', description: '' },
    defaultInventory: [],
    defaultSkills: [],
    sprite: 'warrior',
    ...overrides,
  };
}
