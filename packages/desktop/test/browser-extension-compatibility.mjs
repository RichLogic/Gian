import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { app, session } from 'electron';

if (process.env.GIAN_ALLOW_BROWSER_EXTENSION_COMPAT !== '1') {
  console.error('Set GIAN_ALLOW_BROWSER_EXTENSION_COMPAT=1 to load vendor extension code in a temporary Electron profile.');
  process.exit(2);
}

const paths = process.argv.slice(2).filter(path => path !== '--');
if (paths.length === 0) {
  console.error('Pass one or more unpacked extension directories.');
  process.exit(2);
}

const userData = mkdtempSync(join(tmpdir(), 'gian-extension-compat-'));
app.setPath('userData', userData);
const electronDeclaredPermissions = new Set([
  'activeTab',
  'scripting',
  'storage',
  'tabs',
  'unlimitedStorage',
  'webRequest',
]);

function manifestSummary(path) {
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  return {
    name: typeof manifest.name === 'string' ? manifest.name : basename(path),
    version: typeof manifest.version === 'string' ? manifest.version : '',
    manifestVersion: manifest.manifest_version,
    serviceWorker: manifest.background?.service_worker ?? null,
    declaredUnsupportedPermissions: (Array.isArray(manifest.permissions) ? manifest.permissions : [])
      .filter(permission => typeof permission === 'string' && !electronDeclaredPermissions.has(permission)),
  };
}

async function run() {
  const extensionSession = session.fromPartition('persist:gian-extension-compat', { cache: false });
  const results = [];
  for (const path of paths) {
    let summary = { path };
    try {
      summary = { path, ...manifestSummary(path) };
      const extension = await extensionSession.extensions.loadExtension(path, { allowFileAccess: false });
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const serviceWorkerScopes = Object.values(extensionSession.serviceWorkers.getAllRunning())
        .map(worker => worker.scope)
        .filter(scope => scope.startsWith(extension.url));
      results.push({
        ...summary,
        extensionId: extension.id,
        loaded: true,
        extensionReady: extensionSession.extensions.getExtension(extension.id) !== null,
        serviceWorkerRunning: serviceWorkerScopes.length > 0,
        serviceWorkerScopes,
        electronDeclaredCompatible: summary.declaredUnsupportedPermissions.length === 0
          && !summary.serviceWorker,
      });
      extensionSession.extensions.removeExtension(extension.id);
    } catch (error) {
      results.push({
        ...summary,
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log(JSON.stringify({ electron: process.versions.electron, results }, null, 2));
}

app.whenReady()
  .then(run)
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
app.once('will-quit', () => {
  rmSync(userData, { recursive: true, force: true });
});
