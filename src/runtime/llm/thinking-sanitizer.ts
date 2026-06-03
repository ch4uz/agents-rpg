/**
 * The Anthropic API surfaces a *summary* of extended thinking (the raw chain is
 * used internally but not returned). The summarizer is a separate model, and it
 * occasionally bleeds meta-commentary about its own job into the summary text —
 * e.g. "I need to see the next thinking to rewrite it. Could you provide the
 * next thinking chunk that follows the current rewritten thinking…". We surface
 * `thinking` blocks verbatim as the agent's private `thought` channel, so that
 * leak ends up in the chat log / UI (observed live: run 2026-05-29T16-04-39,
 * t=87).
 *
 * We can't stop the summarizer from producing it, but we can strip it before it
 * becomes a `thought`. The leak is always a trailing artifact — normal thinking
 * first, then the meta-commentary appended — so we find the earliest leak marker
 * and truncate at the start of the sentence it sits in, keeping the genuine
 * reasoning that preceded it.
 */

/**
 * Phrases that only appear when the thinking *summarizer* talks about its own
 * task. Each is tied to the word "thinking" (chunk / rewrite / next) so an
 * in-character tactical thought ("I'm thinking about attacking the rat") won't
 * trip them. Kept deliberately narrow — over-matching only trims a thought, it
 * never breaks the game, but we still prefer precision.
 */
const LEAK_MARKERS: readonly RegExp[] = [
  /\bthinking chunk\b/i,
  /\brewritten thinking\b/i,
  /\bnext thinking\b/i,
  /\brewrite (?:the |this |my )?thinking\b/i,
];

/** Sentence/line boundary terminators we backtrack to when cutting a leak. */
const BOUNDARIES = ['. ', '.\n', '! ', '? ', '\n'];

/**
 * Strip thinking-summarizer meta-leaks from a single thinking block.
 *
 * Returns the genuine reasoning that preceded the first leak marker, trimmed.
 * If the block is entirely (or begins with) a leak, returns `''` — callers
 * should skip emitting an empty thought. A block with no markers is returned
 * trimmed but otherwise untouched.
 */
export const sanitizeThinking = (raw: string): string => {
  let cut = raw.length;
  for (const re of LEAK_MARKERS) {
    const m = re.exec(raw);
    if (m && m.index < cut) cut = m.index;
  }
  if (cut === raw.length) return raw.trim();

  // Backtrack from the marker to the end of the previous sentence so we drop
  // the whole leaking sentence, not just the phrase mid-sentence.
  const head = raw.slice(0, cut);
  let end = 0;
  for (const b of BOUNDARIES) {
    const idx = head.lastIndexOf(b);
    // +1 keeps the terminating '.', '!', '?' or newline with the kept text.
    if (idx >= 0 && idx + 1 > end) end = idx + 1;
  }
  return raw.slice(0, end).trim();
};
