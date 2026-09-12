import { spawnSync } from 'node:child_process';
for (const name of ['shared', 'proxy-protocol', 'proxy-catalog-contract', 'remote-protocol', 'chat-ui', 'tool-cli', 'tool-mcp', null]) {
  const args = name ? ['-F', `@gian/${name}`, 'build'] : ['-r', 'typecheck'];
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
