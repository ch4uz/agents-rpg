import { describe, it, expect } from 'vitest';
import { latestRoll, rollPanel, type RollSummary } from '../../web/components/RollPanel.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';
import { render } from 'lit-html';

// Lightweight RedactedCharacter fixture. Only the fields read by RollPanel
// are required to be realistic; the rest can stay defaulted.
const mkChar = (over: Partial<RedactedCharacter> & { id: string; name: string; kind: 'hero' | 'monster' }): RedactedCharacter => ({
  pos: { x: 0, y: 0 },
  health: { total: 3, damage: 0, status: 'normal' },
  pools: { melee: 0, ranged: 0, magic: 0, armor: 1 },
  inventory: [],
  boons: [],
  specialAction: { name: '', description: '' },
  bonusAbility:  { name: '', description: '' },
  ...over,
} as RedactedCharacter);

const bran = mkChar({
  id: 'human-bran' as RedactedCharacter['id'],
  name: 'Bran',
  kind: 'hero',
  archetype: 'hunter',
  pools: { melee: 1, ranged: 2, magic: 0, armor: 1 },
  specialAction: { name: 'Split Shot', description: '' },
});

const rat1 = mkChar({
  id: 'giant-rat-1' as RedactedCharacter['id'],
  name: 'giant-rat',
  kind: 'monster',
  sprite: 'giant-rat',
  pools: { melee: 1, ranged: 0, magic: 0, armor: 2 },
});

const summary = (over: Partial<RollSummary> = {}): RollSummary => ({
  t: 1,
  attackerName: 'Bran',
  attackerArchetype: 'hunter',
  attackerSprite: null,
  attackerKind: 'hero',
  targetName: 'Giant Rat',
  targetArchetype: null,
  targetSprite: 'giant-rat',
  targetKind: 'monster',
  attackKind: 'ranged',
  attackerPool: 2,
  attackerTop: 5,
  defenderArmorPool: 2,
  defenderTop: 3,
  hit: true,
  damage: 1,
  specialName: null,
  ...over,
});

describe('latestRoll', () => {
  it('returns null when chat is empty', () => {
    expect(latestRoll([], [bran, rat1])).toBeNull();
  });

  it('returns null when no resolution has fired', () => {
    expect(latestRoll([
      { event: { t: 1, type: 'narrate', actorId: 'dm', text: 'Begin.' } },
    ], [bran, rat1])).toBeNull();
  });

  it('returns a summary including the resolution event\'s `t` (used as the lit-html key)', () => {
    const r = latestRoll([
      { event: { t: 1, type: 'narrate', actorId: 'dm', text: 'Begin.' } },
      { event: { t: 2, type: 'action',  actorId: 'human-bran', action: { kind: 'normal_attack', targetId: 'giant-rat-1' } } },
      { event: { t: 3, type: 'resolution', actorId: 'human-bran', public: { hit: true, damage: 1, attackerTop: 5, defenderTop: 3, targetId: 'giant-rat-1' } } },
    ], [bran, rat1]);
    expect(r).not.toBeNull();
    expect(r!.t).toBe(3);
    expect(r!.attackerTop).toBe(5);
    expect(r!.defenderTop).toBe(3);
    expect(r!.hit).toBe(true);
    expect(r!.damage).toBe(1);
  });

  it('carries entity identity for portrait rendering (kind + archetype + sprite)', () => {
    const r = latestRoll([
      { event: { t: 3, type: 'resolution', actorId: 'human-bran', public: { hit: true, damage: 1, attackerTop: 5, defenderTop: 3, targetId: 'giant-rat-1' } } },
    ], [bran, rat1]);
    expect(r!.attackKind).toBe('ranged');
    expect(r!.attackerPool).toBe(2);
    expect(r!.defenderArmorPool).toBe(2);
    expect(r!.attackerName).toBe('Bran');
    expect(r!.targetName).toBe('Giant Rat');
    expect(r!.attackerKind).toBe('hero');
    expect(r!.attackerArchetype).toBe('hunter');
    expect(r!.targetKind).toBe('monster');
    expect(r!.targetSprite).toBe('giant-rat');
  });

  it('marks special_action by resolving the actor\'s special-action name', () => {
    const r = latestRoll([
      { event: { t: 1, type: 'action',     actorId: 'human-bran', action: { kind: 'special_action', targetIds: ['giant-rat-1'] } } },
      { event: { t: 2, type: 'resolution', actorId: 'human-bran', public: { hit: false, damage: 0, attackerTop: 2, defenderTop: 4, targetId: 'giant-rat-1' } } },
    ], [bran, rat1]);
    expect(r!.specialName).toBe('Split Shot');
    expect(r!.hit).toBe(false);
  });

  it('skips a resolution whose actor or target is missing from the snapshot', () => {
    const r = latestRoll([
      { event: { t: 1, type: 'resolution', actorId: 'who-is-this', public: { hit: true, damage: 1, attackerTop: 5, defenderTop: 3, targetId: 'giant-rat-1' } } },
      { event: { t: 2, type: 'resolution', actorId: 'human-bran',  public: { hit: false, damage: 0, attackerTop: 2, defenderTop: 4, targetId: 'giant-rat-1' } } },
    ], [bran, rat1]);
    expect(r!.attackerName).toBe('Bran');
    expect(r!.t).toBe(2);
  });
});

describe('rollPanel', () => {
  it('renders nothing when summary is null', () => {
    const root = document.createElement('div');
    render(rollPanel(null), root);
    expect(root.querySelector('.roll-panel')).toBeNull();
  });

  it('shows both portraits with names + VS divider + verdict (dice are rendered by Dice3DOverlay)', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({
      attackerPool: 2, attackerTop: 5,
      defenderArmorPool: 2, defenderTop: 3,
      hit: true, damage: 1,
    })), root);
    const panel = root.querySelector('.roll-panel')!;
    expect(panel).not.toBeNull();
    // The 3D overlay variant is flagged for CSS so styles can compensate.
    expect(panel.classList.contains('roll-panel--3d')).toBe(true);

    // Two sides + a VS divider.
    expect(panel.querySelector('.roll-side--attacker')).not.toBeNull();
    expect(panel.querySelector('.roll-side--defender')).not.toBeNull();
    expect(panel.querySelector('.roll-vs')).not.toBeNull();

    // The 2D emoji dice strip is gone — dice live in the 3D overlay now.
    expect(panel.querySelector('.roll-dice-strip')).toBeNull();
    expect(panel.querySelector('.roll-die')).toBeNull();

    // Names are present (attacker + target).
    expect(panel.textContent).toMatch(/Bran/);
    expect(panel.textContent).toMatch(/Giant Rat/);

    // Avatars are background-image-driven spans tied to the asset paths.
    const attackerAvatar = panel.querySelector('.roll-side--attacker .roll-avatar') as HTMLElement;
    const defenderAvatar = panel.querySelector('.roll-side--defender .roll-avatar') as HTMLElement;
    expect(attackerAvatar.getAttribute('style')).toMatch(/heroes\/hunter\/south\.png/);
    expect(defenderAvatar.getAttribute('style')).toMatch(/monsters\/giant-rat\/south\.png/);

    // Verdict + damage.
    expect(panel.querySelector('.roll-result.hit')).not.toBeNull();
    expect(panel.textContent).toMatch(/HIT/);
    expect(panel.textContent).toMatch(/1\s*damage/);
  });

  it('does not render dice strip elements regardless of pool size', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({ attackerPool: 4, attackerTop: 6 })), root);
    expect(root.querySelectorAll('.roll-dice-strip')).toHaveLength(0);
    expect(root.querySelectorAll('.roll-die')).toHaveLength(0);
  });

  it('falls back to a placeholder avatar when no archetype/sprite is known', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({
      attackerArchetype: null,
      attackerSprite: null,
      attackerKind: 'dm',
    })), root);
    const av = root.querySelector('.roll-side--attacker .roll-avatar')!;
    expect(av.classList.contains('roll-avatar--placeholder')).toBe(true);
  });

  it('renders MISS state without a damage chip', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({ attackerTop: 1, defenderTop: 4, hit: false, damage: 0 })), root);
    const panel = root.querySelector('.roll-panel')!;
    expect(panel.querySelector('.roll-result.miss')).not.toBeNull();
    expect(panel.textContent).toMatch(/MISS/);
    expect(panel.querySelector('.roll-damage')).toBeNull();
  });

  it('exposes the resolution `t` via data-roll-t (used as the keyed-render identity)', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({ t: 7 })), root);
    expect(root.querySelector('.roll-panel')!.getAttribute('data-roll-t')).toBe('7');
  });

  it('replaces the DOM node when `t` changes (lit-html keyed → CSS animation restarts)', () => {
    const root = document.createElement('div');
    render(rollPanel(summary({ t: 1 })), root);
    const before = root.querySelector('.roll-panel');
    render(rollPanel(summary({ t: 2, attackerTop: 6, damage: 2 })), root);
    const after = root.querySelector('.roll-panel');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);   // identity changed → fresh DOM, fresh animation
  });
});
