// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import { selectLatestPassiveBanner, PASSIVE_BANNER_MS } from '../../web/components/Layout.js';
import { passiveTriggerBanner } from '../../web/components/PassiveTriggerBanner.js';
import type { ChatEntry } from '../../web/store.js';
import type { RedactedCharacter } from '../../src/engine/snapshot.js';

const hero = (id: string, name: string, archetype: string): RedactedCharacter =>
  ({
    id, name, kind: 'hero', archetype, sprite: archetype,
    pos: { x: 0, y: 0 },
    health: { total: 3, damage: 0, status: 'normal' },
    pools: { melee: 2, ranged: 0, magic: 0, armor: 2 },
    inventory: [], boons: [],
    normalAttack: { kind: 'melee', range: 1 },
    specialAction: { name: 'WW', description: '' },
    bonusAbility: { name: 'Teamwork', description: '' },
  }) as unknown as RedactedCharacter;

const passiveEntry = (actorId: string, abilityName: string, effect?: string): ChatEntry =>
  ({ event: { type: 'passive_triggered', actorId, abilityName, ...(effect ? { effect } : {}), t: 1 } }) as unknown as ChatEntry;

const otherEntry = (): ChatEntry =>
  ({ event: { type: 'narrate', actorId: 'dm', text: 'Something happens.', t: 0 } }) as unknown as ChatEntry;

describe('selectLatestPassiveBanner', () => {
  const roster = [hero('h1', 'Anwen', 'warrior'), hero('h2', 'Elara', 'healer')];

  it('returns no banner when the chat carries no passive_triggered events', () => {
    expect(selectLatestPassiveBanner([otherEntry()], roster)).toEqual({ count: 0, data: null });
  });

  it('resolves the latest passive against the roster (name, archetype, effect)', () => {
    const chat = [otherEntry(), passiveEntry('h1', 'Teamwork', '+1 attack die')];
    const { count, data } = selectLatestPassiveBanner(chat, roster);
    expect(count).toBe(1);
    expect(data).toMatchObject({
      name: 'Anwen',
      archetype: 'warrior',
      abilityName: 'Teamwork',
      effect: '+1 attack die',
    });
    // key is derived from the chat index so each trigger re-mounts.
    expect(data!.key).toBe('passive-1');
  });

  it('counts every passive event but surfaces only the most recent', () => {
    const chat = [
      passiveEntry('h1', 'Teamwork', '+1 attack die'),
      passiveEntry('h2', 'Tangled', '+1 armor die'),
    ];
    const { count, data } = selectLatestPassiveBanner(chat, roster);
    expect(count).toBe(2);
    expect(data).toMatchObject({ name: 'Elara', archetype: 'healer', abilityName: 'Tangled' });
  });

  it('falls back to the actorId for the name when the hero is off-roster', () => {
    const { data } = selectLatestPassiveBanner([passiveEntry('ghost', 'Hunter')], roster);
    // displayName normalizes the raw id (e.g. capitalizes it) — match loosely.
    expect(data).toMatchObject({ archetype: null, abilityName: 'Hunter' });
    expect(data!.name.toLowerCase()).toContain('ghost');
  });

  it('exposes a non-trivial hold window so the banner is readable', () => {
    expect(PASSIVE_BANNER_MS).toBeGreaterThanOrEqual(2000);
  });
});

describe('passiveTriggerBanner component', () => {
  it('renders the avatar, hero name, "triggered", and the ability + effect', () => {
    const host = document.createElement('div');
    render(
      passiveTriggerBanner(
        { key: 'k', name: 'Elara', archetype: 'healer', sprite: 'healer', abilityName: 'Tangled', effect: '+1 armor die' },
        false,
      ),
      host,
    );
    const banner = host.querySelector('.passive-banner');
    expect(banner).not.toBeNull();
    expect(banner!.classList.contains('passive-banner--out')).toBe(false);
    expect(host.querySelector('.passive-banner-name')!.textContent).toBe('Elara');
    expect(host.querySelector('.passive-banner-ability')!.textContent).toBe('Tangled');
    expect(host.querySelector('.passive-banner-effect')!.textContent).toBe('+1 armor die');
    expect(host.textContent).toContain('triggered');
    // Avatar resolves to the hero's south-facing portrait.
    const avatar = host.querySelector<HTMLElement>('.passive-banner-avatar')!;
    expect(avatar.getAttribute('style')).toContain('/assets/heroes/healer/south.png');
  });

  it('applies the dismissing class for the fade-out', () => {
    const host = document.createElement('div');
    render(
      passiveTriggerBanner({ key: 'k', name: 'Anwen', archetype: 'warrior', sprite: null, abilityName: 'Teamwork' }, true),
      host,
    );
    expect(host.querySelector('.passive-banner')!.classList.contains('passive-banner--out')).toBe(true);
    // No effect phrase when none supplied.
    expect(host.querySelector('.passive-banner-effect')).toBeNull();
  });
});
