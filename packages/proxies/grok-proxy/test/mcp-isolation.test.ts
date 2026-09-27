import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  admitHostStreamableHttpServices,
  buildSpawnArgs,
  MAX_HOST_MCP_SERVERS,
  mcpServerNamesFromToml,
  mcpSpawnDenyRules,
  scanDiskConfiguredMcpServers,
  unexpectedMcpServerNames,
} from '../src/core/mcp-isolation.js';

function descriptor(id: string, overrides: {
  transport?: Record<string, unknown>;
  [key: string]: unknown;
} = {}) {
  return {
    id,
    protocol: 'mcp',
    transport: { type: 'streamable-http', url: `https://${id}.example.com/mcp`, ...overrides.transport },
    ...overrides,
  };
}

// Hosts send a bare array of service descriptors (Kimi Proxy contract shape).
function hostServices(services: unknown[]) {
  return services;
}

test('admission accepts well-formed Streamable HTTP descriptors with headers', () => {
  const admitted = admitHostStreamableHttpServices(hostServices([
    descriptor('files', { transport: { type: 'streamable-http', url: 'https://files.example.com/mcp', headers: { authorization: 'Bearer x' } } }),
  ]));
  assert.equal(admitted.names.length, 1);
  assert.deepEqual(admitted.servers[0], {
    type: 'http',
    name: 'files',
    url: 'https://files.example.com/mcp',
    headers: [{ name: 'authorization', value: 'Bearer x' }],
  });
});

test('admission rejects stdio and SSE transports — no local process injection', () => {
  for (const type of ['stdio', 'sse', 'http']) {
    assert.throws(
      () => admitHostStreamableHttpServices(hostServices([
        descriptor('bad', { transport: { type, url: 'https://x.example.com' } }),
      ])),
      /only transport type "streamable-http"/,
    );
  }
});

test('admission rejects non-http urls, bad ids, duplicates and oversize lists', () => {
  assert.throws(
    () => admitHostStreamableHttpServices(hostServices([descriptor('ftp', { transport: { type: 'streamable-http', url: 'ftp://x' } })])),
    /absolute http\(s\) URL/,
  );
  assert.throws(
    () => admitHostStreamableHttpServices(hostServices([
      descriptor('bad id!', { transport: { type: 'streamable-http', url: 'https://x.example.com/mcp' } }),
    ])),
    /must match/,
  );
  assert.throws(
    () => admitHostStreamableHttpServices(hostServices([descriptor('dupe'), descriptor('dupe')])),
    /was sent twice/,
  );
  const many = Array.from({ length: MAX_HOST_MCP_SERVERS + 1 }, (_unused, index) => descriptor(`s${index}`));
  assert.throws(
    () => admitHostStreamableHttpServices(hostServices(many)),
    /limited to/,
  );
});

test('blanket MCPTool(*) deny stays in force without Host MCP', () => {
  assert.deepEqual(mcpSpawnDenyRules(null, ['disk-a', 'disk-b']), ['MCPTool(*)']);
  const admitted = admitHostStreamableHttpServices(hostServices([descriptor('hosted')]));
  assert.deepEqual(mcpSpawnDenyRules(admitted, []), []);
});

test('with Host MCP every disk name is denied individually except overridden ones', () => {
  const admitted = admitHostStreamableHttpServices(hostServices([descriptor('hosted')]));
  const rules = mcpSpawnDenyRules(admitted, ['disk-a', 'disk-b', 'hosted']);
  assert.deepEqual(rules, ['MCPTool(disk-a__*)', 'MCPTool(disk-b__*)']);
  assert.deepEqual(buildSpawnArgs(rules), [
    '--deny', 'MCPTool(disk-a__*)',
    '--deny', 'MCPTool(disk-b__*)',
    '--disallowed-tools', 'search_tool,use_tool',
  ]);
});

test('mcpServerNamesFromToml extracts quoted and bare table names', () => {
  const toml = [
    '[mcp_servers.redis]',
    'command = "redis"',
    '',
    '[mcp_servers."weird name"]',
    'url = "https://x"',
    '',
    '[other_section]',
  ].join('\n');
  assert.deepEqual(mcpServerNamesFromToml(toml), ['redis', 'weird name']);
});

test('scanDiskConfiguredMcpServers enumerates config.toml and .mcp.json sources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'grok-mcp-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'grok-mcp-cwd-'));
  process.env.GROK_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), '[mcp_servers.global-one]\ncommand = "a"\n');
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'project-two': { command: 'b' } } }));
    const scan = await scanDiskConfiguredMcpServers(cwd, { userHome: home });
    assert.deepEqual([...scan.names].sort(), ['global-one', 'project-two']);
    assert.deepEqual(scan.diagnostics, []);
  } finally {
    delete process.env.GROK_HOME;
  }
});

test('scanDiskConfiguredMcpServers reports unreadable sources instead of guessing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'grok-mcp-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'grok-mcp-cwd-'));
  process.env.GROK_HOME = home;
  try {
    // A directory where config.toml should be makes the read fail -> diagnostic.
    await mkdir(join(home, 'config.toml'));
    const scan = await scanDiskConfiguredMcpServers(cwd, { userHome: home });
    assert.equal(scan.names.length, 0);
    assert.equal(scan.diagnostics.length, 1);
    assert.match(scan.diagnostics[0]!, /config\.toml exists but could not be read/);
  } finally {
    delete process.env.GROK_HOME;
  }
});

test('unexpectedMcpServerNames flags effective servers outside the approved set', () => {
  assert.deepEqual(
    unexpectedMcpServerNames(['hosted', 'plugin-surprise'], ['hosted']),
    ['plugin-surprise'],
  );
});
