#!/usr/bin/env node
/**
 * Static preview: boot the WS server with a scene's initial snapshot. No
 * orchestrator, no LLM. For visual iteration on the tileset and props.
 *
 * Usage:
 *   tsx bin/preview-scene.ts scenarios/basement-o-rats.json [scene-id]
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadScenario } from '../src/runtime/scenario.js';
import { loadCatalogs } from '../src/engine/load.js';
import { loadAdventure } from '../src/engine/adventure.js';
import { buildSceneGrid } from '../src/engine/scene-grid.js';
import { GameEngine } from '../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../src/engine/ids.js';
import { WsAdapter } from '../src/runtime/ws/adapter.js';
import { bootWsServer } from '../src/runtime/ws/server.js';
import type { Character } from '../src/engine/character.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const main = async () => {
  const scenarioRel = process.argv[2] ?? 'scenarios/basement-o-rats.json';
  const scenario = await loadScenario(path.resolve(REPO, scenarioRel), REPO);

  const cats = await loadCatalogs(path.resolve(REPO, 'data'));
  const adventure = await loadAdventure(scenario.adventurePath);

  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const heroFromCatalog = (id: string, archetype: string, pos: { x: number; y: number }, displayName?: string): Character => {
    const hero = cats.heroes.get(archetype === 'warlock' ? 'warlock-fire' : archetype);
    if (!hero) throw new Error(`unknown archetype: ${archetype}`);
    return {
      id: asCharacterId(id), name: displayName ?? hero.name, kind: 'hero', archetype: hero.archetype,
      sprite: hero.sprite, pools: hero.pools,
      dex: hero.dex ?? 0,
      health: { total: hero.healthTotal, damage: 0, status: 'normal' },
      pos, normalAttack: hero.normalAttack,
      specialAction: { id: asEffectId(hero.specialAction.effectId), name: hero.specialAction.name, description: hero.specialAction.description },
      bonusAbility:  { id: asEffectId(hero.bonusAbility.effectId),  name: hero.bonusAbility.name,  description: hero.bonusAbility.description },
      inventory: [...hero.defaultInventory.map((s) => ({ ...s, itemId: s.itemId as Character['inventory'][number]['itemId'] }))],
      boons: [], skills: hero.defaultSkills as Character['skills'],
    };
  };

  // Optional 2nd arg: a scene id to preview (default scenes[0]). Fails fast on
  // an unknown id, listing the adventure's valid scene ids.
  const sceneArg = process.argv[3];
  if (sceneArg && !adventure.scenes.some((s) => s.id === sceneArg)) {
    console.error(`Unknown scene id "${sceneArg}". Valid ids: ${adventure.scenes.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const targetScene = (sceneArg ? adventure.scenes.find((s) => s.id === sceneArg) : adventure.scenes[0])!;
  const grid = buildSceneGrid(targetScene);

  // Seat heroes on the first three open floor cells scanning column-major from the
  // west, so carved-cave scenes seat the party at the western entrance (and never
  // inside rock or split across a mid-cavern barrier).
  const seats: { x: number; y: number }[] = [];
  for (let x = 0; x < targetScene.map.width && seats.length < 3; x++) {
    for (let y = 0; y < targetScene.map.height && seats.length < 3; y++) {
      if (grid.cellAt({ x, y }).kind === 'floor') seats.push({ x, y });
    }
  }
  const seat = (i: number): { x: number; y: number } => seats[i] ?? { x: 0, y: 0 };
  const p1    = heroFromCatalog(scenario.agents.p1.characterId, scenario.agents.p1.archetype, seat(0), scenario.agents.p1.name);
  const p2    = heroFromCatalog(scenario.agents.p2.characterId, scenario.agents.p2.archetype, seat(1), scenario.agents.p2.name);
  const human = heroFromCatalog(scenario.human.characterId,    scenario.human.archetype,    seat(2), scenario.human.name);

  const engine = new GameEngine({
    seed: scenario.seed, grid,
    characters: [p1, p2, human],
    effects: reg, items: cats.items, boons: cats.boons,
    adventure, monsters: cats.monsters,
  });
  // Enter the target scene so its monsters/NPCs auto-reveal in the snapshot.
  engine.applyDmAction({ kind: 'set_scene', sceneId: targetScene.id });
  engine.flushEvents();

  const webRoot = path.resolve(REPO, 'dist/web');
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    console.log('Building web bundle...');
    const r = spawnSync('npm', ['run', 'build:web'], { stdio: 'inherit', cwd: REPO });
    if (r.status !== 0) { console.error('web build failed'); process.exit(r.status ?? 1); }
  }

  const booted = await bootWsServer({
    webRoot,
    assetsRoot: path.resolve(REPO, 'assets'),
    // $PORT override (same idiom as play.ts) so a preview can run beside a
    // live `play.ts --browser` session already holding 5175.
    port: Number(process.env['PORT']) || 5175,
    singleClient: false, // allow re-opens during iteration
  });
  console.log(`Preview at http://localhost:${booted.port}`);

  const adapter = new WsAdapter({ kind: 'human' }, booted.manifest);
  booted.onConnect((ws, _info) => {
    adapter.attach(ws, engine.getRedactedSnapshot(adapter.viewer));
    // The web UI keeps the board behind the "Summoning the Tale" splash until
    // the DM produces a narration line. With no orchestrator here, push the
    // scene intro as a one-off DM narration so the board reveals for preview.
    adapter.onEvent({ type: 'narrate', actorId: 'dm', text: targetScene.intro, t: 1 } as never);
  });

  // Stay alive.
  process.on('SIGINT', async () => { await booted.shutdown(); process.exit(0); });
};

main().catch((e) => { console.error(e); process.exit(1); });
