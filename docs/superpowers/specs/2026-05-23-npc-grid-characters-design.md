# NPCs as grid characters — design

**Date:** 2026-05-23
**Layer:** B/C (engine + runtime + content)
**Status:** Approved — proceed to plan + implementation

## Intent

Mira and Lyra in *The Whispering Woods* are referenced in scene intro text but have no presence on the board. The user wants NPCs to appear as real grid character tokens (like heroes and monsters) operated by the DM. NPCs are **full combatants** — they have HP, can take damage, can roll initiative, can attack and be attacked. They differ from heroes only in who picks their actions (the DM agent, not a player agent), and from monsters only in that their combat behaviour is LLM-driven rather than the deterministic `monster-ai.ts` algorithm.

## Architecture

### 1. Character kind

`Character.kind` gains a third value: `'hero' | 'monster' | 'npc'`. Same stat block shape as the other two kinds — `pools`, `dex`, `healthTotal`, `normalAttack`, optional `specialAction`/`bonusAbility`, `sprite`.

### 2. NPC catalog (`data/npcs.json`)

Same shape as `data/monsters.json`. Ships with two entries:

```json
[
  {
    "id": "mira",
    "name": "Mira",
    "pools": { "melee": 0, "ranged": 0, "magic": 0, "armor": 1 },
    "dex": 1, "healthTotal": 2,
    "normalAttack": { "kind": "melee", "name": "Shove", "range": 1, "damageMod": 0 },
    "sprite": "mira"
  },
  {
    "id": "lyra",
    "name": "Lyra",
    "pools": { "melee": 0, "ranged": 0, "magic": 0, "armor": 1 },
    "dex": 1, "healthTotal": 2,
    "normalAttack": { "kind": "melee", "name": "Shove", "range": 1, "damageMod": 0 },
    "sprite": "lyra"
  }
]
```

A separate catalog file keeps the semantic distinction clear in tests and prompts even though the runtime entries are structurally identical to monster entries.

### 3. Scene declaration

`Scene.map.npcs[]` parallels `Scene.monsters[]`:

```json
"npcs": [
  { "type": "mira", "startPos": { "x": 0, "y": 5 }, "allegiance": "neutral" }
]
```

`allegiance ∈ { 'ally', 'hostile', 'neutral' }` (default: `'neutral'`).

- **`ally`** — DM is expected to include the NPC in `start_combat.heroSide`.
- **`hostile`** — DM is expected to include the NPC in `start_combat.monsterSide`.
- **`neutral`** — NPC stays out of combat. Engine `start_combat` rejects any side list that names a neutral NPC. The NPC remains on the grid as a non-participating spectator; the DM still operates it via `npc_action` outside combat.

Allegiance is a *suggestion to the DM* at combat-start, enforced only for the neutral case. The DM is free to put an `ally` NPC on `monsterSide` for narrative purposes (e.g. an ally who turned against the party); the engine sorts initiative based on the lists it actually receives.

### 4. Auto-reveal on `set_scene`

The engine's existing `set_scene` handler materializes scene-declared monsters at their `startPos`. It is extended to do the same for scene-declared NPCs, looking the type up in the NPC catalog instead of the monster catalog, and emitting a `reveal_npc` event with the same shape as `reveal_monster`:

```ts
{ kind: 'reveal_npc'; npcTypeId: string; pos: Square; characterId: CharacterId }
```

Ids are deterministic: `mira-1`, `lyra-1`, … per type per scene. Mid-run reveal also has a `reveal_npc` DM action mirroring `reveal_monster`.

### 5. DM tool: `npc_action`

```ts
{ kind: 'npc_action'; npcId: CharacterId; action: PlayerAction }
```

Allowed actions are the narrative subset: `move`, `normal_attack`, `say`, `emote`, `ability_test`, `end_turn`, `skip_turn`. Engine dispatch reuses `applyAction(npcId, action, { interpretedBy: 'dm' })` so events are logged with the DM as the interpreter.

**Turn-ownership rule.** Inside a combat phase, `npc_action` enforces the standard `not-actors-turn` guard — an NPC must be the active combatant. Outside combat (narrative phase), the DM owns every NPC at all times; `npc_action` skips the active-actor check for NPCs only. This lets the DM weave Mira's "she clings to your sleeve and points east" into a narration step without having to first call `request_action`.

### 6. Orchestrator routing

A new `runNpcTurn(npcId, log)` runs whenever the combat cursor lands on a kind=`'npc'` character. It is structurally a thin wrapper around `runDmTurn`: the DM agent is invoked with a turn-prefix message ("It is **Mira**'s turn. Pick an action for them via `npc_action`."), the agent's existing ReACT loop runs, and the orchestrator advances initiative after `npc_action(end_turn)` or step-budget exhaustion.

The main loop branches in this order, given `activeActor = engine.turn.activeActorId`:
1. `null` → `runDmTurn` (narrative phase or post-combat).
2. matches `cfg.human?.characterId` → `runHumanTurn`.
3. character kind is `'monster'` → `runMonsterTurn` (deterministic).
4. character kind is `'npc'` → `runNpcTurn` (LLM via DM agent). *(new)*
5. otherwise → `runAiTurn` (player agent).

### 7. Visibility filter

`reveal_npc` and `action` events sourced from `npc_action` are public, same as their monster/hero counterparts. AI hero agents see the NPC's `say` events in their history and can choose to react in their own turns.

### 8. Snapshot

`RedactedCharacter.kind` widens to `'hero' | 'monster' | 'npc'`. The browser's `state.characters` already renders every entry as a token via `Board.ts` — no rendering branch is needed beyond the sprite lookup (which uses `manifest.heroes` / `manifest.monsters` today; an NPC's `sprite` field maps into a new `manifest.npcs` table).

## Content

### Whispering Woods updates

- **Scene 1 (`forest-edge`)**: add `npcs: [{ type: "mira", startPos: { x: 0, y: 5 }, allegiance: "neutral" }]`. Adjust the intro to refer to her as visible on the path. No combat.
- **Scene 5 (`dryad-grove`)**: add `npcs: [{ type: "lyra", startPos: { x: 6, y: 5 }, allegiance: "neutral" }]` — at Nimue's feet, asleep. The intro already describes her position; the engine entity makes her rescue mechanical (a hero can `move` to her square and the DM can narrate carrying her off via `npc_action(lyra, end_turn)` or by removing her from the grid when the scene ends).

### PixelLab assets

Two new character sprite sets, generated via `create_character` in standard mode (4 directions, basic shading, single color black outline, medium detail) to match the existing pixel-art style:

- `mira` — small frightened girl, dirt-smudged dress, wide eyes
- `lyra` — small sleeping girl, clover crown, peaceful expression

Cost ≈ 2 generations. Registered as `manifest.npcs.mira` and `manifest.npcs.lyra` (new manifest group).

## Engine guards (do NOT relax)

1. `npc_action.npcId` must reference a character with `kind === 'npc'`. Reject `invalid-target` otherwise.
2. `npc_action.action.kind` must be in the narrative subset enumerated above. Reject `invalid-action-shape` for any other kind (in particular `special_action`, `use_item`, `use_boon`, `equip`, `attack_object` are not exposed for NPCs in v1).
3. `start_combat.heroSide`/`monsterSide` must not include a neutral NPC. Reject `invalid-action-shape`.
4. NPCs without a matching `npcs` catalog entry on `set_scene` fail the scene transition with `unknown-id`.
5. `reveal_npc` mid-scene checks for id collision the same way `reveal_monster` does.

## Out of scope (YAGNI)

- LLM-driven NPC personas. The DM continues to script all NPC dialogue.
- Equipment, inventory, items, or boons for NPCs.
- A `set_allegiance` tool to change an NPC's side mid-scene. The DM handles narrative reversals through `start_combat` membership.
- Hero agents calling `say` *to* NPCs directly. The DM agent reacts to AI/human speech and decides whether to have the NPC respond.
- NPC sprites beyond Mira + Lyra.
- A separate `data/npcs.json` schema beyond what `data/monsters.json` already validates against. The catalog is structurally identical.
- Migrating the visibility filter to a new `npc_*` event family. `reveal_npc` is the only new event; everything else reuses existing event types with the NPC's id.

## Acceptance criteria

1. `npm test` passes (no regressions).
2. `npx vitest run tests/engine/adventure.test.ts tests/integration/ws-stub-adventure.test.ts` still passes (basement-o-rats integration test unaffected).
3. New tests:
   - Unit: `npc_action` engine path applies/move/say/emote/normal_attack and enforces guards (1, 2, 3 above).
   - Integration: a fixture scenario that enters a scene with a neutral NPC, runs one DM turn that calls `npc_action` for `say` + `move`, and verifies both the engine state and the public event log.
4. `npx tsx bin/play.ts --browser scenarios/whispering-woods.json` boots the browser, scene 1 renders Mira as a sprite at `(0, 5)` adjacent to the heroes, and a manual DM call to `npc_action({ kind: 'say', text: '...' })` flashes a speech bubble over her token.
5. Manifest validation green for the two new NPC sprites.
