#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGianToolMcpServer } from './server.js';

function dataDir(args: string[]): string {
  const index = args.indexOf('--data-dir');
  if (index === -1) return resolve(process.env.GIAN_DATA_DIR ?? join(homedir(), '.gian'));
  const value = args[index + 1];
  if (!value) throw new Error('--data-dir requires a value');
  args.splice(index, 2);
  return resolve(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = dataDir(args);
  if (args.length > 0) throw new Error(`unknown argument: ${args[0]}`);
  await runGianToolMcpServer(root);
}

main().catch(error => {
  process.stderr.write(`[gian-tool-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
