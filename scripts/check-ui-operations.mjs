#!/usr/bin/env node
/**
 * Static completeness gate for the UI Operation Layer (proposal §6,
 * `docs/archive/proposals/ui-operation-layer.md`).
 *
 * WARN MODE (default, `pnpm quality:operations` — for humans): every
 * violation is printed with rule id and file:line, exit code stays 0.
 * `--strict` exits 1 on any violation. STRICT WIRING (Phase 4): the test/CI
 * entry point `scripts/run-tests.mjs` (`pnpm test` and `pnpm test:all`; the release
 * workflow's "Verify source" step runs) invokes this script with `--strict`,
 * so adding a direct mutation from a view or an unclassified Host command
 * fails locally and in CI (proposal §7 Phase 4).
 *
 * Parsing uses the installed TypeScript compiler API (workspace
 * devDependency `typescript`), never regex, per proposal §6.
 *
 * Rules:
 * - `ws-send` — `ws.send(...)` outside the transport-private modules
 *   (operations/**, ws.ts, components/terminal-wire.ts) and the per-file
 *   allowlist below.
 * - `direct-fetch` — `fetch(...)` outside api.ts and operations/**.
 * - `mutation-import` — importing a mutation API function (the REST
 *   mutation surface, see REST_MUTATION_TO_OPERATION) from
 *   views/components/controllers.
 * - `bridge-call` (added in Phase 4) — mutating Desktop bridge calls
 *   (`restartApp`, `setDockIcon`, `githubAuth.signOut/start/finish/cancel`)
 *   outside operations/**, per proposal §6. `githubAuth.getState` is a
 *   bootstrap query, not a mutation — exempt. The declared-but-never-called
 *   dead surface `retryConnection`/`openLogs` (inventory §5) is a violation
 *   ANYWHERE, including operations/** — do not call them.
 * - `ws-policy-coverage` — every mutating `ClientToServerMessage` type in
 *   shared/src/web.ts must appear in WS_TYPE_POLICIES (operations/types.ts),
 *   and stale entries that no longer exist in the protocol are flagged.
 *   TypeScript already enforces this at the type level (`satisfies
 *   Record<MutatingWsType, ...>`); this rule is the runtime backstop.
 * - `rest-policy-map` — the REST→operation policy map. The map is owned by
 *   THIS SCRIPT (explicit constant below, per the Phase 1 task choice):
 *   every exported mutation function in api.ts must appear in it, every
 *   entry must correspond to an exported api.ts function, and every mapped
 *   operation name must exist in OPERATION_POLICIES.
 *
 * The allowlist is the permanent-exception ledger (proposal §6: every entry
 * needs a reason; wildcard directory exemptions are not acceptable). Entries
 * are per rule + file.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(scriptDir, '..');

/** Protocol exceptions (proposal §4.4): not mutations, no request_id. */
const WS_TYPE_EXEMPTIONS = new Set([
  'auth',
  'events:subscribe',
  'term:input',
  'term:resize',
  'term:replay-request',
]);

/**
 * REST → operation policy map, owned by this gate (Phase 1 choice; see
 * header). Mirrors inventory §2 (`docs/archive/proposals/ui-operation-inventory.md`).
 * Several operations may share one REST function (updateWorkspace backs all
 * workspace metadata writes). Exported for the gate's test fixtures.
 */
export const REST_MUTATION_TO_OPERATION = {
  mergeSession: ['session.merge'],
  dropSession: ['session.drop'],
  uploadAttachment: ['message.uploadAttachment'],
  createSubtask: ['task.createSubtask'],
  completeSubtask: ['task.completeSubtask'],
  reopenSubtask: ['task.reopenSubtask'],
  createWorkspace: ['workspace.create'],
  updateWorkspace: ['workspace.rename', 'workspace.setHidden', 'workspace.pin'],
  reorderWorkspaces: ['workspace.reorder'],
  deleteWorkspace: ['workspace.delete'],
  saveClaudeMd: ['workspace.saveClaudeMd'],
  pickWorkspaceFolder: ['workspace.pickFolder'],
  cloneWorkspaceRepo: ['workspace.cloneRepo'],
  fetchRemotes: ['git.fetch'],
  fetchGitHistory: ['git.historyFetch'],
  abortPendingGitOp: ['git.abortPendingOp'],
  stageFile: ['git.stage'],
  unstageFile: ['git.unstage'],
  openFileWith: ['files.openExternal'],
  openFileWithApp: ['files.openExternal'],
  openFileBuiltin: ['files.openExternal'],
  revealWorkingTree: ['files.openExternal'],
  adoptNativeSession: ['native.adopt'],
  deleteNativeSession: ['native.delete'],
  saveSettings: ['settings.save'],
  resetOnboarding: ['settings.resetOnboarding'],
  installAgentCli: ['agent.installCli'],
  installAgentProxy: ['agent.installProxy'],
  checkAgentProxyUpdate: ['agent.checkProxyUpdate'],
  createAgent: ['agent.create'],
  updateAgent: ['agent.patch', 'agent.setPath', 'agent.switchProxy'],
  deleteAgent: ['agent.delete'],
  pickAgentCliPath: ['agent.pickCliPath'],
  saveOnboardingProjectRoot: ['onboarding.saveProjectRoot'],
  completeOnboarding: ['onboarding.complete'],
  login: ['auth.login'],
  logout: ['auth.logout'],
};

/** Files whose `ws.send`/`fetch` use is transport-private by design (§4.1). */
const TRANSPORT_PRIVATE_FILES = new Set(['src/ws.ts', 'src/api.ts', 'src/components/terminal-wire.ts']);
const TRANSPORT_PRIVATE_DIRS = ['src/operations/'];

/**
 * Permanent exception allowlist (post-Phase-3b state — the migration ledger
 * is CLOSED: every Phase 1–3b migration entry has been removed because the
 * bypass it covered was routed through a registered operation). Only
 * protocol/design exceptions remain, each with its reason (proposal §6;
 * wildcard directory exemptions are not acceptable):
 *
 * - WS `events:subscribe` (use-app-socket.ts, App.tsx) — event subscription,
 *   no Host side effect, carries no request_id (proposal §4.4).
 * - WS `auth` (ws.ts) — authentication bootstrap; transport-private file.
 * - WS `term:input` / `term:resize` / `term:replay-request`
 *   (components/terminal-wire.ts) — raw terminal byte streaming; per-
 *   keystroke correlation is meaningless. term:spawn/term:close ARE
 *   operations now (operations/terminal.ts) and do not appear here.
 * - api.ts query functions (`load*`, `peekAgents`, `fetchWsToken`,
 *   `whoAmI`) — read-only; the §4.5 query-timing rules apply to their
 *   surfaces instead. Only mutating exports must be in the REST map.
 *
 * Documented bridge/local exceptions (enforced by the `bridge-call` rule):
 * - bridge `setDockIcon` (brand-icon.ts) — effect-driven cosmetic mirror of
 *   theme settings; no user action awaiting a result (inventory §3).
 *   Confirmed: do NOT migrate.
 * - bridge `githubAuth.getState` — auth bootstrap query (LoginView,
 *   use-app-auth); not a mutation, never flagged by the rule.
 * - bridge `githubAuth.cancel` — user abort of the in-flight
 *   auth.githubLogin device flow (LoginView); the operation wraps
 *   start+settle, cancellation settles the run failed with 'cancelled'
 *   (see operations/auth.ts).
 * - Dead surface (inventory §5 — resolved in Phase 4): api.ts `createTask` /
 *   `createLocalBranch` were deleted with the entry-less `git.createBranch`
 *   operation; bridge `retryConnection` / `openLogs` stay declared on the
 *   bridge and are `bridge-call` violations if ever called.
 */
const ALLOWLIST = [
  // --- ws.send protocol exceptions (proposal §4.4): not mutations. ---
  { rule: 'ws-send', file: 'src/controllers/use-app-socket.ts', reason: 'protocol exception (§4.4): events:subscribe after auth_ok is not a mutation and carries no request_id' },
  { rule: 'ws-send', file: 'src/App.tsx', reason: 'protocol exception (§4.4): events:subscribe is not a mutation and carries no request_id' },
  // --- bridge-call permanent exceptions (see the doc block above). ---
  { rule: 'bridge-call', file: 'src/brand-icon.ts', reason: 'cosmetic exception (inventory §3): setDockIcon is an effect-driven mirror of theme settings; no user action awaits a result' },
  { rule: 'bridge-call', file: 'src/views/LoginView.tsx', reason: 'githubAuth.cancel aborts the in-flight auth.githubLogin device flow; the operation wraps start+settle and cancellation settles the run failed (operations/auth.ts)' },
];

/**
 * Mutating Desktop bridge methods (proposal §6; inventory §2). Detection is
 * syntactic: a call whose callee chain roots at `desktopBridge()` (or a
 * `bridge`/`desktop` local / a `gianDesktop` hop) with one of these terminal
 * methods, or whose chain passes through `githubAuth` with a mutating
 * GitHub-auth method. `githubAuth.getState` is a query — exempt by design.
 */
const BRIDGE_MUTATING_METHODS = new Set(['restartApp', 'setDockIcon', 'openExternal', 'clearData']);
const GITHUB_AUTH_MUTATING_METHODS = new Set(['signOut', 'start', 'finish', 'cancel']);
/** Declared but never called (inventory §5): a violation ANYWHERE, including
 *  operations/** — do not call them. */
const BRIDGE_DEAD_METHODS = new Set(['retryConnection', 'openLogs']);

const MUTATION_API_NAMES = new Set(Object.keys(REST_MUTATION_TO_OPERATION));
const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FEATURE_FILE_DIRS = ['src/views/', 'src/components/', 'src/controllers/'];

function isTransportPrivate(relFile) {
  return TRANSPORT_PRIVATE_FILES.has(relFile) || TRANSPORT_PRIVATE_DIRS.some(dir => relFile.startsWith(dir));
}

function isFeatureFile(relFile) {
  return FEATURE_FILE_DIRS.some(dir => relFile.startsWith(dir));
}

function allowlistReason(rule, relFile) {
  const entry = ALLOWLIST.find(e => e.rule === rule && e.file === relFile);
  return entry?.reason ?? null;
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function parse(filePath) {
  const text = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function lineOf(sourceFile, node) {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

/** Receiver of a `.send(...)` call resolves to something named `ws`
 *  (`ws.send`, `input.ws.send`, `this.ws.send`). */
function isWsSendCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== 'send') return false;
  let target = node.expression.expression;
  while (ts.isPropertyAccessExpression(target)) target = target.expression;
  if (ts.isThis(target)) return node.expression.expression.getText().endsWith('.ws');
  return ts.isIdentifier(target) && target.text === 'ws';
}

/**
 * Classify a call expression as a mutating Desktop bridge call (Phase 4
 * `bridge-call` rule). Returns 'bridge' (mutating, allowed only from
 * operations/**), 'github-auth' (same), 'dead' (violation anywhere), or null
 * (not a bridge call / the exempt `getState` query / a non-mutating read).
 */
function bridgeCallKind(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const segments = [];
  let target = node.expression;
  while (ts.isPropertyAccessExpression(target)) {
    segments.unshift(target.name.text);
    target = target.expression;
  }
  if (ts.isIdentifier(target)) segments.unshift(target.text);
  const method = segments[segments.length - 1];
  if (segments.includes('githubAuth')) {
    return GITHUB_AUTH_MUTATING_METHODS.has(method) ? 'github-auth' : null;
  }
  const viaBridge =
    (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'desktopBridge')
    || segments[0] === 'bridge' || segments[0] === 'desktop'
    || segments.includes('gianDesktop');
  if (!viaBridge) return null;
  if (BRIDGE_DEAD_METHODS.has(method)) return 'dead';
  return BRIDGE_MUTATING_METHODS.has(method) ? 'bridge' : null;
}

function functionHasMutatingFetch(fn) {
  let found = false;
  const visit = node => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch'
    ) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const prop of options.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'method' &&
            ts.isStringLiteral(prop.initializer) &&
            MUTATING_HTTP_METHODS.has(prop.initializer.text.toUpperCase())
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

/** Exported top-level function names of a source file (+ mutating-fetch flag). */
function exportedFunctions(sourceFile) {
  const fns = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    const exported = ts.canHaveModifiers(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) fns.push({ name: stmt.name.text, node: stmt });
  }
  return fns;
}

function objectLiteralKeys(sourceFile, declarationName) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== declarationName || !decl.initializer) continue;
      // Unwrap `... satisfies T` / `as T` / parens around the literal.
      let init = decl.initializer;
      while (
        ts.isSatisfiesExpression(init) ||
        ts.isAsExpression(init) ||
        ts.isParenthesizedExpression(init)
      ) {
        init = init.expression;
      }
      if (ts.isObjectLiteralExpression(init)) {
        return init.properties
          .filter(ts.isPropertyAssignment)
          .map(p => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null))
          .filter(Boolean);
      }
    }
  }
  return null;
}

/** Union member `type` literals of a type alias like ClientToServerMessage. */
function unionTypeLiterals(sourceFile, aliasName) {
  const interfaces = new Map();
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) interfaces.set(stmt.name.text, stmt);
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== aliasName) continue;
    if (!ts.isUnionTypeNode(stmt.type)) return null;
    const literals = [];
    for (const member of stmt.type.types) {
      if (!ts.isTypeReferenceNode(member)) continue;
      const iface = interfaces.get(member.typeName.getText(sourceFile));
      if (!iface) continue;
      for (const prop of iface.members) {
        if (
          ts.isPropertySignature(prop) &&
          prop.name.getText(sourceFile) === 'type' &&
          prop.type &&
          ts.isLiteralTypeNode(prop.type) &&
          ts.isStringLiteral(prop.type.literal)
        ) {
          literals.push(prop.type.literal.text);
        }
      }
    }
    return literals;
  }
  return null;
}

/**
 * Run all gate rules under `rootDir` (expects packages/web/src and
 * packages/shared/src/web.ts beneath it). Returns
 * `{ violations, suppressed }` — violations are objects
 * `{ rule, file, line, message }` with `file` repo-relative.
 */
export function runChecks(rootDir = DEFAULT_ROOT) {
  const webSrc = join(rootDir, 'packages/web/src');
  const violations = [];
  const suppressed = [];

  const report = (rule, file, line, message) => {
    const rel = relative(join(rootDir, 'packages/web'), file);
    const reason = allowlistReason(rule, rel);
    const entry = { rule, file: relative(rootDir, file), line, message };
    if (reason !== null && file.startsWith(webSrc)) suppressed.push({ ...entry, reason });
    else violations.push(entry);
  };

  // --- Per-file syntactic rules over packages/web/src. ---
  for (const filePath of listSourceFiles(webSrc)) {
    const rel = relative(join(rootDir, 'packages/web'), filePath);
    const sourceFile = parse(filePath);
    const visit = node => {
      if (isWsSendCall(node) && !isTransportPrivate(rel)) {
        report('ws-send', filePath, lineOf(sourceFile, node), '`ws.send` outside transport-private modules — route through a registered operation (proposal §4.1)');
      }
      const bridgeKind = bridgeCallKind(node);
      if (bridgeKind === 'dead') {
        // Dead surface (inventory §5): no allowed caller, not even operations/**.
        report('bridge-call', filePath, lineOf(sourceFile, node), 'dead bridge surface `retryConnection`/`openLogs` — declared, never callable (inventory §5); remove the call');
      } else if (bridgeKind !== null && !rel.startsWith('src/operations/')) {
        report('bridge-call', filePath, lineOf(sourceFile, node), 'mutating Desktop bridge call outside operations/** — route through a registered operation (proposal §6)');
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'fetch' &&
        !isTransportPrivate(rel)
      ) {
        report('direct-fetch', filePath, lineOf(sourceFile, node), 'direct `fetch` outside api.ts/operations — route through a registered operation (proposal §4.1)');
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isFeatureFile(rel)) {
        const spec = node.moduleSpecifier.text;
        if (/(^|\/)api(\.js)?$/.test(spec)) {
          const named = node.importClause?.namedBindings;
          if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              const imported = (el.propertyName ?? el.name).text;
              if (MUTATION_API_NAMES.has(imported)) {
                report('mutation-import', filePath, lineOf(sourceFile, el), `mutation API \`${imported}\` imported from a view/component/controller — call the operation instead (proposal §4.1)`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // --- ws-policy-coverage: shared protocol vs WS_TYPE_POLICIES. ---
  const sharedWebPath = join(rootDir, 'packages/shared/src/web.ts');
  const typesPath = join(webSrc, 'operations/types.ts');
  const sharedSource = parse(sharedWebPath);
  const typesSource = parse(typesPath);
  const wsTypes = unionTypeLiterals(sharedSource, 'ClientToServerMessage') ?? [];
  const mutatingTypes = wsTypes.filter(t => !WS_TYPE_EXEMPTIONS.has(t));
  const policyKeys = objectLiteralKeys(typesSource, 'WS_TYPE_POLICIES') ?? [];
  const operationNames = objectLiteralKeys(typesSource, 'OPERATION_POLICIES') ?? [];

  for (const type of mutatingTypes) {
    if (!policyKeys.includes(type)) {
      violations.push({
        rule: 'ws-policy-coverage',
        file: relative(rootDir, typesPath),
        line: 1,
        message: `mutating WS type \`${type}\` missing from WS_TYPE_POLICIES (proposal §6)`,
      });
    }
  }
  for (const key of policyKeys) {
    if (!mutatingTypes.includes(key)) {
      violations.push({
        rule: 'ws-policy-coverage',
        file: relative(rootDir, typesPath),
        line: 1,
        message: `WS_TYPE_POLICIES entry \`${key}\` is not a mutating ClientToServerMessage type (stale or exempt)`,
      });
    }
  }

  // --- rest-policy-map: api.ts exports vs REST_MUTATION_TO_OPERATION. ---
  const apiPath = join(webSrc, 'api.ts');
  const apiSource = parse(apiPath);
  const apiExports = exportedFunctions(apiSource);
  const apiExportNames = new Set(apiExports.map(f => f.name));

  for (const [fnName, ops] of Object.entries(REST_MUTATION_TO_OPERATION)) {
    if (!apiExportNames.has(fnName)) {
      violations.push({
        rule: 'rest-policy-map',
        file: relative(rootDir, apiPath),
        line: 1,
        message: `REST map entry \`${fnName}\` is not exported from api.ts (stale map entry)`,
      });
    }
    for (const op of ops) {
      if (!operationNames.includes(op)) {
        violations.push({
          rule: 'rest-policy-map',
          file: relative(rootDir, apiPath),
          line: 1,
          message: `REST map entry \`${fnName}\` maps to unknown operation \`${op}\` (not in OPERATION_POLICIES)`,
        });
      }
    }
  }
  for (const fn of apiExports) {
    if (MUTATION_API_NAMES.has(fn.name)) continue;
    if (functionHasMutatingFetch(fn.node)) {
      violations.push({
        rule: 'rest-policy-map',
        file: relative(rootDir, apiPath),
        line: lineOf(apiSource, fn.node),
        message: `exported mutation \`${fn.name}\` missing from the REST→operation map (proposal §6)`,
      });
    }
  }

  return { violations, suppressed };
}

export function main(argv = process.argv.slice(2), rootDir = DEFAULT_ROOT) {
  const strict = argv.includes('--strict');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 && argv[rootIndex + 1] ? resolve(argv[rootIndex + 1]) : rootDir;
  const { violations, suppressed } = runChecks(root);

  for (const v of violations) {
    console.log(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }
  if (suppressed.length > 0) {
    console.log(`(${suppressed.length} allowlisted permanent exceptions suppressed — see ALLOWLIST in scripts/check-ui-operations.mjs)`);
  }
  console.log(
    violations.length === 0
      ? 'ui-operations gate: no violations'
      : `ui-operations gate: ${violations.length} violation(s)${strict ? '' : ' (warn mode — not failing)'}`,
  );
  if (strict && violations.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
