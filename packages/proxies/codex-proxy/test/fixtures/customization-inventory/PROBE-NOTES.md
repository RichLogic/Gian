# P0 probe evidence — customization inventory (2026-09-02)

Read-only probes executed on the task host with **isolated HOME** (no login,
no model calls, no writes to any real Provider config; every probe dir was
scrubbed after capture). Evidence files in `p0-evidence/` are verbatim probe
output (isolated HOME ⇒ no user data). Real-config *shapes* were inspected
read-only and are reproduced in the adapter fixtures as hand-built structural
examples with Secret Canaries; no real value was copied.

## Codex (CLI 0.144.6 installed; manifest verified 0.146.0)

| Probe | Command | Result |
|---|---|---|
| protocol schemas | `codex app-server generate-json-schema --out <dir>` (isolated CODEX_HOME) | 39 + v2 schema files; native `SkillsListResponse`, `HooksListResponse`, `ListMcpServerStatusResponse`, `ConfigReadResponse` |
| skills effective | app-server stdio RPC `skills/list {cwds:[cwd]}` | Works **without login**; returns `data[] {cwd, errors[], skills[]}` with `SkillMetadata {name, description, enabled, path, scope: user\|repo\|system\|admin, shortDescription, interface, dependencies}` (see `p0-evidence/p0-codex-skills-list.json`) |
| hooks effective | app-server stdio RPC `hooks/list {cwds:[cwd]}` | Works without login; `data[] {cwd, hooks, warnings, errors}` with `HookMetadata {key, eventName, matcher, handlerType: command\|prompt\|agent, command, timeoutSec, enabled, trustStatus: managed\|untrusted\|trusted\|modified, isManaged, source: system\|user\|project\|mdm\|sessionFlags\|plugin\|cloudRequirements\|cloudManagedConfig\|legacyManagedConfigFile\|legacyManagedConfigMdm\|unknown, sourcePath, currentHash, displayOrder, pluginId, statusMessage}` (see `p0-evidence/p0-codex-hooks-list.json`) |
| mcp configured | `codex mcp list --json` | Machine-readable JSON of resolved configured servers: `{name, enabled, disabled_reason, transport: {type, command, args, env, env_vars, cwd}, startup_timeout_sec, tool_timeout_sec, auth_status}`. Output may embed env/header values ⇒ adapter must redact `transport.env`, `env_vars`, header values. Does not connect servers. |
| rules | no app-server RPC in schema bundle | Filesystem scan only (AGENTS.md chain, `~/.codex/AGENTS.md`, `.codex/rules/*.rules`, CLAUDE.md as other-discovered) |
| timing | app-server cold start (isolated) | initialize ≈ 0.1 s; skills/list ≈ 0.0 s after init |

MCP connection-status RPC `ListMcpServerStatus*` **initializes MCP servers** —
NOT used (contract forbids connecting MCP).

## Claude (CLI 2.1.220 installed)

`claude --help` captured (isolated HOME). No machine-readable inventory CLI:
`claude mcp list` output is human text ⇒ not parsed. Adapter is bounded
filesystem scan only:

- Skills: `~/.claude/skills/<name>/SKILL.md`, `<ws>/.claude/skills/<name>/SKILL.md`
- Legacy commands: `~/.claude/commands/*.md`, `<ws>/.claude/commands/*.md`
- MCP: `.claude.json` `mcpServers` subtree only (user + project files). Real
  shape confirmed: `mcpServers.<name> = {type, url, headers{Authorization}}`
  — header values are secrets ⇒ allowlist + redact. Other `.claude.json`
  top-level fields (accounts, OAuth, history, tips, feature flags) must never
  be read or hashed.
- Hooks: `.claude/settings.{json,local.json}` `hooks` subtree only (user +
  project). Real `~/.claude/settings.json` has no hooks block today; shape
  follows the documented events → matchers[] → hooks[].
- Rules: `~/.claude/CLAUDE.md`, `<ws>/CLAUDE.md`, nested CLAUDE.md,
  `~/.claude/rules/*.md`, `<ws>/.claude/rules/*.md`, plus AGENTS.md files as
  other-discovered.

## Kimi (CLI not installed — no local probe)

Authoritative live docs (MoonshotAI/kimi-code, fetched read-only):

- Skills: `$KIMI_CODE_HOME/skills/` (default `~/.kimi-code/skills/`) and
  `~/.agents/skills/` (user); `.kimi-code/skills/` and `.agents/skills/`
  (project); `extra_skill_dirs` top-level in `config.toml`. Directory form
  `<name>/SKILL.md` or flat `<name>.md`; frontmatter name/description/type/
  disableModelInvocation/arguments.
- MCP: `$KIMI_CODE_HOME/mcp.json` + `.kimi-code/mcp.json`, `mcpServers`
  entries with command/args/env/cwd/url/transport/headers/bearerTokenEnvVar/
  enabled/enabledTools/disabledTools.
- Hooks: `[[hooks]]` tables in `$KIMI_CODE_HOME/config.toml` (and project
  `.kimi-code/config.toml`): event, matcher, command, timeout.
- Rules: `$KIMI_CODE_HOME/AGENTS.md` (global), `~/.agents/AGENTS.md`,
  `<ws>/AGENTS.md`, nested AGENTS.md; legacy `.kimi/AGENTS.md` per Issue #50
  contract (nativeType `kimi.agents.legacy`).
- Plugin-sourced Skills/MCP/Hooks (`plugins/installed.json`) are recorded but
  their manifests are not enumerated in V1 ⇒ presence yields `partial` +
  `SOURCE_NOT_ENUMERABLE`.

## DSH / ZCode / Grok

No CLI installed; no verified safe machine-readable inventory path (ZCode
inner protocol, DSH bridge, Grok staged). Adapters return explicit
`provider_unsupported` / `proxy_unsupported` (never empty `ok`).