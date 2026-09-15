import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: 'grok',
  kind: 'managed',
  format: 'raw',
  entryRelativePath: 'bin/grok',
});
