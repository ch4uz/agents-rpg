import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/runtime/orchestrator.js';

describe('Orchestrator runNpcTurn', () => {
  it('exists as a private method on Orchestrator', () => {
    expect(typeof (Orchestrator as unknown as { prototype: { runNpcTurn?: unknown } }).prototype.runNpcTurn).toBe('function');
  });
});
