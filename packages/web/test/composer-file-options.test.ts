import { describe, expect, it } from 'vitest';

import {
  FILE_OPTION_LIMIT,
  filterFileOptions,
} from '../src/components/composer/capabilities.js';

const ROOT = '/repo/app';
const FILES = [
  'src/components/Composer.tsx',
  'src/components/Composer.test.tsx',
  'src/api.ts',
  'docs/composer-guide.md',
  'package.json',
  'README.md',
];

describe('filterFileOptions', () => {
  it('matches case-insensitively on any path segment', () => {
    const options = filterFileOptions(FILES, 'COMPOSER', ROOT);
    // All three basenames start with the query; ties break by shorter path.
    expect(options.map(o => o.relPath)).toEqual([
      'docs/composer-guide.md',
      'src/components/Composer.tsx',
      'src/components/Composer.test.tsx',
    ]);
  });

  it('ranks exact basename above basename substring above path substring', () => {
    const options = filterFileOptions([
      'src/util/api-helpers.ts',
      'lib/api.ts',
      'src/api.ts.bak',
    ], 'api', ROOT);
    expect(options.map(o => o.relPath)).toEqual([
      'lib/api.ts',
      'src/api.ts.bak',
      'src/util/api-helpers.ts',
    ]);
  });

  it('breaks ties by shorter path, then alphabetically', () => {
    const options = filterFileOptions([
      'a/b/c/notes.md',
      'notes.md',
      'docs/notes.md',
    ], 'notes', ROOT);
    expect(options.map(o => o.relPath)).toEqual([
      'notes.md',
      'docs/notes.md',
      'a/b/c/notes.md',
    ]);
  });

  it('builds absolute paths against the tree root and keeps the basename', () => {
    const [option] = filterFileOptions(['src/api.ts'], 'api', '/repo/app/');
    expect(option).toEqual({
      path: '/repo/app/src/api.ts',
      relPath: 'src/api.ts',
      name: 'api.ts',
    });
  });

  it('caps the option count and returns everything (ranked) for an empty query', () => {
    const many = Array.from({ length: 40 }, (_, i) => `dir/file-${String(i).padStart(2, '0')}.ts`);
    expect(filterFileOptions(many, 'file', ROOT)).toHaveLength(FILE_OPTION_LIMIT);
    const all = filterFileOptions(['b.ts', 'a.ts'], '', ROOT);
    expect(all.map(o => o.relPath)).toEqual(['a.ts', 'b.ts']);
  });
});
