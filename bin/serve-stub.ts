#!/usr/bin/env node
// Idle WS+bundle server for ui-test runs. Builds an engine, applies set_scene
// to populate monsters, then attaches the WsAdapter on connect and stays up
// until SIGINT. No orchestrator, no LLM calls.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { loadCatalogs } from '../src/engine/load.js';
import { loadAdventure } from '../src/engine/adventure.js';
import { Grid } from '../src/engine/grid.js';
import { GameEngine } from '../src/engine/game-engine.js';
import { EffectRegistry, registerCoreEffects } from '../src/engine/effects.js';
import { asCharacterId, asEffectId } from '../src/engine/ids.js';
import { WsAdapter } from '../src/runtime/ws/adapter.js';
import { bootWsServer } from '../src/runtime/ws/server.js';
import type { Character } from '../src/engine/character.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const heroFromCatalog = (
  cats: Awaited<ReturnType<typeof loadCatalogs>>,
  id: string,
  archetype: string,
  pos: { x: number; y: number },
  displayName?: string,
): Character => {
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

const main = async () => {
  const webRoot = path.resolve(REPO, 'dist/web');
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    console.log('Building web bundle...');
    const r = spawnSync('npm', ['run', 'build:web'], { stdio: 'inherit', cwd: REPO });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }

  const cats = await loadCatalogs(path.resolve(REPO, 'data'));
  const adventure = await loadAdventure(path.resolve(REPO, 'adventures/basement-o-rats.json'));
  const scene0 = adventure.scenes[0]!;

  const reg = new EffectRegistry(); registerCoreEffects(reg);

  const p1 = heroFromCatalog(cats, 'p1_warrior', 'warrior', { x: 0, y: 0 }, 'Gareth');
  const p2 = heroFromCatalog(cats, 'p2_warlock',  'warlock', { x: 1, y: 0 }, 'Kael');
  const human = heroFromCatalog(cats, 'human_hunter', 'hunter', { x: 0, y: 1 }, 'Bran');

  const grid = new Grid(
    Array.from({ length: scene0.map.height }, () =>
      Array.from({ length: scene0.map.width }, () => ({ kind: 'floor' as const }))),
  );
  const engine = new GameEngine({
    seed: 'serve-stub', grid, characters: [p1, p2, human],
    effects: reg, items: cats.items, boons: cats.boons,
    adventure, monsters: cats.monsters,
  });

  const setRes = engine.applyDmAction({ kind: 'set_scene', sceneId: scene0.id });
  if (!setRes.ok) throw new Error(`set_scene failed: ${JSON.stringify(setRes.error)}`);

  const booted = await bootWsServer({
    webRoot,
    assetsRoot: path.resolve(REPO, 'assets'),
    port: process.env.STUB_PORT ? Number(process.env.STUB_PORT) : 5175,
    singleClient: false,
  });
  console.log(`Idle stub serving on http://localhost:${booted.port} (Ctrl-C to stop)`);

  booted.onConnect((ws, _info) => {
    const adapter = new WsAdapter({ kind: 'human' }, booted.manifest);
    adapter.attach(ws, engine.getRedactedSnapshot(adapter.viewer));
    adapter.onTurnStarted(human.id);
    console.log('client attached; snapshot + turn_started(human) sent');
  });

  process.on('SIGINT',  () => { void booted.shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void booted.shutdown().then(() => process.exit(0)); });
};

main().catch((e) => { console.error(e); process.exit(1); });
