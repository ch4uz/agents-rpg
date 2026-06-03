import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest, loadManifest } from '../../../src/runtime/ws/manifest.js';

const fixture = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe('manifest validator', () => {
  it('passes when every referenced file exists', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes'));
      writeFileSync(join(root, 'heroes', 'warrior.png'), 'png-bytes');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally { cleanup(); }
  });

  it('throws with the missing path on a missing file', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/heroes\/warrior\.png/);
    } finally { cleanup(); }
  });
});

describe('manifest validator — tilesets and props', () => {
  it('passes when tileset image + metadata exist and props files exist', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'maps', 'tavern'),  { recursive: true });
      mkdirSync(join(root, 'props', 'barrel'), { recursive: true });
      writeFileSync(join(root, 'maps', 'tavern', 'tileset.png'), 'png');
      writeFileSync(join(root, 'maps', 'tavern', 'tileset.json'), '{}');
      writeFileSync(join(root, 'props', 'barrel', 'south.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: { tavern: { image: 'maps/tavern/tileset.png',
                              metadata: 'maps/tavern/tileset.json' } },
        props:    { barrel: 'props/barrel/south.png' },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
      expect(m.tilesets.tavern).toEqual({
        image: 'maps/tavern/tileset.png', metadata: 'maps/tavern/tileset.json',
      });
      expect(m.props.barrel).toBe('props/barrel/south.png');
    } finally { cleanup(); }
  });

  it('throws on missing tileset image', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: { tavern: { image: 'maps/tavern/tileset.png', metadata: 'x.json' } },
        props: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/tileset.*tavern.*image/i);
    } finally { cleanup(); }
  });

  it('throws on missing prop file', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        tilesets: {},
        props: { barrel: 'props/barrel/south.png' },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/props\.barrel.*south\.png/);
    } finally { cleanup(); }
  });

  it('defaults tilesets and props to {} when omitted', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(m.tilesets).toEqual({});
      expect(m.props).toEqual({});
    } finally { cleanup(); }
  });
});

describe('manifest validator — directional folder form (heroes/monsters/props)', () => {
  it('accepts a folder path for a hero and requires south.png inside', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes', 'warrior'), { recursive: true });
      writeFileSync(join(root, 'heroes', 'warrior', 'south.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally { cleanup(); }
  });

  it('throws when a hero folder lacks south.png', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes', 'warrior'), { recursive: true });
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).toThrow(/heroes\.warrior.*south\.png/);
    } finally { cleanup(); }
  });

  it('still accepts the legacy .png hero path for backward compat', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes'));
      writeFileSync(join(root, 'heroes', 'warrior.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior.png' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally { cleanup(); }
  });
});

describe('manifest validator — animations', () => {
  it('defaults animations to {} when omitted', () => {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: {}, monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(m.animations).toEqual({});
    } finally { cleanup(); }
  });

  it('passes when every (animation, south, 0.png) exists', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes', 'warrior', 'anim', 'walk', 'south'), { recursive: true });
      writeFileSync(join(root, 'heroes', 'warrior', 'south.png'), 'png');
      writeFileSync(join(root, 'heroes', 'warrior', 'anim', 'walk', 'south', '0.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        animations: {
          warrior: { walk: { path: 'heroes/warrior/anim/walk', frames: 4, fps: 8 } },
        },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root)).not.toThrow();
    } finally { cleanup(); }
  });

  it('throws when an animation south/0.png is missing', () => {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'heroes', 'warrior'), { recursive: true });
      writeFileSync(join(root, 'heroes', 'warrior', 'south.png'), 'png');
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        heroes: { warrior: 'heroes/warrior' },
        monsters: {}, maps: {}, items: {}, equipment: {}, boons: {},
        animations: {
          warrior: { walk: { path: 'heroes/warrior/anim/walk', frames: 4, fps: 8 } },
        },
      }));
      const m = loadManifest(join(root, 'manifest.json'));
      expect(() => validateManifest(m, root))
        .toThrow(/animations\.warrior\.walk.*south\/0\.png/);
    } finally { cleanup(); }
  });
});
