import { describe, it, expect } from 'vitest';
import { parseInlineMarkdown, markdownInlineHtml } from '../../src/util/markdown.js';

describe('parseInlineMarkdown', () => {
  it('returns a single plain segment for plain text', () => {
    expect(parseInlineMarkdown('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('parses **bold**', () => {
    expect(parseInlineMarkdown('hi **there** friend')).toEqual([
      { text: 'hi ' },
      { text: 'there', bold: true },
      { text: ' friend' },
    ]);
  });

  it('parses *italic*', () => {
    expect(parseInlineMarkdown('a *b* c')).toEqual([
      { text: 'a ' },
      { text: 'b', italic: true },
      { text: ' c' },
    ]);
  });

  it('parses `code` as opaque (no markdown inside)', () => {
    expect(parseInlineMarkdown('use `**foo**` here')).toEqual([
      { text: 'use ' },
      { text: '**foo**', code: true },
      { text: ' here' },
    ]);
  });

  it('parses ~~strikethrough~~', () => {
    expect(parseInlineMarkdown('was ~~gone~~ back')).toEqual([
      { text: 'was ' },
      { text: 'gone', strike: true },
      { text: ' back' },
    ]);
  });

  it('supports bold inside italic (nesting via flag toggling)', () => {
    expect(parseInlineMarkdown('*so **very** cool*')).toEqual([
      { text: 'so ', italic: true },
      { text: 'very', bold: true, italic: true },
      { text: ' cool', italic: true },
    ]);
  });

  it('leaves a stray asterisk without a closer as literal text', () => {
    expect(parseInlineMarkdown('5 * 3 = 15')).toEqual([
      { text: '5 * 3 = 15' },
    ]);
  });

  it('keeps snake_case_underscores literal (not italic)', () => {
    expect(parseInlineMarkdown('use snake_case_var here')).toEqual([
      { text: 'use snake_case_var here' },
    ]);
  });

  it('preserves newlines in segment text', () => {
    expect(parseInlineMarkdown('a\nb')).toEqual([{ text: 'a\nb' }]);
  });
});

describe('markdownInlineHtml', () => {
  it('escapes HTML in raw text', () => {
    expect(markdownInlineHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('wraps bold in <strong>', () => {
    expect(markdownInlineHtml('**hi**')).toBe('<strong>hi</strong>');
  });

  it('wraps italic in <em>', () => {
    expect(markdownInlineHtml('*hi*')).toBe('<em>hi</em>');
  });

  it('wraps code in <code> and escapes its content', () => {
    expect(markdownInlineHtml('`<b>`')).toBe('<code>&lt;b&gt;</code>');
  });

  it('wraps strikethrough in <del>', () => {
    expect(markdownInlineHtml('~~bye~~')).toBe('<del>bye</del>');
  });

  it('converts newlines to <br>', () => {
    expect(markdownInlineHtml('a\nb')).toBe('a<br>b');
  });

  it('nests bold inside italic', () => {
    expect(markdownInlineHtml('*so **very** cool*')).toBe(
      '<em>so </em><strong><em>very</em></strong><em> cool</em>',
    );
  });
});
