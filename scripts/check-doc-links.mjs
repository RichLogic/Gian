import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['README.md', 'CONTRIBUTING.md', 'ONBOARDING.md', 'docs', 'design'];
const markdownLink = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+['"][^'"]*['"])?\)/g;

async function collect(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (!entries) return relativePath.endsWith('.md') ? [relativePath] : [];

  const nested = await Promise.all(entries.map((entry) => {
    const child = path.join(relativePath, entry.name);
    return entry.isDirectory() ? collect(child) : Promise.resolve(child.endsWith('.md') ? [child] : []);
  }));
  return nested.flat();
}

function localTarget(rawTarget) {
  const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(target)) return null;
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

const files = (await Promise.all(roots.map(collect))).flat();
const failures = [];

for (const file of files) {
  const source = (await readFile(path.join(root, file), 'utf8'))
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
  for (const match of source.matchAll(markdownLink)) {
    const target = localTarget(match[1]);
    if (!target) continue;
    const resolved = path.resolve(root, path.dirname(file), target);
    if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
      failures.push(`${file}: link escapes repository: ${match[1]}`);
      continue;
    }
    try {
      await access(resolved);
    } catch {
      failures.push(`${file}: missing ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`doc-links: ${failures.length} broken local link(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`doc-links: checked ${files.length} Markdown file(s); all local links resolve`);
}
