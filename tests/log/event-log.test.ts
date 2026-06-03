import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, readEventLog } from '../../src/log/event-log.js';
import type { Event } from '../../src/log/events.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EventLog', () => {
  it('append + reads back identical events', async () => {
    const log = await EventLog.create(join(dir, 'events.jsonl'));
    const events: Event[] = [
      { t: 1, type: 'narrate', actorId: 'dm', text: 'hello' } as Event,
      { t: 2, type: 'combat_ended' } as Event,
    ];
    for (const e of events) await log.append(e);
    await log.close();
    const read = await readEventLog(join(dir, 'events.jsonl'));
    expect(read).toEqual(events);
  });

  it('append is durable across reopen', async () => {
    const path = join(dir, 'events.jsonl');
    const log1 = await EventLog.create(path);
    await log1.append({ t: 1, type: 'narrate', actorId: 'dm', text: 'first' } as Event);
    await log1.close();
    const log2 = await EventLog.create(path, { append: true });
    await log2.append({ t: 2, type: 'narrate', actorId: 'dm', text: 'second' } as Event);
    await log2.close();
    const read = await readEventLog(path);
    expect(read).toHaveLength(2);
    expect((read[0] as { text: string }).text).toBe('first');
    expect((read[1] as { text: string }).text).toBe('second');
  });

  it('stampWallClock: true stamps each serialized line with wallMs (epoch ms)', async () => {
    const before = Date.now();
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.create(path, { stampWallClock: true });
    await log.append({ t: 1, type: 'narrate', actorId: 'dm', text: 'hello' } as Event);
    await log.close();
    const read = await readEventLog(path) as Array<Event & { wallMs?: number }>;
    expect(read[0]!.t).toBe(1);
    expect(typeof read[0]!.wallMs).toBe('number');
    expect(read[0]!.wallMs!).toBeGreaterThanOrEqual(before);
    expect(read[0]!.wallMs!).toBeLessThanOrEqual(Date.now());
  });

  it('default (no stampWallClock) keeps lines free of wallMs — byte-stable logs', async () => {
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.create(path);
    await log.append({ t: 1, type: 'narrate', actorId: 'dm', text: 'hello' } as Event);
    await log.close();
    const read = await readEventLog(path) as Array<Event & { wallMs?: number }>;
    expect(read[0]!.wallMs).toBeUndefined();
  });

  it('readEventLog throws on malformed JSON line', async () => {
    const fs = await import('node:fs/promises');
    const path = join(dir, 'events.jsonl');
    await fs.writeFile(path, '{"t":1,"type":"narrate"}\nNOT JSON\n');
    await expect(readEventLog(path)).rejects.toThrow();
  });
});
