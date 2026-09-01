/**
 * Static executor/Agent registry — the single registration source for the
 * executors Gian knows about. Every layer (shared guards, Host runtime and
 * proxy wiring, Web display, Desktop attention, release matrix) derives its
 * enumeration from these definitions so adding an executor is one entry here
 * plus the capability-specific work, never a new scattering of literal lists.
 *
 * This module must stay dependency-free (only type-level imports) so every
 * package can consume it.
 */

export const EXECUTOR_IDS = ['claude', 'codex', 'kimi', 'grok', 'dsh', 'zcode'] as const;
export type ExecutorId = (typeof EXECUTOR_IDS)[number];

/** Executors exposed in the product AI Agents catalog. `grok` remains a valid
 *  protocol/vendor executor (its Proxy and Host adapter stay in the tree) but
 *  is not offered anywhere in the product surface. */
export const PRODUCT_EXECUTOR_IDS = ['claude', 'codex', 'kimi', 'dsh', 'zcode'] as const;
export type ProductExecutorId = (typeof PRODUCT_EXECUTOR_IDS)[number];

export interface ExecutorDefinition {
  readonly id: ExecutorId;
  /** Manifest / initialize plugin identity. Reverse-domain for executors
   *  whose plugin id cannot be the bare executor id (proxy-protocol
   *  pluginIdSchema reserves the bare built-in ids). */
  readonly pluginId: string;
  /** User-facing Agent display name (settings, onboarding, notifications). */
  readonly displayName: string;
  /** Default proxy process scope in the development runtime; managed mode
   *  reads the activated manifest instead. */
  readonly processScope: 'shared' | 'session';
  /** Host env var overriding the Proxy entry path in development. */
  readonly entryEnvVar: string;
  /** Host env var overriding the vendor CLI binary path. */
  readonly binEnvVar: string;
  /** Proxy package name under the @gian scope (dev entry resolution). */
  readonly proxyPackageName: string;
  /** Proxy package directory under packages/proxies/. */
  readonly proxyPackageDir: string;
  /** Whether the executor appears in the product surface (catalog, picker,
   *  onboarding). False keeps a shipped executor hidden. */
  readonly productVisible: boolean;
  /** Whether the executor uses the legacy per-CLI capability surface
   *  (/models + /slash host routes). Catalog-driven protocol-v2 agents
   *  (kimi/grok/dsh/zcode) serve everything through gian.proxy catalogs. */
  readonly cliCapabilitySurface: boolean;
  /** Provider exposes opaque native config options instead of the Gian
   *  ApprovalMode segmented control. */
  readonly nativeExecutorConfig: boolean;
  /** Provider supports listing/adopting provider-native sessions through the
   *  dedicated native history surface. */
  readonly nativeSessions: boolean;
}

export const EXECUTOR_DEFS: Readonly<Record<ExecutorId, ExecutorDefinition>> = {
  claude: {
    id: 'claude',
    pluginId: 'claude',
    displayName: 'Claude Code',
    processScope: 'session',
    entryEnvVar: 'GIAN_CC_PROXY_ENTRY',
    binEnvVar: 'CLAUDE_BIN',
    proxyPackageName: '@gian/cc-proxy',
    proxyPackageDir: 'cc-proxy',
    productVisible: true,
    cliCapabilitySurface: true,
    nativeExecutorConfig: false,
    nativeSessions: true,
  },
  codex: {
    id: 'codex',
    pluginId: 'codex',
    displayName: 'Codex',
    processScope: 'shared',
    entryEnvVar: 'GIAN_CODEX_PROXY_ENTRY',
    binEnvVar: 'CODEX_BIN',
    proxyPackageName: '@gian/codex-proxy',
    proxyPackageDir: 'codex-proxy',
    productVisible: true,
    cliCapabilitySurface: true,
    nativeExecutorConfig: false,
    nativeSessions: true,
  },
  kimi: {
    id: 'kimi',
    pluginId: 'kimi',
    displayName: 'Kimi Code',
    processScope: 'shared',
    entryEnvVar: 'GIAN_KIMI_PROXY_ENTRY',
    binEnvVar: 'KIMI_BIN',
    proxyPackageName: '@gian/kimi-proxy',
    proxyPackageDir: 'kimi-proxy',
    productVisible: true,
    cliCapabilitySurface: false,
    nativeExecutorConfig: true,
    nativeSessions: true,
  },
  grok: {
    id: 'grok',
    pluginId: 'grok',
    displayName: 'Grok Build',
    processScope: 'session',
    entryEnvVar: 'GIAN_GROK_PROXY_ENTRY',
    binEnvVar: 'GROK_BIN',
    proxyPackageName: '@gian/grok-proxy',
    proxyPackageDir: 'grok-proxy',
    productVisible: false,
    cliCapabilitySurface: false,
    nativeExecutorConfig: true,
    nativeSessions: true,
  },
  dsh: {
    id: 'dsh',
    pluginId: 'ai.deepseek.harness',
    displayName: 'DeepSeek Harness',
    processScope: 'shared',
    entryEnvVar: 'GIAN_DSH_PROXY_ENTRY',
    binEnvVar: 'DSH_BIN',
    proxyPackageName: '@gian/dsh-proxy',
    proxyPackageDir: 'dsh-proxy',
    productVisible: true,
    cliCapabilitySurface: false,
    nativeExecutorConfig: true,
    nativeSessions: false,
  },
  zcode: {
    id: 'zcode',
    pluginId: 'com.zhipu.zcode',
    displayName: 'ZCode',
    processScope: 'shared',
    entryEnvVar: 'GIAN_ZCODE_PROXY_ENTRY',
    binEnvVar: 'ZCODE_BIN',
    proxyPackageName: '@gian/zcode-proxy',
    proxyPackageDir: 'zcode-proxy',
    productVisible: true,
    // ZCode exposes its catalog through gian.proxy/2.1 special slots, so the
    // product renders the standard model/thinking/approval controls.
    cliCapabilitySurface: false,
    nativeExecutorConfig: false,
    nativeSessions: true,
  },
};

export function isExecutorId(value: unknown): value is ExecutorId {
  return typeof value === 'string'
    && (EXECUTOR_IDS as readonly string[]).includes(value);
}

export function executorDefinition(id: ExecutorId): ExecutorDefinition {
  return EXECUTOR_DEFS[id];
}
