import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, validateManifest, type AssetManifest } from '../../../src/runtime/ws/manifest.js';

const baseManifest = (over: Partial<AssetManifest> = {}): AssetManifest => ({
  heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
  tilesets: {}, props: {}, projectiles: {}, animations: {}, npcs: {}, ...over,
});

describe('validateManifest (dice)', () => {
  it('accepts an empty / missing dice category', () => {
    const root = mkScratchRoot();
    try {
      const m = baseManifest();
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally {
      cleanup(root);
    }
  });

  it('rejects a dice entry with a non-.glb extension', () => {
    const root = mkScratchRoot();
    try {
      writeFileSync(join(root, 'foo.png'), 'x');
      const m = baseManifest({ dice: { default: 'foo.png' } });
      expect(() => validateManifest(m, root)).toThrow(/must be a \.glb/);
    } finally {
      cleanup(root);
    }
  });

  it('rejects a dice entry whose .glb file is missing', () => {
    const root = mkScratchRoot();
    try {
      const m = baseManifest({ dice: { default: 'missing.glb' } });
      expect(() => validateManifest(m, root)).toThrow(/Missing manifest asset/);
    } finally {
      cleanup(root);
    }
  });

  it('accepts a dice entry whose .glb file exists', () => {
    const root = mkScratchRoot();
    try {
      mkdirSync(join(root, 'dice'), { recursive: true });
      writeFileSync(join(root, 'dice', 'default.glb'), 'fake');
      const m = baseManifest({ dice: { default: 'dice/default.glb' } });
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally {
      cleanup(root);
    }
  });
});

describe('loadManifest', () => {
  it('parses an empty manifest with no dice block', () => {
    const root = mkScratchRoot();
    try {
      const file = join(root, 'manifest.json');
      writeFileSync(file, JSON.stringify({}));
      const m = loadManifest(file);
      expect(m.dice).toEqual({});
    } finally {
      cleanup(root);
    }
  });

  it('parses a manifest with a dice block', () => {
    const root = mkScratchRoot();
    try {
      const file = join(root, 'manifest.json');
      writeFileSync(file, JSON.stringify({ dice: { default: 'dice/d6.glb' } }));
      const m = loadManifest(file);
      expect(m.dice).toEqual({ default: 'dice/d6.glb' });
    } finally {
      cleanup(root);
    }
  });
});

let counter = 0;
const mkScratchRoot = (): string => {
  const root = join(tmpdir(), `agents-rpg-manifest-dice-${process.pid}-${counter++}`);
  mkdirSync(root, { recursive: true });
  return root;
};
const cleanup = (root: string): void => {
  rmSync(root, { recursive: true, force: true });
};
