import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webPkg = new URL('../../web/package.json', import.meta.url);
const requireFromWeb = createRequire(webPkg);
const viteHref = pathToFileURL(requireFromWeb.resolve('vite')).href;

test('Web production Vite build bundles shared Session bindings without node:path', async () => {
  const { build } = await import(viteHref);
  const outDir = mkdtempSync(join(tmpdir(), 'gian-web-shared-vite-'));
  try {
    await build({
      configFile: fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('../../web', import.meta.url)),
      logLevel: 'error',
      build: {
        outDir,
        emptyOutDir: true,
        sourcemap: false,
      },
    });
    const files = readdirSync(outDir, { recursive: true })
      .filter((name) => typeof name === 'string' && name.endsWith('.js'));
    assert.ok(files.length > 0, 'Vite production build emitted no JS');
    for (const file of files) {
      const source = readFileSync(join(outDir, file), 'utf8');
      assert.doesNotMatch(source, /__vite-browser-external/, file);
      assert.doesNotMatch(source, /from ["']node:path["']/, file);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
