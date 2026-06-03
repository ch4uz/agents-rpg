# Tavern-Basement Map Asset Design

**Date:** 2026-05-10
**Status:** Approved
**Scope:** Defines the asset set, generation parameters, JSON encoding, and downstream code expectations needed to bring the *Basement O' Rats* encounter 1 (the tavern basement) up to the canonical PDF map's gameplay AND the project's pixel-art identity. Builds on `2026-05-10-pixel-art-direction-design.md` (which covered heroes and monsters but explicitly punted maps).

## Context

The encoded scene `tavern-basement` in `adventures/basement-o-rats.json` is currently a 5×8 portrait grid with `obstacles: []` and `exits: []` — a heavy reduction of the canonical PDF map (Encounter 1, page 3 of `Hero_Kids_-_Fantasy_Adventure_-_Basement_O_Rats.pdf`). The canonical map is a roughly 11×7 landscape room with:

- A **vertical dividing wall** at column 4 (with two doorways) splitting the room into a smaller west room and a larger east room.
- **Stacked barrels** along walls and in the middle, which "cannot be climbed over or shot through with ranged or magic attacks" (PDF page 3, *Encounter Features*).
- A **descending wooden staircase** at the east wall — the heroes' entry from the tavern dining room above.
- A **tunnel-hole** in the south-west corner — the rats' entry, and the exit to encounter 2.

Existing background art is a cartoon pencil-on-parchment illustration at 640×475. We are replacing it with pixel art consistent with the heroes/monsters generated in the prior session, AND we are encoding the canonical gameplay (obstacles, narrow choke point, exit transition).

This is the first map upgrade. The decisions here set the pattern for encounters 2–5.

## Locked decisions

1. **Scope** = visual upgrade + faithful canonical adaptation. Both the look and the tactical layout change.
2. **Grid** = 11×7 landscape (matches the canonical PDF). Re-encodes the existing 5×8 portrait scene.
3. **Approach** = layered: a tileset for the room shell (floor + walls) + per-cell prop sprites for obstacles and decorations, layered by the renderer at the coordinates declared in the scene JSON.
4. **Aesthetic** = warm tavern cellar — wood-plank floor, stone-and-plaster walls, ambient warm lantern light. Reads as a working storeroom under a lived-in tavern.

## Asset inventory

Five PixelLab generations.

### 1× floor / wall tileset

Tool: `mcp__pixellab__create_topdown_tileset`.

Output: a Wang-style tileset that can be assembled at runtime into the 11×7 room shell. Must include:

- 2 wood-plank floor tile variants (subtle grain variation so a tiled floor doesn't read as a single repeated pattern).
- Stone-and-plaster wall edge tiles: corners (NW/NE/SW/SE), straight sides (N/S/E/W), and an interior straight if needed.

### 4× per-cell prop sprites

Each via `mcp__pixellab__create_object`. All share the locked PixelLab parameters below.

| Prop | Description prompt | Gameplay |
|---|---|---|
| `barrel-stack` | single wooden barrel viewed slightly from above, dark oak staves with iron hoops, top of barrel visible | blocks movement + ranged + LoS |
| `wooden-wall-section` | vertical wooden plank wall section about 5 feet tall, rough-hewn timber, viewed slightly from south | blocks movement + ranged + LoS |
| `tunnel-hole` | jagged hole in plank floor with broken floorboards, dark void below, hint of dirt tunnel visible | walkable; triggers exit transition to encounter 2 when stepped on |
| `stairs-down` | bottom of a wooden staircase descending from above, viewed top-down, three or four wooden steps fading into darkness at the top | walkable; visual marker only (heroes spawn on it) |

Sacks of grain and other dressing in the canonical PDF are deferred (out of scope).

## Locked PixelLab parameters

For the **tileset** (`create_topdown_tileset`):

| Parameter | Value |
|---|---|
| `mode` | `standard` |
| Tile size | `64` (matches `CELL_PX` in `web/components/Board.ts:7`) |

For the **per-cell props** (`create_object`):

| Parameter | Value |
|---|---|
| `mode` | `standard` |
| `view` | `low top-down` |
| `n_directions` | `1` |
| `size` | `64` |
| `outline` | `single color black outline` |
| `shading` | `basic shading` |
| `detail` | `medium detail` |
| Background | transparent |

These align with the heroes/monsters parameters from `2026-05-10-pixel-art-direction-design.md` so the props read as the same visual world as the characters that stand on them.

## Obstacle layout — locked coordinates

11 columns (x=0..10, west to east) × 7 rows (y=0..6, north to south).

```
y\x  0   1   2   3   4   5   6   7   8   9  10
 0   B   B   B   W   .   B   B   .   .   .   .
 1   .   .   .   W   .   .   .  R1   .   .   .
 2   .   .   .   d   .   .   B   B   .   .  H1
 3   .  R2   .   W   .   .   B   B   .   .  S/H2
 4   .   .   .   d   .   .   .   .   .   .  S/H3
 5   .   .  R3   W   .   .   .  R4   .   .  H4
 6   H   .   .   W   .   B   B   .   .   .   .
```

Legend: `B` = barrel-stack obstacle. `W` = wooden-wall-section obstacle. `d` = doorway (gap, walkable). `H` = tunnel-hole exit. `S` = stairs decoration. `H1`–`H4` = hero spawn cells. `R1`–`R4` = giant-rat spawn cells. `.` = empty floor.

## JSON encoding

Replace the `map`, `monsters`, and (new) `decorations` keys of scene `tavern-basement` in `adventures/basement-o-rats.json`:

```json
{
  "id": "tavern-basement",
  "intro": "...",
  "map": {
    "width": 11,
    "height": 7,
    "background": "tavern-basement",
    "obstacles": [
      { "type": "barrel-stack",        "x": 0, "y": 0 },
      { "type": "barrel-stack",        "x": 1, "y": 0 },
      { "type": "barrel-stack",        "x": 2, "y": 0 },
      { "type": "barrel-stack",        "x": 5, "y": 0 },
      { "type": "barrel-stack",        "x": 6, "y": 0 },
      { "type": "barrel-stack",        "x": 6, "y": 2 },
      { "type": "barrel-stack",        "x": 7, "y": 2 },
      { "type": "barrel-stack",        "x": 6, "y": 3 },
      { "type": "barrel-stack",        "x": 7, "y": 3 },
      { "type": "barrel-stack",        "x": 5, "y": 6 },
      { "type": "barrel-stack",        "x": 6, "y": 6 },
      { "type": "wooden-wall-section", "x": 3, "y": 0 },
      { "type": "wooden-wall-section", "x": 3, "y": 1 },
      { "type": "wooden-wall-section", "x": 3, "y": 3 },
      { "type": "wooden-wall-section", "x": 3, "y": 5 },
      { "type": "wooden-wall-section", "x": 3, "y": 6 }
    ],
    "decorations": [
      { "type": "stairs-down", "x": 10, "y": 3 },
      { "type": "stairs-down", "x": 10, "y": 4 }
    ],
    "exits": [
      { "to": "rat-tunnel", "x": 0, "y": 6, "trigger": "step-on" }
    ]
  },
  "monsters": [
    { "type": "giant-rat", "startPos": { "x": 7, "y": 1 } },
    { "type": "giant-rat", "startPos": { "x": 1, "y": 3 } },
    { "type": "giant-rat", "startPos": { "x": 2, "y": 5 } },
    { "type": "giant-rat", "startPos": { "x": 7, "y": 5 } }
  ]
}
```

`bin/play.ts` hero spawn positions move from `(0,0), (1,0), (0,1)` to `(10,2), (10,3), (10,4), (10,5)` for this scene.

### Schema notes

- `obstacles[]` is the engine-blocking list. Each entry MUST have one of the prop type IDs declared in the manifest. The engine treats an obstacle cell as impassable and as ranged/LoS-blocking.
- `decorations[]` is render-only. Walkable. No engine effect. Used here for the stairs marker and any future cosmetic-only props.
- `exits[]` with `trigger: "step-on"` fires the scene transition when any character ends a turn on that cell. Encounter 2 is not yet encoded — until it is, the step-on trigger is a no-op (engine notes that the character is on the exit cell but does not fire any transition). This prevents a hero stepping on the hole from ending the encounter early before all rats are KO'd.

## File layout

```
assets/
├── maps/
│   └── tavern-basement/
│       ├── tileset.png        (PixelLab create_topdown_tileset output)
│       └── tileset.json       (tile metadata: which tile = floor / wall-N / wall-NE / etc.)
├── props/                      (NEW directory)
│   ├── barrel-stack/
│   │   └── south.png
│   ├── wooden-wall-section/
│   │   └── south.png
│   ├── tunnel-hole/
│   │   └── south.png
│   └── stairs-down/
│       └── south.png
└── _legacy/
    └── tavern-basement.png    (archived original cartoon, not deleted)
```

Like the heroes/monsters work, props use a `<asset>/south.png` directory layout even though `n_directions: 1` for now — keeps room for future facing/animation without renaming files.

## Manifest changes

`assets/manifest.json` gains two new sections:

```json
{
  "heroes": { ... },
  "monsters": { ... },
  "maps": {
    "tavern-basement": "maps/tavern-basement/tileset.png",
    ...
  },
  "tilesets": {
    "tavern-basement": {
      "image": "maps/tavern-basement/tileset.png",
      "metadata": "maps/tavern-basement/tileset.json"
    }
  },
  "props": {
    "barrel-stack":         "props/barrel-stack/south.png",
    "wooden-wall-section":  "props/wooden-wall-section/south.png",
    "tunnel-hole":          "props/tunnel-hole/south.png",
    "stairs-down":          "props/stairs-down/south.png"
  },
  "items": {},
  "equipment": {},
  "boons": {}
}
```

The existing `maps[tavern-basement]` entry is repurposed to point at the tileset image for backward compatibility with the renderer's current single-bg path; once the tilemap renderer lands, that field can be deprecated or repointed.

`src/runtime/ws/manifest.ts:validateManifest` extends to validate `tilesets[*].image`, `tilesets[*].metadata`, and `props[*]` paths exist.

## Downstream code work (out of scope of THIS spec, but required for the assets to function)

The asset spec only commits to generating files. For the assets to actually render and play correctly, the following code changes are needed and should be picked up by the implementation plan that follows this spec:

1. **Engine** — honor `obstacles[]` in scene maps for movement validation and for ranged/magic LoS resolution. The current engine treats all cells as walkable; this needs to change for the basement to play as designed.
2. **Engine** — honor `exits[]` with `trigger: "step-on"`. Already partially in place for `all-monsters-ko`; extend to step-on triggers.
3. **Renderer** (`web/components/Board.ts`) — replace the single-scaled-background path with a tilemap assembler that consumes `tilesets[]` metadata and renders the floor/walls cell-by-cell, then layers `props` sprites at the coordinates declared in `obstacles[]` and `decorations[]`.
4. **Manifest validator** (`src/runtime/ws/manifest.ts`) — extend `validateManifest` to cover the new `tilesets` and `props` sections.
5. **Bin/play.ts** — update hero spawn positions for the basement scene from `(0,0)…(0,1)` to `(10,2)…(10,5)`.

## Validation gate

A new asset (or the full set) is approved when ALL of the following hold:

1. **Aesthetic consistency** — palette, outline weight, shading, and detail level are consistent with the warrior/hunter/healer/warlock/giant-rat/king-rat sprites already approved in `2026-05-10-pixel-art-direction-design.md`. Side-by-side at 64 px must look like the same game.
2. **Tileset seamlessness** — when the renderer assembles the 11×7 room shell, no visible seams or pattern repetition that breaks the illusion of a single floor.
3. **Prop legibility at 64 px** — on the live board, each prop sprite is unambiguous: a barrel reads as a barrel, the wall section reads as a wood-plank wall, the hole reads as a broken-floorboard pit, the stairs read as descending stairs. The four prop types must be visually distinct from each other.
4. **Engine correctness** — once the downstream engine work lands, rats cannot path through obstacle cells; ranged attacks across obstacle cells are blocked by the engine; the (0,6) cell triggers the encounter-2 transition when stepped on.
5. **No regression** — the existing vitest suite still passes; `npm run play -- --browser` shows the new layout end-to-end with heroes spawned at the east wall and rats at canonical positions.

If a generation fails any of (1)–(3): regenerate with adjusted `description` first; only fall back to `pro` mode if `standard` cannot reach approval after two attempts. This matches the cost discipline locked in the prior pixel-art-direction spec.

## Reference exemplars

After approval, the validated tileset and props will be mirrored to `docs/superpowers/specs/assets/2026-05-10-tavern-basement-map/` alongside the heroes/monsters exemplars from the prior session, with a table of PixelLab IDs added back to this spec for future regeneration.

## Open questions (for future sessions)

1. **Encounters 2–5 maps** — the tileset + prop pattern locked here can be reused for the cave encounters, but the cave maps are organic shapes (not rectangular rooms), so the wall-edge tile set may need additional curved/diagonal variants. Decide when encoding encounter 2.
2. **Decorations beyond stairs** — sacks of grain, broken crates, and other dressing were deferred. Worth adding once the tactical layout is proven on the board.
3. **Animated props** — the tunnel-hole could benefit from a subtle dark-pulse animation hinting at "something is in there". Out of scope for this spec; revisit when `mcp__pixellab__animate_object` becomes part of the pipeline.
