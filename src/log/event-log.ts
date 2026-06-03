import { open, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Event } from './events.js';

export interface EventLogOptions {
  append?: boolean;
  /**
   * When true, every serialized line is stamped with `wallMs` (epoch ms at
   * write time) so post-hoc analysis can reconstruct where the wall-clock
   * went between events (turn latency, LLM gaps, UI gates — Layer D fodder).
   * Only the FILE carries the stamp: the in-memory events handed to
   * subscribers stay untouched, and replay re-applies recorded `action`
   * events regardless of extra fields. Opt-in (bin/play.ts live runs) so the
   * test suite's logs stay byte-deterministic and round-trip equal.
   */
  stampWallClock?: boolean;
}

export class EventLog {
  private constructor(
    private handle: FileHandle,
    private readonly stampWallClock: boolean,
  ) {}

  static async create(path: string, opts: EventLogOptions = {}): Promise<EventLog> {
    await mkdir(dirname(path), { recursive: true });
    const flags = opts.append ? 'a' : 'w';
    const handle = await open(path, flags);
    return new EventLog(handle, opts.stampWallClock ?? false);
  }

  async append(event: Event): Promise<void> {
    const payload = this.stampWallClock ? { ...event, wallMs: Date.now() } : event;
    const line = JSON.stringify(payload) + '\n';
    await this.handle.write(line, null, 'utf8');
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export const readEventLog = async (path: string): Promise<Event[]> => {
  const raw = await readFile(path, 'utf8');
  const out: Event[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch (e) {
      throw new Error(`Malformed JSON at line ${lineNo} of ${path}: ${(e as Error).message}`);
    }
  }
  return out;
};
