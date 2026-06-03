import { readFile } from 'node:fs/promises';
import type { HumanInput, HumanInputProvider } from '../orchestrator.js';
import type { PlayerAction } from '../../engine/action.js';

interface ScriptLine {
  text?: string;
  action?: PlayerAction;
  /**
   * Optional target for free-text input. 'game' (default) interprets the text
   * as an in-character action; 'dm' routes it as an out-of-character question
   * that doesn't consume the turn.
   */
  target?: 'game' | 'dm';
}

export interface ScriptHumanProviderOptions {
  /**
   * What to do when the script is exhausted. Default 'throw' for tight tests;
   * 'skip' is useful for unattended smoke runs where the agents may take more
   * turns than scripted.
   */
  onExhausted?: 'throw' | 'skip';
}

export class ScriptHumanProvider implements HumanInputProvider {
  private inputs: HumanInput[] = [];
  private cursor = 0;
  private onExhausted: 'throw' | 'skip' = 'throw';

  static async fromFile(
    path: string,
    options: ScriptHumanProviderOptions = {},
  ): Promise<ScriptHumanProvider> {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const inputs: HumanInput[] = lines.map((l, i) => {
      const obj = JSON.parse(l) as ScriptLine;
      if (obj.action) {
        if (obj.action.kind === 'skip_turn') return { kind: 'skip' };
        return { kind: 'structured_action', action: obj.action };
      }
      if (typeof obj.text === 'string') {
        if (obj.target === 'dm') return { kind: 'ooc_query', text: obj.text };
        return { kind: 'free_text', text: obj.text };
      }
      throw new Error(`Script line ${i + 1} has neither "text" nor "action"`);
    });
    const p = new ScriptHumanProvider();
    p.inputs = inputs;
    p.onExhausted = options.onExhausted ?? 'throw';
    return p;
  }

  async requestInput(): Promise<HumanInput> {
    const next = this.inputs[this.cursor];
    if (!next) {
      if (this.onExhausted === 'skip') return { kind: 'skip' };
      throw new Error('Scripted human input exhausted');
    }
    this.cursor += 1;
    return next;
  }

  remaining(): number {
    return this.inputs.length - this.cursor;
  }
}
