import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultCatalogPath = resolve(rootDir, 'test/proxy-real-acceptance.json');

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
  ) current = current.expression;
  return current;
}

async function exportedInitializer(path, name) {
  const source = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return unwrapExpression(declaration.initializer);
      }
    }
  }
  throw new Error(`Could not find exported initializer ${name} in ${path}.`);
}

function stringObjectValues(node, label) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`${label} must be an object literal.`);
  return node.properties.flatMap(property => (
    ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
      ? [property.initializer.text]
      : []
  ));
}

function stringArrayValues(node, spreadValues, label) {
  if (!ts.isArrayLiteralExpression(node)) throw new Error(`${label} must be an array literal.`);
  return node.elements.flatMap(element => {
    if (ts.isStringLiteral(element)) return [element.text];
    if (
      ts.isSpreadElement(element)
      && ts.isCallExpression(element.expression)
      && ts.isPropertyAccessExpression(element.expression.expression)
      && element.expression.expression.expression.getText() === 'Object'
      && element.expression.expression.name.text === 'values'
    ) return spreadValues;
    return [];
  });
}

const sharedProxySource = resolve(rootDir, 'packages/shared/src/proxy.ts');
const protocolConstantsSource = resolve(rootDir, 'packages/proxy-protocol/src/constants.ts');
const optionalCapabilities = stringObjectValues(
  await exportedInitializer(protocolConstantsSource, 'OPTIONAL_METHOD_CAPABILITIES'),
  'OPTIONAL_METHOD_CAPABILITIES',
);
const CAPABILITY_NAMES = stringArrayValues(
  await exportedInitializer(protocolConstantsSource, 'CAPABILITY_NAMES'),
  optionalCapabilities,
  'CAPABILITY_NAMES',
);
const PROXY_METHODS = stringArrayValues(
  await exportedInitializer(sharedProxySource, 'PROXY_METHODS'),
  [],
  'PROXY_METHODS',
);
const PROXY_NOTIFICATION_METHODS = stringArrayValues(
  await exportedInitializer(sharedProxySource, 'PROXY_NOTIFICATION_METHODS'),
  [],
  'PROXY_NOTIFICATION_METHODS',
);

const providerStatuses = new Set([
  'required',
  'partial',
  'unsupported',
  'contract_only',
  'not_run',
  'conditional',
  'policy_blocked',
  'fake_only',
  'spec_gap',
  'session_scope',
  'catalog_only',
  'mixed_real_fake',
  'real_plus_fake',
]);

const capabilityByNotification = {
  'plan.updated': 'event.plan',
  'diff.updated': 'event.diff',
  'usage.updated': 'event.usage',
  'step.updated': 'event.step',
  'request.updated': 'event.request',
};

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameMembers(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return value;
}

export async function loadProxyRealAcceptanceCatalog(path = defaultCatalogPath) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function validateProxyRealAcceptanceCatalog(catalog) {
  requireRecord(catalog, 'catalog');
  const providers = requireRecord(catalog.providers, 'providers');
  const providerIds = Object.keys(providers);
  if (providerIds.length < 5) throw new Error('Catalog must include all four Gian Proxies plus DSH.');

  const resultSchemas = requireRecord(catalog.resultSchemas, 'resultSchemas');
  if (!sameMembers(Object.keys(resultSchemas), PROXY_METHODS)) {
    throw new Error('resultSchemas must cover every gian.proxy/2.0 method exactly once.');
  }
  const notificationSchemas = requireRecord(catalog.notificationSchemas, 'notificationSchemas');
  if (!sameMembers(Object.keys(notificationSchemas), PROXY_NOTIFICATION_METHODS)) {
    throw new Error('notificationSchemas must cover every gian.proxy/2.0 notification exactly once.');
  }
  for (const method of PROXY_NOTIFICATION_METHODS) {
    const schema = requireRecord(notificationSchemas[method], `notificationSchemas.${method}`);
    requireStringArray(schema.required, `notificationSchemas.${method}.required`);
  }

  const knownCapabilities = new Set(CAPABILITY_NAMES);
  const knownNotifications = new Set(PROXY_NOTIFICATION_METHODS);
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    const provider = requireRecord(rawProvider, `providers.${providerId}`);
    const capabilities = requireStringArray(provider.capabilities, `${providerId}.capabilities`);
    const notifications = requireStringArray(
      provider.implementedNotifications,
      `${providerId}.implementedNotifications`,
    );
    for (const capability of capabilities) {
      if (!knownCapabilities.has(capability)) {
        throw new Error(`${providerId} declares unknown capability ${capability}.`);
      }
    }
    for (const method of notifications) {
      if (!knownNotifications.has(method)) {
        throw new Error(`${providerId} implements unknown notification ${method}.`);
      }
      const capability = capabilityByNotification[method];
      if (capability && !capabilities.includes(capability)) {
        throw new Error(`${providerId} implements ${method} without ${capability}.`);
      }
    }
    requireRecord(provider.cheapestConfig, `${providerId}.cheapestConfig`);
  }

  if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length === 0) {
    throw new Error('scenarios must be a non-empty array.');
  }
  const ids = new Set();
  const coveredMethods = new Set();
  const coveredNotifications = new Set();
  for (const [index, rawScenario] of catalog.scenarios.entries()) {
    const scenario = requireRecord(rawScenario, `scenarios[${index}]`);
    if (typeof scenario.id !== 'string' || !/^[a-z][a-z0-9_.-]+$/.test(scenario.id)) {
      throw new Error(`scenarios[${index}].id is invalid.`);
    }
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    if (typeof scenario.category !== 'string' || typeof scenario.trigger !== 'string') {
      throw new Error(`${scenario.id} requires category and trigger.`);
    }
    if (scenario.trigger === 'real_prompt' && typeof scenario.prompt !== 'string') {
      throw new Error(`${scenario.id} is real_prompt but has no prompt.`);
    }
    const methods = requireStringArray(scenario.methods, `${scenario.id}.methods`);
    const notifications = Array.isArray(scenario.notifications)
      ? scenario.notifications
      : requireStringArray(scenario.notifications, `${scenario.id}.notifications`);
    for (const method of methods) {
      if (!PROXY_METHODS.includes(method)) throw new Error(`${scenario.id} uses unknown method ${method}.`);
      coveredMethods.add(method);
    }
    for (const method of notifications) {
      if (!knownNotifications.has(method)) {
        throw new Error(`${scenario.id} expects unknown notification ${method}.`);
      }
      coveredNotifications.add(method);
    }
    requireStringArray(scenario.steps, `${scenario.id}.steps`);
    const statuses = requireRecord(scenario.providers, `${scenario.id}.providers`);
    if (!sameMembers(Object.keys(statuses), providerIds)) {
      throw new Error(`${scenario.id} must classify every provider.`);
    }
    for (const [providerId, status] of Object.entries(statuses)) {
      if (!providerStatuses.has(status)) {
        throw new Error(`${scenario.id}.${providerId} has unknown status ${status}.`);
      }
    }
  }

  if (!sameMembers(coveredMethods, PROXY_METHODS)) {
    const missing = PROXY_METHODS.filter(method => !coveredMethods.has(method));
    throw new Error(`Scenario coverage is missing method(s): ${missing.join(', ')}.`);
  }
  if (!sameMembers(coveredNotifications, PROXY_NOTIFICATION_METHODS)) {
    const missing = PROXY_NOTIFICATION_METHODS.filter(method => !coveredNotifications.has(method));
    throw new Error(`Scenario coverage is missing notification(s): ${missing.join(', ')}.`);
  }
  return catalog;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusClass(status) {
  if (status === 'required') return 'required';
  if (status === 'unsupported') return 'unsupported';
  if (status.includes('fake') || status.includes('contract')) return 'fixture';
  if (status.includes('gap') || status.includes('blocked')) return 'blocked';
  return 'conditional';
}

export function renderProxyRealAcceptanceHtml(catalog) {
  validateProxyRealAcceptanceCatalog(catalog);
  const providers = Object.entries(catalog.providers);
  const scenarioRows = catalog.scenarios.map((scenario) => `
    <tr>
      <td><strong>${escapeHtml(scenario.id)}</strong><small>${escapeHtml(scenario.category)} / ${escapeHtml(scenario.trigger)}</small></td>
      <td>${escapeHtml(scenario.purpose)}</td>
      <td><ol>${scenario.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>${scenario.prompt ? `<details><summary>Prompt</summary><pre>${escapeHtml(scenario.prompt)}</pre></details>` : ''}</td>
      <td><div class="schema"><b>Requests</b>${scenario.methods.map(method => `<code>${escapeHtml(method)}</code>`).join('')}<b>Notifications</b>${scenario.notifications.length ? scenario.notifications.map(method => `<code>${escapeHtml(method)}</code>`).join('') : '<span class="muted">none</span>'}</div></td>
      ${providers.map(([providerId]) => {
        const status = scenario.providers[providerId];
        return `<td><span class="status ${statusClass(status)}">${escapeHtml(status)}</span></td>`;
      }).join('')}
    </tr>`).join('');
  const schemaRows = Object.entries(catalog.notificationSchemas).map(([method, schema]) => `
    <tr><td><code>${escapeHtml(method)}</code></td><td>${escapeHtml(schema.scope)}</td><td>${schema.required.map(path => `<code>${escapeHtml(path)}</code>`).join(' ')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gian 0.5.0 Real Proxy Acceptance Matrix</title><style>
:root{color-scheme:light;--bg:#f5f6f7;--surface:#fff;--text:#202124;--muted:#68707a;--line:#dfe3e7;--head:#eef1f3;--green:#087a45;--amber:#8a4b08;--red:#b3261e;--blue:#285f9e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}main{width:min(1900px,calc(100% - 32px));margin:24px auto 48px}h1{margin:0;font-size:26px}h2{margin:28px 0 10px;font-size:18px}.subtitle,.muted,small{color:var(--muted)}.summary{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:1px;margin:18px 0;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden}.metric{padding:12px 14px;background:var(--surface)}.metric b{display:block;font-size:20px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--surface)}table{border-collapse:collapse;width:100%;min-width:1500px}th,td{padding:12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);vertical-align:top}th{position:sticky;top:0;background:var(--head);text-align:left;font-size:12px}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}td:first-child{width:230px}small{display:block;margin-top:3px}ol{margin:0;padding-left:18px}.status{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700}.required{color:var(--green);background:#e8f6ee}.unsupported{color:var(--muted);background:#eef0f2}.fixture{color:var(--blue);background:#e8f0fb}.blocked{color:var(--red);background:#fce8e6}.conditional{color:var(--amber);background:#fff2d8}.schema{display:flex;flex-wrap:wrap;gap:5px}.schema b{width:100%;font-size:11px;color:var(--muted);text-transform:uppercase}.schema code,td>code{padding:1px 4px;border-radius:3px;background:#f0f2f4}details{margin-top:8px}pre{white-space:pre-wrap;margin:6px 0 0;padding:8px;background:#f6f7f8;border-radius:4px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.schemas table{min-width:900px}@media(max-width:900px){main{width:calc(100% - 16px);margin-top:12px}.summary{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main><h1>Gian 0.5.0 Real Proxy Acceptance Matrix</h1><p class="subtitle">${escapeHtml(catalog.protocol)} · catalog v${catalog.version} · ${catalog.scenarios.length} scenarios · generated ${new Date().toISOString()}</p>
<section class="summary"><div class="metric"><span>Scenarios</span><b>${catalog.scenarios.length}</b></div><div class="metric"><span>Proxy targets</span><b>${providers.length}</b></div><div class="metric"><span>Request methods</span><b>${Object.keys(catalog.resultSchemas).length}</b></div><div class="metric"><span>Notification schemas</span><b>${Object.keys(catalog.notificationSchemas).length}</b></div></section>
<div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Purpose</th><th>Steps / Prompt</th><th>Expected wire output</th>${providers.map(([, provider]) => `<th>${escapeHtml(provider.displayName)}</th>`).join('')}</tr></thead><tbody>${scenarioRows}</tbody></table></div>
<section class="schemas"><h2>Expected Notification Schema</h2><div class="table-wrap"><table><thead><tr><th>Method</th><th>Scope</th><th>Required paths under params</th></tr></thead><tbody>${schemaRows}</tbody></table></div></section>
<h2>Global Invariants</h2><ol>${catalog.globalInvariants.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol></main></body></html>`;
}

export async function writeProxyRealAcceptanceHtml(path, catalog) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderProxyRealAcceptanceHtml(catalog), 'utf8');
}

async function main(argv = process.argv.slice(2)) {
  const catalog = validateProxyRealAcceptanceCatalog(await loadProxyRealAcceptanceCatalog());
  const htmlIndex = argv.indexOf('--html');
  if (htmlIndex >= 0) {
    const path = argv[htmlIndex + 1];
    if (!path) throw new Error('--html requires an output path.');
    await writeProxyRealAcceptanceHtml(resolve(rootDir, path), catalog);
    console.log(`proxy real acceptance: wrote ${path}`);
  } else {
    console.log(`proxy real acceptance: ${catalog.scenarios.length} scenarios valid`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
