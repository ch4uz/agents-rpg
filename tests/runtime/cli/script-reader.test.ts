import { describe, it, expect } from 'vitest';
import { ScriptHumanProvider } from '../../../src/runtime/cli/script-reader.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('ScriptHumanProvider', () => {
  it('reads jsonl, returns inputs in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'script-'));
    const file = path.join(dir, 'h.jsonl');
    writeFileSync(file, [
      JSON.stringify({ text: 'I rush in' }),
      JSON.stringify({ action: { kind: 'skip_turn' } }),
      JSON.stringify({ action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] } }),
    ].join('\n') + '\n');

    const p = await ScriptHumanProvider.fromFile(file);
    expect(p.remaining()).toBe(3);
    expect(await p.requestInput()).toEqual({ kind: 'free_text', text: 'I rush in' });
    expect(await p.requestInput()).toEqual({ kind: 'skip' });
    expect(await p.requestInput()).toEqual({
      kind: 'structured_action',
      action: { kind: 'move', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
    });
  });

  it('throws when exhausted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'script-'));
    const file = path.join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    const p = await ScriptHumanProvider.fromFile(file);
    await expect(p.requestInput()).rejects.toThrow(/exhausted/);
  });
});
