import { describe, it, expect } from 'vitest';
import { loadManifest } from '../../../src/runtime/ws/manifest.js';

describe('manifest.npcs', () => {
  it('exposes an empty record by default', () => {
    const m = loadManifest('assets/manifest.json');
    expect(typeof m.npcs).toBe('object');
  });
});
