import { html, type TemplateResult } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { markdownInlineRefsHtml } from './refs.js';

/**
 * Render inline markdown into a lit-html template. Use everywhere a dialog
 * line (player `say`, DM `narrate`, DM `say`, human-input echo) lands in
 * the DOM so authors can emphasise words with **bold** / *italic* / `code`
 * and have the styling come through on the page.
 *
 * Markdown is converted to a safe HTML string by `markdownInlineRefsHtml`
 * (which HTML-escapes raw text first), then re-injected via lit-html's
 * `unsafeHTML` directive — the same pattern lit-html recommends when you
 * need to render dynamic markup from a trusted, server-rendered string.
 *
 * `markdownInlineRefsHtml` also wraps any coordinate / creature mention in a
 * hoverable `.dlg-ref` chip when a ref context is active (set by Layout each
 * render). With no active context it falls back to plain markdown, so callers
 * outside the live UI (tests, CLI-adjacent renders) are unaffected.
 */
export const markdownInline = (text: string): TemplateResult =>
  html`${unsafeHTML(markdownInlineRefsHtml(text))}`;
