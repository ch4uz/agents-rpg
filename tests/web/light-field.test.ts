import { describe, it, expect } from 'vitest';
import {
  buildOccluderMask,
  deriveStaticLights,
  ambientFor,
  hasLineOfSight,
  computeLightField,
  effectiveDitherPx,
  AMBIENT_CAVE,
  AMBIENT_ROOM,
  type LightScene,
  type LightSource,
} from '../../web/components/light-field.js';

const scene = (over: Partial<LightScene>): LightScene => ({
  gridW: 5,
  gridH: 5,
  walls: false,
  obstacles: [],
  decorations: [],
  ...over,
});

describe('buildOccluderMask', () => {
  it('uses carved wallCells when present', () => {
    const occ = buildOccluderMask(scene({ wallCells: [{ x: 2, y: 2 }, { x: 3, y: 2 }] }));
    expect(occ.has('2,2')).toBe(true);
    expect(occ.has('3,2')).toBe(true);
    expect(occ.has('0,0')).toBe(false);
  });

  it('uses the rectangular ring when walls=true and no wallCells', () => {
    const occ = buildOccluderMask(scene({ walls: true }));
    expect(occ.has('0,0')).toBe(true);
    expect(occ.has('4,0')).toBe(true);
    expect(occ.has('0,4')).toBe(true);
    expect(occ.has('2,2')).toBe(false); // interior open
  });

  it('includes standing obstacles but excludes smashed ones', () => {
    const occ = buildOccluderMask(scene({
      obstacles: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
      destroyedObstacles: [{ x: 2, y: 1 }],
    }));
    expect(occ.has('1,1')).toBe(true);
    expect(occ.has('2,1')).toBe(false); // smashed → light flows through
  });
});

describe('deriveStaticLights', () => {
  it('maps known light props to cell-centred sources and ignores unknown types', () => {
    const lights = deriveStaticLights(scene({
      decorations: [
        { type: 'glowing-mushroom', x: 1, y: 2 },
        { type: 'rat-hole', x: 0, y: 0 }, // no light
      ],
    }));
    expect(lights).toHaveLength(1);
    expect(lights[0]).toMatchObject({ x: 1.5, y: 2.5 });
    expect(lights[0]!.color).toEqual({ r: 120, g: 245, b: 175 });
  });

  it('does not emit a light from a smashed light-obstacle', () => {
    // glowing-mushroom modelled as an obstacle here to exercise the destroyed path.
    const s = scene({
      obstacles: [{ x: 4, y: 4 } as never],
      destroyedObstacles: [{ x: 4, y: 4 }],
    });
    (s.obstacles[0] as { type?: string }).type = 'glowing-mushroom';
    expect(deriveStaticLights(s)).toHaveLength(0);
  });
});

describe('ambientFor', () => {
  it('returns the dark cave ambient when wallCells exist', () => {
    expect(ambientFor(scene({ wallCells: [{ x: 0, y: 0 }] }))).toBe(AMBIENT_CAVE);
  });
  it('returns the warm room ambient otherwise', () => {
    expect(ambientFor(scene({}))).toBe(AMBIENT_ROOM);
  });
});

describe('hasLineOfSight', () => {
  const occAt = (cells: string[]) => (x: number, y: number) => cells.includes(`${x},${y}`);

  it('is clear across open ground', () => {
    expect(hasLineOfSight(0, 0, 4, 0, occAt([]))).toBe(true);
  });

  it('is blocked by an intermediate occluder', () => {
    expect(hasLineOfSight(0, 0, 4, 0, occAt(['2,0']))).toBe(false);
  });

  it('does not test the endpoints (a wall face can be lit)', () => {
    // (4,0) is the target wall itself — LoS to it stays clear.
    expect(hasLineOfSight(0, 0, 4, 0, occAt(['4,0']))).toBe(true);
    // (0,0) is the light's own cell.
    expect(hasLineOfSight(0, 0, 4, 0, occAt(['0,0']))).toBe(true);
  });

  it('is clear to an adjacent cell (no cells in between)', () => {
    expect(hasLineOfSight(1, 1, 2, 1, occAt(['9,9']))).toBe(true);
  });
});

describe('effectiveDitherPx', () => {
  it('keeps the base size at / near a native (≈1:1) display scale', () => {
    expect(effectiveDitherPx(1, 1)).toBe(1);
    expect(effectiveDitherPx(1, 1.3)).toBe(1);
    expect(effectiveDitherPx(1, 0.8)).toBe(1); // mild downscale
  });

  it('doubles the cell for typical CSS upscales (hi-dpi / large screens)', () => {
    expect(effectiveDitherPx(1, 1.5)).toBe(2);
    expect(effectiveDitherPx(1, 2.644)).toBe(2); // the measured moiré case
    expect(effectiveDitherPx(1, 3.2)).toBe(2);
  });

  it('triples the cell for extreme upscales', () => {
    expect(effectiveDitherPx(1, 3.5)).toBe(3);
    expect(effectiveDitherPx(1, 8)).toBe(3);
  });

  it('scales the artistic base and never drops below 1', () => {
    expect(effectiveDitherPx(2, 2)).toBe(4); // base 2, ×2 upscale band
    expect(effectiveDitherPx(1, 0)).toBe(1); // degenerate scale → clamps to 1
  });
});

describe('computeLightField', () => {
  const SUB = 4;
  const mkBuf = (gridW: number, gridH: number) =>
    new Uint8ClampedArray(gridW * SUB * gridH * SUB * 4);

  it('fills with ambient when there are no lights, alpha=255', () => {
    const out = mkBuf(3, 3);
    computeLightField({
      gridW: 3, gridH: 3, sub: SUB,
      ambient: { r: 50, g: 60, b: 70 },
      lights: [], occluders: new Set(), out,
    });
    expect(out[0]).toBe(50);
    expect(out[1]).toBe(60);
    expect(out[2]).toBe(70);
    expect(out[3]).toBe(255);
  });

  const sampleCell = (out: Uint8ClampedArray, gridW: number, cx: number, cy: number) => {
    // Centre texel of cell (cx,cy).
    const tx = cx * SUB + (SUB >> 1);
    const ty = cy * SUB + (SUB >> 1);
    const o = (ty * gridW * SUB + tx) * 4;
    return { r: out[o]!, g: out[o + 1]!, b: out[o + 2]! };
  };

  it('brightens the lit cell above ambient and leaves shadowed cells at ambient', () => {
    const gridW = 5, gridH = 1;
    const out = mkBuf(gridW, gridH);
    const ambient = { r: 20, g: 20, b: 20 };
    const light: LightSource = { x: 0.5, y: 0.5, radius: 6, color: { r: 255, g: 255, b: 255 }, intensity: 1 };
    // Wall at cell (2,0) shadows cells 3 and 4 from a light at cell 0.
    computeLightField({
      gridW, gridH, sub: SUB, ambient, lights: [light],
      occluders: new Set(['2,0']), out,
    });
    const lit = sampleCell(out, gridW, 0, 0);
    const behind = sampleCell(out, gridW, 4, 0);
    expect(lit.r).toBeGreaterThan(ambient.r);     // light's own cell is lit
    expect(behind).toEqual(ambient);              // cell behind the wall stays dark
  });

  it('softens the shadow edge into a sub-cell penumbra (no hard cell step)', () => {
    const gridW = 5, gridH = 1;
    const out = mkBuf(gridW, gridH);
    const ambient = { r: 20, g: 20, b: 20 };
    const light: LightSource = { x: 0.5, y: 0.5, radius: 6, color: { r: 255, g: 255, b: 255 }, intensity: 1 };
    // Wall at (2,0): its near face (cell 2) is lit, cells 3+ fall into shadow.
    computeLightField({
      gridW, gridH, sub: SUB, ambient, lights: [light],
      occluders: new Set(['2,0']), out,
    });
    const litFace = sampleCell(out, gridW, 2, 0).r; // lit wall-face cell
    // Leftmost texel of the first shadowed cell (3) abuts the lit face cell, so
    // bilinear visibility gives it PARTIAL light — strictly between full ambient
    // and the lit face. A hard per-cell mask would leave it exactly at ambient.
    const edgeTexel = out[(2 * gridW * SUB + 3 * SUB) * 4]!; // row ty=SUB/2, tx=cell3 start
    expect(edgeTexel).toBeGreaterThan(ambient.r);
    expect(edgeTexel).toBeLessThan(litFace);
  });

  it('quantizes to discrete levels and dithers across texels when levels is set', () => {
    // A constant mid-strength glow over an open strip. With 3 levels the only
    // legal outputs are 0, 127/128, 255. A smooth ~half value must dither
    // between two adjacent levels across the texel grid, not produce one flat
    // intermediate value.
    const gridW = 4, gridH = 4;
    const out = new Uint8ClampedArray(gridW * SUB * gridH * SUB * 4);
    const light: LightSource = { x: 2, y: 2, radius: 8, color: { r: 255, g: 255, b: 255 }, intensity: 0.5 };
    computeLightField({
      gridW, gridH, sub: SUB, ambient: { r: 0, g: 0, b: 0 },
      lights: [light], occluders: new Set(), out, levels: 3,
    });
    const reds = new Set<number>();
    for (let i = 0; i < out.length; i += 4) reds.add(out[i]!);
    // Quantized: no more distinct values than there are levels (3)…
    expect(reds.size).toBeLessThanOrEqual(3);
    // …actually dithered: at least two distinct levels appear…
    expect(reds.size).toBeGreaterThanOrEqual(2);
    // …the darkest level is full black and nothing exceeds full white.
    expect(Math.min(...reds)).toBe(0);
    expect(Math.max(...reds)).toBeLessThanOrEqual(255);
  });

  it('falls off with distance (near cell brighter than far cell)', () => {
    const gridW = 6, gridH = 1;
    const out = mkBuf(gridW, gridH);
    const light: LightSource = { x: 0.5, y: 0.5, radius: 6, color: { r: 255, g: 255, b: 255 }, intensity: 1 };
    computeLightField({
      gridW, gridH, sub: SUB, ambient: { r: 0, g: 0, b: 0 },
      lights: [light], occluders: new Set(), out,
    });
    const near = sampleCell(out, gridW, 1, 0);
    const far = sampleCell(out, gridW, 4, 0);
    expect(near.r).toBeGreaterThan(far.r);
    expect(far.r).toBeGreaterThan(0);
  });
});
