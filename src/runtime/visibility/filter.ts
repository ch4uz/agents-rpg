import type { Event } from '../../log/events.js';
import type { Viewer, RedactedEvent } from './types.js';

const isSelfActor = (v: Viewer, actorId: string | 'dm'): boolean =>
  v.kind === 'self' && v.actorId === actorId;

const isResearcher = (v: Viewer): v is Extract<Viewer, { kind: 'researcher' }> =>
  v.kind === 'researcher';

/**
 * Pure function. Encodes the spec §5 visibility matrix as a single switch
 * over event.type. Returns:
 *   - null         → drop the event for this viewer
 *   - the event    → unchanged passthrough
 *   - a redaction  → for `resolution`, omit `private` for non-self viewers
 */
export const filter = (event: Event, viewer: Viewer): RedactedEvent | null => {
  switch (event.type) {
    // Always public:
    case 'scene_enter':
    case 'narrate':
    case 'request_action':
    case 'human_input':
    case 'state_change':
    case 'passive_triggered':
    case 'combat_started':
    case 'combat_ended':
    case 'rest_offered':
    case 'adventure_ended':
    case 'step_budget_exhausted':
      return event;

    case 'action':
      // Public actions are observable; engine never logs invalid ones.
      return event;

    case 'resolution': {
      // Self & researcher see private; everyone else gets public-only.
      if (isSelfActor(viewer, event.actorId) || isResearcher(viewer)) {
        return event;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { private: _priv, ...publicOnly } = event;
      return publicOnly as Event;
    }

    case 'thought': {
      if (isSelfActor(viewer, event.actorId)) return event;
      if (isResearcher(viewer) && viewer.revealThoughts) return event;
      return null;
    }

    case 'rule_violation': {
      if (isSelfActor(viewer, event.actorId)) return event;
      if (isResearcher(viewer)) return event;
      return null;
    }

    case 'player_ooc_query': {
      // Visible to: the asking player (self), the DM (in either {kind:'dm'}
      // or {kind:'self', actorId:'dm'} flavours), the local human viewer
      // (renders in the chat), and the researcher (auditing). Other
      // party-mate agents must NOT see it — OOC questions are meta and
      // would pollute their decision context.
      if (isSelfActor(viewer, event.actorId)) return event;
      if (isSelfActor(viewer, 'dm')) return event;
      if (viewer.kind === 'dm') return event;
      if (viewer.kind === 'human') return event;
      if (isResearcher(viewer)) return event;
      return null;
    }

    case 'dm_ooc_reply': {
      // Mirror of player_ooc_query: only the addressed player, the DM, the
      // human, and the researcher see it.
      if (isSelfActor(viewer, event.toActorId)) return event;
      if (isSelfActor(viewer, 'dm')) return event;
      if (viewer.kind === 'dm') return event;
      if (viewer.kind === 'human') return event;
      if (isResearcher(viewer)) return event;
      return null;
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
