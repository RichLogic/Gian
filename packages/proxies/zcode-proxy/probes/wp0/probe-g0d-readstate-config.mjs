// G0d: workspace/readState with a REAL config file present in an isolated
// HOME (config written by the harness with a placeholder key) — verifies the
// side-effect-free Catalog source returns the full model vocabulary.
import fs from 'node:fs';
import { ProbeSession, note, makeIsolatedHome } from './lib.mjs';

const { home, cwd } = makeIsolatedHome({ withConfig: true });
const logPath = new URL('../../evidence/wp0/raw/g0d-readstate-config.ndjson', import.meta.url).pathname;
const probe = new ProbeSession({ label: 'g0d', home, cwd, logPath });
const results = {};

const before = await probe.request('session/list', {}, 20_000);
results.sessionCountBefore = before?.sessions?.length ?? 0;

const state = await probe.request('workspace/readState', {
  workspace: { workspacePath: cwd, workspaceKey: cwd },
}, 30_000);
results.topKeys = Object.keys(state ?? {});
results.model = {
  current: state?.settings?.model?.current,
  availableCount: state?.settings?.model?.available?.length,
  available: state?.settings?.model?.available,
};
results.mode = state?.settings?.mode;
results.permission = state?.settings?.permission;
results.thoughtLevel = state?.settings?.thoughtLevel;
results.slashCommands = state?.slashCommands;
results.modelCatalog = state?.modelCatalog;

const after = await probe.request('session/list', {}, 20_000);
results.sessionCountAfter = after?.sessions?.length ?? 0;
results.sideEffectFree = results.sessionCountBefore === results.sessionCountAfter;

await probe.close();
fs.writeFileSync(
  new URL('../../evidence/wp0/g0d-readstate-config.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G0', sub: 'workspace/readState with config', results }, null, 2),
);
note(`G0d done; sideEffectFree=${results.sideEffectFree} models=${results.model?.availableCount}`);
