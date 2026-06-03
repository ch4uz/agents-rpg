export type Terrain = 'lower' | 'upper';

export interface TileCorners {
  NW: Terrain;
  NE: Terrain;
  SW: Terrain;
  SE: Terrain;
}

export interface TileBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WangTile {
  corners: TileCorners;
  bbox: TileBox;
}

export interface TilesetMetadata {
  tileSize:  { width: number; height: number };
  imageSize: { width: number; height: number };
  tiles:     WangTile[];
}

const isTerrain = (v: unknown): v is Terrain => v === 'lower' || v === 'upper';

const isCorners = (v: unknown): v is TileCorners =>
  v !== null && typeof v === 'object' &&
  isTerrain((v as Record<string, unknown>)['NW']) &&
  isTerrain((v as Record<string, unknown>)['NE']) &&
  isTerrain((v as Record<string, unknown>)['SW']) &&
  isTerrain((v as Record<string, unknown>)['SE']);

const isBox = (v: unknown): v is TileBox =>
  v !== null && typeof v === 'object' &&
  typeof (v as Record<string, unknown>)['x']      === 'number' &&
  typeof (v as Record<string, unknown>)['y']      === 'number' &&
  typeof (v as Record<string, unknown>)['width']  === 'number' &&
  typeof (v as Record<string, unknown>)['height'] === 'number';

/**
 * Validate and normalize a PixelLab create_topdown_tileset metadata blob into
 * the renderer's expected shape. Throws on missing or malformed required fields.
 */
export const loadTilesetMetadata = (raw: unknown): TilesetMetadata => {
  if (raw === null || typeof raw !== 'object') throw new Error('tileset metadata must be an object');
  const r = raw as Record<string, unknown>;

  const ts = r['tile_size'];
  if (!ts || typeof ts !== 'object'
    || typeof (ts as Record<string, unknown>)['width']  !== 'number'
    || typeof (ts as Record<string, unknown>)['height'] !== 'number') {
    throw new Error('tileset metadata: tile_size.{width,height} required');
  }
  const tileSize = { width: (ts as Record<string, number>)['width']!, height: (ts as Record<string, number>)['height']! };

  const ti = r['tileset_image'];
  const tiDims = ti && typeof ti === 'object' ? (ti as Record<string, unknown>)['dimensions'] : null;
  if (!tiDims || typeof tiDims !== 'object'
    || typeof (tiDims as Record<string, unknown>)['width']  !== 'number'
    || typeof (tiDims as Record<string, unknown>)['height'] !== 'number') {
    throw new Error('tileset metadata: tileset_image.dimensions.{width,height} required');
  }
  const imageSize = { width: (tiDims as Record<string, number>)['width']!, height: (tiDims as Record<string, number>)['height']! };

  const td = r['tileset_data'];
  const tilesRaw = td && typeof td === 'object' ? (td as Record<string, unknown>)['tiles'] : null;
  if (!Array.isArray(tilesRaw)) {
    throw new Error('tileset metadata: tileset_data.tiles[] required');
  }
  if (tilesRaw.length === 0) {
    throw new Error('tileset metadata: tileset_data.tiles must be non-empty');
  }

  const tiles: WangTile[] = tilesRaw.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`tileset metadata: tile ${i} must be an object`);
    const tr = t as Record<string, unknown>;
    if (!isCorners(tr['corners']))     throw new Error(`tileset metadata: tile ${i} missing corners.{NW,NE,SW,SE}`);
    if (!isBox(tr['bounding_box']))    throw new Error(`tileset metadata: tile ${i} missing bounding_box.{x,y,width,height}`);
    return { corners: tr['corners'], bbox: tr['bounding_box'] };
  });

  return { tileSize, imageSize, tiles };
};

/** `${x},${y}` key for a wall-cell membership set. */
export const cellKey = (x: number, y: number): string => `${x},${y}`;

/**
 * Pick the Wang tile bounding_box for cell (cx, cy) in a (gridW × gridH) scene.
 *
 * Two modes:
 *
 *  1. **Carved cave** — when `wallMask` (a set of `${x},${y}` keys for the
 *     scene's impassable `rock` cells) is supplied, the cave outline is drawn
 *     by a marching-squares pass: a tile corner (vertex) is 'upper' (rock) iff
 *     ALL four cells touching that vertex are walls, where out-of-bounds counts
 *     as wall so the cave closes cleanly at the grid edge. This makes wall
 *     interiors render as solid rock and wall↔floor borders render as the
 *     transition tiles, following whatever organic shape `wallMask` describes.
 *
 *  2. **Rectangular ring** — with no `wallMask`, the legacy behaviour: when
 *     `walls` is true (default) the room perimeter vertices are 'upper'; when
 *     false every cell uses the all-lower (floor) tile.
 *
 * If no Wang tile matches the computed corners (defensive fallback), returns
 * the all-lower tile's bbox.
 */
export const chooseTileBox = (
  cx: number, cy: number, gridW: number, gridH: number, meta: TilesetMetadata,
  walls = true,
  wallMask?: ReadonlySet<string>,
): TileBox => {
  const allLower = meta.tiles.find((t) =>
    t.corners.NW === 'lower' && t.corners.NE === 'lower' &&
    t.corners.SW === 'lower' && t.corners.SE === 'lower');

  let corner: (vx: number, vy: number) => Terrain;
  if (wallMask) {
    // Out-of-bounds counts as wall so the cave seals at the grid edge.
    const isWall = (x: number, y: number): boolean =>
      x < 0 || x >= gridW || y < 0 || y >= gridH || wallMask.has(cellKey(x, y));
    corner = (vx, vy) =>
      isWall(vx - 1, vy - 1) && isWall(vx, vy - 1) &&
      isWall(vx - 1, vy    ) && isWall(vx, vy    )
        ? 'upper' : 'lower';
  } else {
    if (!walls) return allLower?.bbox ?? meta.tiles[0]!.bbox;
    corner = (vx, vy) =>
      (vx === 0 || vx === gridW || vy === 0 || vy === gridH) ? 'upper' : 'lower';
  }

  const want: TileCorners = {
    NW: corner(cx,     cy    ),
    NE: corner(cx + 1, cy    ),
    SW: corner(cx,     cy + 1),
    SE: corner(cx + 1, cy + 1),
  };

  const match = meta.tiles.find((t) =>
    t.corners.NW === want.NW && t.corners.NE === want.NE &&
    t.corners.SW === want.SW && t.corners.SE === want.SE);
  if (match) return match.bbox;

  return allLower?.bbox ?? meta.tiles[0]!.bbox;
};
