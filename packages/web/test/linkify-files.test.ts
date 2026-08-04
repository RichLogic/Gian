import { describe, it, expect } from 'vitest';
import { findFileRefs, buildFileRefIndex } from '../src/transcript/linkify-files.js';

describe('findFileRefs', () => {
  it('captures a path with a :line suffix', () => {
    const refs = findFileRefs('edit src/App.tsx:42 now');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: 'src/App.tsx', line: 42 });
    expect('edit src/App.tsx:42 now'.slice(refs[0]!.start, refs[0]!.end)).toBe('src/App.tsx:42');
  });

  it('captures a bare basename with a "(line N)" suffix', () => {
    const refs = findFileRefs('see App.tsx (line 7) for the fix');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: 'App.tsx', line: 7 });
    expect('see App.tsx (line 7) for the fix'.slice(refs[0]!.start, refs[0]!.end)).toBe('App.tsx (line 7)');
  });

  it('captures a plain path with no line', () => {
    const refs = findFileRefs('look at README.md.');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: 'README.md' });
    expect(refs[0]!.line).toBeUndefined();
  });

  it('does NOT match version strings or decimals (extension must start with a letter)', () => {
    expect(findFileRefs('pnpm v10.1.0 and pi is 3.14')).toHaveLength(0);
  });

  it('finds multiple refs in one string', () => {
    const refs = findFileRefs('App.tsx calls helpers.ts:9');
    expect(refs.map(r => r.path)).toEqual(['App.tsx', 'helpers.ts']);
    expect(refs[1]!.line).toBe(9);
  });

  it('captures an absolute path with a :line suffix', () => {
    const refs = findFileRefs('open /Users/r/Coding/Gian-Dev/packages/web/src/App.tsx:490 please');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: '/Users/r/Coding/Gian-Dev/packages/web/src/App.tsx', line: 490 });
  });
});

describe('buildFileRefIndex', () => {
  const index = buildFileRefIndex([
    'packages/web/src/App.tsx',
    'packages/host/src/web/app.ts',
    'README.md',
    'docs/a/notes.md',
    'docs/b/notes.md',
  ]);

  it('resolves an exact relative path', () => {
    expect(index.resolve('packages/web/src/App.tsx')).toBe('packages/web/src/App.tsx');
  });

  it('resolves a unique bare basename to its full path', () => {
    expect(index.resolve('App.tsx')).toBe('packages/web/src/App.tsx');
    expect(index.resolve('README.md')).toBe('README.md');
  });

  it('resolves a unique partial path by suffix', () => {
    expect(index.resolve('src/App.tsx')).toBe('packages/web/src/App.tsx');
    expect(index.resolve('web/app.ts')).toBe('packages/host/src/web/app.ts');
  });

  it('returns null for an ambiguous bare basename', () => {
    expect(index.resolve('notes.md')).toBeNull();
  });

  it('resolves an ambiguous basename when a disambiguating partial path is given', () => {
    expect(index.resolve('a/notes.md')).toBe('docs/a/notes.md');
    expect(index.resolve('b/notes.md')).toBe('docs/b/notes.md');
  });

  it('returns null for an unknown file', () => {
    expect(index.resolve('nope.ts')).toBeNull();
    expect(index.resolve('src/Missing.tsx')).toBeNull();
  });

  it('resolves an absolute path under the working-tree root (when root is given)', () => {
    const rooted = buildFileRefIndex(['packages/web/src/App.tsx'], '/Users/r/Coding/Gian-Dev');
    expect(rooted.resolve('/Users/r/Coding/Gian-Dev/packages/web/src/App.tsx')).toBe('packages/web/src/App.tsx');
    // Tolerates a trailing slash on the root.
    const rooted2 = buildFileRefIndex(['packages/web/src/App.tsx'], '/Users/r/Coding/Gian-Dev/');
    expect(rooted2.resolve('/Users/r/Coding/Gian-Dev/packages/web/src/App.tsx')).toBe('packages/web/src/App.tsx');
  });

  it('returns null for an absolute path outside the root, or when no root is set', () => {
    const rooted = buildFileRefIndex(['packages/web/src/App.tsx'], '/Users/r/Coding/Gian-Dev');
    expect(rooted.resolve('/somewhere/else/App.tsx')).toBeNull();
    // No root → absolute tokens are unresolvable.
    expect(index.resolve('/Users/r/Coding/Gian-Dev/packages/web/src/App.tsx')).toBeNull();
  });
});
