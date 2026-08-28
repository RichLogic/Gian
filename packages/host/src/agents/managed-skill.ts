import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const OWNER_FILE = '.gian-managed.json';
const MAX_SKILL_BYTES = 512 * 1024;

export interface ManagedSkillSource {
  name: 'gian-session';
  version: string;
  path: string;
  sha256: string;
}

export interface ManagedSkillResult {
  name: 'gian-session';
  version: string;
  path: string;
  state: 'ready' | 'missing' | 'conflict' | 'invalid';
  changed: boolean;
  error?: string;
}

interface OwnerMarker {
  schemaVersion: 1;
  owner: 'gian';
  name: 'gian-session';
  version: string;
  sha256: string;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetFor(home: string): string {
  return join(home, '.agents', 'skills', 'gian-session');
}

function marker(value: unknown): OwnerMarker | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<OwnerMarker>;
  return record.schemaVersion === 1
    && record.owner === 'gian'
    && record.name === 'gian-session'
    && typeof record.version === 'string'
    && typeof record.sha256 === 'string'
    ? record as OwnerMarker
    : null;
}

async function readOwner(target: string): Promise<OwnerMarker | null> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return marker(JSON.parse(await readFile(join(target, OWNER_FILE), 'utf8')));
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceBytes(source: ManagedSkillSource): Promise<Buffer> {
  const info = await lstat(source.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_SKILL_BYTES) {
    throw new Error('managed Skill source must be a bounded regular file');
  }
  const bytes = await readFile(source.path);
  if (digest(bytes) !== source.sha256) throw new Error('managed Skill source digest mismatch');
  const text = bytes.toString('utf8');
  const frontmatterEnd = text.indexOf('\n---', 4);
  const frontmatter = frontmatterEnd > 0 ? text.slice(4, frontmatterEnd) : '';
  if (!/^name:\s*gian-session\s*$/m.test(frontmatter)
    || !/^description:\s*\S.*$/m.test(frontmatter)) {
    throw new Error('managed Skill source has invalid gian-session frontmatter');
  }
  return bytes;
}

export async function inspectManagedGianSkill(
  home: string,
  version: string,
): Promise<ManagedSkillResult> {
  const target = targetFor(home);
  if (!await exists(target)) {
    return { name: 'gian-session', version, path: target, state: 'missing', changed: false };
  }
  const owner = await readOwner(target);
  if (!owner) {
    return { name: 'gian-session', version, path: target, state: 'conflict', changed: false };
  }
  try {
    const bytes = await readFile(join(target, 'SKILL.md'));
    const valid = owner.version === version && owner.sha256 === digest(bytes);
    return {
      name: 'gian-session',
      version,
      path: target,
      state: valid ? 'ready' : 'invalid',
      changed: false,
    };
  } catch (error) {
    return {
      name: 'gian-session',
      version,
      path: target,
      state: 'invalid',
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Install or upgrade only a Gian-owned target. A user-owned collision is
 * reported and left byte-for-byte untouched. */
export async function reconcileManagedGianSkill(
  home: string,
  source: ManagedSkillSource,
): Promise<ManagedSkillResult> {
  const target = targetFor(home);
  let bytes: Buffer;
  try {
    bytes = await sourceBytes(source);
  } catch (error) {
    return {
      name: source.name,
      version: source.version,
      path: target,
      state: 'invalid',
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const targetExists = await exists(target);
  const owner = targetExists ? await readOwner(target) : null;
  if (targetExists && !owner) {
    return { name: source.name, version: source.version, path: target, state: 'conflict', changed: false };
  }
  if (owner?.version === source.version && owner.sha256 === source.sha256) {
    try {
      if (digest(await readFile(join(target, 'SKILL.md'))) === source.sha256) {
        return { name: source.name, version: source.version, path: target, state: 'ready', changed: false };
      }
    } catch {
      // Repair the owned target below.
    }
  }

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.staging-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  const ownerMarker: OwnerMarker = {
    schemaVersion: 1,
    owner: 'gian',
    name: source.name,
    version: source.version,
    sha256: source.sha256,
  };
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    await writeFile(join(staging, 'SKILL.md'), bytes, { mode: 0o600 });
    await writeFile(join(staging, OWNER_FILE), `${JSON.stringify(ownerMarker)}\n`, { mode: 0o600 });
    if (targetExists) await rename(target, backup);
    try {
      await rename(staging, target);
    } catch (error) {
      if (targetExists) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    if (targetExists) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { name: source.name, version: source.version, path: target, state: 'ready', changed: true };
}
