#!/usr/bin/env node
// Fake `codex mcp list --json` CLI for Codex customization tests.
// Output includes Secret Canaries that the adapter's first redaction layer
// must remove; this fixture never connects to anything.
import { writeFileSync } from 'node:fs';

if (!process.argv.includes('--json')) process.exit(2);

const LOG = process.env.GIAN_FAKE_MCP_LOG;
if (LOG) writeFileSync(LOG, 'mcp-list-called\n', { flag: 'a' });

process.stdout.write(JSON.stringify([
  {
    name: 'github',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: '/usr/local/bin/npx',
      args: ['-y', '@modelcontextprotocol/server-github', '--token', 'mcp-canary-token-123'],
      env: { GITHUB_TOKEN: 'ghp_mcp_env_canary_456' },
      env_vars: [],
      cwd: '.',
    },
    startup_timeout_sec: 30,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
  },
  {
    name: 'remote-api',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'https://api.example.com/mcp?token=mcp-query-canary-789',
      bearer_token_env_var: 'REMOTE_API_TOKEN',
      http_headers: { Authorization: 'Bearer mcp-header-canary-000' },
      env_http_headers: [],
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'bearer_token',
  },
  {
    name: 'disabled-qa',
    enabled: false,
    disabled_reason: 'user disabled',
    transport: { type: 'stdio', command: '/bin/false', args: [] },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
  },
]));