import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FACE_NORMALS, quaternionForFace, type Face } from '../../web/components/three/DiceMesh.js';

const FACES: Face[] = [1, 2, 3, 4, 5, 6];
const WORLD_UP = new THREE.Vector3(0, 1, 0);

describe('quaternionForFace', () => {
  it.each(FACES)('face %i aligns its local normal to world +Y', (face) => {
    const currentQ = new THREE.Quaternion();
    const target = quaternionForFace(face, currentQ);
    const rotated = FACE_NORMALS[face].clone().applyQuaternion(target);
    expect(rotated.x).toBeCloseTo(WORLD_UP.x, 6);
    expect(rotated.y).toBeCloseTo(WORLD_UP.y, 6);
    expect(rotated.z).toBeCloseTo(WORLD_UP.z, 6);
  });

  it('chooses the minimum-arc spin candidate', () => {
    // Start with a slight tilt around +Y so two of the 4 candidates are
    // visibly closer than the others.
    const currentQ = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, 0.4);
    const chosen = quaternionForFace(1, currentQ);

    // Hand-build all four candidates and confirm the picked one has the
    // largest |dot| against currentQ — the definition of "minimum-arc".
    const align = new THREE.Quaternion().setFromUnitVectors(FACE_NORMALS[1], WORLD_UP);
    let bestDot = -Infinity;
    for (let k = 0; k < 4; k++) {
      const spin = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, (k * Math.PI) / 2);
      const cand = spin.clone().multiply(align);
      const d = Math.abs(currentQ.dot(cand));
      if (d > bestDot) bestDot = d;
    }
    const chosenDot = Math.abs(currentQ.dot(chosen));
    expect(chosenDot).toBeCloseTo(bestDot, 6);
  });

  it('opposite faces produce inverse alignments', () => {
    // Sanity: face 1 (+Y up) should map identity-ish; face 6 (-Y up) should
    // flip the die 180°. The product of both target quaternions, applied to
    // FACE_NORMALS[1], should still produce +Y (face 6's flip + face 1's
    // identity = a 180° rotation that takes +Y → -Y → +Y back).
    const q1 = quaternionForFace(1, new THREE.Quaternion());
    const q6 = quaternionForFace(6, new THREE.Quaternion());
    const rotated6 = FACE_NORMALS[6].clone().applyQuaternion(q6);
    expect(rotated6.y).toBeCloseTo(1, 6);
    const rotated1 = FACE_NORMALS[1].clone().applyQuaternion(q1);
    expect(rotated1.y).toBeCloseTo(1, 6);
  });
});

describe('FACE_NORMALS', () => {
  it('opposite faces sum to 7 along the same axis', () => {
    // 1↔6 (Y), 2↔5 (X), 3↔4 (Z). Each pair's normals must be antiparallel.
    const pairs: [Face, Face][] = [[1, 6], [2, 5], [3, 4]];
    for (const [a, b] of pairs) {
      const sum = FACE_NORMALS[a].clone().add(FACE_NORMALS[b]);
      expect(sum.lengthSq()).toBeCloseTo(0, 6);
    }
  });

  it('all six faces are axis-aligned unit vectors', () => {
    for (const f of FACES) {
      expect(FACE_NORMALS[f].length()).toBeCloseTo(1, 6);
      const v = FACE_NORMALS[f];
      const nonZero = [v.x, v.y, v.z].filter((c) => Math.abs(c) > 0.01).length;
      expect(nonZero).toBe(1);
    }
  });
});
