import { describe, it, expect } from 'vitest';
import { chooseTileBox, loadTilesetMetadata } from '../../web/components/TileMap.js';

// Minimal Wang tileset for tests (subset of the 16 tiles we'd have in real metadata).
const META = loadTilesetMetadata({
  tile_size: { width: 32, height: 32 },
  tileset_image: { dimensions: { width: 128, height: 128 } },
  tileset_data: {
    tiles: [
      // All-lower (pure floor) — interior tile
      { corners: { NW: 'lower', NE: 'lower', SW: 'lower', SE: 'lower' },
        bounding_box: { x: 64, y: 32, width: 32, height: 32 } },
      // All-upper (pure wall) — fully outside the room
      { corners: { NW: 'upper', NE: 'upper', SW: 'upper', SE: 'upper' },
        bounding_box: { x: 0, y: 96, width: 32, height: 32 } },
      // NW=upper, NE=upper, SW=upper, SE=lower — top-left CORNER cell shape
      { corners: { NW: 'upper', NE: 'upper', SW: 'upper', SE: 'lower' },
        bounding_box: { x: 32, y: 96, width: 32, height: 32 } },
      // NW=upper, NE=upper, SW=lower, SE=lower — top edge interior cell
      { corners: { NW: 'upper', NE: 'upper', SW: 'lower', SE: 'lower' },
        bounding_box: { x: 96, y: 0, width: 32, height: 32 } },
      // NW=lower, NE=lower, SW=upper, SE=upper — bottom edge interior cell
      { corners: { NW: 'lower', NE: 'lower', SW: 'upper', SE: 'upper' },
        bounding_box: { x: 32, y: 64, width: 32, height: 32 } },
      // NW=lower, NE=lower, SW=lower, SE=upper — single SE rock corner
      { corners: { NW: 'lower', NE: 'lower', SW: 'lower', SE: 'upper' },
        bounding_box: { x: 0, y: 0, width: 32, height: 32 } },
    ],
  },
});

describe('chooseTileBox (11×7 room, perimeter-vertex rule)', () => {
  it('returns the all-lower tile for an interior cell', () => {
    expect(chooseTileBox(5, 3, 11, 7, META)).toEqual({ x: 64, y: 32, width: 32, height: 32 });
  });

  it('returns the NW-NE-SW=upper, SE=lower tile for the top-left corner cell (0,0)', () => {
    expect(chooseTileBox(0, 0, 11, 7, META)).toEqual({ x: 32, y: 96, width: 32, height: 32 });
  });

  it('returns the NW-NE=upper, SW-SE=lower tile for top-edge interior cell (5,0)', () => {
    expect(chooseTileBox(5, 0, 11, 7, META)).toEqual({ x: 96, y: 0, width: 32, height: 32 });
  });

  it('returns the SW-SE=upper, NW-NE=lower tile for bottom-edge interior cell (5,6)', () => {
    expect(chooseTileBox(5, 6, 11, 7, META)).toEqual({ x: 32, y: 64, width: 32, height: 32 });
  });
});

describe('chooseTileBox (walls=false)', () => {
  it('returns the all-lower tile for every cell, including the perimeter', () => {
    const allLower = { x: 64, y: 32, width: 32, height: 32 };
    expect(chooseTileBox(0, 0, 11, 7, META, false)).toEqual(allLower);
    expect(chooseTileBox(5, 0, 11, 7, META, false)).toEqual(allLower);
    expect(chooseTileBox(10, 6, 11, 7, META, false)).toEqual(allLower);
    expect(chooseTileBox(5, 3, 11, 7, META, false)).toEqual(allLower);
  });
});

describe('chooseTileBox (wallMask carved cave, marching squares)', () => {
  const allLower = { x: 64, y: 32, width: 32, height: 32 };
  const allUpper = { x: 0, y: 96, width: 32, height: 32 };
  // A 5×5 scene with a solid 3×3 rock block at x∈[2,4], y∈[2,4] anchored to the
  // SE corner so OOB-as-wall makes its core a fully solid cell.
  const W = 5, H = 5;
  const mask = new Set(['2,2', '3,2', '4,2', '2,3', '3,3', '4,3', '2,4', '3,4', '4,4']);

  it('returns the all-lower tile for a fully-interior floor cell', () => {
    expect(chooseTileBox(0, 0, W, H, META, true, mask)).toEqual(allLower);
  });

  it('returns the all-upper (solid rock) tile for a wall cell whose every corner is surrounded by wall', () => {
    // Cell (3,3): its four corner-vertices are each touched only by wall cells
    // (the 3×3 block + OOB), so all corners are upper → solid rock.
    expect(chooseTileBox(3, 3, W, H, META, true, mask)).toEqual(allUpper);
  });

  it('draws the wall→floor transition on the block boundary cell (2,2)', () => {
    // Cell (2,2) sits at the NW corner of the rock block. Only its SE vertex
    // (3,3) is surrounded entirely by wall → upper; the other three corners
    // touch the floor cells to the N/W → lower. That matches the SE-only tile.
    expect(chooseTileBox(2, 2, W, H, META, true, mask))
      .toEqual({ x: 0, y: 0, width: 32, height: 32 });
  });

  it('ignores the perimeter-ring `walls` flag when a wallMask is supplied', () => {
    // With a mask, walls=true must NOT add a perimeter ring: corner floor cell
    // (0,0) stays all-lower instead of the ring's corner tile.
    expect(chooseTileBox(0, 0, W, H, META, true, mask)).toEqual(allLower);
    expect(chooseTileBox(0, 0, W, H, META, false, mask)).toEqual(allLower);
  });
});

describe('loadTilesetMetadata', () => {
  it('rejects missing tile_size', () => {
    expect(() => loadTilesetMetadata({ tileset_image: { dimensions: { width: 128, height: 128 } }, tileset_data: { tiles: [] } } as never))
      .toThrow();
  });

  it('rejects missing tileset_data.tiles', () => {
    expect(() => loadTilesetMetadata({ tile_size: { width: 32, height: 32 }, tileset_image: { dimensions: { width: 128, height: 128 } } } as never))
      .toThrow();
  });

  it('rejects a tile missing corners or bounding_box', () => {
    expect(() => loadTilesetMetadata({
      tile_size: { width: 32, height: 32 },
      tileset_image: { dimensions: { width: 128, height: 128 } },
      tileset_data: { tiles: [{ corners: { NW: 'lower', NE: 'lower', SW: 'lower' }, bounding_box: { x: 0, y: 0, width: 32, height: 32 } }] },
    } as never)).toThrow();
  });

  it('rejects an empty tiles array', () => {
    expect(() => loadTilesetMetadata({
      tile_size: { width: 32, height: 32 },
      tileset_image: { dimensions: { width: 128, height: 128 } },
      tileset_data: { tiles: [] },
    } as never)).toThrow(/non-empty/);
  });

  it('preserves the actual tileset.json format from PixelLab', async () => {
    // Spot-check that the real tileset.json on disk parses cleanly.
    const fs = await import('node:fs');
    const raw = JSON.parse(fs.readFileSync('assets/maps/tavern-basement/tileset.json', 'utf8')) as unknown;
    const meta = loadTilesetMetadata(raw);
    expect(meta.tileSize).toEqual({ width: 32, height: 32 });
    expect(meta.imageSize).toEqual({ width: 128, height: 128 });
    expect(meta.tiles.length).toBe(16);
    // The all-lower tile must exist (otherwise we can't fall back).
    const allLower = meta.tiles.find((t) => t.corners.NW === 'lower' && t.corners.NE === 'lower' && t.corners.SW === 'lower' && t.corners.SE === 'lower');
    expect(allLower).toBeDefined();
  });
});
