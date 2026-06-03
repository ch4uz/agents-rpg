import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadAdventure, sceneIntro, sceneConclusion, sceneOpeningText } from '../../src/engine/adventure.js';
import { buildSceneGrid } from '../../src/engine/scene-grid.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('loadAdventure', () => {
  it('loads the stub adventure', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'stub-one-scene.json'));
    expect(adv.id).toBe('stub-one-scene');
    expect(adv.scenes).toHaveLength(1);
    expect(adv.scenes[0]!.id).toBe('stub-cell');
  });

  it("loads the compressed Basement O' Rats chain (2 encounters, king-rat finale on rat-tunnel)", async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    expect(adv.id).toBe('basement-o-rats');
    const ids = adv.scenes.map((s) => s.id);
    expect(ids).toEqual(['tavern-basement', 'rat-tunnel']);
    // Every transition resolves to a real scene id or END.
    const valid = new Set<string>([...ids, 'END']);
    for (const s of adv.scenes) {
      for (const t of s.transitions) {
        expect(valid.has(t.to)).toBe(true);
      }
    }
    // The basement flows into the rat tunnel once its rats are KO'd.
    const basement = adv.scenes.find((s) => s.id === 'tavern-basement')!;
    expect(
      basement.transitions.some((t) => t.to === 'rat-tunnel' && t.trigger === 'all-monsters-ko'),
    ).toBe(true);
    // The king rat is the finale boss on rat-tunnel (moved here from the retired rat-den).
    const finale = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    expect(finale.monsters.some((m) => m.type === 'king-rat')).toBe(true);
    // rat-tunnel ends the adventure.
    expect(finale.transitions.some((t) => t.to === 'END')).toBe(true);
    // Both scenes declare hero entry cells so the party lands at the right spot on entry.
    for (const s of adv.scenes) {
      expect((s.map.entry ?? []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rat-tunnel: a solid ATTACK-PROOF stalagmite wall seals the heroes off from the king-rat arena, breachable only by detonating the pushable oil cask against it', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const scene = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    const { width, height, wallCells } = scene.map;
    expect(wallCells && wallCells.length).toBeGreaterThan(0);
    const grid = buildSceneGrid(scene);

    const walkable = (x: number, y: number): boolean =>
      x >= 0 && x < width && y >= 0 && y < height && grid.cellAt({ x, y }).kind === 'floor';

    // wallCells must materialise as indestructible rock (not floor / not wall).
    for (const c of wallCells ?? []) {
      expect(grid.cellAt({ x: c.x, y: c.y }).kind).toBe('rock');
    }

    // The breach barrier is a SOLID column of FIVE stalagmites at x=6, y=3..7 —
    // full-block `wall` cells, and ALL ATTACK-PROOF (no durability weak point;
    // attacks/spells can't touch them). The ONLY way through is the cask blast.
    const stalagmites = scene.map.obstacles.filter((o) => o.type === 'stalagmite');
    expect(stalagmites).toHaveLength(5);
    for (const o of stalagmites) {
      expect(o.x).toBe(6);
      expect(o.durability ?? 1).toBe(1); // no multi-hit weak point — they can't be smashed at all
      expect(grid.cellAt({ x: o.x, y: o.y }).kind).toBe('wall');
    }
    // The crossing tool: a PUSHABLE explosive oil cask at (4,7), one cell shy of
    // the wall with an empty gap at (5,7) to shove it into, and an open cell at
    // (3,7) where the pusher stands.
    const cask = scene.map.obstacles.find((o) => o.type === 'oil-cask')!;
    expect(cask).toMatchObject({ x: 4, y: 7, pushable: true });
    expect(cask.explosive).toBeTruthy();
    expect(grid.cellAt({ x: 4, y: 7 }).kind).toBe('wall'); // the cask blocks its own cell
    expect(walkable(5, 7)).toBe(true); // the gap to push it into
    expect(walkable(3, 7)).toBe(true); // where the pusher stands

    // x=6 has NO walkable cell on any row — the barrier is unbroken floor-to-ceiling.
    for (let y = 0; y < height; y++) {
      expect(walkable(6, y)).toBe(false);
    }

    // The wall blocks line-of-sight across it on every corridor row, so ranged/magic
    // heroes can't snipe the king-rat arena over the wall until a gap opens.
    for (const y of [3, 4, 5, 6, 7]) {
      expect(grid.lineOfSight({ x: 3, y }, { x: 9, y }).blocked).toBe(true);
    }

    // Hero entry cells and every monster spawn stay walkable floor.
    for (const e of scene.map.entry ?? []) expect(walkable(e.x, e.y)).toBe(true);
    for (const m of scene.monsters) expect(walkable(m.startPos.x, m.startPos.y)).toBe(true);

    // 8-connected flood-fill of the floor reachable from the western hero entry.
    const reachableFrom = (sx: number, sy: number): Set<string> => {
      const seen = new Set<string>([`${sx},${sy}`]);
      const queue = [{ x: sx, y: sy }];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cur.x + dx, ny = cur.y + dy, k = `${nx},${ny}`;
            if (!seen.has(k) && walkable(nx, ny)) { seen.add(k); queue.push({ x: nx, y: ny }); }
          }
        }
      }
      return seen;
    };

    const entry0 = scene.map.entry![0]!;
    // Before any breach: the western party CANNOT reach the king-rat or any of its
    // pack — the arena is a separate floor region behind the wall.
    const west = reachableFrom(entry0.x, entry0.y);
    for (const m of scene.monsters) {
      expect(west.has(`${m.startPos.x},${m.startPos.y}`)).toBe(false);
    }

    // Detonating the cask once it's shoved to (5,7) blasts (Chebyshev radius 1)
    // the two stalagmites at (6,6),(6,7) — the rock at (6,8) is indestructible.
    // Simulate that breach via clearCell and confirm the cavern reconnects: the
    // king-rat and every giant rat ARE now reachable from the western entry.
    for (const c of [{ x: 6, y: 6 }, { x: 6, y: 7 }]) grid.clearCell(c);
    const afterBreach = reachableFrom(entry0.x, entry0.y);
    for (const m of scene.monsters) {
      expect(afterBreach.has(`${m.startPos.x},${m.startPos.y}`)).toBe(true);
    }
  });

  it('rat-tunnel declares Elara as an immobilized captive beyond the breach (a rescue objective)', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const scene = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    const captives = scene.map.captives ?? [];
    expect(captives).toHaveLength(1);
    const elara = captives[0]!;
    expect(elara.characterId).toBe('p3_healer'); // must match scenario agents.p3
    expect(elara.archetype).toBe('healer');
    // She's east of the x=6 breach wall — unreachable until the party breaks through.
    expect(elara.startPos.x).toBeGreaterThan(6);
    // Her cell is open floor, not a monster spawn.
    const grid = buildSceneGrid(scene);
    expect(grid.cellAt(elara.startPos).kind).toBe('floor');
    expect(scene.monsters.some((m) => m.startPos.x === elara.startPos.x && m.startPos.y === elara.startPos.y)).toBe(false);
  });

  it('rat-tunnel declares a monster-focus directive: fixate on Elara from round 2', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const scene = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    expect(scene.monsterFocus).toBeDefined();
    expect(scene.monsterFocus!.characterId).toBe('p3_healer'); // the bound captive
    expect(scene.monsterFocus!.fromRound).toBe(2); // round 1 plays normally
  });

  it('monsterFocus.fromRound defaults to 1 when omitted', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-'));
    const file = path.join(tmp, 'focus.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        id: 'f', title: 'F', estimatedDurationMin: 1,
        scenes: [{
          id: 's1', intro: '', conclusion: '',
          map: { width: 4, height: 4, background: 'b', obstacles: [], exits: [] },
          monsters: [],
          monsterFocus: { characterId: 'victim' },
          tactics: '', abilityTests: [], transitions: [],
        }],
      }),
    );
    const adv = await loadAdventure(file);
    expect(adv.scenes[0]!.monsterFocus).toEqual({ characterId: 'victim', fromRound: 1 });
  });

  it('rat-tunnel declares a chest of cheese on the heroes\' (west) side of the breach', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const scene = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    const chests = scene.map.chests ?? [];
    expect(chests).toHaveLength(1);
    const chest = chests[0]!;
    expect(chest.contents).toBe('cheese');
    // West of the x=6 breach wall, so the party can loot it before/while breaching.
    expect(chest.pos.x).toBeLessThan(6);
    // Its cell is open floor (heroes must be able to stand adjacent to open it).
    const grid = buildSceneGrid(scene);
    expect(grid.cellAt(chest.pos).kind).toBe('floor');
  });

  it('rejects an adventure with a transition to a non-existent scene', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-'));
    const file = path.join(tmp, 'bad.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        id: 'bad',
        title: 'Bad',
        estimatedDurationMin: 1,
        scenes: [
          {
            id: 's1',
            intro: '',
            conclusion: '',
            map: { width: 4, height: 4, background: 'b', obstacles: [], exits: [] },
            monsters: [],
            tactics: '',
            abilityTests: [],
            transitions: [{ to: 'no-such-scene', trigger: 'all-monsters-ko' }],
          },
        ],
      }),
    );
    await expect(loadAdventure(file)).rejects.toThrow(/transition.*no-such-scene/i);
  });
});

describe('scene i18n prose overlay (pt)', () => {
  it("basement-o-rats carries pt overlays and the selectors pick them", async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const basement = adv.scenes.find((s) => s.id === 'tavern-basement')!;
    const tunnel = adv.scenes.find((s) => s.id === 'rat-tunnel')!;

    // pt selectors return the translated prose…
    expect(sceneIntro(basement, 'pt')).toContain('Ratos gigantes');
    expect(sceneConclusion(basement, 'pt')).toContain('Socorro!');
    expect(sceneIntro(tunnel, 'pt')).toContain('O Rato Rei');
    expect(sceneConclusion(tunnel, 'pt')).toContain('sorvete');
    const ptOpening = sceneOpeningText(basement, 'pt')!;
    expect(ptOpening.before).toContain('Três jovens heróis');
    expect(ptOpening.after).toContain('repolho azedo');

    // …while en selectors return the canonical English.
    expect(sceneIntro(basement, 'en')).toContain('Giant rats');
    expect(sceneOpeningText(basement, 'en')!.before).toContain('Three young heroes');

    // Cast names (bold + avatar anchors) appear verbatim in each language's
    // text: the EN cast name in the EN opening, the pt name (names.pt) in the
    // pt opening — that's what the splash's highlighting matches against.
    const enOpening = sceneOpeningText(basement, 'en')!;
    for (const member of basement.opening!.cast ?? []) {
      if (!member.portrait) continue;
      expect(enOpening.before).toContain(member.name);
      expect(ptOpening.before).toContain(member.names?.['pt'] ?? member.name);
    }
    // The four portrait-bearing heroes all declare pt names.
    expect(
      (basement.opening!.cast ?? []).filter((c) => c.portrait).map((c) => c.names?.['pt']),
    ).toEqual(['Heitor', 'Caio', 'Breno', 'Iara']);
  });

  it('selectors fall back to English when a scene has no overlay', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'stub-one-scene.json'));
    const scene = adv.scenes[0]!;
    expect(scene.i18n).toBeUndefined();
    expect(sceneIntro(scene, 'pt')).toBe(scene.intro);
    expect(sceneConclusion(scene, 'pt')).toBe(scene.conclusion);
    expect(sceneOpeningText(scene, 'pt')).toEqual(
      scene.opening ? { before: scene.opening.before, after: scene.opening.after } : undefined,
    );
  });

  it('rat-tunnel has no opening — sceneOpeningText stays undefined in both languages', async () => {
    const adv = await loadAdventure(path.join(REPO, 'adventures', 'basement-o-rats.json'));
    const tunnel = adv.scenes.find((s) => s.id === 'rat-tunnel')!;
    expect(sceneOpeningText(tunnel, 'en')).toBeUndefined();
    expect(sceneOpeningText(tunnel, 'pt')).toBeUndefined();
  });
});

describe('scene i18n is language-key generic', () => {
  it('tolerates a future language code and the selectors resolve it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'adv-i18n-'));
    const file = path.join(dir, 'a.json');
    writeFileSync(file, JSON.stringify({
      id: 'a', title: 't', estimatedDurationMin: 1,
      scenes: [{
        id: 's1', intro: 'EN intro', conclusion: 'EN concl', tactics: '',
        opening: { before: 'EN before', after: 'EN after' },
        // 'fr' is not (yet) a GameLanguage — content may lead the code.
        i18n: {
          pt: { intro: 'PT intro' },
          fr: { intro: 'FR intro', opening: { before: 'FR before', after: 'FR after' } },
        },
        map: { width: 3, height: 3, background: 'bg', walls: true, obstacles: [], decorations: [], exits: [], npcs: [] },
        monsters: [], abilityTests: [], transitions: [],
      }],
    }));
    const adv = await loadAdventure(file);
    const scene = adv.scenes[0]!;
    // Declared languages resolve; everything else falls back to English.
    expect(sceneIntro(scene, 'pt')).toBe('PT intro');
    expect(sceneIntro(scene, 'fr')).toBe('FR intro');
    expect(sceneIntro(scene, 'de')).toBe('EN intro');
    expect(sceneConclusion(scene, 'fr')).toBe('EN concl');  // fr has no conclusion
    expect(sceneOpeningText(scene, 'fr')).toEqual({ before: 'FR before', after: 'FR after' });
    expect(sceneOpeningText(scene, 'pt')).toEqual({ before: 'EN before', after: 'EN after' });
  });
});
