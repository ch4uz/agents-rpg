import type { Event } from '../../log/events.js';
import type { CharacterId } from '../../engine/ids.js';

export type Viewer =
  | { kind: 'self'; actorId: CharacterId | 'dm' }
  | { kind: 'other_player'; actorId: CharacterId }
  | { kind: 'dm' }
  | { kind: 'human' }
  | { kind: 'researcher'; revealThoughts: boolean };

/**
 * RedactedEvent is structurally identical to Event, except `resolution` may have
 * its `private` field stripped. `thought` and `rule_violation` events are
 * dropped entirely (filter returns null) for non-self viewers.
 */
export type RedactedEvent = Event;
