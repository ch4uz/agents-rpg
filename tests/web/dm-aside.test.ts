// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'lit-html';
import { dmAside } from '../../web/components/DmAside.js';

/**
 * `DmAside` — the out-of-character question/answer margin slip. It replaces
 * the old in-narrator "Player asked / DM reply" echo, which used to overwrite
 * the in-fiction narration. The component is a pure function of its payload;
 * Layout owns the lifecycle (mount on DM-target submit, fill reply on
 * `dm_ooc_reply`, unmount on fresh narration).
 */
describe('DmAside', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => root.remove());

  it('renders nothing when there is no active OOC thread', () => {
    render(dmAside(null), root);
    expect(root.querySelector('.dm-aside')).toBeNull();
    expect(root.textContent?.trim()).toBe('');
  });

  it('renders the question in a pending state while the DM has not replied', () => {
    render(dmAside({ question: 'Can I climb the crates?', reply: null }), root);

    const aside = root.querySelector<HTMLElement>('.dm-aside')!;
    expect(aside).not.toBeNull();
    expect(aside.dataset['state']).toBe('pending');
    expect(aside.getAttribute('role')).toBe('note');

    // Question row present with its label + text.
    expect(aside.querySelector('.dm-aside-turn--you .dm-aside-speaker')?.textContent)
      .toMatch(/you asked/i);
    expect(aside.querySelector('.dm-aside-text--question')?.textContent)
      .toBe('Can I climb the crates?');

    // Pending placeholder shown; no answered reply row yet.
    expect(aside.querySelector('.dm-aside-pending')).not.toBeNull();
    expect(aside.querySelector('.dm-aside-turn[data-role="reply"]')).toBeNull();
  });

  it('renders the reply row and flips to the answered state once the DM replies', () => {
    render(
      dmAside({ question: 'Can I see the door?', reply: 'Yes — three squares north.' }),
      root,
    );

    const aside = root.querySelector<HTMLElement>('.dm-aside')!;
    expect(aside.dataset['state']).toBe('answered');

    // The pending placeholder is gone; the reply row carries the answer.
    expect(aside.querySelector('.dm-aside-pending')).toBeNull();
    const reply = aside.querySelector<HTMLElement>('.dm-aside-turn[data-role="reply"] .dm-aside-text--reply');
    expect(reply).not.toBeNull();
    expect(reply!.textContent).toBe('Yes — three squares north.');
    expect(aside.querySelector('.dm-aside-turn--dm .dm-aside-speaker')?.textContent)
      .toMatch(/dungeon master/i);

    // The question stays as the prologue, ABOVE the reply in DOM order.
    const turns = Array.from(aside.querySelectorAll('.dm-aside-turn'));
    const qIdx = turns.findIndex((t) => t.getAttribute('data-role') === 'question');
    const rIdx = turns.findIndex((t) => t.getAttribute('data-role') === 'reply');
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(rIdx).toBeGreaterThan(qIdx);
  });

  it('renders inline markdown in both the question and the reply', () => {
    render(
      dmAside({ question: 'Is the *rat* hostile?', reply: 'It is **very** hostile.' }),
      root,
    );
    const aside = root.querySelector<HTMLElement>('.dm-aside')!;
    expect(aside.querySelector('.dm-aside-text--question em')?.textContent).toBe('rat');
    expect(aside.querySelector('.dm-aside-text--reply strong')?.textContent).toBe('very');
  });

  it('renders a dismiss button only when an onDismiss handler is provided', () => {
    // No handler → no button (static rendering / tests).
    render(dmAside({ question: 'Anything?', reply: null }), root);
    expect(root.querySelector('.dm-aside-dismiss')).toBeNull();

    // Handler provided → a labelled close button in the header.
    render(dmAside({ question: 'Anything?', reply: null }, vi.fn()), root);
    const dismiss = root.querySelector<HTMLButtonElement>('.dm-aside-dismiss');
    expect(dismiss).not.toBeNull();
    expect(dismiss!.getAttribute('aria-label')).toMatch(/dismiss/i);
    // It lives in the header (so it sits alongside the title, not in the thread).
    expect(root.querySelector('.dm-aside-header .dm-aside-dismiss')).not.toBeNull();
  });

  it('invokes onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(dmAside({ question: 'Anything?', reply: 'Sure.' }, onDismiss), root);
    root.querySelector<HTMLButtonElement>('.dm-aside-dismiss')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
