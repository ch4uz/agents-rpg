// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { DiceHUD } from '../../web/components/DiceHUD.js';

/**
 * A skill check (ability test / object smash / free-ally) used to spell the DC
 * into the right frame's nameplate as "DC 3". Instead it now renders the DC as
 * a die icon + number in that frame's dice slot — the same visual the hero /
 * enemy frames use for their rolled result — so the DC reads consistently with
 * the rest of the HUD.
 */
describe('DiceHUD — skill-check DC frame', () => {
  // Each mount injects elements with id="dice-hud-right"; jsdom's id-selector
  // fast path searches the whole document, so a stale prior mount would shadow
  // the current one. Reset the body (and query by class) to keep mounts isolated.
  beforeEach(() => { document.body.replaceChildren(); });

  const mount = (): { wrapper: HTMLElement; hud: DiceHUD } => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const hud = new DiceHUD();
    hud.attach(wrapper);
    return { wrapper, hud };
  };

  it('renders the DC as a die icon + number on the right frame, not in the name', () => {
    const { wrapper, hud } = mount();
    hud.beginDuel(
      { name: 'Bran', kind: 'hero', archetype: 'hunter', sprite: null },
      { name: 'DC', kind: 'dm', archetype: null, sprite: null },
      { difficulty: 4 },
    );

    const right = wrapper.querySelector('.combat-frame--right')!;
    const name = right.querySelector('.combat-name') as HTMLElement;
    const slot = right.querySelector('.dice-slot') as HTMLElement;
    const pips = right.querySelectorAll('.dice-pip');
    const result = right.querySelector('.combat-result') as HTMLElement;

    // The number is NOT spelled into the nameplate…
    expect(name.textContent).toBe('DC');
    expect(name.textContent).not.toMatch(/\d/);
    // …it's a single die icon + the DC number, exactly like a rolled result.
    expect(pips.length).toBe(1);
    expect(slot.dataset.resultActive).toBe('true');
    expect(result.textContent).toBe('4');
    expect(result.dataset.active).toBe('true');
  });

  it('clamps the die-icon face to a valid d6 while still showing the real DC', () => {
    const { wrapper, hud } = mount();
    hud.beginDuel(
      { name: 'Bran', kind: 'hero', archetype: 'hunter', sprite: null },
      { name: 'DC', kind: 'dm', archetype: null, sprite: null },
      { difficulty: 6 },
    );
    const right = wrapper.querySelector('.combat-frame--right')!;
    expect((right.querySelector('.combat-result') as HTMLElement).textContent).toBe('6');
    const pip = right.querySelector('.dice-pip') as HTMLElement;
    expect(pip.style.getPropertyValue('--face-img')).not.toBe('');
  });

  it('a normal attack (no check arg) renders no DC die on the right frame', () => {
    const { wrapper, hud } = mount();
    hud.beginDuel(
      { name: 'Bran', kind: 'hero', archetype: 'hunter', sprite: null },
      { name: 'Giant Rat', kind: 'monster', archetype: null, sprite: 'giant-rat' },
    );
    const right = wrapper.querySelector('.combat-frame--right')!;
    expect(right.querySelectorAll('.dice-pip').length).toBe(0);
    expect((right.querySelector('.dice-slot') as HTMLElement).dataset.resultActive).toBe('false');
  });
});
