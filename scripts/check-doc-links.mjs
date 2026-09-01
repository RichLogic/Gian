import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['README.md', 'CONTRIBUTING.md', 'ONBOARDING.md', 'docs', 'design'];
const markdownLink = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+['"][^'"]*['"])?\)/g;

async function exists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function collect(projectRoot, relativePath, required) {
  const absolutePath = path.join(projectRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    if (await exists(absolutePath)) return relativePath.endsWith('.md') ? [relativePath] : [];
    if (required) throw new Error(`required documentation root is missing: ${relativePath}`);
    return [];
  }

  const nested = await Promise.all(entries.map((entry) => {
    const child = path.join(relativePath, entry.name);
    return entry.isDirectory()
      ? collect(projectRoot, child, false)
      : Promise.resolve(child.endsWith('.md') ? [child] : []);
  }));
  return nested.flat();
}

export async function collectDocumentationFiles(projectRoot = root) {
  const privateSource = await exists(path.join(projectRoot, 'AGENTS.md'));
  return (await Promise.all(roots.map(relativePath => collect(
    projectRoot,
    relativePath,
    privateSource || relativePath === 'README.md' || relativePath === 'CONTRIBUTING.md',
  )))).flat();
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

export async function main(projectRoot = root) {
  const files = await collectDocumentationFiles(projectRoot);
  const failures = [];

  for (const file of files) {
    const source = (await readFile(path.join(projectRoot, file), 'utf8'))
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
      .replace(/`[^`\n]*`/g, '');
    for (const match of source.matchAll(markdownLink)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      const resolved = path.resolve(projectRoot, path.dirname(file), target);
      if (!resolved.startsWith(`${projectRoot}${path.sep}`) && resolved !== projectRoot) {
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
    throw new Error([
      `doc-links: ${failures.length} broken local link(s)`,
      ...failures.map(failure => `- ${failure}`),
    ].join('\n'));
  }
  console.log(`doc-links: checked ${files.length} Markdown file(s); all local links resolve`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
