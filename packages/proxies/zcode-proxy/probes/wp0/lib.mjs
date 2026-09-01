// WP0 probe shared harness: ZCode Protocol v1 client with line framing,
// reverse-request answering, timeouts, and secret redaction.
// Self-contained (no repo deps) so evidence is reproducible standalone.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSyntheticZcodeConfig } from '../../test/fixtures/synthetic-zcode-config.mjs';

export const BIN = process.env.ZCODE_CJS
  ?? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

// Revision 2 §4.4 Gian runtime preferences profile.
export const GIAN_PREFS = {
  materialization: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
  },
  userExecution: {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1',
    integratedTerminalShell: { mode: 'auto' },
  },
};

const SECRET_KEY = /api[-_]?key|token|authorization|secret|cookie|password|credential/i;

export function redact(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const MAX_LINE = 16 * 1024 * 1024;

// Every reverse request MUST be answered (never hang the server). Unknown
// reverse methods get an explicit method-not-supported error response.
export const DEFAULT_REVERSE_HANDLERS = {
  'session/requestRuntimePreferences': (_params) => {
    const scope = _params?.scope === 'user-execution'
      ? GIAN_PREFS.userExecution
      : GIAN_PREFS.materialization;
    return { result: scope };
  },
  'interaction/requestOfficialMcpAuthHeaders': () => {
    return {
      error: {
        code: -32603,
        data: { reason: 'official_auth_unavailable' },
        message: 'Gian does not provide official MCP auth headers.',
      },
    };
  },
};

export class ProbeSession {
  constructor({ label, home, cwd, logPath, settingsPath, settingsPlacement = 'after' }) {
    this.label = label;
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.reverseRequests = [];
    this.t0 = Date.now();
    this.closed = false;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const args = [BIN];
    if (settingsPath) {
      if (settingsPlacement === 'before') args.push('--settings', settingsPath);
      args.push('app-server', '--cwd', cwd);
      if (settingsPlacement === 'after') args.push('--settings', settingsPath);
    } else {
      args.push('app-server', '--cwd', cwd);
    }

    const env = {
      HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
      TMPDIR: fs.mkdtempSync('/tmp/zcode-wp0-tmp-'),
      LANG: 'en_US.UTF-8',
    };

    this.child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.log('spawn', { pid: this.child.pid, args: args.map((a) => a.startsWith('/') && a !== BIN ? a : a) });

    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.handleLine(line);
      }
      if (buf.length > MAX_LINE) {
        this.log('fatal', { reason: 'line limit exceeded' });
        this.child.kill('SIGKILL');
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => this.log('stderr', { text: redact(c.slice(0, 4000)) }));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.log('exit', { code, signal });
      for (const [id, p] of this.pending) {
        p.reject(new Error(`app-server exited (${code}/${signal}) with request ${id} pending`));
      }
      this.pending.clear();
    });
  }

  log(kind, obj) {
    const rec = redact({ t: Date.now() - this.t0, kind, ...obj });
    this.logStream.write(JSON.stringify(rec) + '\n');
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let m;
    try {
      m = JSON.parse(trimmed);
    } catch {
      this.log('unparseable', { raw: trimmed.slice(0, 500) });
      return;
    }
    // Reverse request: {id, method, params} — id is a string like "server-N".
    if (m.method !== undefined && m.id !== undefined) {
      this.reverseRequests.push(m);
      this.log('server-request', m);
      const handler = DEFAULT_REVERSE_HANDLERS[m.method];
      const answer = handler
        ? handler(m.params)
        : { error: { code: -32601, message: `Method not supported by client: ${m.method}` } };
      this.respond(m.id, answer);
      return;
    }
    // Notification: {method, params}
    if (m.method !== undefined) {
      this.notifications.push({ t: Date.now() - this.t0, ...m });
      this.log('notif', { method: m.method, params: m.params });
      return;
    }
    // Response: {id, result|error}
    const p = this.pending.get(m.id);
    if (p) {
      this.pending.delete(m.id);
      this.log('result', { id: m.id, ...(m.error ? { error: m.error } : { result: m.result }) });
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? 'inner error'), { innerError: m.error }));
      else p.resolve(m.result);
    } else {
      this.log('late-response', { id: m.id });
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const envelope = { id, method, params };
      this.log('sent', envelope);
      this.child.stdin.write(JSON.stringify(envelope) + '\n');
    });
  }

  respond(id, answer) {
    const envelope = { id, ...(answer.error ? { error: answer.error } : { result: answer.result ?? {} }) };
    this.log('client-response', { id, hasError: !!answer.error });
    this.child.stdin.write(JSON.stringify(envelope) + '\n');
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
      this.child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function waitFor(pred, timeoutMs, everyMs = 100, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// Build a throwaway HOME with a FUNCTIONAL, ENTIRELY SYNTHETIC CLI config.
// Historical note: the ORIGINAL WP0 runs copied model/provider metadata from
// the machine's real ~/.zcode/cli/config.json (replacing the apiKey before
// writing). This helper no longer reads the real file at all.
//
// Schema caveat (discovered 2026-08-30 against the REAL 0.16.5 app-server):
// the first synthetic shape used a bare model id in `model.main`; the real
// config schema refines model references to `provider/model` form, so that
// config parsed to an empty model section and app-server surfaced
// `model_config_missing`. The shared generator
// (test/fixtures/synthetic-zcode-config.mjs) now emits a schema-exact
// config — `provider/model` reference, provider entry with kind
// openai-compatible, unreachable loopback baseURL — proven by the real
// app-server lifecycle regression test (session/create + session/read, no
// provider call).

export function makeIsolatedHome({ withConfig = true } = {}) {
  const home = fs.mkdtempSync('/tmp/zcode-wp0-home-');
  if (withConfig) {
    fs.mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.zcode/cli/config.json'),
      JSON.stringify(buildSyntheticZcodeConfig(), null, 2),
      { mode: 0o600 },
    );
  }
  const cwd = fs.mkdtempSync('/tmp/zcode-wp0-ws-');
  return { home, cwd };
}

export function note(msg) {
  console.log(`[wp0] ${msg}`);
}
