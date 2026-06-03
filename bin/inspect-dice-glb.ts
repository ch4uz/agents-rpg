/**
 * One-shot dev tool: parse the dice GLB, group triangles by face normal, and
 * print each face's local-space normal + centroid. Calibrates the
 * `FACE_NORMALS` constant in `web/components/three/DiceMesh.ts`.
 *
 * Run:  npx tsx bin/inspect-dice-glb.ts
 *
 * Output: six lines, one per cube face, sorted so dominant axis is obvious.
 * The pip-count → face mapping must be confirmed visually (open the GLB in
 * a glTF viewer). See `DiceMesh.ts` for the recorded mapping.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GLB_PATH = resolve(process.cwd(), 'assets/dice/perfect_little_dice_3cm.glb');

interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface Accessor { bufferView: number; componentType: number; count: number; type: string; byteOffset?: number }
interface Primitive { attributes: Record<string, number>; indices?: number }
interface Mesh { primitives: Primitive[]; name?: string }
interface GLTF { bufferViews: BufferView[]; accessors: Accessor[]; meshes: Mesh[] }

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUMC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const parseGlb = (buf: Buffer): { gltf: GLTF; bin: Buffer } => {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  let p = 12;
  const jsonLen = buf.readUInt32LE(p); p += 4;
  const jsonType = buf.readUInt32LE(p); p += 4;
  if (jsonType !== 0x4e4f534a) throw new Error('first chunk not JSON');
  const json = JSON.parse(buf.slice(p, p + jsonLen).toString('utf8')) as GLTF;
  p += jsonLen;
  const binLen = buf.readUInt32LE(p); p += 4;
  const binType = buf.readUInt32LE(p); p += 4;
  if (binType !== 0x004e4942) throw new Error('second chunk not BIN');
  const bin = Buffer.from(buf.slice(p, p + binLen));
  if (p + binLen > total) throw new Error('GLB truncated');
  return { gltf: json, bin };
};

const readAccessor = (gltf: GLTF, bin: Buffer, accIdx: number): Float32Array | Uint32Array => {
  const acc = gltf.accessors[accIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const elemCount = (NUMC as Record<string, number>)[acc.type];
  const compSize = (COMP as Record<number, number>)[acc.componentType];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const totalElems = acc.count * elemCount;
  if (acc.componentType === 5126) {
    return new Float32Array(bin.buffer, bin.byteOffset + off, totalElems);
  }
  if (acc.componentType === 5125) {
    return new Uint32Array(bin.buffer, bin.byteOffset + off, totalElems);
  }
  if (acc.componentType === 5123) {
    const u16 = new Uint16Array(bin.buffer, bin.byteOffset + off, totalElems);
    return Uint32Array.from(u16);
  }
  throw new Error(`unsupported componentType ${acc.componentType} (compSize=${compSize})`);
};

const main = () => {
  const buf = readFileSync(GLB_PATH);
  const { gltf, bin } = parseGlb(buf);
  console.log(`meshes: ${gltf.meshes.length}`);
  for (const m of gltf.meshes) {
    console.log(`mesh: ${m.name ?? '(unnamed)'} primitives=${m.primitives.length}`);
  }

  const prim = gltf.meshes[0].primitives[0];
  const posIdx = prim.attributes.POSITION;
  if (posIdx === undefined) throw new Error('no POSITION');
  if (prim.indices === undefined) throw new Error('no indices (need indexed mesh)');

  const positions = readAccessor(gltf, bin, posIdx) as Float32Array;
  const indices   = readAccessor(gltf, bin, prim.indices) as Uint32Array;
  console.log(`vertices: ${positions.length / 3}  triangles: ${indices.length / 3}`);

  // Group triangles by face normal. For a cube, every face has a normal aligned
  // with ±X, ±Y, or ±Z. Compute per-triangle normal and bin by sign of axis with
  // largest magnitude.
  interface FaceBin { axis: string; sign: number; tris: number[][] }
  const bins: Record<string, FaceBin> = {};
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    const ax2 = Math.abs(nx), ay2 = Math.abs(ny), az2 = Math.abs(nz);
    let axis: string; let sign: number;
    if (ax2 >= ay2 && ax2 >= az2)      { axis = 'X'; sign = Math.sign(nx); }
    else if (ay2 >= az2)               { axis = 'Y'; sign = Math.sign(ny); }
    else                               { axis = 'Z'; sign = Math.sign(nz); }
    const key = `${sign > 0 ? '+' : '-'}${axis}`;
    if (!bins[key]) bins[key] = { axis, sign, tris: [] };
    const cxAvg = (ax + bx + cx) / 3, cyAvg = (ay + by + cy) / 3, czAvg = (az + bz + cz) / 3;
    bins[key].tris.push([cxAvg, cyAvg, czAvg]);
  }

  // Print one summary per face.
  for (const key of ['+X', '-X', '+Y', '-Y', '+Z', '-Z']) {
    const b = bins[key];
    if (!b) { console.log(`${key}: <no triangles>`); continue; }
    let sx = 0, sy = 0, sz = 0;
    for (const c of b.tris) { sx += c[0]; sy += c[1]; sz += c[2]; }
    const n = b.tris.length;
    console.log(`${key}: tris=${n}  centroid=(${(sx/n).toFixed(4)}, ${(sy/n).toFixed(4)}, ${(sz/n).toFixed(4)})`);
  }

  // Bounding box for sanity.
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minx) minx = positions[i];
    if (positions[i + 1] < miny) miny = positions[i + 1];
    if (positions[i + 2] < minz) minz = positions[i + 2];
    if (positions[i] > maxx) maxx = positions[i];
    if (positions[i + 1] > maxy) maxy = positions[i + 1];
    if (positions[i + 2] > maxz) maxz = positions[i + 2];
  }
  console.log(`bbox: x=[${minx.toFixed(4)}, ${maxx.toFixed(4)}]  y=[${miny.toFixed(4)}, ${maxy.toFixed(4)}]  z=[${minz.toFixed(4)}, ${maxz.toFixed(4)}]`);
};

main();
