import { renameSync, writeFileSync } from 'node:fs';

// Fork children can keep an old fixture process alive while the parent restarts.
// Readers must see a whole snapshot, never writeFile's truncated target.
export function writeFixtureJson(path, value, io = { writeFileSync, renameSync }) {
  const temporary = `${path}.${process.pid}.tmp`;
  io.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  io.renameSync(temporary, path);
}
