// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { parseInlineMarkdown } from '../../src/util/markdown.js';
import {
  annotateRefs,
  buildRefContext,
  markdownInlineRefsHtml,
  parseWithRefs,
  refTargetFromElement,
  setRefContext,
  type RefContext,
} from '../../web/components/refs.js';

const ctx = (over: Partial<RefContext> = {}): RefContext => ({
  gridW: 13,
  gridH: 9,
  creatures: [
    { id: 'p1_hunter', name: 'Bran', kind: 'hero' },
    { id: 'king-rat', name: 'King Rat', kind: 'monster' },
    { id: 'giant-rat-1', name: 'Giant Rat', kind: 'monster' },
    { id: 'giant-rat-2', name: 'Giant Rat', kind: 'monster' },
    { id: 'mira', name: 'Mira', kind: 'npc' },
  ],
  ...over,
});

// Annotation always resets the module-global context after each test so a
// stray `setRefContext` can't leak into another spec.
afterEach(() => setRefContext(null));

describe('annotateRefs — coordinates', () => {
  it('tags an in-bounds (x,y) coordinate as a cell ref', () => {
    const out = annotateRefs(parseInlineMarkdown('Move to (3,4) now'), ctx());
    expect(out).toEqual([
      { text: 'Move to ' },
      { text: '(3,4)', ref: { kind: 'cell', value: '3,4', x: 3, y: 4 } },
      { text: ' now' },
    ]);
  });

  it('tolerates whitespace inside the parens', () => {
    const out = annotateRefs(parseInlineMarkdown('at ( 11 , 3 )'), ctx());
    expect(out[1]).toEqual({ text: '( 11 , 3 )', ref: { kind: 'cell', value: '11,3', x: 11, y: 3 } });
  });

  it('does NOT tag an out-of-bounds coordinate', () => {
    // gridW=13, gridH=9 → (20,20) is off the map.
    const out = annotateRefs(parseInlineMarkdown('ghost at (20,20)'), ctx());
    expect(out.some((s) => s.ref)).toBe(false);
  });

  it('accepts any non-negative pair when grid size is unknown', () => {
    const out = annotateRefs(parseInlineMarkdown('(20,20)'), ctx({ gridW: 0, gridH: 0 }));
    expect(out[0]?.ref).toEqual({ kind: 'cell', value: '20,20', x: 20, y: 20 });
  });
});

describe('annotateRefs — creatures', () => {
  it('tags a raw engine id with its faction', () => {
    const out = annotateRefs(parseInlineMarkdown('I strike giant-rat-2.'), ctx());
    expect(out).toEqual([
      { text: 'I strike ' },
      // Matched the slug, but the chip DISPLAYS the friendly name; the id stays
      // in `value` for the board highlight.
      { text: 'Giant Rat', ref: { kind: 'creature', value: 'giant-rat-2', faction: 'monster' } },
      { text: '.' },
    ]);
  });

  it('renders the creature display name in place of a raw slug', () => {
    const out = annotateRefs(parseInlineMarkdown('focus fire on giant-rat-1'), ctx());
    const ref = out.find((s) => s.ref);
    expect(ref?.text).toBe('Giant Rat');          // shown as the name…
    expect(ref?.ref?.value).toBe('giant-rat-1');  // …but still points at the id
  });

  it('tags an in-fiction display name', () => {
    const out = annotateRefs(parseInlineMarkdown('The King Rat snarls.'), ctx());
    expect(out[1]).toEqual({
      text: 'King Rat',
      ref: { kind: 'creature', value: 'king-rat', faction: 'monster' },
    });
  });

  it('groups a shared name into every matching id', () => {
    const out = annotateRefs(parseInlineMarkdown('A Giant Rat lunges'), ctx());
    expect(out[1]?.ref).toEqual({
      kind: 'creature',
      value: 'giant-rat-1 giant-rat-2',
      faction: 'monster',
    });
  });

  it('tags heroes and npcs with their own faction class', () => {
    const hero = annotateRefs(parseInlineMarkdown('Bran charges'), ctx());
    expect(hero[0]?.ref).toEqual({ kind: 'creature', value: 'p1_hunter', faction: 'hero' });
    const npc = annotateRefs(parseInlineMarkdown('Mira waves'), ctx());
    expect(npc[0]?.ref).toEqual({ kind: 'creature', value: 'mira', faction: 'npc' });
  });

  it('prefers the longest match (giant-rat-2 over the shared Giant Rat group)', () => {
    const out = annotateRefs(parseInlineMarkdown('hit giant-rat-2'), ctx());
    expect(out[1]?.ref?.value).toBe('giant-rat-2');
  });

  it('captures an instance abbreviation like rat-2 (type prefix dropped)', () => {
    const out = annotateRefs(parseInlineMarkdown('I hit rat-2 hard'), ctx());
    const ref = out.find((s) => s.ref);
    expect(ref?.ref?.value).toBe('giant-rat-2');   // resolves to the full id
    expect(ref?.text).toBe('Giant Rat');           // still displayed as the name
  });

  it('captures the spaced abbreviation "Rat 2"', () => {
    const out = annotateRefs(parseInlineMarkdown('the Rat 2 lunges'), ctx());
    expect(out.find((s) => s.ref)?.ref?.value).toBe('giant-rat-2');
  });

  it('does NOT register a bare generic word (no "rat" needle for king-rat)', () => {
    const out = annotateRefs(parseInlineMarkdown('a rat scurries'), ctx({
      creatures: [{ id: 'king-rat', name: 'King Rat', kind: 'monster' }],
    }));
    expect(out.some((s) => s.ref)).toBe(false);
  });

  it('requires word boundaries — no match inside a larger word', () => {
    // "giant-rat-2" must not match inside "giant-rat-21".
    const out = annotateRefs(parseInlineMarkdown('see giant-rat-21 here'), ctx());
    expect(out.some((s) => s.ref)).toBe(false);
  });

  it('does not match a creature substring inside another word', () => {
    const out = annotateRefs(parseInlineMarkdown('I am grateful'), ctx({
      creatures: [{ id: 'rat', name: 'Rat', kind: 'monster' }],
    }));
    expect(out.some((s) => s.ref)).toBe(false);
  });
});

describe('annotateRefs — composition + guards', () => {
  it('keeps markdown style flags on a ref inside **bold**', () => {
    const out = annotateRefs(parseInlineMarkdown('**giant-rat-2**'), ctx());
    expect(out).toEqual([
      { text: 'Giant Rat', bold: true, ref: { kind: 'creature', value: 'giant-rat-2', faction: 'monster' } },
    ]);
  });

  it('never annotates inside a `code` span', () => {
    const out = annotateRefs(parseInlineMarkdown('use `(3,4)` literally'), ctx());
    expect(out.find((s) => s.code)?.ref).toBeUndefined();
  });

  it('is a no-op with a null context', () => {
    const segs = parseInlineMarkdown('King Rat at (3,4)');
    expect(annotateRefs(segs, null)).toEqual(segs);
  });

  it('handles both a coordinate and a creature in one line', () => {
    const out = annotateRefs(parseInlineMarkdown('King Rat lurks at (11,3)'), ctx());
    const refs = out.filter((s) => s.ref).map((s) => s.ref);
    expect(refs).toEqual([
      { kind: 'creature', value: 'king-rat', faction: 'monster' },
      { kind: 'cell', value: '11,3', x: 11, y: 3 },
    ]);
  });
});

describe('markdownInlineRefsHtml', () => {
  it('renders a cell chip with data attributes', () => {
    const html = markdownInlineRefsHtml('go (3,4)', ctx());
    expect(html).toContain(
      '<span class="dlg-ref dlg-ref--cell" data-ref-kind="cell" data-ref-cell="3,4" data-ref-x="3" data-ref-y="4">(3,4)</span>',
    );
  });

  it('renders a creature chip with faction class + id list', () => {
    const html = markdownInlineRefsHtml('the Giant Rat', ctx());
    expect(html).toContain(
      '<span class="dlg-ref dlg-ref--creature dlg-ref--monster" data-ref-kind="creature" data-ref-id="giant-rat-1 giant-rat-2">Giant Rat</span>',
    );
  });

  it('produces plain markdown (no chips) when no context is active', () => {
    expect(markdownInlineRefsHtml('King Rat at (3,4)')).toBe('King Rat at (3,4)');
  });

  it('reads the module-level active context set by setRefContext', () => {
    setRefContext(ctx());
    expect(markdownInlineRefsHtml('Bran')).toContain('data-ref-id="p1_hunter"');
  });
});

describe('parseWithRefs', () => {
  it('parses markdown and annotates in one pass', () => {
    const out = parseWithRefs('hit *giant-rat-2*', ctx());
    expect(out[1]).toEqual({
      text: 'Giant Rat', italic: true,
      ref: { kind: 'creature', value: 'giant-rat-2', faction: 'monster' },
    });
  });
});

describe('buildRefContext', () => {
  it('projects a store snapshot into a RefContext', () => {
    const rc = buildRefContext({
      characters: [{ id: 'giant-rat-1', name: 'Giant Rat', kind: 'monster' }],
      scene: { gridW: 15, gridH: 11 },
    });
    expect(rc).toEqual({
      gridW: 15, gridH: 11,
      creatures: [{ id: 'giant-rat-1', name: 'Giant Rat', kind: 'monster' }],
    });
  });

  it('falls back to a 0×0 grid when there is no scene', () => {
    const rc = buildRefContext({ characters: [], scene: null });
    expect(rc.gridW).toBe(0);
    expect(rc.gridH).toBe(0);
  });
});

describe('refTargetFromElement', () => {
  const el = (attrs: Record<string, string>): HTMLElement => {
    const span = document.createElement('span');
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    return span;
  };

  it('reads a cell chip', () => {
    expect(refTargetFromElement(el({ 'data-ref-kind': 'cell', 'data-ref-x': '3', 'data-ref-y': '4' })))
      .toEqual({ kind: 'cell', x: 3, y: 4 });
  });

  it('reads a creature chip with multiple ids', () => {
    expect(refTargetFromElement(el({ 'data-ref-kind': 'creature', 'data-ref-id': 'giant-rat-1 giant-rat-2' })))
      .toEqual({ kind: 'creature', ids: ['giant-rat-1', 'giant-rat-2'] });
  });

  it('returns null for a non-ref element', () => {
    expect(refTargetFromElement(el({}))).toBeNull();
  });

  it('returns null for a malformed cell chip', () => {
    expect(refTargetFromElement(el({ 'data-ref-kind': 'cell' }))).toBeNull();
  });
});
