import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Sheet } from '../src/components/Sheet.js';
import type { SheetTab } from '../src/components/Sheet.js';

// Regression: the Sheet md preview used to run a hand-rolled parser that only
// knew headings / paragraphs / bullet lists / code fences, so GFM tables were
// flattened into a run-on paragraph (`| a | b | --- | ...`). It now renders via
// react-markdown + remark-gfm — real <table> markup.
const md = [
  '# Title',
  '',
  '| 来源 | 30 天 episode | 占比 |',
  '| --- | ---: | ---: |',
  '| QCE 云监控 | 977 | 48% |',
  '| RUM | 655 | 32% |',
  '',
  'Trailing paragraph.',
].join('\n');

function mdTab(): SheetTab {
  return {
    id: 't1', pane: 0, name: 'report.md', kind: 'file', icoKind: 'md', ico: 'MD',
    lines: md.split('\n').map((l, i) => [String(i + 1), l] as [string, string]),
    fullPath: '/tmp/demo/report.md', viewMode: 'preview',
  };
}

const actions = {
  activateTab: () => {}, closeTab: () => {}, pinTab: () => {}, setTabViewMode: () => {},
};

afterEach(() => cleanup());

describe('Sheet markdown preview', () => {
  it('renders GFM tables as real <table> markup, not flattened text', () => {
    const { container } = render(
      <Sheet tabs={[mdTab()]} active={{ 0: 't1', 1: null }} actions={actions} />,
    );
    expect(container.querySelector('.md-preview table')).toBeTruthy();
    expect(container.querySelectorAll('.md-preview thead th').length).toBe(3);
    expect(container.querySelectorAll('.md-preview tbody tr').length).toBe(2);

    const text = container.querySelector('.md-preview')!.textContent ?? '';
    expect(text).not.toContain('---'); // separator row is not leaked as text
    expect(text).not.toContain('| QCE'); // cells are not run together with pipes
    expect(text).toContain('QCE 云监控');
  });
});
