/**
 * Inline-markdown parser used by every place that renders player or narrator
 * dialogue. Supports a small CommonMark subset:
 *
 *   **bold**   __bold__
 *   *italic*   _italic_     (underscore italic skipped inside snake_case)
 *   ~~strike~~
 *   `code`                  (opaque — no markdown inside)
 *   \n                      (preserved; renderers decide whether to break)
 *
 * Output is a flat list of styled segments so any renderer (HTML for the
 * browser, Ink Text props for the CLI) can map each segment to its
 * platform-specific style without re-parsing.
 *
 * Nesting is supported via flag toggling: bold opens, italic opens, italic
 * closes, bold closes. A marker only counts as opening when a matching
 * closer exists later in the input — otherwise it stays as a literal
 * character. This keeps stray asterisks from swallowing the rest of a line.
 */

/**
 * A live "reference" inside a dialogue segment — a grid coordinate the speaker
 * named (`(3,4)`) or one-or-more creatures they mentioned (`giant-rat-2`,
 * "King Rat"). Attached by the browser's `annotateRefs` pass (web/components/
 * refs.ts) so `renderSegmentsHtml` can wrap the run in a hoverable chip that
 * the board-highlight bridge keys off. Absent on every CLI / plain segment,
 * so non-browser renderers and existing callers are unaffected.
 */
export interface SegRef {
  /** 'cell' → a grid coordinate; 'creature' → one or more characters. */
  kind: 'cell' | 'creature';
  /** creature: space-joined character id(s); cell: the "x,y" coordinate text. */
  value: string;
  /** Cell coordinate (cell refs only). */
  x?: number;
  y?: number;
  /** Faction class for creature refs (hero | monster | npc) → colour. */
  faction?: string;
}

export interface MdSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Set by the browser ref-annotation pass; wraps the run in a `.dlg-ref`
   *  chip in HTML output. Untouched by `parseInlineMarkdown`. */
  ref?: SegRef;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);

const buildSegment = (
  text: string,
  bold: boolean,
  italic: boolean,
  strike: boolean,
): MdSegment => {
  const seg: MdSegment = { text };
  if (bold) seg.bold = true;
  if (italic) seg.italic = true;
  if (strike) seg.strike = true;
  return seg;
};

export const parseInlineMarkdown = (input: string): MdSegment[] => {
  const out: MdSegment[] = [];
  let bold = false;
  let italic = false;
  let strike = false;
  let buf = '';

  const flush = (): void => {
    if (buf.length === 0) return;
    out.push(buildSegment(buf, bold, italic, strike));
    buf = '';
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;

    // Code span — opaque, no markdown inside.
    if (c === '`') {
      const end = input.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ text: input.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Strikethrough.
    if (c === '~' && input[i + 1] === '~') {
      if (strike) {
        flush();
        strike = false;
        i += 2;
        continue;
      }
      if (input.indexOf('~~', i + 2) > -1) {
        flush();
        strike = true;
        i += 2;
        continue;
      }
    }

    // Bold (** or __). Underscore-bold is skipped inside words to keep
    // names like __init__ from collapsing.
    if (c === '*' && input[i + 1] === '*') {
      if (bold) {
        flush();
        bold = false;
        i += 2;
        continue;
      }
      if (input.indexOf('**', i + 2) > -1) {
        flush();
        bold = true;
        i += 2;
        continue;
      }
    }
    if (c === '_' && input[i + 1] === '_') {
      const prev = i > 0 ? input[i - 1] : undefined;
      const ahead = input[i + 2];
      const insideWord = isWord(prev) && isWord(ahead);
      if (!insideWord) {
        if (bold) {
          flush();
          bold = false;
          i += 2;
          continue;
        }
        if (input.indexOf('__', i + 2) > -1) {
          flush();
          bold = true;
          i += 2;
          continue;
        }
      }
    }

    // Italic (* or _). Single underscore inside a word stays literal.
    if (c === '*') {
      if (italic) {
        flush();
        italic = false;
        i += 1;
        continue;
      }
      if (input.indexOf('*', i + 1) > -1) {
        flush();
        italic = true;
        i += 1;
        continue;
      }
    }
    if (c === '_') {
      const prev = i > 0 ? input[i - 1] : undefined;
      const ahead = input[i + 1];
      const insideWord = isWord(prev) && isWord(ahead);
      if (!insideWord) {
        if (italic) {
          flush();
          italic = false;
          i += 1;
          continue;
        }
        if (input.indexOf('_', i + 1) > -1) {
          flush();
          italic = true;
          i += 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Render parsed segments to a safe HTML string. Each raw segment is
 * HTML-escaped before tag wrapping, so the only HTML in the output comes
 * from this function itself. Exposed separately from `markdownInlineHtml`
 * so callers (the narrator typewriter) can re-render a partially-revealed
 * sequence of segments without re-parsing the source text every tick.
 */
/** Wrap an already-rendered inner HTML run in a hoverable `.dlg-ref` chip.
 *  The data-* attributes are what the browser's board-hover bridge reads to
 *  highlight the matching cell / creature(s). Attribute values are escaped via
 *  `escapeHtml` (which also escapes quotes), so engine ids stay inert. */
const wrapRef = (ref: SegRef, inner: string): string => {
  if (ref.kind === 'cell') {
    return (
      `<span class="dlg-ref dlg-ref--cell" data-ref-kind="cell"` +
      ` data-ref-cell="${escapeHtml(ref.value)}"` +
      ` data-ref-x="${ref.x ?? ''}" data-ref-y="${ref.y ?? ''}">${inner}</span>`
    );
  }
  const faction = ref.faction ? ` dlg-ref--${escapeHtml(ref.faction)}` : '';
  return (
    `<span class="dlg-ref dlg-ref--creature${faction}" data-ref-kind="creature"` +
    ` data-ref-id="${escapeHtml(ref.value)}">${inner}</span>`
  );
};

export const renderSegmentsHtml = (segs: ReadonlyArray<MdSegment>): string => {
  let html = '';
  for (const s of segs) {
    let inner: string;
    if (s.code) {
      inner = `<code>${escapeHtml(s.text)}</code>`;
    } else {
      inner = escapeHtml(s.text);
      if (s.strike) inner = `<del>${inner}</del>`;
      if (s.italic) inner = `<em>${inner}</em>`;
      if (s.bold) inner = `<strong>${inner}</strong>`;
    }
    // A ref wraps the styled run (outermost) so the whole token is one hover
    // target even when it's also bold / italic.
    if (s.ref) inner = wrapRef(s.ref, inner);
    html += inner;
  }
  return html.replace(/\n/g, '<br>');
};

/**
 * Parse and render inline markdown to a safe HTML string. Used by the
 * browser narrator-window painter (innerHTML) and by lit-html's
 * `unsafeHTML` directive wrapper.
 */
export const markdownInlineHtml = (text: string): string =>
  renderSegmentsHtml(parseInlineMarkdown(text));
