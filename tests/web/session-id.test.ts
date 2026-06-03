// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { resolveSessionId, SID_STORAGE_KEY } from '../../web/ws-client.js';

/** Minimal in-memory Storage stand-in. */
const makeStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    dump: () => Object.fromEntries(map),
  };
};

describe('resolveSessionId — per-tab sid, sticky across reloads', () => {
  it('generates an id and persists it on first load', () => {
    const storage = makeStorage();
    const sid = resolveSessionId(storage);
    expect(sid.length).toBeGreaterThan(0);
    expect(storage.dump()[SID_STORAGE_KEY]).toBe(sid);
  });

  it('reuses the stored id on a reload — a refresh re-attaches to the SAME game', () => {
    const storage = makeStorage({ [SID_STORAGE_KEY]: 'sticky-sid' });
    expect(resolveSessionId(storage)).toBe('sticky-sid');
    // Second "load" of the same tab → same id again.
    expect(resolveSessionId(storage)).toBe('sticky-sid');
  });

  it('two different tabs (separate storages) get DIFFERENT ids', () => {
    const a = resolveSessionId(makeStorage());
    const b = resolveSessionId(makeStorage());
    expect(a).not.toBe(b);
  });

  it('falls back to a per-load id when storage is unavailable or throws', () => {
    expect(resolveSessionId(null).length).toBeGreaterThan(0);
    const throwing = {
      getItem: () => { throw new Error('private mode'); },
      setItem: () => { throw new Error('private mode'); },
    };
    expect(resolveSessionId(throwing).length).toBeGreaterThan(0);
  });
});
