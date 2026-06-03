// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'lit-html';
import { queueWindow, sessionGoneWindow } from '../../web/components/QueueWindow.js';

const renderInto = (q: { position: number; capacity: number }): HTMLElement => {
  const host = document.createElement('div');
  render(queueWindow(q), host);
  return host;
};

describe('queueWindow — centered session-queue window', () => {
  it('renders the place in line and the capacity', () => {
    const host = renderInto({ position: 2, capacity: 3 });
    const text = host.textContent ?? '';
    expect(text).toContain('#2');
    expect(text).toContain('All 3 adventures are underway');
    expect(host.querySelector('.queue-pos')?.textContent).toBe('#2');
  });

  it('uses singular copy at capacity 1', () => {
    const host = renderInto({ position: 1, capacity: 1 });
    expect(host.textContent).toContain('All 1 adventure is underway');
  });

  it('is a framed window with title bar, not a bare banner line', () => {
    const host = renderInto({ position: 1, capacity: 3 });
    expect(host.querySelector('.queue-overlay .queue-window')).not.toBeNull();
    expect(host.querySelector('.queue-titlebar .queue-title')?.textContent)
      .toBe('The Tavern Is Full');
  });

  it('announces politely for screen readers and offers no controls', () => {
    const host = renderInto({ position: 1, capacity: 3 });
    const overlay = host.querySelector('.queue-overlay')!;
    expect(overlay.getAttribute('role')).toBe('status');
    expect(overlay.getAttribute('aria-live')).toBe('polite');
    // Nothing to click — the wait ends only when the server admits the session.
    expect(host.querySelector('button')).toBeNull();
  });
});

describe('sessionGoneWindow — the tab\'s game no longer exists', () => {
  it('explains the state, alerts assertively, and offers a Reload button', () => {
    const host = document.createElement('div');
    render(sessionGoneWindow(), host);
    const overlay = host.querySelector('.queue-overlay--gone')!;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('alert');
    expect(host.textContent).toContain('no longer running');
    expect(host.textContent).toMatch(/reload the page/i);
    expect(host.querySelector('button.queue-reload')?.textContent).toBe('Reload');
  });
});
