import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '@gian/shared';
import { flatFiltered, slashFilterGrouped } from '../src/components/composer/capabilities.js';

function command(name: string, source: SlashCommand['source']): SlashCommand {
  return { name, source, description: name };
}

describe('slashFilterGrouped / flatFiltered', () => {
  const commands = [
    command('help', 'builtin'),
    command('hello', 'project'),
    command('history', 'user'),
    command('other', 'project'),
  ];

  it('groups in builtin/project/user order and keeps empty-prefix groups', () => {
    const groups = slashFilterGrouped(commands, '/');
    expect(groups.map(group => group.source)).toEqual(['builtin', 'project', 'user']);
    expect(flatFiltered(groups).map(entry => entry.name)).toEqual(['help', 'hello', 'other', 'history']);
  });

  it('filters by prefix case-insensitively and drops empty groups', () => {
    const groups = slashFilterGrouped(commands, 'HE');
    expect(groups.map(group => group.source)).toEqual(['builtin', 'project']);
    expect(flatFiltered(groups).map(entry => entry.name)).toEqual(['help', 'hello']);
  });
});
