import { describe, it, expect } from 'vitest';
import { selectionHint } from '../../web/components/ActionButtons.js';

describe('selectionHint — Special describes the active hero', () => {
  it('renders the special name + description when one is supplied', () => {
    const hint = selectionHint('special', {
      name: 'Healing Touch',
      description: 'Remove 1 damage from yourself or an adjacent ally.',
    });
    expect(hint).toContain('Healing Touch');
    expect(hint).toContain('Remove 1 damage from yourself or an adjacent ally.');
    // Still tells the player how to act / cancel.
    expect(hint).toContain('Special again to cancel');
    // It no longer falls back to the generic prompt.
    expect(hint).not.toBe(
      'Click a target on the map for your special action — or press Special again to cancel.',
    );
  });

  it('includes the name even when the description is blank', () => {
    const hint = selectionHint('special', { name: 'Flame Burst', description: '' });
    expect(hint).toContain('Flame Burst');
    expect(hint).not.toContain('—'); // no dangling em-dash for the missing description
  });

  it('falls back to the generic prompt when no special is known', () => {
    expect(selectionHint('special')).toBe(
      'Click a target on the map for your special action — or press Special again to cancel.',
    );
    expect(selectionHint('special', null)).toBe(
      'Click a target on the map for your special action — or press Special again to cancel.',
    );
  });

  it('leaves the other modes untouched', () => {
    expect(selectionHint('move')).toContain('Click a destination cell');
    expect(selectionHint('attack')).toContain('Click a target on the map to attack');
    expect(selectionHint('idle')).toBe('');
  });
});
