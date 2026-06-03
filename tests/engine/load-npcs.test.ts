import { describe, it, expect } from 'vitest';
import { loadCatalogs } from '../../src/engine/load.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('loadCatalogs - npcs', () => {
  it('exposes an empty Map when npcs.json is []', async () => {
    const tmpDir = await makeTmpCatalog({
      'heroes.json': [],
      'monsters.json': [],
      'npcs.json': [],
      'items.json': [],
      'equipment.json': [],
      'boons.json': [],
    });
    const cats = await loadCatalogs(tmpDir);
    expect(cats.npcs).toBeInstanceOf(Map);
    expect(cats.npcs.size).toBe(0);
  });
});

async function makeTmpCatalog(files: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-rpg-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(tmp, name), JSON.stringify(content));
  }
  return tmp;
}
