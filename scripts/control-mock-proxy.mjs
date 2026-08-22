import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function usage() {
  throw new Error(
    'Usage: node scripts/control-mock-proxy.mjs <mock-control.json> <JSON command>',
  );
}

const descriptorPath = process.argv[2];
const rawCommand = process.argv[3];
if (!descriptorPath || !rawCommand) usage();
const descriptor = JSON.parse(await readFile(resolve(descriptorPath), 'utf8'));
const command = JSON.parse(rawCommand);
const requestId = randomUUID();
await appendFile(descriptor.controlFile, `${JSON.stringify({ requestId, ...command })}\n`);
const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  const lines = (await readFile(descriptor.responseFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const response = lines.find(line => line.requestId === requestId);
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exit(response.ok ? 0 : 1);
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 25));
}
throw new Error('Timed out waiting for Mock Proxy response.');
