/**
 * Sprite-facing logic. Heroes and monsters have four directional rotations
 * (south/east/north/west); the renderer picks the right one based on the
 * actor's last meaningful movement or attack vector. Kept pure + standalone
 * so it can be unit-tested without Pixi.
 */

export type Facing = 'south' | 'east' | 'north' | 'west';

export const DEFAULT_FACING: Facing = 'south';

interface AnyEvent {
  type?: string;
  actorId?: string;
  action?: {
    kind?: string;
    path?: ReadonlyArray<{ x: number; y: number }>;
    targetId?: string;
    targetIds?: string[];
    pos?: { x: number; y: number };
  };
  public?: { targetId?: string };
}

/**
 * Pure: pick the 4-way facing closest to a (dx, dy) vector. Diagonals snap to
 * the dominant axis (ties prefer horizontal — east/west — because top-down
 * sprites read clearer in profile than head-on). (0, 0) returns null so
 * callers can preserve the actor's last-known facing.
 */
export const facingFromDelta = (dx: number, dy: number): Facing | null => {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
};

/**
 * Pure: facing implied by a `move` action — the last step of the path.
 * Returns null when the path is too short to derive direction.
 */
export const facingFromMovePath = (
  path: ReadonlyArray<{ x: number; y: number }>,
): Facing | null => {
  if (path.length < 2) return null;
  const a = path[path.length - 2]!;
  const b = path[path.length - 1]!;
  return facingFromDelta(b.x - a.x, b.y - a.y);
};

/**
 * Pure: facing implied by an attack — from the actor's current grid pos to
 * the target's pos. Returns null when either side has no position.
 */
export const facingFromAttack = (
  actor: { x: number; y: number } | null | undefined,
  target: { x: number; y: number } | null | undefined,
): Facing | null => {
  if (!actor || !target) return null;
  return facingFromDelta(target.x - actor.x, target.y - actor.y);
};

/**
 * Pure: scan a chat event and return any facing update implied by it.
 * Returns null when the event doesn't carry a direction (DM narration,
 * say events, etc.). Pass `posLookup` so this function can dereference
 * actor/target ids to current grid cells without Pixi or store access.
 */
export const facingChangeFromEvent = (
  event: unknown,
  posLookup: (id: string) => { x: number; y: number } | null,
): { actorId: string; facing: Facing } | null => {
  const e = event as AnyEvent;
  if (!e.type || !e.actorId) return null;

  // Move action: derive from path tail.
  if (e.type === 'action' && e.action?.kind === 'move' && Array.isArray(e.action.path)) {
    const f = facingFromMovePath(e.action.path);
    return f ? { actorId: e.actorId, facing: f } : null;
  }

  // Attacks land in resolution events with public.targetId set.
  if (e.type === 'resolution' && e.public?.targetId) {
    const target = posLookup(e.public.targetId);
    const actor = posLookup(e.actorId);
    const f = facingFromAttack(actor, target);
    return f ? { actorId: e.actorId, facing: f } : null;
  }

  // attack_object: action.pos points at the cell.
  if (e.type === 'action' && e.action?.kind === 'attack_object' && e.action.pos) {
    const actor = posLookup(e.actorId);
    const f = facingFromAttack(actor, e.action.pos);
    return f ? { actorId: e.actorId, facing: f } : null;
  }

  // normal_attack action (also fires a resolution; either is fine — handle
  // both for robustness when resolution lacks the public.targetId redaction).
  if (e.type === 'action' && e.action?.kind === 'normal_attack' && e.action.targetId) {
    const target = posLookup(e.action.targetId);
    const actor = posLookup(e.actorId);
    const f = facingFromAttack(actor, target);
    return f ? { actorId: e.actorId, facing: f } : null;
  }

  // special_action with at least one target: face the first target.
  if (
    e.type === 'action' &&
    e.action?.kind === 'special_action' &&
    Array.isArray(e.action.targetIds) &&
    e.action.targetIds.length > 0
  ) {
    const target = posLookup(e.action.targetIds[0]!);
    const actor = posLookup(e.actorId);
    const f = facingFromAttack(actor, target);
    return f ? { actorId: e.actorId, facing: f } : null;
  }

  return null;
};
