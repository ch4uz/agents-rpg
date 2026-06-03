import type { MdSegment, SegRef } from '../../src/util/markdown.js';
import { parseInlineMarkdown, renderSegmentsHtml } from '../../src/util/markdown.js';
import { displayName } from './names.js';

/**
 * "Live references" in dialogue. Whenever the DM or a hero names a grid
 * coordinate (`(11,3)`) or a creature (`giant-rat-2`, "King Rat"), the text is
 * split so the matched run renders as a hoverable `.dlg-ref` chip; hovering it
 * highlights the matching cell / creature(s) on the Pixi board.
 *
 * The detection (`annotateRefs`) is a PURE pass over parsed markdown segments
 * (so it composes with **bold** / *italic* and is exhaustively unit-tested).
 * The browser wires it in through `parseWithRefs` / `markdownInlineRefsHtml`,
 * which read a module-level "active context" that `Layout.renderOnce` refreshes
 * from the store each frame — that keeps the dozens of existing `markdownInline`
 * call sites untouched (they automatically pick up refs when a context is set,
 * and fall back to plain markdown when it is null, so non-browser / test
 * renders are byte-for-byte unchanged).
 */

/** What a hovered chip points at — consumed by `Board.setHoverHighlight`. */
export type RefTarget =
  | { kind: 'cell'; x: number; y: number }
  | { kind: 'creature'; ids: string[] };

/** Roster + grid bounds needed to recognise references in a line of dialogue. */
export interface RefContext {
  creatures: ReadonlyArray<{ id: string; name: string; kind: string }>;
  gridW: number;
  gridH: number;
}

/** Minimal store-snapshot shape `buildRefContext` reads — kept structural so
 *  refs.ts doesn't depend on the concrete store/snapshot modules. */
interface SnapshotLike {
  characters: ReadonlyArray<{ id: unknown; name: string; kind: string }>;
  scene: { gridW: number; gridH: number } | null;
}

export const buildRefContext = (snap: SnapshotLike): RefContext => ({
  creatures: snap.characters.map((c) => ({
    id: String(c.id),
    name: c.name,
    kind: String(c.kind),
  })),
  gridW: snap.scene?.gridW ?? 0,
  gridH: snap.scene?.gridH ?? 0,
});

/** Map an engine `kind` to the chip's faction colour class. */
const factionClass = (kind: string): string =>
  kind === 'hero' ? 'hero' : kind === 'npc' ? 'npc' : 'monster';

interface CreatureNeedle {
  /** Lowercased search string. */
  lower: string;
  /** Space-joined character id(s) this needle resolves to. */
  value: string;
  /** Faction colour class (single kind) or 'monster' for a mixed group. */
  faction: string;
  /** Friendly name to DISPLAY for this reference (e.g. "Giant Rat"), shown in
   *  place of the matched text — so a raw slug ("giant-rat-1") reads as the
   *  creature's name while the id(s) still drive the board highlight. */
  display: string;
}

/**
 * Slug forms an LLM might use for a hyphenated id. Always the full id; plus,
 * when the id ends in a numeric instance segment, the shorter tails that KEEP
 * that number — so `giant-rat-2` also matches the common abbreviation `rat-2`.
 * Excluded on purpose: the bare number (`2`, too noisy) and any tail that
 * drops the number (e.g. `rat` for `giant-rat`, which would match the generic
 * word "rat"). Ids with no numeric instance (e.g. `king-rat`) yield only the
 * full id.
 */
const idVariants = (id: string): string[] => {
  const parts = id.split('-');
  const variants = new Set<string>([id]);
  const last = parts[parts.length - 1]!;
  if (parts.length > 2 && /^\d+$/.test(last)) {
    // Drop leading segments one at a time, keeping the trailing "<word>-<num>".
    for (let i = 1; i < parts.length - 1; i++) {
      variants.add(parts.slice(i).join('-'));
    }
  }
  return [...variants];
};

/**
 * Build the list of creature search strings from the roster. For every
 * character we accept its raw id (and instance abbreviations like `rat-2`),
 * its raw name, and the title-cased form of each (so `giant-rat-2`, `rat-2`,
 * "Giant Rat 2", and "Rat 2" all match, and both `king-rat` and "King Rat").
 * A string shared by several creatures (e.g. "Giant Rat" when three are on the
 * board) resolves to ALL their ids, so hovering it lights up the whole group.
 * Sorted longest-first so "Giant Rat 2" wins over "Giant Rat".
 *
 * Each needle also carries the creature's friendly DISPLAY name (the title-
 * cased `name`), which the chip renders instead of whatever matched — so an
 * agent writing the bare slug `giant-rat-1` or `rat-1` still shows up as
 * "Giant Rat".
 */
const buildCreatureNeedles = (ctx: RefContext): CreatureNeedle[] => {
  const byNeedle = new Map<string, { ids: Set<string>; kinds: Set<string>; display: string }>();
  const add = (raw: string, id: string, kind: string, display: string): void => {
    const trimmed = raw.trim();
    // Skip 1-char needles — far too noisy (would match stray letters).
    if (trimmed.length < 2) return;
    const lower = trimmed.toLowerCase();
    let e = byNeedle.get(lower);
    if (!e) { e = { ids: new Set(), kinds: new Set(), display }; byNeedle.set(lower, e); }
    e.ids.add(id);
    e.kinds.add(kind);
  };
  for (const c of ctx.creatures) {
    const id = String(c.id);
    // `name` is the creature TYPE for revealed-monster stubs ("giant-rat") and
    // the catalog name otherwise ("Giant Rat"); title-casing yields "Giant Rat"
    // either way — the label we want on the chip.
    const display = displayName(c.name);
    add(c.name, id, c.kind, display);
    add(display, id, c.kind, display);
    for (const v of idVariants(id)) {
      add(v, id, c.kind, display);              // slug: "giant-rat-2", "rat-2"
      add(displayName(v), id, c.kind, display); // spaced: "Giant Rat 2", "Rat 2"
    }
  }
  const out: CreatureNeedle[] = [];
  for (const [lower, e] of byNeedle) {
    const ids = [...e.ids].sort();
    const kinds = [...e.kinds];
    const faction = kinds.length === 1 ? factionClass(kinds[0]!) : 'monster';
    out.push({ lower, value: ids.join(' '), faction, display: e.display });
  }
  out.sort((a, b) => b.lower.length - a.lower.length);
  return out;
};

interface Match {
  start: number;
  end: number;
  ref: SegRef;
  /** Text to render in place of the matched substring — the creature display
   *  name for creature matches; undefined for coordinates (render verbatim). */
  displayText?: string;
}

const COORD_RE = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g;

const isAlnum = (c: string): boolean => /[a-z0-9]/i.test(c);

/**
 * Drop matches that overlap an already-accepted one. Earliest start wins; on a
 * tie the longer match wins (so a longer creature needle beats a shorter one
 * anchored at the same spot).
 */
const resolveOverlaps = (matches: Match[]): Match[] => {
  matches.sort(
    (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start),
  );
  const out: Match[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    out.push(m);
    lastEnd = m.end;
  }
  return out;
};

/** Find every coordinate + creature reference in a plain-text run. */
const findMatchesInText = (
  text: string,
  ctx: RefContext,
  needles: CreatureNeedle[],
): Match[] => {
  const matches: Match[] = [];

  // Grid coordinates `(x,y)` — only when they land on a real cell (when the
  // grid size is known; otherwise accept any non-negative pair).
  COORD_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = COORD_RE.exec(text)) !== null) {
    const x = Number(cm[1]);
    const y = Number(cm[2]);
    const inBounds = ctx.gridW > 0 && ctx.gridH > 0
      ? x >= 0 && x < ctx.gridW && y >= 0 && y < ctx.gridH
      : x >= 0 && y >= 0;
    if (!inBounds) continue;
    matches.push({
      start: cm.index,
      end: cm.index + cm[0].length,
      ref: { kind: 'cell', value: `${x},${y}`, x, y },
    });
  }

  // Creatures — case-insensitive, requiring a non-alphanumeric boundary on
  // both sides so "rat" inside "grateful" or "giant-rat-2" inside
  // "giant-rat-21" never matches.
  const lower = text.toLowerCase();
  for (const n of needles) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(n.lower, from);
      if (idx < 0) break;
      from = idx + n.lower.length;
      const before = idx > 0 ? lower[idx - 1]! : '';
      const after = from < lower.length ? lower[from]! : '';
      if (isAlnum(before) || isAlnum(after)) continue;
      matches.push({
        start: idx,
        end: idx + n.lower.length,
        ref: { kind: 'creature', value: n.value, faction: n.faction },
        displayText: n.display,
      });
    }
  }

  return resolveOverlaps(matches);
};

/**
 * Split each plain (non-code, not-already-a-ref) segment at every coordinate /
 * creature reference, tagging the matched runs with a `SegRef`. Style flags
 * (bold / italic / strike) are propagated to every produced sub-segment so a
 * reference inside **bold** stays bold. A null context is a no-op (returns the
 * segments unchanged) so callers can disable refs cheaply.
 */
export const annotateRefs = (
  segs: ReadonlyArray<MdSegment>,
  ctx: RefContext | null,
): MdSegment[] => {
  if (!ctx) return segs.slice();
  const needles = buildCreatureNeedles(ctx);
  const out: MdSegment[] = [];
  for (const s of segs) {
    if (s.code || s.ref || s.text.length === 0) { out.push(s); continue; }
    const matches = findMatchesInText(s.text, ctx, needles);
    if (matches.length === 0) { out.push(s); continue; }
    const styled = (text: string, ref?: SegRef): MdSegment => {
      const seg: MdSegment = { text };
      if (s.bold) seg.bold = true;
      if (s.italic) seg.italic = true;
      if (s.strike) seg.strike = true;
      if (ref) seg.ref = ref;
      return seg;
    };
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) out.push(styled(s.text.slice(cursor, m.start)));
      // Creature matches render the friendly display name (m.displayText) in
      // place of whatever was written (e.g. the slug "giant-rat-1"); the ref's
      // `value` still carries the id(s) for the board highlight. Coordinates
      // have no displayText, so they render verbatim.
      out.push(styled(m.displayText ?? s.text.slice(m.start, m.end), m.ref));
      cursor = m.end;
    }
    if (cursor < s.text.length) out.push(styled(s.text.slice(cursor)));
  }
  return out;
};

// --- Active context (set by Layout each render; read by the markdown helpers
//     and the typewriter so every existing `markdownInline` call site picks up
//     refs without a signature change) -------------------------------------

let activeCtx: RefContext | null = null;

export const setRefContext = (ctx: RefContext | null): void => { activeCtx = ctx; };
export const getRefContext = (): RefContext | null => activeCtx;

/** Parse inline markdown AND annotate refs. Defaults to the active context. */
export const parseWithRefs = (
  text: string,
  ctx: RefContext | null = activeCtx,
): MdSegment[] => annotateRefs(parseInlineMarkdown(text), ctx);

/** `markdownInlineHtml`, plus ref chips. Defaults to the active context. */
export const markdownInlineRefsHtml = (
  text: string,
  ctx: RefContext | null = activeCtx,
): string => renderSegmentsHtml(parseWithRefs(text, ctx));

/** Read the `data-ref-*` attributes off a hovered chip into a `RefTarget`.
 *  Returns null for an element that isn't a (well-formed) reference chip. */
export const refTargetFromElement = (el: HTMLElement): RefTarget | null => {
  const kind = el.dataset['refKind'];
  if (kind === 'cell') {
    const x = Number(el.dataset['refX']);
    const y = Number(el.dataset['refY']);
    if (Number.isFinite(x) && Number.isFinite(y)) return { kind: 'cell', x, y };
    return null;
  }
  if (kind === 'creature') {
    const ids = (el.dataset['refId'] ?? '').split(/\s+/).filter(Boolean);
    return ids.length > 0 ? { kind: 'creature', ids } : null;
  }
  return null;
};
