// G8: runtime fingerprint — hash the full glm execution closure (dir-level
// over-approximation) and record exact CLI version.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BIN, sha256File, note } from './lib.mjs';

const glmDir = path.dirname(BIN);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}(glmDir));

const h = crypto.createHash('sha256');
let totalBytes = 0;
const manifest = [];
for (const f of files) {
  const rel = path.relative(glmDir, f);
  const digest = sha256File(f);
  const size = fs.statSync(f).size;
  totalBytes += size;
  h.update(`${rel}\u0000${digest}\u0000`);
  manifest.push({ path: rel, sha256: digest, size });
}

const closureDigest = h.digest('hex');
const meta = {
  gate: 'G8',
  entry: BIN,
  entrySha256: sha256File(BIN),
  fileCount: files.length,
  totalBytes,
  closureDigest, // hash over sorted (relative path, file sha256) pairs
};
fs.writeFileSync(
  new URL('../../evidence/wp0/g8-runtime-fingerprint.json', import.meta.url),
  JSON.stringify({ ...meta, files: manifest }, null, 2),
);
note(`G8 closureDigest=${closureDigest}`);
note(`G8 entrySha256=${meta.entrySha256} files=${files.length} bytes=${totalBytes}`);
