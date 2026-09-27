/** com.zhipu.zcode plugin identity (must match the generated Manifest v3 and
 *  the initialize handshake; Host validates both against the registry). */
export const PLUGIN_ID = 'com.zhipu.zcode';
export const PLUGIN_NAME = 'ZCode';
export const PLUGIN_VERSION = '0.4.3';

/** Inner wire facts for the open-source ZCode CLI 0.16.9
 *  (github.com/zai-org/ZCode @ 328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f). */
export const INNER_PROTOCOL_NAME = 'ZCode Protocol';
export const INNER_PROTOCOL_VERSION = 1;
export const VERIFIED_CLI_VERSIONS = ['0.16.9'] as const;

/** Outer capability set, rebased onto the 0.16.9 runtime surface:
 *  - `input.localImage` / `input.localFile`: v4 sendText attachments accept
 *    absolute local paths (desktop "local zero-copy",
 *    useComposerAttachments.ts:643-668; attachment-refs.ts:3-12).
 *  - `input.skill`: the upstream /skill canonical prompt
 *    (slash-commands.ts:229 buildManualSkillPrompt).
 *  - `turn.steer`: v4 sendText requestedDelivery "guide" — same-turn inline
 *    steering (session.port.ts:272-278).
 *  - `session.rename`: v4 renameSession command (session-mgmt.ts:140-152).
 *  - `session.fork` / `session.fork.atTurn`: v4 forkAssistant, the stable
 *    conversation-only fork (fork-edit-retry.ts:6).
 *  - `event.plan` / `event.diff`: TodoWrite todos and Edit/Write
 *    structuredPatch results projected from the session/event stream.
 *  NOT declared: `sidechat` (upstream selection side chats inherit hidden
 *  parent context and restrict commands), `session.native.delete`
 *  (deleteSession is a close; history is never purged),
 *  `session.create.forkBoundaries` (boundaries come from the live
 *  projection at fork time), `integration.mcp.streamableHttp` as a capability
 *  name (Host MCP is injected per-session via session/create mcpServers). */
export function capabilitiesFor(options: { interaction: boolean }): Record<string, number> {
  const capabilities: Record<string, number> = {
    'input.localFile': 1,
    'input.localImage': 1,
    'input.skill': 1,
    'catalog.resolve': 1,
    'session.native.list': 1,
    'session.replay': 1,
    'session.rename': 1,
    'session.fork': 1,
    'session.fork.atTurn': 1,
    'turn.steer': 1,
    'event.reasoning': 1,
    'event.plan': 1,
    'event.diff': 1,
    'event.usage': 1,
  };
  if (options.interaction) capabilities['interaction'] = 1;
  return capabilities;
}
