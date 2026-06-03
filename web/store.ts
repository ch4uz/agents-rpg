import type { ServerEnvelope } from '../src/runtime/ws/protocol.js';
import type { RedactedSnapshot, RedactedCharacter, EmojiProp } from '../src/engine/snapshot.js';
import type { CharacterId } from '../src/engine/ids.js';
import type { AssetManifest } from '../src/runtime/ws/manifest.js';

export interface ChatEntry { event: unknown; }

export interface StoreState {
  scene: RedactedSnapshot['scene'];
  characters: RedactedCharacter[];
  /** DM-summoned emoji props on the grid. */
  props: EmojiProp[];
  activeActor: CharacterId | 'dm' | null;
  chat: ChatEntry[];
  thinking: Set<CharacterId | 'dm'>;
  /**
   * Live streamed thinking text per actor (accumulated `thinking_delta`
   * envelopes). Display-only: the status banner shows its tail while the LLM
   * generates. Reset for an actor on its `thinking` envelope (a fresh call)
   * and dropped on `thinking_done`. Empty map on batch (non-streaming) runs.
   */
  thinkingText: Map<CharacterId | 'dm', string>;
  inputUnlocked: boolean;
  /** Active actor has used their move this turn (HeroKids: 1 move per turn). */
  hasMoved: boolean;
  /** Active actor has used their main action this turn (attack/special/use/equip/ability_test). */
  hasActed: boolean;
  /** True between a `combat_started` and the matching `combat_ended` event.
   *  Drives the story-mode vs combat-mode UI split: when false the board is
   *  hidden and the player is offered only the free-text Prompt input. */
  inCombat: boolean;
  /** Request id of an outstanding beat-pacing gate the server is holding,
   *  or null when none is pending. The server ships `beat_gate` before
   *  starting the next turn; Layout acks it (→ `beat_gate_ack`) once its
   *  playback queue has fully drained, so the server doesn't advance while
   *  the player is still reading. */
  pendingBeatGate: string | null;
  /** Non-null while the server holds this tab in the waiting line for a free
   *  game slot (it is at its concurrent-session cap). `position` is 1-based
   *  and updates as the line moves; cleared by the attach snapshot that
   *  arrives once the session is admitted. */
  queued: { position: number; capacity: number } | null;
  /** True after `rejected: session_gone` — this tab's game no longer exists
   *  on the server (restart / idle reap) and ws-client has stopped
   *  reconnecting. The banner asks for a reload, which makes a fresh claim. */
  sessionGone: boolean;
  /** True while the server is (or is about to be) holding this run at the
   *  hero-selection gate — stamped onto the snapshot envelope. The first
   *  snapshot arrives BEFORE the `hero_select_request`, yet already carries
   *  `scene.opening`; Layout reads this to suppress the opening splash (and
   *  any pre-game chrome) so nothing renders before the chooser mounts.
   *  Cleared once the gate is answered (a later snapshot drops the flag; the
   *  chooser's own `heroSelectDone` also overrides it locally). */
  awaitingHeroSelect: boolean;
  manifest?: AssetManifest;
  /** Set by the server's `end` envelope. `reason: 'party_wipe'` (every hero
   *  KO'd) routes Layout to the dedicated game-over screen instead of the
   *  gentle "The Heroes Fall" ending banner. */
  ended?: { outcome: 'success' | 'failure' | 'aborted'; reason?: 'party_wipe' };
  /** Latest `survey_ack` from the server. `seq` increments per ack so the
   *  survey modal can tell a fresh reply to ITS submit from a stale one
   *  consumed earlier (see SurveyModal `applySurveyAck`). Meta-UI state —
   *  deliberately preserved across reconnect snapshot resets. */
  surveyAck: { seq: number; ok: boolean; destination?: 'cloud' | 'local'; detail?: string } | null;
  /** True once this session has received any `roll_request` — i.e. the server
   *  runs physics-as-truth dice (PHYSICS_DICE on). In this mode a resolution
   *  that arrives WITHOUT a `rollRequestId` is a seeded FALLBACK (the browser
   *  failed to answer the roll in time); the playback queue must NOT re-enqueue
   *  a dice beat for it (matchQueueItems), and ws-client resolves its timing
   *  signal immediately so the deferred HP-drain still lands. Set-once, and
   *  preserved across reconnect snapshots (the mode doesn't change mid-run). */
  physicsActive: boolean;
}

// Mirrors the engine's "main action" set in src/engine/game-engine.ts
// (the actions that call this.turn.markActed()). Pure client-side gate for the
// player UI — the engine remains the source of truth via 'action-already-used'
// rejections.
const MAIN_ACTION_KINDS = new Set<string>([
  'normal_attack', 'special_action', 'use_item', 'use_boon', 'equip', 'ability_test',
  'attack_object',
]);

export interface Store {
  getSnapshot(): StoreState;
  subscribe(listener: () => void): () => void;
  applyEnvelope(env: ServerEnvelope): void;
  setInputUnlocked(unlocked: boolean): void;
  /** Mark this session as physics-as-truth (a `roll_request` was received).
   *  Set-once; idempotent. Drives the seeded-fallback handling described on
   *  `StoreState.physicsActive`. */
  markPhysicsActive(): void;
  /** Append grid cells to scene.destroyedObstacles (deduped) and notify. The
   *  Board calls this to remove an explosion's cleared cells (the cask + the
   *  stalagmites it demolished) IN SYNC with the blast VFX — the store defers
   *  those to here so the wall doesn't vanish before the fireball lands. No-op
   *  without a scene or with no new cells. */
  markDestroyed(cells: ReadonlyArray<{ x: number; y: number }>): void;
}

export const createStore = (): Store => {
  let state: StoreState = {
    scene: null,
    characters: [],
    props: [],
    activeActor: null,
    chat: [],
    thinking: new Set(),
    thinkingText: new Map(),
    inputUnlocked: false,
    hasMoved: false,
    hasActed: false,
    inCombat: false,
    pendingBeatGate: null,
    queued: null,
    sessionGone: false,
    awaitingHeroSelect: false,
    surveyAck: null,
    physicsActive: false,
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    getSnapshot: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    applyEnvelope: (env) => {
      switch (env.kind) {
        case 'snapshot': {
          const s = env.state;
          // Mid-run scene transition: swap engine-canonical fields (scene +
          // characters + props + activeActor) but PRESERVE chat history,
          // thinking indicators, input lock, hasMoved/hasActed, combat flag.
          // Otherwise the prior scene's narration would disappear from the
          // log every time the DM calls set_scene.
          if (env.reason === 'scene_change') {
            state = {
              ...state,
              scene: s.scene,
              characters: s.characters as RedactedCharacter[],
              props: (s.props as EmojiProp[]) ?? [],
              activeActor: s.activeActor,
              awaitingHeroSelect: env.awaitingHeroSelect ?? false,
              manifest: env.manifest,
            };
            notify();
            return;
          }
          // Initial attach (or reconnect) — full reset. Also ends any queue
          // wait: a snapshot means the session was admitted and is live.
          state = {
            scene: s.scene,
            characters: s.characters as RedactedCharacter[],
            props: (s.props as EmojiProp[]) ?? [],
            activeActor: s.activeActor,
            chat: (s.recentChat as ChatEntry[]) ?? [],
            thinking: new Set(),
            thinkingText: new Map(),
            inputUnlocked: false,
            hasMoved: false,
            hasActed: false,
            inCombat: false,
            pendingBeatGate: null,
            queued: null,
            sessionGone: false,
            awaitingHeroSelect: env.awaitingHeroSelect ?? false,
            // Meta-UI, not engine state: a reconnect must not forget that the
            // tester's survey was already acked (or is still being saved).
            surveyAck: state.surveyAck,
            // The physics-dice mode of the run doesn't change across a
            // reconnect — keep it so a post-snapshot fallback resolution is
            // still handled correctly before the next roll_request re-marks it.
            physicsActive: state.physicsActive,
            manifest: env.manifest,
          };
          notify();
          return;
        }
        case 'event': {
          // Apply structural updates to characters[] for events that carry
          // engine-state mutations. Without this, the browser would only see
          // the initial snapshot and would never reflect movement, damage,
          // or DM-revealed monsters appearing mid-session.
          const ev = env.event as {
            type?: string;
            actorId?: string;
            changes?: Array<{ id: string; damage?: number; status?: string; pos?: { x: number; y: number } }>;
            action?: {
              kind?: string;
              monsterTypeId?: string;
              characterId?: string;
              pos?: { x: number; y: number };
              // spawn_prop fields
              id?: string;
              emoji?: string;
              name?: string;
              description?: string;
              spriteId?: string;
            };
            // resolution payload — present on attack_object / push_object outcomes
            public?: {
              obstacleDestroyed?: { x: number; y: number };
              obstacleDamaged?: { pos: { x: number; y: number }; remaining: number; max: number };
              propRemoved?: string;
              objectPushed?: { from: { x: number; y: number }; to: { x: number; y: number }; type?: string };
              // An explosive cask's blast also DEMOLISHES attack-proof stalagmites
              // in range — those cells must be marked destroyed too, or they keep
              // rendering after the breach.
              blast?: { demolished?: { x: number; y: number }[] };
            };
          };
          let nextCharacters = state.characters;
          let nextProps = state.props;
          let nextScene = state.scene;
          if (ev.type === 'state_change' && Array.isArray(ev.changes)) {
            // Build a NEW array (and NEW per-character objects when patched),
            // so subscribers using identity comparison see the change and the
            // previous snapshot reference is not mutated.
            const byId = new Map<string, RedactedCharacter>();
            for (const c of state.characters) byId.set(String(c.id), c);
            let mutated = false;
            for (const ch of ev.changes) {
              const existing = byId.get(String(ch.id));
              if (!existing) continue;  // unknown id → silently skip
              const patched: RedactedCharacter = {
                ...existing,
                ...(ch.pos !== undefined ? { pos: ch.pos } : {}),
                ...(ch.damage !== undefined || ch.status !== undefined
                  ? { health: {
                      ...existing.health,
                      ...(ch.damage !== undefined ? { damage: ch.damage } : {}),
                      ...(ch.status !== undefined
                        ? { status: ch.status as RedactedCharacter['health']['status'] }
                        : {}),
                    } }
                  : {}),
              };
              byId.set(String(ch.id), patched);
              mutated = true;
            }
            if (mutated) {
              nextCharacters = state.characters.map((c) => byId.get(String(c.id)) ?? c);
            }
          } else if (
            ev.type === 'action' &&
            ev.action?.kind === 'spawn_prop' &&
            typeof ev.action.id === 'string' &&
            typeof ev.action.emoji === 'string' &&
            typeof ev.action.name === 'string' &&
            ev.action.pos !== undefined
          ) {
            const id = ev.action.id;
            if (!state.props.some((p) => p.id === id)) {
              const prop: EmojiProp = {
                id,
                emoji: ev.action.emoji,
                name: ev.action.name,
                pos: ev.action.pos,
                ...(ev.action.description !== undefined && { description: ev.action.description }),
                ...(ev.action.spriteId !== undefined && { spriteId: ev.action.spriteId }),
              };
              nextProps = [...state.props, prop];
            }
          } else if (
            ev.type === 'action' &&
            ev.action?.kind === 'remove_prop' &&
            typeof ev.action.id === 'string'
          ) {
            const id = ev.action.id;
            if (state.props.some((p) => p.id === id)) {
              nextProps = state.props.filter((p) => p.id !== id);
            }
          } else if (
            ev.type === 'resolution' &&
            ev.public &&
            (ev.public.obstacleDestroyed !== undefined ||
              ev.public.obstacleDamaged !== undefined ||
              ev.public.objectPushed !== undefined ||
              typeof ev.public.propRemoved === 'string')
          ) {
            // attack_object / push_object resolution. Any of these keys may be present:
            //   - obstacleDestroyed: append the cell to scene.destroyedObstacles
            //   - obstacleDamaged:   drain a durability pip on the matching obstacle
            //   - objectPushed:      relocate the matching obstacle from→to
            //   - propRemoved:       drop the prop id from props[]
            // An EXPLOSION (resolution carries `blast`) DEFERS all its obstacle
            // removal — the cask cell AND the stalagmites it demolished — to the
            // Board, which calls store.markDestroyed() once the fireball lands, so
            // the wall doesn't vanish BEFORE the boom (a ranged detonation's blast
            // arrives a whole projectile-flight after the resolution). Hence we
            // skip the cask removal here when a blast is present.
            const hasBlast = ev.public.blast !== undefined;
            if (ev.public.obstacleDestroyed && state.scene && !hasBlast) {
              const cell = ev.public.obstacleDestroyed;
              const already = state.scene.destroyedObstacles.some(
                (d) => d.x === cell.x && d.y === cell.y,
              );
              if (!already) {
                nextScene = {
                  ...state.scene,
                  destroyedObstacles: [...state.scene.destroyedObstacles, { x: cell.x, y: cell.y }],
                };
              }
            }
            if (ev.public.obstacleDamaged && (nextScene ?? state.scene)) {
              const { pos, remaining, max } = ev.public.obstacleDamaged;
              const base = nextScene ?? state.scene!;
              nextScene = {
                ...base,
                obstacles: base.obstacles.map((o) =>
                  o.x === pos.x && o.y === pos.y ? { ...o, durability: max, remaining } : o,
                ),
              };
            }
            if (ev.public.objectPushed && (nextScene ?? state.scene)) {
              // A shoved obstacle (e.g. an oil cask) moved one cell. Relocate the
              // matching entry so Board redraws/slides it AND Layout offers it as
              // a target at its NEW cell (otherwise a detonation aimed at the old
              // cell hits empty floor → no-such-object).
              const { from, to } = ev.public.objectPushed;
              const base = nextScene ?? state.scene!;
              nextScene = {
                ...base,
                obstacles: base.obstacles.map((o) =>
                  o.x === from.x && o.y === from.y ? { ...o, x: to.x, y: to.y } : o,
                ),
              };
            }
            // (blast.demolished is applied by the Board via markDestroyed when the
            //  explosion VFX lands — see the note above; not removed here.)
            if (typeof ev.public.propRemoved === 'string') {
              const id = ev.public.propRemoved;
              if (state.props.some((p) => p.id === id)) {
                nextProps = state.props.filter((p) => p.id !== id);
              }
            }
          } else if (
            ev.type === 'action' &&
            ev.action?.kind === 'reveal_monster' &&
            typeof ev.action.characterId === 'string' &&
            typeof ev.action.monsterTypeId === 'string' &&
            ev.action.pos !== undefined
          ) {
            const id = ev.action.characterId;
            // Idempotency: skip if already present.
            if (!state.characters.some((c) => String(c.id) === id)) {
              const stub: RedactedCharacter = {
                id: id as CharacterId,
                name: ev.action.monsterTypeId,
                kind: 'monster',
                sprite: ev.action.monsterTypeId,
                pos: ev.action.pos,
                health: { total: 1, damage: 0, status: 'normal' },
                pools: { melee: 0, ranged: 0, magic: 0, armor: 0 },
                inventory: [],
                boons: [],
                normalAttack: { kind: 'melee', range: 1 },
                specialAction: { name: '', description: '' },
                bonusAbility:  { name: '', description: '' },
              };
              nextCharacters = [...state.characters, stub];
            }
          }
          // Track turn-action consumption client-side. The engine marks
          // markMoved()/markActed() on the active actor; mirror that here so
          // the player UI can hide buttons whose actions would be rejected.
          let nextHasMoved = state.hasMoved;
          let nextHasActed = state.hasActed;
          if (
            ev.type === 'action' &&
            typeof ev.actorId === 'string' &&
            ev.actorId === state.activeActor &&
            typeof ev.action?.kind === 'string'
          ) {
            if (ev.action.kind === 'move') nextHasMoved = true;
            else if (MAIN_ACTION_KINDS.has(ev.action.kind)) nextHasActed = true;
          }
          // Story-mode vs combat-mode flag. The engine emits `combat_started`
          // when the DM rolls initiative and `combat_ended` when the last
          // monster falls (or the DM ends the encounter). We mirror those
          // bookends here so the UI can hide the board + action buttons
          // outside of combat.
          let nextInCombat = state.inCombat;
          if (ev.type === 'combat_started') nextInCombat = true;
          else if (ev.type === 'combat_ended') nextInCombat = false;
          state = {
            ...state,
            characters: nextCharacters,
            props: nextProps,
            scene: nextScene,
            chat: [...state.chat, { event: env.event }],
            hasMoved: nextHasMoved,
            hasActed: nextHasActed,
            inCombat: nextInCombat,
          };
          notify();
          return;
        }
        case 'turn_started':
          state = {
            ...state,
            activeActor: env.actorId,
            hasMoved: false,
            hasActed: false,
          };
          notify();
          return;
        case 'turn_ended':
          state = { ...state, activeActor: null };
          notify();
          return;
        case 'input_required':
          state = { ...state, inputUnlocked: true };
          notify();
          return;
        case 'input_done':
          state = { ...state, inputUnlocked: false };
          notify();
          return;
        case 'thinking': {
          const next = new Set(state.thinking);
          next.add(env.actorId);
          // Fresh LLM call → reset this actor's streamed text.
          const text = new Map(state.thinkingText);
          text.delete(env.actorId);
          state = { ...state, thinking: next, thinkingText: text };
          notify();
          return;
        }
        case 'thinking_delta': {
          const text = new Map(state.thinkingText);
          text.set(env.actorId, (text.get(env.actorId) ?? '') + env.text);
          state = { ...state, thinkingText: text };
          notify();
          return;
        }
        case 'thinking_done': {
          const next = new Set(state.thinking);
          next.delete(env.actorId);
          const text = new Map(state.thinkingText);
          text.delete(env.actorId);
          state = { ...state, thinking: next, thinkingText: text };
          notify();
          return;
        }
        case 'end':
          state = {
            ...state,
            ended: env.reason ? { outcome: env.outcome, reason: env.reason } : { outcome: env.outcome },
            inputUnlocked: false,
          };
          notify();
          return;
        case 'beat_gate':
          // The server is holding the next turn until the player has read the
          // previous turn's beats. Record the request id; Layout sends the
          // matching `beat_gate_ack` once its playback queue drains. Routed
          // through the deferred dispatcher (see ws-client) so this lands
          // AFTER any narration still parked behind an in-flight projectile —
          // i.e. queueDrained is correctly false here when a beat is pending.
          if (state.pendingBeatGate === env.requestId) return;
          state = { ...state, pendingBeatGate: env.requestId };
          notify();
          return;
        case 'queued':
          // Waiting in line for a free game slot (server at session capacity).
          // Updates as the line moves; the attach snapshot clears it once the
          // session is admitted.
          state = { ...state, queued: { position: env.position, capacity: env.capacity } };
          notify();
          return;
        case 'survey_ack':
          // Reply to a submitted playtest survey. seq increments so the
          // modal's reconciliation can distinguish this ack from one it
          // already consumed.
          state = {
            ...state,
            surveyAck: {
              seq: (state.surveyAck?.seq ?? 0) + 1,
              ok: env.ok,
              ...(env.destination !== undefined ? { destination: env.destination } : {}),
              ...(env.detail !== undefined ? { detail: env.detail } : {}),
            },
          };
          notify();
          return;
        case 'rejected':
          // `session_gone`: this tab's game no longer exists server-side and
          // ws-client has stopped reconnecting — surface "reload to rejoin"
          // (clearing any stale queue standing). Other reasons: no state
          // change; browser components may add a toast banner later.
          if (env.reason === 'session_gone') {
            state = { ...state, sessionGone: true, queued: null };
            notify();
          }
          return;
      }
    },
    setInputUnlocked: (unlocked) => {
      if (state.inputUnlocked === unlocked) return;
      state = { ...state, inputUnlocked: unlocked };
      notify();
    },
    markPhysicsActive: () => {
      if (state.physicsActive) return;  // set-once
      state = { ...state, physicsActive: true };
      // No notify(): no rendered surface keys off physicsActive directly — it's
      // read at ingest time (matchQueueItems) on the next store change, which a
      // subsequent event/snapshot always triggers.
    },
    markDestroyed: (cells) => {
      if (!state.scene || cells.length === 0) return;
      const have = new Set(state.scene.destroyedObstacles.map((d) => `${d.x},${d.y}`));
      const add = cells.filter((c) => !have.has(`${c.x},${c.y}`));
      if (add.length === 0) return;
      state = {
        ...state,
        scene: {
          ...state.scene,
          destroyedObstacles: [...state.scene.destroyedObstacles, ...add.map((c) => ({ x: c.x, y: c.y }))],
        },
      };
      notify();
    },
  };
};
