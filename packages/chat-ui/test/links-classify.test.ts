// links/classify.ts — the single scheme-sniffing authority. Every LinkKind,
// the unsafe bucket, and the edge cases that used to live in inline regexes.

import { describe, expect, it } from 'vitest';
import { classifyLink } from '../src/links/classify.js';

describe('classifyLink', () => {
  it('classifies http and https as web', () => {
    expect(classifyLink('https://example.com').kind).toBe('web');
    expect(classifyLink('http://example.com/path?q=1').kind).toBe('web');
  });

  it('classifies a render-time-resolved file as file regardless of href text', () => {
    const target = classifyLink('./README.md', { fileAbs: '/repo/README.md', fileLine: 12 });
    expect(target).toEqual({ kind: 'file', href: './README.md', fileAbs: '/repo/README.md', fileLine: 12 });
  });

  it('fileAbs wins even over a web-looking href', () => {
    expect(classifyLink('https://example.com', { fileAbs: '/repo/a.ts' }).kind).toBe('file');
  });

  it('classifies scheme-less hrefs as relative', () => {
    expect(classifyLink('./docs/plan.md').kind).toBe('relative');
    expect(classifyLink('docs/plan.md').kind).toBe('relative');
    expect(classifyLink('/abs/path/without-scheme').kind).toBe('relative');
  });

  it('classifies in-page anchors as fragment', () => {
    expect(classifyLink('#section-2').kind).toBe('fragment');
  });

  it('classifies known editor schemes as editor', () => {
    expect(classifyLink('vscode://file/repo/a.ts:3').kind).toBe('editor');
    expect(classifyLink('cursor://file/repo/a.ts').kind).toBe('editor');
    expect(classifyLink('zed://file/repo/a.ts').kind).toBe('editor');
  });

  it('classifies other parseable schemes as external-scheme', () => {
    expect(classifyLink('mailto:dev@example.com').kind).toBe('external-scheme');
    expect(classifyLink('tel:+15551234567').kind).toBe('external-scheme');
    expect(classifyLink('ftp://files.example.com/x').kind).toBe('external-scheme');
  });

  it('never linkifies javascript:, data:, vbscript: or file:', () => {
    expect(classifyLink('javascript:alert(1)').kind).toBe('unsafe');
    expect(classifyLink('JavaScript:alert(1)').kind).toBe('unsafe');
    expect(classifyLink('data:text/html,<script>1</script>').kind).toBe('unsafe');
    expect(classifyLink('vbscript:msgbox(1)').kind).toBe('unsafe');
    expect(classifyLink('file:///etc/passwd').kind).toBe('unsafe');
  });

  it('treats missing or empty hrefs as unsafe', () => {
    expect(classifyLink(undefined).kind).toBe('unsafe');
    expect(classifyLink(null).kind).toBe('unsafe');
    expect(classifyLink('').kind).toBe('unsafe');
    expect(classifyLink('   ').kind).toBe('unsafe');
  });

  it('trims surrounding whitespace before classification', () => {
    expect(classifyLink('  https://example.com  ').kind).toBe('web');
    expect(classifyLink('  javascript:alert(1) ').kind).toBe('unsafe');
  });
});
