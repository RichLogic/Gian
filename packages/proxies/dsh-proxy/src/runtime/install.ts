import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: 'deepseek-harness',
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
  legacyDirectories: version => [`deepseek-harness/runtimes/deepseek-harness/${version}`],
});
