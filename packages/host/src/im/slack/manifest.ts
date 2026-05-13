/**
 * Slack Manifest API integration for auto-registering slash commands.
 *
 * Uses the Configuration Token to read and update the Slack app manifest,
 * specifically the `features.slash_commands` section.
 */

const SLACK_COMMANDS = ['new', 'switch', 'alter', 'stop', 'status'] as const;

const COMMAND_DESCRIPTIONS: Record<typeof SLACK_COMMANDS[number], string> = {
  new: 'Create a new coding session',
  switch: 'Switch to a different session',
  alter: 'Change model, mode, or thinking',
  stop: 'Stop the current task and clear queue',
  status: 'Show current session status',
};

const COMMAND_USAGE_HINTS: Record<typeof SLACK_COMMANDS[number], string> = {
  new: '[prompt]',
  switch: '[session name]',
  alter: '[model|mode|thinking] [value]',
  stop: ' ',
  status: ' ',
};

export function slackCommandNames(prefix: string): string[] {
  return SLACK_COMMANDS.map((cmd) => `/${prefix}-${cmd}`);
}

/**
 * Given a full slash command string (e.g. "/eva00-new"), extract the action
 * suffix by matching against known command suffixes.
 *
 * The prefix itself may contain dashes, so we match from the end.
 */
export function parseSlackCommandAction(
  command: string,
  prefix: string,
): typeof SLACK_COMMANDS[number] | null {
  const normalized = command.startsWith('/') ? command.slice(1) : command;
  const expectedPrefix = `${prefix}-`;
  if (!normalized.startsWith(expectedPrefix)) return null;
  const action = normalized.slice(expectedPrefix.length);
  return (SLACK_COMMANDS as readonly string[]).includes(action)
    ? (action as typeof SLACK_COMMANDS[number])
    : null;
}

// ---------------------------------------------------------------------------
// Manifest API
// ---------------------------------------------------------------------------

interface ManifestSlashCommand {
  command: string;
  description: string;
  usage_hint?: string;
  should_escape?: boolean;
}

/**
 * Register slash commands for a Slack app via the Manifest API.
 *
 * @param configToken - Slack Configuration Token
 * @param appId - Slack App ID (available from auth.test or stored on bot)
 * @param prefix - The command prefix (e.g. "eva00")
 */
export async function registerSlackCommands(params: {
  configToken: string;
  appId: string;
  prefix: string;
  log?: { info(msg: string): unknown; warn(msg: string): unknown };
}): Promise<void> {
  const { configToken, appId, prefix, log } = params;

  // 1. Read current manifest
  const exportRes = await slackApi('apps.manifest.export', configToken, { app_id: appId });
  if (!exportRes.ok) {
    throw new Error(`Failed to export Slack manifest: ${exportRes.error ?? 'unknown'}`);
  }

  const manifest = exportRes.manifest as Record<string, unknown>;
  const features = (manifest.features ?? {}) as Record<string, unknown>;

  // 2. Build the new slash_commands list, preserving non-prefixed commands
  const existingCommands = (features.slash_commands ?? []) as ManifestSlashCommand[];
  const prefixedPattern = `/${prefix}-`;
  const preserved = existingCommands.filter((c) => !c.command.startsWith(prefixedPattern));
  const newCommands: ManifestSlashCommand[] = SLACK_COMMANDS.map((action) => ({
    command: `/${prefix}-${action}`,
    description: COMMAND_DESCRIPTIONS[action],
    usage_hint: COMMAND_USAGE_HINTS[action],
    should_escape: false,
  }));

  features.slash_commands = [...preserved, ...newCommands];
  manifest.features = features;

  // 3. Update manifest
  const updateRes = await slackApi('apps.manifest.update', configToken, {
    app_id: appId,
    manifest,
  });
  if (!updateRes.ok) {
    const errors = updateRes.errors ? JSON.stringify(updateRes.errors) : '';
    throw new Error(`Failed to update Slack manifest: ${updateRes.error ?? 'unknown'}${errors ? ` — ${errors}` : ''}`);
  }

  log?.info(`Registered Slack commands for prefix "${prefix}": ${slackCommandNames(prefix).join(', ')}`);
}

/**
 * Remove all commands with the given prefix from the Slack app manifest.
 */
export async function unregisterSlackCommands(params: {
  configToken: string;
  appId: string;
  prefix: string;
  log?: { info(msg: string): unknown; warn(msg: string): unknown };
}): Promise<void> {
  const { configToken, appId, prefix, log } = params;

  const exportRes = await slackApi('apps.manifest.export', configToken, { app_id: appId });
  if (!exportRes.ok) {
    throw new Error(`Failed to export Slack manifest: ${exportRes.error ?? 'unknown'}`);
  }

  const manifest = exportRes.manifest as Record<string, unknown>;
  const features = (manifest.features ?? {}) as Record<string, unknown>;
  const existingCommands = (features.slash_commands ?? []) as ManifestSlashCommand[];
  const prefixedPattern = `/${prefix}-`;
  features.slash_commands = existingCommands.filter((c) => !c.command.startsWith(prefixedPattern));
  manifest.features = features;

  const updateRes = await slackApi('apps.manifest.update', configToken, {
    app_id: appId,
    manifest,
  });
  if (!updateRes.ok) {
    const errors = updateRes.errors ? JSON.stringify(updateRes.errors) : '';
    throw new Error(`Failed to update Slack manifest: ${updateRes.error ?? 'unknown'}${errors ? ` — ${errors}` : ''}`);
  }

  log?.info(`Unregistered Slack commands for prefix "${prefix}"`);
}

// ---------------------------------------------------------------------------
// Low-level Slack API helper
// ---------------------------------------------------------------------------

async function slackApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Slack API ${method} returned HTTP ${res.status}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}
