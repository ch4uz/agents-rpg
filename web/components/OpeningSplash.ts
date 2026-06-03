import { html, nothing, type TemplateResult } from 'lit-html';
import { t, getLanguage } from '../i18n.js';

const ASSETS_BASE = '/assets';

/**
 * The splash text in the browser's CURRENT UI language. The snapshot carries
 * every declared variant (`opening.i18n`, keyed by language code) because it
 * is published before the hero-select screen where the language is picked;
 * selecting here — at render time — means the splash flips live when the
 * player toggles the language on the chooser. Falls back to English. In
 * practice the language is final before the splash's typewriter starts (the
 * reveal is suppressed while the chooser is up), so reveal lengths computed
 * from this text stay consistent with what renders.
 */
export const openingBefore = (
  opening: { before: string; i18n?: Record<string, { before: string }> },
): string =>
  opening.i18n?.[getLanguage()]?.before ?? opening.before;

/**
 * The splash cast in the browser's CURRENT UI language: each member's `name`
 * becomes its declared variant for that language (the `names` record), so
 * the bold+avatar highlighting matches the names the translated opening text
 * actually uses ("Heitor", not "Gareth"). Pure mapping — portraits unchanged.
 */
export const openingCast = (
  cast: ReadonlyArray<{ name: string; names?: Record<string, string>; portrait?: string }>,
): OpeningCastMember[] =>
  cast.map((c) => ({
    name: c.names?.[getLanguage()] ?? c.name,
    ...(c.portrait !== undefined ? { portrait: c.portrait } : {}),
  }));

/** A character the splash should highlight: bold everywhere it appears, plus an
 *  inline portrait at its first mention when `portrait` (an assets-relative
 *  sprite path, e.g. "heroes/hunter/south.png") is set. */
export interface OpeningCastMember {
  name: string;
  portrait?: string;
}

/** Escape a string for safe use inside a RegExp character/word pattern. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface OpeningBlock { kind: 'prose' | 'quote'; text: string; }

/**
 * Split `before` into ordered prose/quote blocks. Paragraphs split on blank
 * lines; within each, double-quoted runs (`"..."`) become their own QUOTE block
 * so the spoken line lands on its own indented row instead of inline. Double
 * quotes are used so apostrophes inside speech ("hasn't") don't confuse the
 * matcher.
 */
const toBlocks = (before: string): OpeningBlock[] => {
  const blocks: OpeningBlock[] = [];
  for (const para of before.split(/\n{2,}/)) {
    const p = para.trim();
    if (p.length === 0) continue;
    const qre = /"([^"]*)"/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = qre.exec(p)) !== null) {
      const pre = p.slice(last, m.index).trim();
      if (pre.length > 0) blocks.push({ kind: 'prose', text: pre });
      const quoted = m[1]!.trim();
      if (quoted.length > 0) blocks.push({ kind: 'quote', text: quoted });
      last = m.index + m[0].length;
    }
    const post = p.slice(last).trim();
    if (post.length > 0) blocks.push({ kind: 'prose', text: post });
  }
  return blocks;
};

/** Total revealable characters in `before` (sum of all block text). Lets the
 *  host size/stop the typewriter without re-parsing the structure itself. */
export const openingVisibleLength = (before: string): number =>
  toBlocks(before).reduce((n, b) => n + b.text.length, 0);

type Atom =
  | { kind: 'text'; text: string }
  | { kind: 'name'; text: string; member: OpeningCastMember | undefined };

/** Tokenize a block's text into plain runs and cast-name tokens. */
const tokenize = (text: string, cast: ReadonlyArray<OpeningCastMember>): Atom[] => {
  if (cast.length === 0) return [{ kind: 'text', text }];
  const names = [...cast].map((c) => c.name).sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${names.map(escapeRegExp).join('|')})\\b`, 'g');
  const atoms: Atom[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    if (m.index > last) atoms.push({ kind: 'text', text: text.slice(last, m.index) });
    atoms.push({ kind: 'name', text: matched, member: cast.find((c) => c.name === matched) });
    last = m.index + matched.length;
  }
  if (last < text.length) atoms.push({ kind: 'text', text: text.slice(last) });
  return atoms;
};

/** Wrap content that should occupy layout space but stay invisible (the
 *  not-yet-typed tail). Mirrors the narrator's `.typewriter-hidden` technique so
 *  the full final layout is reserved from frame 0 and revealed letters never
 *  shift position. */
const hidden = (content: unknown): TemplateResult =>
  html`<span class="typewriter-hidden" aria-hidden="true">${content}</span>`;

/**
 * Render one block's text with the first `visible` characters shown and the rest
 * laid out but hidden. Cast names render bold; the first global mention of a
 * cast member with a portrait gets an inline head-crop avatar (hidden until that
 * name starts revealing, so it too reserves its space up front).
 */
const renderReveal = (
  text: string,
  cast: ReadonlyArray<OpeningCastMember>,
  shown: Set<string>,
  visible: number,
): Array<TemplateResult | string> => {
  const out: Array<TemplateResult | string> = [];
  let pos = 0;
  for (const a of tokenize(text, cast)) {
    const len = a.text.length;
    const vHere = Math.max(0, Math.min(len, visible - pos));
    if (a.kind === 'text') {
      if (vHere >= len) out.push(a.text);
      else if (vHere <= 0) out.push(hidden(a.text));
      else out.push(a.text.slice(0, vHere), hidden(a.text.slice(vHere)));
    } else {
      const member = a.member;
      const wantsAvatar = !!member?.portrait && !shown.has(a.text);
      if (wantsAvatar) shown.add(a.text);
      const avatarVisible = vHere > 0;
      const head = a.text.slice(0, vHere);
      const tail = a.text.slice(vHere);
      out.push(html`<span class="opening-cast"
        >${wantsAvatar
          ? html`<span
              class=${avatarVisible ? 'opening-avatar' : 'opening-avatar typewriter-hidden'}
              style=${`background-image: url('${ASSETS_BASE}/${member!.portrait}')`}
              aria-hidden="true"
            ></span>`
          : nothing}<strong class="opening-name">${head}${tail.length > 0 ? hidden(tail) : nothing}</strong></span
      >`);
    }
    pos += len;
  }
  return out;
};

/**
 * Cinematic adventure-opening splash. Shown full-screen at game start, OVER the
 * "Summoning the Tale" loader and the (still-hidden) board, while the server
 * holds the DM's first turn on the opening gate.
 *
 * `revealChars` types the body out character-by-character (the host ticks it),
 * using the dialogue system's stable-layout technique: the full text is always
 * laid out and the not-yet-typed tail is `visibility: hidden`, so revealed
 * letters never move.
 *
 * A single dialogue-style Skip button (the same `.dialog-skip` glyph the
 * narrator uses, plus a localized "Continue" text label — i18n
 * `opening.continue`) sits below the text and behaves exactly like the
 * narration Skip: while the body is still typing it fast-forwards the reveal
 * (`onFastForward`, finish-this-line); once complete it dismisses the splash
 * and releases the opening gate (`onBegin`, relaying the opening_ack — i.e.
 * advance-to-next). Clicking anywhere on the still-typing splash also
 * fast-forwards.
 *
 * `pending` is set by the host once "Begin" has been clicked but the DM's first
 * narration line hasn't landed yet. In that state the splash holds the screen
 * (so the boot "Summoning the Tale" loader can't flash back in), shows the body
 * fully revealed, and swaps the Skip/Begin button for a quiet "summoning"
 * indicator — clicks are inert, since the gate has already been released.
 */
export const openingSplash = (
  before: string,
  cast: ReadonlyArray<OpeningCastMember>,
  revealChars: number,
  onBegin: () => void,
  onFastForward: () => void,
  pending = false,
): TemplateResult => {
  const blocks = toBlocks(before);
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  // While pending, the body is always fully shown (Begin was only clickable
  // once the reveal completed). Forcing it here keeps the text stable even if a
  // re-render arrives with a stale `revealChars`.
  const effectiveReveal = pending ? total : revealChars;
  const done = effectiveReveal >= total;
  const shown = new Set<string>();
  let offset = 0;
  const body = blocks.map((b) => {
    const visible = Math.max(0, Math.min(b.text.length, effectiveReveal - offset));
    offset += b.text.length;
    const inner = renderReveal(b.text, cast, shown, visible);
    if (b.kind !== 'quote') return html`<p class="opening-body">${inner}</p>`;
    const started = visible > 0;
    const quoteDone = visible >= b.text.length;
    return html`<blockquote class="opening-quote"
      >${started ? '“' : hidden('“')}${inner}${quoteDone ? '”' : hidden('”')}</blockquote>`;
  });

  // The same pixel-art "skip" glyph the dialogue system uses (Layout's
  // `skipIconSvg`): a stepped right-pointing triangle + advance-one bar.
  const skipIconSvg = html`
    <svg viewBox="0 0 14 14" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
      <path d="M3 2 h1 v1 h1 v1 h1 v1 h1 v1 h1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 v1 h-1 Z"/>
      <rect x="9" y="2" width="2" height="9"/>
    </svg>
  `;

  const cls = ['opening-splash'];
  if (!done) cls.push('opening-splash--typing');
  if (pending) cls.push('opening-splash--pending');

  return html`
    <div
      class=${cls.join(' ')}
      role="dialog"
      aria-modal="true"
      aria-label=${t('opening.aria')}
      @click=${(e: Event) => { if (!done && !pending) { e.stopPropagation(); onFastForward(); } }}
    >
      <div class="opening-card">
        ${body}
        ${pending
          ? html`<p class="opening-pending" role="status" aria-live="polite">
              ${t('opening.pending')}<span class="opening-pending-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
            </p>`
          : html`<button
              class="dialog-skip opening-skip"
              type="button"
              ?autofocus=${done}
              aria-label=${done
                ? t('opening.beginAria')
                : t('opening.skipAria')}
              @click=${(e: Event) => { e.stopPropagation(); if (done) onBegin(); else onFastForward(); }}
            ><span class="opening-skip-label">${t('opening.continue')}</span>${skipIconSvg}</button>`}
      </div>
    </div>
  `;
};
