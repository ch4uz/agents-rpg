import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { InputLine } from '../../../src/runtime/cli/InputLine.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('InputLine', () => {
  it('disabled state shows waiting message and ignores input', async () => {
    let submitted: string | null = null;
    const { lastFrame, stdin } = render(
      <InputLine enabled={false} onSubmit={(line) => { submitted = line; }} />,
    );
    expect(lastFrame() ?? '').toMatch(/Waiting/);
    stdin.write('a');
    await flush();
    expect(submitted).toBeNull();
  });

  it('accumulates keystrokes and submits on Enter', async () => {
    let submitted: string | null = null;
    const { stdin } = render(
      <InputLine enabled={true} onSubmit={(line) => { submitted = line; }} />,
    );
    await flush(); // let useEffect register the stdin listener
    stdin.write('hi');
    await flush();
    stdin.write('\r');
    await flush();
    expect(submitted).toBe('hi');
  });

  // NOTE: deviation from plan — plan used stdin.write('') for backspace which
  // is an empty string and would not trigger backspace key detection.
  // Ink's testing library sends key events via stdin; '\x7f' (DEL) maps to
  // key.delete in useInput, which the InputLine handles the same as backspace.
  it('backspace/delete removes the last character', async () => {
    const lines: string[] = [];
    const { stdin } = render(
      <InputLine enabled={true} onSubmit={(line) => lines.push(line)} />,
    );
    await flush(); // let useEffect register the stdin listener
    stdin.write('abc');
    await flush();
    stdin.write('\x7f'); // DEL character — ink maps this to key.delete
    await flush();
    stdin.write('\r');
    await flush();
    expect(lines).toEqual(['ab']);
  });
});
