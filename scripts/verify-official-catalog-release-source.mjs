#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOfficialCatalogSource } from '../packages/proxy-catalog-contract/dist/src/index.js';
import { proxyDefinitions } from './build-proxy-artifacts.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function releaseSourceIssues(plugins) {
  const issues = [];
  const byId = new Map(plugins.map(plugin => [plugin.entry.pluginId, plugin.entry]));
  for (const definition of proxyDefinitions.filter(item => item.shipping)) {
    const entry = byId.get(definition.pluginId);
    const stable = entry?.channels?.stable;
    if (!stable) {
      issues.push(`${definition.id} is missing from official Catalog source`);
      continue;
    }
    if (stable.pluginVersion !== definition.pluginVersion) {
      issues.push(`${definition.id} Catalog version differs from the shipping Proxy`);
    }
    if (!stable.manifest || !stable.artifacts?.['darwin-arm64']) {
      issues.push(`${definition.id} has no installable darwin-arm64 Proxy coordinate`);
    }
    if (!stable.combination) {
      issues.push(`${definition.id} has no certified Proxy/Runtime combination`);
    }
  }
  return issues;
}

export async function verifyOfficialCatalogReleaseSource(sourceRoot = join(rootDir, 'catalog/official-source')) {
  const plugins = await loadOfficialCatalogSource(sourceRoot);
  const issues = releaseSourceIssues(plugins);
  if (issues.length > 0) throw new Error(`Catalog release source rejected:\n- ${issues.join('\n- ')}`);
  return plugins.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf('--source-root');
  const sourceRoot = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
  if (sourceIndex >= 0 && !sourceRoot) throw new Error('--source-root requires a path.');
  verifyOfficialCatalogReleaseSource(sourceRoot).then(count => {
    console.log(`Catalog release source ready (${count} plugins)`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
