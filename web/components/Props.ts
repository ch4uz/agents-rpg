export type PropLayer = 'decoration' | 'obstacle' | 'exit';

export interface PropPlacement {
  x: number;
  y: number;
  assetRel: string;
  layer: PropLayer;
}

export interface SceneMapForProps {
  obstacles:   { type: string; x: number; y: number; explosive?: boolean }[];
  decorations: { type: string; x: number; y: number }[];
  exits:       { to: string; at: { x: number; y: number }; trigger: 'manual' | 'step-on' }[];
  /**
   * Cells whose scene-declared obstacle has been smashed mid-scene
   * (attack_object). Optional so callers built before the feature stay
   * source-compatible. Matching obstacle entries are skipped.
   */
  destroyedObstacles?: { x: number; y: number }[];
}

/**
 * Pure: resolve every prop placement (decorations + obstacles + exits) into a
 * list of {x, y, assetRel, layer}. Layer order is decoration → obstacle → exit
 * so renderers that draw in array order produce the right z-stacking. Any
 * placement whose `type` (or, for exits, whose `to`-mapped prop) is absent
 * from the manifest is silently skipped. Obstacles listed in
 * `destroyedObstacles` are also skipped — those cells went floor mid-scene.
 */
export const resolvePropPlacements = (
  scene: SceneMapForProps,
  props: Record<string, string>,
  exitToProp: Record<string, string>,
): PropPlacement[] => {
  const out: PropPlacement[] = [];
  const destroyed = new Set(
    (scene.destroyedObstacles ?? []).map((d) => `${d.x},${d.y}`),
  );
  for (const d of scene.decorations) {
    const rel = props[d.type];
    if (rel) out.push({ x: d.x, y: d.y, assetRel: rel, layer: 'decoration' });
  }
  for (const o of scene.obstacles) {
    if (destroyed.has(`${o.x},${o.y}`)) continue;
    const rel = props[o.type];
    if (rel) out.push({ x: o.x, y: o.y, assetRel: rel, layer: 'obstacle' });
  }
  for (const e of scene.exits) {
    const propId = exitToProp[e.to];
    const rel = propId ? props[propId] : undefined;
    if (rel) out.push({ x: e.at.x, y: e.at.y, assetRel: rel, layer: 'exit' });
  }
  return out;
};
