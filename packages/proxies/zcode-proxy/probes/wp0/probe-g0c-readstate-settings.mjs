// G0c: workspace/readState with a sanitized --settings config — does it return
// the full model catalog (the side-effect-free Catalog source) without any
// session/create? Reuses the G1 settings derivation (apiKey stripped).
import fs from 'node:fs';
import path from 'node:path';
import { ProbeSession, note } from './lib.mjs';

const realConfigPath = path.join(process.env.HOME, '.zcode/cli/config.json');
const real = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
for (const provider of Object.values(real.provider ?? {})) {
  if (provider?.options?.apiKey !== undefined) delete provider.options.apiKey;
}
const settingsPath = path.join(fs.mkdtempSync('/tmp/zcode-wp0-g0c-'), 'zcode-config.json');
fs.writeFileSync(settingsPath, JSON.stringify(real, null, 2), { mode: 0o600 });

const home = fs.mkdtempSync('/tmp/zcode-wp0-g0c-home-');
const cwd = fs.mkdtempSync('/tmp/zcode-wp0-g0c-ws-');
const logPath = new URL('../../evidence/wp0/raw/g0c-readstate-settings.ndjson', import.meta.url).pathname;

const probe = new ProbeSession({ label: 'g0c', home, cwd, logPath, settingsPath, settingsPlacement: 'before' });
const results = {};

const before = await probe.request('session/list', {}, 20_000);
results.sessionCountBefore = before?.sessions?.length ?? 0;

const state = await probe.request('workspace/readState', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 30_000);
results.topKeys = Object.keys(state ?? {});
results.modelCatalog = state?.modelCatalog;
results.model = {
  current: state?.settings?.model?.current,
  availableCount: state?.settings?.model?.available?.length,
  firstAvailable: state?.settings?.model?.available?.[0],
};
results.mode = state?.settings?.mode;
results.permission = state?.settings?.permission;
results.thoughtLevel = state?.settings?.thoughtLevel;
results.slashCommands = state?.slashCommands;

const after = await probe.request('session/list', {}, 20_000);
results.sessionCountAfter = after?.sessions?.length ?? 0;
results.sideEffectFree = results.sessionCountBefore === results.sessionCountAfter;

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g0c-readstate-settings.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G0', sub: 'workspace/readState with --settings', results }, null, 2),
);
note(`G0c done; sideEffectFree=${results.sideEffectFree} models=${results.model?.availableCount}`);
