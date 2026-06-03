# The Whispering Woods — scenario design

**Date:** 2026-05-22
**Layer:** C (content addition, no engine changes)
**Status:** Approved — proceed to plan + execution

## Intent

A second HeroKids adventure for the agents-rpg engine, in addition to *Basement O' Rats*. Same 4 hero archetypes (warrior, hunter, healer, warlock). Goal: a content workload that exercises **ability tests far more than combat** so the ReACT agents have to reason about *which characteristic to roll, which skill bonus applies, when to talk vs swing*.

The party makeup, persona files, model, dice, and engine rules are reused unchanged. The only new artifacts are:

- 1 adventure JSON + 1 scenario JSON
- 2 new monsters in `data/monsters.json` (thorn-wisp + dryad)
- 1 new prop type (optional briar/log/mushroom set)
- 5 forest map PNGs (single-image, like the cave maps — no wang tileset)
- 2 new sprite sets (thorn-wisp, dryad) with idle / walk / attack animations
- A `manifest.json` patch

Everything else (engine, runtime, browser bundle, dice overlay) is untouched.

## Story

The village of Hallow's Reach loses children to the forest each midsummer. This year a girl named **Lyra** is missing. The party — Anwen (warrior), Kael (warlock), Bran (hunter, human) — is sent in. The forest has *gone wrong*: no birdsong, paths bend back on themselves, a sweet humming drifts between the trees.

**Twist (revealed at scene 4).** It is not a monster. A young dryad named **Nimue**, whose oak was wounded by a careless woodcutter, is lashing out with confused fae magic — she has been luring children to her grove and trying to keep them as "guests" so she won't be alone while her tree dies. She is grieving, not evil.

**Branch.** Scene 5 has two endings:
1. **Peaceful** — if the party successfully healed Nimue's wounded oak in scene 4 (a magic+knowledge ability test by Healer or Warlock), they can talk her down in scene 5 with persuasion checks. No combat. Lyra is returned. Outcome = success.
2. **Combat** — if the oak was not healed, Nimue and 2 thorn-wisps fight. Outcome = success if Nimue is KO'd. Lyra is rescued.

Both branches return the same `end_adventure outcome=success`; the engine doesn't need to know which branch happened — the DM narrates it via `set_scene` + `narrate`.

## Scenes

All 5 scenes have a real grid (consistent with existing engine behaviour: every scene already has `map.width` and `map.height`). Each scene targets 4–6 `abilityTests` so that the per-scene ratio of *attribute tests : attack actions* skews heavily toward attribute tests.

| # | Scene id | Map size | Combat? | Test focus |
|---|---|---|---|---|
| 1 | `forest-edge` | 10×7 | No | persuasion (calm Mira, Lyra's sister), perception (no birdsong), knowledge (recall fae lore), tracking (find Lyra's footprints) |
| 2 | `whispering-path` | 12×8 | No | tracking (read the bent path), acrobatics (cross a fallen log over the creek), perception (hear the lullaby), knowledge (break the fae glamour) |
| 3 | `briar-hollow` | 10×8 | Yes (light: 3 thorn-wisps) | athletics (shove through brambles), acrobatics (squeeze sideways), perception (spot the hidden trail), tracking (read recent dryad tracks) |
| 4 | `wounded-oak` | 11×8 | No | knowledge (identify the rot), perception (signs the dryad hides above), persuasion (call out to her), **magic-ritual ability_test (soothe the oak — gates the peaceful ending of scene 5)** |
| 5 | `dryad-grove` | 12×9 | Branches | persuasion (talk Nimue down), knowledge (name her grief) **OR** combat (Nimue + 2 thorn-wisps) |

Transitions are linear: `forest-edge → whispering-path → briar-hollow → wounded-oak → dryad-grove → END`. No splits, no looping (simpler than Basement O' Rats — the branching lives inside scene 5, not across scenes).

## New catalog entries

### Monsters (`data/monsters.json`)

Reuses `pack-attack` and `coward` effect IDs — no new engine work.

```json
{
  "id": "thorn-wisp",
  "pools": { "melee": 1, "ranged": 0, "magic": 0, "armor": 2 },
  "dex": 1,
  "healthTotal": 1,
  ...
}
```

```json
{
  "id": "dryad-nimue",
  "pools": { "melee": 0, "ranged": 0, "magic": 2, "armor": 2 },
  "dex": 1,
  "healthTotal": 3,
  ...
}
```

Engine-side, the dryad is the same shape as `king-rat`. The flavour layer (DM narration, persona) carries the dryad-ness — the engine just sees a 3-HP magic boss. Reuses existing `pack-attack` / `coward` effects: no new effect implementations, no engine code at all.

### Props (manifest only — no engine changes)

`mossy-log` (decorative blocker, like `barrel-stack`), `glowing-mushroom` (decoration), `briar-patch` (decorative blocker). All single PNGs.

## Asset generation plan (PixelLab)

Match the existing pixel-art style/scale (16×16 character-tile grid, palette adjacent to the cave maps).

- **Maps (5 single PNGs):** forest-edge, whispering-path, briar-hollow, wounded-oak, dryad-grove. Generated as map backgrounds at the grid's resolution. Single PNG path, like the existing cave maps — no wang tileset.
- **Characters (2 sets, each with idle / walk / attack animations):** thorn-wisp (small spiky imp), dryad-nimue (humanoid woman wreathed in vines).
- **Props (3 single PNGs):** mossy-log, glowing-mushroom, briar-patch.

Budget: check `get_balance` first; abort if insufficient credit.

## Hard constraints (do NOT relax)

1. **No engine changes.** The new content uses existing action shapes (`ability_test`, `attack_object`, `normal_attack`, `say`, `move`, …) and existing effect IDs (`pack-attack`, `coward`).
2. **All scenes have a real grid.** Even non-combat scenes render the heroes on the board. This is already how the engine works; nothing new.
3. **Pixel art matches existing style.** Same palette family, same character-tile size as the giant-rat / heroes.
4. **No new persona files.** Reuse `personas/cautious.md`, `personas/reckless.md`, `personas/dm-default.md`.
5. **`adventure.test.ts`-style validation passes.** The new adventure JSON must load via `loadAdventure()` (zod schema + transition cross-ref).

## Out of scope

- New equipment, items, or boons.
- Tilesets / wang tiles. The forest maps render as single PNGs (same as `rat-den.png`, `rat-tunnel.png`, etc.).
- CI integration test for this adventure. The basement-o-rats stub test already covers WS replay; a parallel `whispering-woods` test can come later if needed.
- The live-Sonnet smoke. That's the open Layer C task and is not blocked by this content.

## Acceptance criteria

1. `npm test` passes (no new test failures introduced).
2. `npx tsx bin/play.ts --browser scenarios/whispering-woods.json` boots the browser, loads the first map, and the WS protocol pushes the 5 forest backgrounds + heroes + dryad/thorn-wisp sprites without manifest errors.
3. `npm run typecheck` and `npm run lint` pass.
