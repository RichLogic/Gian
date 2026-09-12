import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const CONTROL_PLANE_DIRS = [
  "packages/host/src/catalog",
  "packages/host/src/plugin-store",
  "packages/host/src/proxy",
  "packages/host/src/runtime",
  "packages/host/src/session",
  "packages/host/src/web",
  "packages/web/src",
];

const FORBIDDEN = [
  /\bEXECUTOR_IDS\b/,
  /\bPRODUCT_EXECUTOR_IDS\b/,
  /\bisExecutorId\b/,
  /\bisProductExecutor\b/,
  /\bPRODUCT_EXECUTORS\b/,
  /legacy-plugin-aliases/,
  /executor\s*===\s*['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
  /case ['"](?:claude|codex|kimi|grok|dsh|zcode)['"]/,
];

/** Exact normalized occurrences. Additive growth and same-count substitutions fail. */
const BASELINE = {
  "packages/host/src/session/auto-title.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 2,
      "snippets": [
        "executor === 'claude'",
        "executor === 'codex'"
      ]
    }
  },
  "packages/host/src/session/input-items.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/host/src/session/compatibility-executor.ts": {
    "\\bisExecutorId\\b": {
      "count": 2,
      "snippets": [
        "isExecutorId",
        "isExecutorId"
      ]
    }
  },
  "packages/host/src/session/lifecycle-service.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 5,
      "snippets": [
        "executor === 'grok'",
        "executor === 'claude'",
        "executor === 'codex'",
        "executor === 'claude'",
        "executor === 'codex'"
      ]
    }
  },
  "packages/host/src/session/manager.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 3,
      "snippets": [
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'claude'"
      ]
    }
  },
  "packages/host/src/session/native-session-service.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 3,
      "snippets": [
        "executor === 'codex'",
        "executor === 'kimi'",
        "executor === 'grok'"
      ]
    }
  },
  "packages/host/src/session/proxy-session-coordinator.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/host/src/session/token-usage.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 2,
      "snippets": [
        "executor === 'codex'",
        "executor === 'claude'"
      ]
    }
  },
  "packages/host/src/web/routes/agents.ts": {
    "\\bisProductExecutor\\b": {
      "count": 6,
      "snippets": [
        "isProductExecutor",
        "isProductExecutor",
        "isProductExecutor",
        "isProductExecutor",
        "isProductExecutor",
        "isProductExecutor"
      ]
    }
  },
  "packages/host/src/web/routes/native-sessions.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 12,
      "snippets": [
        "executor === 'kimi'",
        "executor === 'grok'",
        "executor === 'zcode'",
        "executor === 'kimi'",
        "executor === 'kimi'",
        "executor === 'zcode'",
        "executor === 'grok'",
        "executor === 'claude'",
        "executor === 'codex'",
        "executor === 'kimi'",
        "executor === 'claude'",
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/components/Composer.tsx": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 6,
      "snippets": [
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'claude'",
        "executor === 'codex'",
        "executor === 'claude'"
      ]
    }
  },
  "packages/web/src/components/composer/capabilities.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 8,
      "snippets": [
        "executor === 'codex'",
        "executor === 'claude'",
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'claude'",
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/controllers/use-app-shortcuts.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/operations/session.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/operations/task.ts": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/views/SessionMain.tsx": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 1,
      "snippets": [
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/views/new-session-view.tsx": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 4,
      "snippets": [
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'codex'",
        "executor === 'codex'"
      ]
    }
  },
  "packages/web/src/views/spaces-native-sessions.tsx": {
    "executor\\s*===\\s*['\"](?:claude|codex|kimi|grok|dsh|zcode)['\"]": {
      "count": 2,
      "snippets": [
        "executor === 'claude'",
        "executor === 'codex'"
      ]
    }
  }
};

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

function collectSnippets(source, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...source.matchAll(global)].map((match) => match[0]);
}

function collectHits(source) {
  const hits = {};
  for (const pattern of FORBIDDEN) {
    const snippets = collectSnippets(source, pattern);
    if (snippets.length > 0) hits[pattern.source] = { count: snippets.length, snippets };
  }
  return hits;
}

const GENERIC_SUPERVISOR_FILES = [
  "packages/host/src/proxy/supervisor.ts",
  "packages/host/src/proxy/launch-binding.ts",
  "packages/host/src/proxy/manager.ts",
  "packages/host/src/proxy/protocol-v2-session-client.ts",
  "packages/host/src/proxy/protocol-v2-client.ts",
];

const GENERIC_FORBIDDEN = [
  /\bproductExecutorForPluginId\b/,
  /\bas Executor\b/,
  /pluginId\s+as\s+Executor/,
];

test("shared production sources stay browser-packable and do not import node builtins", () => {
  const leaks = [];
  for (const file of walk(join(repoRoot, "packages/shared/src"))) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, "utf8");
    if (/from\s+['"]node:/.test(source) || /require\(\s*['"]node:/.test(source)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [], `Shared production sources imported a node builtin:\n${leaks.join("\n")}`);
});

test("generic supervisor path cannot map open pluginIds through the closed Executor registry", () => {
  const leaks = [];
  for (const rel of GENERIC_SUPERVISOR_FILES) {
    const source = readFileSync(join(repoRoot, rel), "utf8");
    for (const pattern of GENERIC_FORBIDDEN) {
      const snippets = collectSnippets(source, pattern);
      if (snippets.length > 0) leaks.push(`${rel} ${pattern} ${JSON.stringify(snippets)}`);
    }
  }
  assert.deepEqual(leaks, [], `Generic supervisor leaked a closed Executor mapping:\n${leaks.join("\n")}`);
});

test("live Host boot and release discovery have no named Provider registry", () => {
  const removed = [
    "packages/shared/src/executors.ts",
    "packages/host/src/proxy/boot-descriptors.ts",
    "packages/host/src/runtime/manager.ts",
    "packages/host/src/runtime/command-provider.ts",
    "packages/host/src/runtime/kimi-provider.ts",
    "packages/host/src/runtime/dsh-provider.ts",
    "packages/host/src/runtime/zcode-provider.ts",
  ];
  assert.deepEqual(
    removed.filter(path => existsSync(join(repoRoot, path))),
    [],
    "removed registry/Provider modules returned to production",
  );
  const live = [
    "packages/host/src/index.ts",
    "packages/host/src/web/app.ts",
    "packages/host/src/proxy/manager.ts",
    "scripts/dev-runtime.mjs",
    "scripts/build-proxy-artifacts.mjs",
  ].map(path => [path, readFileSync(join(repoRoot, path), "utf8")]);
  const namedEntry = /GIAN_(?:CC|CODEX|KIMI|GROK|DSH|ZCODE)_PROXY_ENTRY/u;
  const namedBootField = /\b(?:cc|codex|kimi|grok|dsh|zcode)Proxy(?:Entry)?\b/u;
  const leaks = [];
  for (const [path, source] of live) {
    if (namedEntry.test(source)) leaks.push(`${path}: named Proxy env`);
    if (namedBootField.test(source)) leaks.push(`${path}: named boot field`);
  }
  assert.deepEqual(leaks, []);
});

test("Catalog/Plugin/Runtime/Session/Web control paths do not grow Provider-id branching", () => {
  const growth = [];
  const stale = [];
  const seen = new Set();
  for (const relativeDir of CONTROL_PLANE_DIRS) {
    const dir = join(repoRoot, relativeDir);
    assert.equal(existsSync(dir), true, `control-plane directory missing: ${relativeDir}`);
    for (const file of walk(dir)) {
      const rel = relative(repoRoot, file);
      seen.add(rel);
      const hits = collectHits(readFileSync(file, "utf8"));
      const baseline = BASELINE[rel] ?? {};
      for (const [pattern, hit] of Object.entries(hits)) {
        const allowed = baseline[pattern];
        if (!allowed || hit.count > allowed.count || JSON.stringify(hit.snippets) !== JSON.stringify(allowed.snippets)) {
          growth.push(`${rel} ${pattern} ${JSON.stringify(allowed ?? { count: 0, snippets: [] })} -> ${JSON.stringify(hit)}`);
        }
      }
      for (const [pattern, allowed] of Object.entries(baseline)) {
        const hit = hits[pattern] ?? { count: 0, snippets: [] };
        if (hit.count < allowed.count) {
          stale.push(`${rel} ${pattern} ${allowed.count} -> ${hit.count}`);
        }
      }
    }
  }
  for (const rel of Object.keys(BASELINE)) {
    if (!seen.has(rel)) stale.push(`${rel} missing from scan`);
  }
  assert.deepEqual(growth, [], `New Provider-id branching leaked into control-plane files:\n${growth.join("\n")}`);
  assert.deepEqual(stale, [], `Baseline occurrence counts are stale and must shrink:\n${stale.join("\n")}`);
});
