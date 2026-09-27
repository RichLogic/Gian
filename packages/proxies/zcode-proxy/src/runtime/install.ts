import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';
import type { RuntimeInstallPlanParams } from '@gian/proxy-protocol';
import source from './source.json' with { type: 'json' };

const planManagedInstallation = createRuntimeInstallPlanner({
  runtimeId: 'zcode',
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: source.entryRelativePath,
});

export function planRuntimeInstallation(input: RuntimeInstallPlanParams) {
  if (input.version !== source.cliVersion || input.platform !== source.platform) {
    throw new Error('ZCode Runtime does not match this Proxy\'s pinned source version/platform.');
  }
  return planManagedInstallation(input);
}
