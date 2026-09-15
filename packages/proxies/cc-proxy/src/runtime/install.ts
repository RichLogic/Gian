import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: 'claude',
  kind: 'managed',
  format: 'raw',
  entryRelativePath: 'bin/claude',
});
