import type { GameEngine } from '../engine/game-engine.js';
import type { CharacterId, BoonId, EquipmentId } from '../engine/ids.js';
import { asCharacterId } from '../engine/ids.js';
import type { PlayerAction } from '../engine/action.js';
import type { Character, ItemStack } from '../engine/character.js';

export interface ReplayFixture {
  seed: string;
  characters: unknown[];
  narrativeActor: string;
  actions: Array<{ actorId: string; action: PlayerAction }>;
}

export const replayFromFixture = (engine: GameEngine, fixture: ReplayFixture): void => {
  engine.beginNarrativeTurn(asCharacterId(fixture.narrativeActor));
  for (const step of fixture.actions) {
    const result = engine.applyAction(asCharacterId(step.actorId), step.action);
    if (!result.ok) {
      throw new Error(
        `Replay diverged on action ${JSON.stringify(step.action)}: ${result.error.reason}`,
      );
    }
  }
};

export interface CharacterSnapshot {
  id: CharacterId;
  pos: Character['pos'];
  health: Character['health'];
  inventory: ReadonlyArray<ItemStack>;
  boons: ReadonlyArray<BoonId>;
  equipped: EquipmentId | null;
}

export interface EngineSnapshot {
  characters: CharacterSnapshot[];
  phase: string;
  activeActor: CharacterId | null;
}

/**
 * Canonicalized snapshot used for equality checks. Excludes pendingEvents
 * (already drained) and includes only public, deterministic state.
 */
export const snapshotEngineState = (engine: GameEngine): EngineSnapshot => {
  const chars: CharacterSnapshot[] = Array.from(engine.charactersById().values())
    .map((c) => ({
      id: c.id,
      pos: c.pos,
      health: c.health,
      inventory: [...c.inventory].sort((a, b) =>
        (a.itemId as string).localeCompare(b.itemId as string),
      ),
      boons: [...c.boons].sort((a, b) => (a as string).localeCompare(b as string)),
      equipped: c.equipped ?? null,
    }))
    .sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return {
    characters: chars,
    phase: engine.turn.phase,
    activeActor: engine.turn.activeActorId,
  };
};
