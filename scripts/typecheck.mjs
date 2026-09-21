import { spawnSync } from 'node:child_process';
import { withLocalVerification } from './local-verification.mjs';
withLocalVerification('typecheck', env => {
  for (const name of ['shared', 'proxy-protocol', 'proxy-catalog-contract', 'remote-protocol', 'chat-ui', 'tool-cli', 'tool-mcp', null]) {
    const args = name ? ['-F', `@gian/${name}`, 'build'] : ['-r', 'typecheck'];
    const result = spawnSync('pnpm', args, { stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
});
