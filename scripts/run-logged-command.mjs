import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export async function runLoggedCommand(command, args, {
  cwd,
  env,
  logPath,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  return await new Promise(resolve => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const forward = (chunk, destination) => {
      appendFileSync(logPath, chunk);
      destination.write(chunk);
    };
    child.stdout.on('data', chunk => forward(chunk, stdout));
    child.stderr.on('data', chunk => forward(chunk, stderr));

    child.once('error', error => {
      if (settled) return;
      settled = true;
      resolve({ error, status: null, signal: null });
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      resolve({ error: null, status, signal });
    });
  });
}
