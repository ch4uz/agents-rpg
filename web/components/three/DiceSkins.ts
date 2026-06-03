/**
 * Per-unit dice "skins". Each character (hero / monster / DM) carries its
 * own tint AND material profile — so attack rolls visibly distinguish whose
 * dice are whose, and initiative rolls show every combatant's die with a
 * unique surface (polished gold for warrior, magical glow for warlock, etc.).
 *
 * Each skin is a `DieMaterialOverrides` (with `tint` required); see
 * `DiceMesh.ts` for the full override surface.
 */
import type { DieMaterialOverrides } from './DiceMesh.js';

export interface DiceSkin extends DieMaterialOverrides {
  tint: number;
  /** Optional override used ONLY by the 2D dice icon in the combat HUD.
   *  The 2D `mix-blend-mode: multiply` path reads colors differently from
   *  the 3D PBR pipeline (no texture, no lighting), so some hues need a
   *  bespoke value to read the same on screen. Falls back to `tint` when
   *  unset. */
  iconTint?: number;
}

/** Map of hero archetype → skin. Each archetype gets a distinct surface
 *  feel:
 *    - warrior: bright yellow — painted/lacquered look
 *    - hunter:  forest green — matte wood-like surface
 *    - warlock: blood-red — slight dark emissive for menace
 *    - healer:  rose with gentle emissive (unchanged — not yet redefined)
 */
const HERO_TINTS: Record<string, DiceSkin> = {
  warrior: {
    tint:      0xffd838,  // saturated yellow
    metalness: 0.1,
    roughness: 0.55,      // slight sheen, but mostly matte
  },
  hunter: {
    tint:      0x4ec85a,  // forest green (3D)
    iconTint:  0x2f8a3a,  // 2D icon reads ~30% darker to match perceived 3D shading
    metalness: 0.0,
    roughness: 0.85,      // matte natural feel
  },
  warlock: {
    tint:              0xff4040,  // bright fiery red (3D)
    iconTint:          0xff1818,  // 2D icon shows pure saturated red (less pink cast)
    metalness:         0.1,
    roughness:         0.55,      // slightly more reflective for extra pop
    emissive:          0x802020,  // strong red glow
    emissiveIntensity: 0.3,
  },
  healer: {
    tint:              0xff9ec3,  // rose (3D — carried over from v1)
    iconTint:          0xfb8a95,  // 2D icon: salmon-pink (warm with a pink shift)
    metalness:         0.1,
    roughness:         0.55,
    emissive:          0xffb8d0,
    emissiveIntensity: 0.18,
  },
};

/** Monster dice = "standard" — no tint, default material. The natural
 *  dice texture renders unmodified so monsters read as a baseline. */
const MONSTER_TINT: DiceSkin = { tint: 0xffffff };

/** DM = polished gold. Metallic warm yellow with sharp highlights so DM
 *  rolls (rare, narrative-driven) stand out as something special. */
const DM_TINT: DiceSkin = {
  tint:      0xffd070,
  metalness: 0.85,
  roughness: 0.3,
};

const NEUTRAL_TINT: DiceSkin = { tint: 0xffffff };  // fallback (no tint)

/**
 * Pick a skin for a character given its kind + archetype. Falls back to a
 * neutral white skin for unknown archetypes / dm-without-other-info so
 * dice always have a valid skin and never throw at runtime.
 */
export const skinForCharacter = (
  kind: 'hero' | 'monster' | 'npc' | 'dm',
  archetype: string | null,
): DiceSkin => {
  if (kind === 'hero' && archetype) {
    const found = HERO_TINTS[archetype];
    if (found) return found;
  }
  if (kind === 'monster' || kind === 'npc') return MONSTER_TINT;
  if (kind === 'dm') return DM_TINT;
  return NEUTRAL_TINT;
};
