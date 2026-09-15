import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: 'kimi',
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: 'kimi',
});
