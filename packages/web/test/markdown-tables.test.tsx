// Regression: models constantly emit spec-invalid GFM tables that micromark
// silently degrades to raw pipe text — a header glued to a list item without
// a blank line, or a delimiter row whose cell count differs from the header.
// normalizeGfmTables repairs both before react-markdown sees the source, and
// the render-level tests prove a real <table> comes out.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LocaleProvider } from '../src/i18n/index.js';
import { normalizeGfmTables } from '../src/markdown-tables.js';
import { MarkdownText } from '../src/transcript/items.js';

describe('normalizeGfmTables', () => {
  it('leaves a valid table untouched', () => {
    const md = 'Intro.\n\n| a | b |\n| --- | ---: |\n| 1 | 2 |\n\nTrailing.';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('inserts a blank line between a list item and a column-0 table header', () => {
    const md = '- 对比：\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe('- 对比：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('handles ordered list items the same way', () => {
    const md = '1. 步骤：\n| a |\n| --- |\n| 1 |';
    expect(normalizeGfmTables(md)).toBe('1. 步骤：\n\n| a |\n| --- |\n| 1 |');
  });

  it('does not insert a blank line when one already exists', () => {
    const md = '- 对比：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('leaves a table indented under a list item alone (it parses as list content)', () => {
    const md = '- 对比：\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('pads a short delimiter row to the header cell count', () => {
    const md = '| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |';
    expect(normalizeGfmTables(md)).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
  });

  it('trims a long delimiter row to the header cell count', () => {
    const md = '| a | b |\n| --- | --- | --- |\n| 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('preserves alignment colons on surviving delimiter cells', () => {
    const md = '| a | b | c |\n| :--- | ---: |\n| 1 | 2 | 3 |';
    expect(normalizeGfmTables(md)).toBe('| a | b | c |\n| :--- | ---: | --- |\n| 1 | 2 | 3 |');
  });

  it('ignores escaped pipes when counting header cells', () => {
    // Header has 2 cells: "a | b" (escaped) and "c". Delimiter already matches.
    const md = '| a \\| b | c |\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('never touches fenced code blocks', () => {
    const md = '```md\n- x\n| a | b |\n| --- | --- |\n```\n~~~\n| a |\n| --- |\n~~~';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('does not treat a plain hr as a delimiter row', () => {
    const md = 'text | with pipe\n---\nnext';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('leaves pipe text without a delimiter row alone', () => {
    const md = 'a | b\njust text\n| 1 | 2 |';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('repairs both defects on the same table', () => {
    const md = '- 结果：\n| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |';
    expect(normalizeGfmTables(md)).toBe('- 结果：\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
  });
});

describe('MarkdownText table repair (render level)', () => {
  function renderMd(md: string) {
    return render(
      <LocaleProvider locale="en">
        <MarkdownText>{md}</MarkdownText>
      </LocaleProvider>,
    );
  }

  it('renders a table glued to a list item as real <table> markup', () => {
    const { container } = renderMd('- 对比：\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th').length).toBe(2);
  });

  it('renders a table with a mismatched delimiter row as real <table> markup', () => {
    const { container } = renderMd('| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th').length).toBe(3);
  });
});
