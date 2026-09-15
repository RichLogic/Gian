import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function validatePorts(value) {
  if (!Number.isInteger(value?.host) || value.host < 8992 || value.host > 9991
    || value.web !== value.host - 3800) throw new Error('Invalid worktree port assignment');
  return value;
}

export function portAvailable(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function allocatePorts(runtimeDir, registryDir, available = portAvailable) {
  await mkdir(runtimeDir, { recursive: true });
  const assignment = join(runtimeDir, 'ports.json');
  try { return validatePorts(JSON.parse(await readFile(assignment, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(registryDir, { recursive: true });
  for (let host = 8992; host <= 9991; host++) {
    const claim = join(registryDir, String(host));
    try { await mkdir(claim); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    if (!await available(host) || !await available(host - 3800)) {
      await rm(claim, { recursive: true });
      continue;
    }
    const ports = { host, web: host - 3800 };
    await writeFile(join(claim, 'owner'), runtimeDir, { mode: 0o600 });
    await writeFile(assignment, JSON.stringify(ports) + '\n', { flag: 'wx', mode: 0o600 });
    return ports;
  }
  throw new Error('No free Gian source worktree ports');
}
