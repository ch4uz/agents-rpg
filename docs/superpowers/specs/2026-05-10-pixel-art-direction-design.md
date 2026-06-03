# Pixel-Art Asset Direction

**Date:** 2026-05-10
**Status:** Approved (validated against the warrior generation; see exemplars/)
**Scope:** Defines the parameters PixelLab MCP must use when regenerating any in-game asset, so that the four heroes, the monsters, and (eventually) the maps share a single coherent visual identity.

## Context

The repository ships with cartoon Hero Kids portraits (~272×470 PNG, white background) and 640×475 illustrated map backgrounds. The browser renderer (`web/components/Board.ts`) draws each entity bottom-anchored inside a 64-px cell with `fitTokenScale` preserving aspect ratio.

We are migrating to pixel art — generated via the PixelLab MCP — to give the project a consistent retro-JRPG identity that reads cleanly at the 64-px cell size. This document locks the art direction. Every future asset regeneration MUST use these parameters; only the `description` and (for quadrupeds) the `template` change per asset.

## Locked parameters — humanoid characters

These apply to every hero (warrior, hunter, healer, warlock) and any future humanoid NPC. Use the `mcp__pixellab__create_character` tool.

| Parameter | Value | Rationale |
|---|---|---|
| `mode` | `standard` | 1 generation per character. Reserve `pro` only if standard quality is rejected. |
| `body_type` | `humanoid` | — |
| `view` | `low top-down` | Matches JRPG standee convention; pairs with bottom-anchored token rendering. |
| `n_directions` | `4` | south/west/east/north. Engine has no facing yet, but having frames now means future facing costs nothing. |
| `size` | `48` | Canvas lands at ~68 px; chibi sprite fills the 64-cell well after `fitTokenScale`. |
| `proportions` | `{"type":"preset","name":"chibi"}` | Big head, small body — matches the *Hero Kids* brand. |
| `outline` | `single color black outline` | Classic JRPG readability at 48 px. |
| `shading` | `basic shading` | Volume cue without reading muddy at small sizes. |
| `detail` | `medium detail` | Sweet spot for 48 px. |
| `ai_freedom` | `750` | Default. Bump only if results feel templatey. |

## Locked parameters — monsters

Monster body type depends on the creature's posture in its source reference, not on its species. Decide per asset by looking at the cartoon PNG before generating:

- **Four-legged in source** (e.g., giant-rat) → `body_type: "quadruped"` with the closest available template (`bear`, `cat`, `dog`, `horse`, `lion`). For rat-like creatures, use `cat` and let the prompt push toward "rat" (rounded ears, long bald tail, smaller body).
- **Bipedal in source** (e.g., king-rat — wears a cloak, holds a staff) → `body_type: "humanoid"` + `chibi` proportions, plus a "rat-headed humanoid" cue in the description. Quadruped templates won't render gear or props.

| Parameter | Value | Rationale |
|---|---|---|
| `mode` | `standard` | Same cost discipline as heroes. |
| `view` | `low top-down` | Same as heroes for visual consistency. |
| `n_directions` | `4` | Same as heroes. |
| `size` | `48` (default) | Bump bosses up (king-rat used `56`) so they read as physically larger than the party on the board. |
| `outline` | `single color black outline` | — |
| `shading` | `basic shading` | — |
| `detail` | `medium detail` | — |

`proportions` is ignored for quadrupeds; for humanoid monsters, use `{"type":"preset","name":"chibi"}` to match the heroes.

### Lessons from this session

- The original spec assumed both rats were quadrupeds (cat template). After looking at the king-rat reference, that was wrong: he's a bipedal ratman with cloak + crown + staff. The quadruped pipeline can't render that. **Always look at the source PNG before deciding `body_type`.**
- Quadruped templates aren't perfectly species-matched. The `cat` template gave a good giant-rat after prompt-pushing, but the underlying skeleton is a cat — long tail, pointed snout, ears scaled down to rat proportions in the prompt. Acceptable trade.

## Description prompts

The `description` field is the only thing that varies per asset. Hero descriptions mirror the existing cartoon references. Each prompt opens with `chibi child <archetype>` to anchor proportions and tone.

### Heroes

All four heroes were generated and validated in this session.

- **warrior**:
  > chibi child warrior with messy brown hair and a wide grin, wearing a grey tunic, brown leather pauldron and bracer on the left arm, dark brown boots; holding a small wooden round shield with leather banding in the left hand and a steel shortsword in the right hand

- **hunter**:
  > chibi child hunter with messy brown hair, wearing a forest-green hooded tunic and brown leggings, brown leather bracer and bandolier; carrying a brown leather quiver full of arrows on the back; holding a wooden longbow with one hand

- **healer**:
  > chibi child healer girl with very long flowing golden blonde hair down to her feet, wearing a violet dress with puffed shoulders and a gold belt, a small gold tiara, blue slippers, smiling warmly

- **warlock**:
  > chibi child warlock with shaved head and a fierce grin, bare chested with dark tattoos across the torso, wearing a gold collar and a red leather kilt with tan leather boots; both hands wreathed in glowing orange flames

  Note: standard mode dropped the second flame and most chest tattoo detail at 48 px. The remaining bald-head + single-flame + red-kilt silhouette reads unambiguously as a warlock and was approved as-is. If you regenerate, expect the same loss of detail unless you bump to `pro` mode.

When adding new humanoids in the future, study any existing reference first and write the description to faithfully mirror palette, hair color, and signature equipment. Keep prompts ≤2 sentences; PixelLab handles the rest. Avoid combining "bare chested" with multi-source flames in a single prompt — that combination caused a long stall during this session's warlock generation.

### Monsters

Both monsters were generated and validated in this session.

- **giant-rat** (quadruped, `cat` template, size 48):
  > giant chibi rat with patchy brown-grey fur, long bald pink tail, pink ears, yellow incisors bared, small red eyes, four short legs in a low predatory stance

- **king-rat** (humanoid, chibi proportions, size 56):
  > chibi rat-headed humanoid king standing upright on two legs, brown fur with shaggy grey mane, jagged gold crown, tattered grey cloak, leather wraps around the legs, holding a wooden staff topped with a glowing torch flame in one hand, fierce yellow incisors

  Note: stalled at 90% with growing-ETA for ~5 min before recovering — same retry-loop pattern as the warlock generation. Likely the "torch flame" cue. Standard mode eventually finished without intervention.

## Maps — out of scope of this direction

The five 640×475 map backgrounds are NOT covered by this spec. They use a different generation pipeline (`mcp__pixellab__create_topdown_tileset` for tile-based maps, or stay as illustrated backgrounds). Decide separately whether to:

1. Leave the existing illustrated maps in place (they already read well behind pixel-art tokens), or
2. Regenerate as Wang tilesets and assemble per encounter, or
3. Generate single composite map images via `create_object` directions=1.

That decision belongs to its own brainstorm.

## File layout convention

When regenerating a hero or monster:

1. Run `create_character` with the parameters above.
2. Poll `get_character` until complete (~2-3 minutes).
3. Download all four rotations to `assets/<heroes|monsters>/<asset>/{south,east,north,west}.png`.
4. Update `assets/manifest.json`: change the entry from a flat `"warrior": "heroes/warrior.png"` to a directional record `"warrior": { "south": "heroes/warrior/south.png", "east": "...", "north": "...", "west": "..." }` — IF and only if the renderer has been updated to consume directional records. Until then, point the manifest at `<asset>/south.png` and keep the other three rotations on disk for later.
5. Archive the original cartoon PNG to `assets/_legacy/<asset>.png` rather than deleting (rollback safety).

## Validation gate

A new asset is approved when ALL of the following hold:

1. The brief was followed (palette, gear, archetype reads correctly).
2. The four rotations are coherent with each other (no model swap mid-generation).
3. At 64 px in the live board, the character is recognizable AND visually distinct from every other approved sprite in the same category (e.g., warrior vs hunter must be unambiguous).
4. Background is fully transparent (PixelLab guarantees this — sanity-check with `file` against the 8-bit RGBA marker).

If any check fails: regenerate with adjusted `description` first; only fall back to `pro` mode (20-40× cost) if `standard` cannot reach approval after two attempts.

## Reference exemplars

The validated generations live at `docs/superpowers/specs/assets/2026-05-10-pixel-art-direction/<name>/{south,east,north,west}.png` and are also installed at `assets/<heroes|monsters>/<name>/`. PixelLab character IDs:

| Asset | ID |
|---|---|
| warrior | `7997c635-7f1c-4306-b5f5-f29b5ec1cf95` |
| hunter | `2b4d1b35-855b-47f8-b1e9-9aef3be1d36d` |
| healer | `136cffe3-8d90-4468-83a7-44ff2d559d29` |
| warlock | `85ab6f67-ec67-4b66-9937-ddf8efe22b9d` |
| giant-rat | `eb885ec4-e653-4cff-820f-a05e1493b69e` |
| king-rat | `ed3cd0ed-2624-4a15-9f25-59a28ebf3415` |

Use this party as the visual benchmark when judging future generations. If a new sprite feels like it belongs to a different game than these six, regenerate.

## Open questions (for future sessions)

1. Update the renderer to consume directional sprites (`facing` on character snapshots), or keep using south-only?
2. Maps: regenerate or leave as illustrated backgrounds?
3. Items / equipment / boons in `manifest.json` are currently empty — when these get content, do they follow the same chibi/48-px direction or get their own (e.g., 32-px isolated objects via `create_object`)?
