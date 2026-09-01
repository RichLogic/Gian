/** com.zhipu.zcode plugin identity (must match the generated Manifest v3 and
 *  the initialize handshake; Host validates both against the registry). */
export const PLUGIN_ID = 'com.zhipu.zcode';
export const PLUGIN_NAME = 'ZCode';
export const PLUGIN_VERSION = '0.1.0';

/** Inner wire facts frozen by WP0 (evidence/wp0/gate-summary.json). */
export const INNER_PROTOCOL_NAME = 'ZCode Protocol';
export const INNER_PROTOCOL_VERSION = 1;
export const VERIFIED_CLI_VERSIONS = ['0.16.5'] as const;

/** Outer capability set. WP7 proved permission interaction across a 25-second
 *  human delay. `input.localImage` / `input.localFile` remain undeclared
 *  because the public app-server text method does not accept them. */
export function capabilitiesFor(options: { interaction: boolean }): Record<string, number> {
  const capabilities: Record<string, number> = {
    'catalog.resolve': 1,
    'session.native.list': 1,
    'session.replay': 1,
    'event.reasoning': 1,
    'event.usage': 1,
  };
  if (options.interaction) capabilities['interaction'] = 1;
  return capabilities;
}
