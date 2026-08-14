const BLOCKED_EXACT = new Set([
  '/fork',
  '/rewind',
  '/undo',
  '/plan',
  '/mcp',
  '/mcps',
  '/login',
  '/logout',
  '/feedback',
  '/share',
  '/relay',
  '/billing',
  '/cost',
  '/plugins',
  '/plugins install',
  '/plugins uninstall',
  '/plugins update',
]);

const BLOCKED_PREFIXES = [
  '/plugins install',
  '/plugins uninstall',
  '/plugins update',
];

export function normalizeSlashName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function canonicalCommand(text: string): string {
  return normalizeSlashName(text).replace(/\s+/g, ' ').toLowerCase();
}

export function isBlockedSlashCommand(name: string): boolean {
  const canonical = canonicalCommand(name);
  if (!canonical.startsWith('/')) return false;
  if (BLOCKED_EXACT.has(canonical)) return true;
  if (BLOCKED_PREFIXES.some(prefix => canonical === prefix || canonical.startsWith(`${prefix} `))) {
    return true;
  }
  const head = canonical.split(' ')[0] ?? '';
  if (head === '/plugins') {
    const rest = canonical.slice('/plugins'.length).trim();
    return rest !== 'list' && rest !== 'reload';
  }
  return BLOCKED_EXACT.has(head);
}

export function firstSlashToken(text: string): string | null {
  const match = /^\s*(\/[^\s]+(?:\s+[^\s]+)*)/.exec(text);
  if (!match) return null;
  const tokens = match[1]!.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() === '/plugins' && tokens[1]) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0] ?? null;
}

export function filterAdvertisedCommands<T extends { name: string }>(commands: T[]): T[] {
  return commands.filter(command => !isBlockedSlashCommand(command.name));
}
