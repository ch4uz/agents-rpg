import { describe, it, expect } from 'vitest';
import { loadScenario } from '../../src/runtime/scenario.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const writeFile = (p: string, content: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

describe('scenario loader', () => {
  it('reads scenario JSON, inlines persona Markdown, and computes promptHash per agent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-'));

    writeFile(path.join(dir, 'personas', 'cautious.md'), 'You are cautious.');
    writeFile(path.join(dir, 'personas', 'reckless.md'), 'You are reckless.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'You are the DM.');

    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline',
      adventure: 'adventures/x.json',
      seed: 'seed-1',
      model: 'claude-sonnet-4-6',
      stepBudget: { player: 6, dm: 12 },
      snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/cautious.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/reckless.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h1', archetype: 'hunter' },
    }, null, 2));

    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.id).toBe('baseline');
    expect(scenario.agents.p1.persona).toBe('You are cautious.');
    expect(scenario.agents.p2.persona).toBe('You are reckless.');
    expect(scenario.agents.dm.persona).toBe('You are the DM.');
    expect(scenario.agentRecords).toHaveLength(3);
    for (const ar of scenario.agentRecords) {
      expect(ar.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // Same persona text → same hash; different text → different hash.
    const hashes = new Set(scenario.agentRecords.map((a) => a.promptHash));
    expect(hashes.size).toBe(3);
  });

  it('parses optional hero names for p1/p2/human and exposes them on the scenario', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-name-'));
    writeFile(path.join(dir, 'personas', 'cautious.md'), 'You are cautious.');
    writeFile(path.join(dir, 'personas', 'reckless.md'), 'You are reckless.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'You are the DM.');

    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline',
      adventure: 'adventures/x.json', seed: 's-1', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1_warrior', archetype: 'warrior', name: 'Anwen', persona: 'personas/cautious.md' },
        p2: { characterId: 'p2_warlock',  archetype: 'warlock', name: 'Kael',  persona: 'personas/reckless.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'human_hunter', archetype: 'hunter', name: 'Bran' },
    }, null, 2));

    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p1.name).toBe('Anwen');
    expect(scenario.agents.p2.name).toBe('Kael');
    expect(scenario.human.name).toBe('Bran');
  });

  it('omitting name is allowed (backward compatible)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-noname-'));
    writeFile(path.join(dir, 'personas', 'a.md'), 'a');
    writeFile(path.join(dir, 'personas', 'b.md'), 'b');
    writeFile(path.join(dir, 'personas', 'd.md'), 'd');

    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline',
      adventure: 'adventures/x.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/d.md' },
      },
      human: { characterId: 'h', archetype: 'hunter' },
    }, null, 2));

    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p1.name).toBeUndefined();
    expect(scenario.human.name).toBeUndefined();
  });

  it('loads an optional 3rd AI hero (p3) and records it in agentRecords', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-p3-'));
    writeFile(path.join(dir, 'personas', 'cautious.md'), 'You are cautious.');
    writeFile(path.join(dir, 'personas', 'reckless.md'), 'You are reckless.');
    writeFile(path.join(dir, 'personas', 'elara.md'), 'You are Elara.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'You are the DM.');

    const scenarioPath = path.join(dir, 'scenarios', 'cap.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'cap', adventure: 'adventures/x.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/cautious.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/reckless.md' },
        p3: { characterId: 'p3_healer', archetype: 'healer', name: 'Elara', persona: 'personas/elara.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h', archetype: 'hunter' },
    }, null, 2));

    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p3?.characterId).toBe('p3_healer');
    expect(scenario.agents.p3?.archetype).toBe('healer');
    expect(scenario.agents.p3?.name).toBe('Elara');
    expect(scenario.agents.p3?.persona).toBe('You are Elara.');
    expect(scenario.agentRecords).toHaveLength(4);
    expect(scenario.agentRecords.some((a) => a.role === 'p3' && a.characterId === 'p3_healer')).toBe(true);
  });

  it('p3 is optional — a 2-AI scenario omits it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-nop3-'));
    writeFile(path.join(dir, 'personas', 'a.md'), 'a');
    writeFile(path.join(dir, 'personas', 'b.md'), 'b');
    writeFile(path.join(dir, 'personas', 'd.md'), 'd');
    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline', adventure: 'adventures/x.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/d.md' },
      },
      human: { characterId: 'h', archetype: 'hunter' },
    }, null, 2));
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p3).toBeUndefined();
    expect(scenario.agentRecords).toHaveLength(3);
  });

  it('loads an optional human persona (for when the player picks a different hero)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-humanpersona-'));
    writeFile(path.join(dir, 'personas', 'a.md'), 'a');
    writeFile(path.join(dir, 'personas', 'b.md'), 'b');
    writeFile(path.join(dir, 'personas', 'd.md'), 'd');
    writeFile(path.join(dir, 'personas', 'bran.md'), 'You are Bran the hunter.');
    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline', adventure: 'adventures/x.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/d.md' },
      },
      human: { characterId: 'human_hunter', archetype: 'hunter', name: 'Bran', persona: 'personas/bran.md' },
    }, null, 2));
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.human.persona).toBe('You are Bran the hunter.');
  });

  it('human persona is optional — omitting it leaves human.persona undefined', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-nohumanpersona-'));
    writeFile(path.join(dir, 'personas', 'a.md'), 'a');
    writeFile(path.join(dir, 'personas', 'b.md'), 'b');
    writeFile(path.join(dir, 'personas', 'd.md'), 'd');
    const scenarioPath = path.join(dir, 'scenarios', 'baseline.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'baseline', adventure: 'adventures/x.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/d.md' },
      },
      human: { characterId: 'h', archetype: 'hunter' },
    }, null, 2));
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.human.persona).toBeUndefined();
  });

  it('throws on missing persona file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-'));
    const scenarioPath = path.join(dir, 's.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 'x', adventure: 'a.json', seed: 's', model: 'm',
      stepBudget: { player: 6, dm: 12 }, snapshotEveryTurns: 3,
      agents: { p1: { characterId: 'p1', archetype: 'warrior', persona: 'nope.md' },
                p2: { characterId: 'p2', archetype: 'warlock', persona: 'nope.md' },
                dm: { persona: 'nope.md' } },
      human: { characterId: 'h', archetype: 'hunter' },
    }));
    await expect(loadScenario(scenarioPath, dir)).rejects.toThrow(/nope\.md/);
  });
});

describe('scenario language', () => {
  const writeMinimal = (dir: string, extra: Record<string, unknown> = {}): string => {
    writeFile(path.join(dir, 'personas', 'a.md'), 'A.');
    writeFile(path.join(dir, 'personas', 'b.md'), 'B.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'DM.');
    const scenarioPath = path.join(dir, 'scenarios', 's.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 's', adventure: 'adventures/x.json', seed: 'seed', model: 'm',
      stepBudget: { player: 6, dm: 12 },
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h1', archetype: 'hunter' },
      ...extra,
    }, null, 2));
    return scenarioPath;
  };

  it('defaults to en when absent (backward compatible)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-lang-'));
    const scenario = await loadScenario(writeMinimal(dir), dir);
    expect(scenario.language).toBe('en');
  });

  it('parses an explicit pt language', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-lang-'));
    const scenario = await loadScenario(writeMinimal(dir, { language: 'pt' }), dir);
    expect(scenario.language).toBe('pt');
  });

  it('rejects an unknown language', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-lang-'));
    await expect(loadScenario(writeMinimal(dir, { language: 'fr' }), dir))
      .rejects.toThrow(/invalid scenario/);
  });
});

describe('persona .pt.md siblings', () => {
  const writeBase = (dir: string): string => {
    writeFile(path.join(dir, 'personas', 'a.md'), 'A en.');
    writeFile(path.join(dir, 'personas', 'b.md'), 'B en.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'DM en.');
    const scenarioPath = path.join(dir, 'scenarios', 's.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 's', adventure: 'adventures/x.json', seed: 'seed', model: 'm',
      stepBudget: { player: 6, dm: 12 },
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md' },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h1', archetype: 'hunter' },
    }, null, 2));
    return scenarioPath;
  };

  it('loads { en, pt } when a .pt.md sibling exists; plain string otherwise', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-pt-'));
    const scenarioPath = writeBase(dir);
    writeFile(path.join(dir, 'personas', 'a.pt.md'), 'A pt.');
    writeFile(path.join(dir, 'personas', 'dm.pt.md'), 'DM pt.');
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p1.persona).toEqual({ en: 'A en.', pt: 'A pt.' });
    expect(scenario.agents.dm.persona).toEqual({ en: 'DM en.', pt: 'DM pt.' });
    // No sibling for b.md → legacy plain-string shape.
    expect(scenario.agents.p2.persona).toBe('B en.');
  });

  it('promptHash stays the hash of the ENGLISH text (stable across language picks)', async () => {
    const dirNoPt = mkdtempSync(path.join(tmpdir(), 'scen-pt-'));
    const noPt = await loadScenario(writeBase(dirNoPt), dirNoPt);
    const dirPt = mkdtempSync(path.join(tmpdir(), 'scen-pt-'));
    const ptPath = writeBase(dirPt);
    writeFile(path.join(dirPt, 'personas', 'a.pt.md'), 'A pt.');
    const withPt = await loadScenario(ptPath, dirPt);
    const hashOf = (s: Awaited<ReturnType<typeof loadScenario>>, role: string) =>
      s.agentRecords.find((a) => a.role === role)!.promptHash;
    expect(hashOf(withPt, 'p1')).toBe(hashOf(noPt, 'p1'));
  });

  it('an empty .pt.md sibling is ignored (English-only persona)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-pt-'));
    const scenarioPath = writeBase(dir);
    writeFile(path.join(dir, 'personas', 'a.pt.md'), '   \n');
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p1.persona).toBe('A en.');
  });

  it('the real basement-o-rats scenario loads pt variants for every persona', async () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const scenario = await loadScenario(
      path.join(repo, 'scenarios', 'basement-o-rats.json'), repo,
    );
    for (const p of [
      scenario.agents.p1.persona, scenario.agents.p2.persona,
      scenario.agents.p3!.persona, scenario.agents.dm.persona,
      scenario.human.persona!,
    ]) {
      expect(typeof p).toBe('object');
      expect((p as { pt?: string }).pt).toBeTruthy();
      expect((p as { en: string }).en).toBeTruthy();
    }
    // Spot-check the voice carried over: Kael announces in pt-BR.
    expect((scenario.agents.p2.persona as Record<string, string>)['pt']).toContain('RAIO FLAMEJANTE');
  });
});

describe('scenario names records (localized hero names)', () => {
  it('parses names records on agents + human and the real basement scenario carries all four', async () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const scenario = await loadScenario(
      path.join(repo, 'scenarios', 'basement-o-rats.json'), repo,
    );
    expect(scenario.agents.p1.names).toEqual({ pt: 'Heitor' });
    expect(scenario.agents.p2.names).toEqual({ pt: 'Caio' });
    expect(scenario.agents.p3!.names).toEqual({ pt: 'Iara' });
    expect(scenario.human.names).toEqual({ pt: 'Breno' });
  });

  it('names is optional — absent fields stay undefined', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scen-namept-'));
    writeFile(path.join(dir, 'personas', 'a.md'), 'A.');
    writeFile(path.join(dir, 'personas', 'b.md'), 'B.');
    writeFile(path.join(dir, 'personas', 'dm.md'), 'DM.');
    const scenarioPath = path.join(dir, 'scenarios', 's.json');
    writeFile(scenarioPath, JSON.stringify({
      id: 's', adventure: 'adventures/x.json', seed: 'seed', model: 'm',
      stepBudget: { player: 6, dm: 12 },
      agents: {
        p1: { characterId: 'p1', archetype: 'warrior', persona: 'personas/a.md', names: { pt: 'Heitor' } },
        p2: { characterId: 'p2', archetype: 'warlock', persona: 'personas/b.md' },
        dm: { persona: 'personas/dm.md' },
      },
      human: { characterId: 'h1', archetype: 'hunter' },
    }));
    const scenario = await loadScenario(scenarioPath, dir);
    expect(scenario.agents.p1.names).toEqual({ pt: 'Heitor' });
    expect(scenario.agents.p2.names).toBeUndefined();
    expect(scenario.human.names).toBeUndefined();
  });
});
