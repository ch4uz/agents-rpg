import type { Subscriber } from '../subscriber.js';
import type { HumanInput, HumanInputProvider } from '../orchestrator.js';
import type { Viewer, RedactedEvent } from '../visibility/types.js';
import type { CharacterId } from '../../engine/ids.js';
import type { CliStore, DisplayFor } from './cli-store.js';
import type { Grid } from '../../engine/grid.js';
import type { Character } from '../../engine/character.js';
import type { Scene } from '../../engine/adventure.js';
import { parseLine, HELP_TEXT } from './slash-parser.js';

export interface CliAdapterDeps {
  store: CliStore;
  /** Resolve an actor id to its display label, emoji, and color. */
  displayFor: DisplayFor;
  /** Return current state for the store (called every event tick). */
  readState(): { scene: Scene | null; grid: Grid | null; characters: Character[] };
}

export class CliAdapter implements Subscriber, HumanInputProvider {
  readonly viewer: Viewer = { kind: 'human' };

  private pendingResolve: ((input: HumanInput) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(private readonly deps: CliAdapterDeps) {}

  /* Subscriber */

  onStart(): void {
    const s = this.deps.readState();
    if (s.scene && s.grid) this.deps.store.setScene(s.scene, s.grid);
    this.deps.store.setCharacters(s.characters);
  }

  onEvent(ev: RedactedEvent): void {
    this.deps.store.ingest(ev, this.deps.displayFor);
    const s = this.deps.readState();
    this.deps.store.setCharacters(s.characters);
    if (s.scene && s.grid) this.deps.store.setScene(s.scene, s.grid);
  }

  onTurnStarted(actorId: CharacterId | 'dm'): void {
    this.deps.store.setActive(actorId);
  }

  onTurnEnded(_actorId: CharacterId | 'dm'): void {
    this.deps.store.unlockInput(false);
  }

  onEnd(outcome: 'success' | 'failure' | 'aborted', _reason?: 'party_wipe'): void {
    this.deps.store.end(outcome);
    if (this.pendingReject) {
      this.pendingReject(new Error(`run ended (${outcome}) while waiting for human input`));
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  /* HumanInputProvider */

  async requestInput(): Promise<HumanInput> {
    this.deps.store.unlockInput(true);
    return new Promise<HumanInput>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  /** Called by App.onSubmit. */
  submit(line: string): void {
    if (!this.pendingResolve) return; // input not requested; ignore stray keystrokes
    const parsed = parseLine(line);
    switch (parsed.kind) {
      case 'free_text':
        this.deliver({ kind: 'free_text', text: parsed.text });
        break;
      case 'structured_action':
        this.deliver({ kind: 'structured_action', action: parsed.action });
        break;
      case 'skip':
        this.deliver({ kind: 'skip' });
        break;
      case 'help':
        this.deps.store.ingest(
          { t: -1, type: 'narrate', actorId: 'dm', text: HELP_TEXT } as never,
          this.deps.displayFor,
        );
        // input remains unlocked; do not resolve
        break;
      case 'parse_error':
        this.deps.store.ingest(
          { t: -1, type: 'narrate', actorId: 'dm', text: `(${parsed.message})` } as never,
          this.deps.displayFor,
        );
        // input remains unlocked
        break;
    }
  }

  private deliver(input: HumanInput): void {
    const r = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.deps.store.unlockInput(false);
    r?.(input);
  }
}
