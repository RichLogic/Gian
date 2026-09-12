import type { AgentProxyDefaults, LegacyExecutorId, SystemConfig } from '@gian/shared';

/** Pre-pluginId settings/env migration only. New Runtime discovery is owned by
 * each Manifest v4 Proxy and never reads this table. */
const LEGACY_RUNTIME_ENV: Readonly<Record<string, string>> = {
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN',
  kimi: 'KIMI_BIN',
  grok: 'GROK_BIN',
  dsh: 'DSH_BIN',
  zcode: 'ZCODE_BIN',
};

export function legacyAgentBootstrap(
  config: SystemConfig,
  environment: NodeJS.ProcessEnv,
): {
  legacyProxyDefaults: Partial<Record<LegacyExecutorId, Partial<AgentProxyDefaults>>>;
  environmentCliPaths: Partial<Record<LegacyExecutorId, string>>;
} {
  return {
    legacyProxyDefaults: {
      claude: {
        model: config.default_claude_model,
        thinking: config.default_claude_effort,
        mode: 'ask',
      },
      codex: {
        model: config.default_codex_model,
        thinking: config.default_codex_effort,
        mode: 'ask',
      },
      kimi: { model: '', thinking: '', mode: '' },
      grok: { model: '', thinking: '', mode: '' },
      dsh: { model: '', thinking: '', mode: '' },
      zcode: { model: '', thinking: '', mode: '' },
    },
    environmentCliPaths: Object.fromEntries(
      Object.entries(LEGACY_RUNTIME_ENV)
        .map(([id, variable]) => [id, environment[variable]] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ) as Partial<Record<LegacyExecutorId, string>>,
  };
}
