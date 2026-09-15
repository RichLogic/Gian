import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: 'codex',
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: 'bin/codex',
});
