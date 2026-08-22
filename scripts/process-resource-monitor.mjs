import { spawnSync } from 'node:child_process';

export function parseProcessTable(output) {
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]) }] : [];
  });
}

export function processTree(rows, rootPid) {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => selected.has(row.pid));
}

export function countOpenFiles(output) {
  return output.split('\n').filter(line => /^f\d/.test(line)).length;
}

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  return result.status === 0 ? parseProcessTable(result.stdout) : [];
}

function openFileCount(pids) {
  if (pids.length === 0) return null;
  const result = spawnSync('lsof', ['-n', '-P', '-a', '-p', pids.join(','), '-F', 'f'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? countOpenFiles(result.stdout) : null;
}

export function startProcessResourceMonitor(rootPid, {
  intervalMs = 1_000,
  settleMs = 250,
  readOpenFiles = openFileCount,
  readProcesses = processRows,
} = {}) {
  const seen = new Set();
  const metrics = {
    peakOpenFiles: null,
    peakProcesses: 0,
    peakRssKiB: 0,
    samples: 0,
  };

  const sample = () => {
    const tree = processTree(readProcesses(), rootPid);
    if (tree.length === 0) return;
    for (const row of tree) seen.add(row.pid);
    metrics.samples += 1;
    metrics.peakProcesses = Math.max(metrics.peakProcesses, tree.length);
    metrics.peakRssKiB = Math.max(
      metrics.peakRssKiB,
      tree.reduce((total, row) => total + row.rssKiB, 0),
    );
    const files = readOpenFiles(tree.map(row => row.pid));
    if (files !== null) metrics.peakOpenFiles = Math.max(metrics.peakOpenFiles ?? 0, files);
  };

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      sample();
      if (settleMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleMs);
      }
      const alive = new Set(readProcesses().map(row => row.pid));
      return {
        ...metrics,
        remainingPids: [...seen].filter(pid => pid !== rootPid && alive.has(pid)).sort((a, b) => a - b),
      };
    },
  };
}

export function formatResourceMetrics(metrics) {
  if (!metrics) return 'resources unavailable';
  const rssMiB = (metrics.peakRssKiB / 1024).toFixed(1);
  const files = metrics.peakOpenFiles === null ? 'n/a' : metrics.peakOpenFiles;
  return `peak RSS ${rssMiB} MiB, processes ${metrics.peakProcesses}, open files ${files}, remaining ${metrics.remainingPids.length}`;
}
