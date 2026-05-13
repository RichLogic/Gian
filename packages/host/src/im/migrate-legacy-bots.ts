/**
 * One-shot migration:把 Gian 老 `bots` 表里的 Discord/Slack 行迁到 rvc 形态的
 * `discord_bots` / `slack_bots`。运行时机:host 启动时调一次,幂等
 * (新表里已有同 id 的行就跳过)。
 *
 * 不兼容点处理:
 *   - **加密格式**:老 `extra` 列是 `iv:tag:cipher` (hex) 形式,scrypt(env GIAN_SECRET) 派生 key,
 *     整个 BotExtra JSON 一起加密。这里读出来 → 拆字段 → 用 rvc 形态的
 *     per-token base64url 加密(key 来自 ~/.config/gian/{discord,slack}.key)重写。
 *   - **mode 字段** (read-only/full-control):rvc 设计上把 mode 概念改到了
 *     per-session `approval_mode`,bot 自身不再有 mode。这一列直接丢弃。
 *
 * 老 `bots` 表保留不删 —— 留作 rollback 锚点。第一次迁完之后正常路径都
 * 走新表。
 */

import { listBots } from '../storage/bots.js';
import type { Db } from '../storage/db.js';
import { encryptDiscordSecret } from './discord/secrets.js';
import { encryptSlackSecret } from './slack/secrets.js';

interface MigrationResult {
  discordMigrated: number;
  slackMigrated: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}

export async function migrateLegacyBots(db: Db): Promise<MigrationResult> {
  const result: MigrationResult = {
    discordMigrated: 0,
    slackMigrated: 0,
    skipped: 0,
    errors: [],
  };

  // listBots() handles the legacy decryption (handles both encrypted and old
  // plaintext-JSON rows transparently).
  let legacy: ReturnType<typeof listBots>;
  try {
    legacy = listBots(db);
  } catch (err) {
    // No `bots` table at all (very old install or test DB) — nothing to migrate.
    if (err instanceof Error && /no such table: bots/i.test(err.message)) {
      return result;
    }
    throw err;
  }
  if (legacy.length === 0) return result;

  const discordHas = db.prepare('SELECT 1 FROM discord_bots WHERE id = ?');
  const slackHas = db.prepare('SELECT 1 FROM slack_bots WHERE id = ?');

  const insertDiscord = db.prepare(`
    INSERT INTO discord_bots (
      id, owner_user_id, owner_username, label, token_ciphertext,
      application_id, bot_user_id, allowed_discord_user_id,
      selected_workspace_id, selected_session_id, direct_channel_id,
      enabled, status, last_error, last_connected_at, created_at, updated_at
    ) VALUES (
      @id, 'local', 'local', @label, @token,
      @app, @bot_user, @allowed,
      @workspace, NULL, @channel,
      @enabled, @status, @last_error, @last_connected, @created, @updated
    )
  `);

  const insertSlack = db.prepare(`
    INSERT INTO slack_bots (
      id, owner_user_id, owner_username, label,
      bot_token_ciphertext, app_token_ciphertext, config_token_ciphertext,
      team_id, bot_user_id, allowed_slack_user_id,
      selected_workspace_id, selected_session_id, direct_channel_id, command_prefix,
      enabled, status, last_error, last_connected_at, created_at, updated_at
    ) VALUES (
      @id, 'local', 'local', @label,
      @bot_token, @app_token, @config_token,
      @team, @bot_user, @allowed,
      @workspace, NULL, @channel, @prefix,
      @enabled, @status, @last_error, @last_connected, @created, @updated
    )
  `);

  for (const bot of legacy) {
    try {
      if (bot.platform === 'discord') {
        if (discordHas.get(bot.id)) {
          result.skipped++;
          continue;
        }
        const extra = bot.extra as { token?: string; application_id?: string; bot_user_id?: string; direct_channel_id?: string };
        if (!extra.token) {
          result.errors.push({ id: bot.id, error: 'discord bot has no token in extra' });
          continue;
        }
        const tokenCiphertext = await encryptDiscordSecret(extra.token);
        insertDiscord.run({
          id: bot.id,
          label: bot.label,
          token: tokenCiphertext,
          app: extra.application_id ?? null,
          bot_user: extra.bot_user_id ?? null,
          allowed: bot.allowed_user_id,
          workspace: bot.workspace_id,
          channel: extra.direct_channel_id ?? null,
          enabled: bot.enabled,
          status: bot.status,
          last_error: bot.last_error,
          last_connected: bot.last_connected_at,
          created: bot.created_at,
          updated: bot.updated_at,
        });
        result.discordMigrated++;
        continue;
      }

      if (bot.platform === 'slack') {
        if (slackHas.get(bot.id)) {
          result.skipped++;
          continue;
        }
        const extra = bot.extra as {
          bot_token?: string;
          app_token?: string;
          config_token?: string;
          team_id?: string;
          bot_user_id?: string;
          direct_channel_id?: string;
          command_prefix?: string;
        };
        if (!extra.bot_token || !extra.app_token) {
          result.errors.push({ id: bot.id, error: 'slack bot missing bot_token or app_token' });
          continue;
        }
        const [botTok, appTok, configTok] = await Promise.all([
          encryptSlackSecret(extra.bot_token),
          encryptSlackSecret(extra.app_token),
          extra.config_token ? encryptSlackSecret(extra.config_token) : Promise.resolve(null),
        ]);
        insertSlack.run({
          id: bot.id,
          label: bot.label,
          bot_token: botTok,
          app_token: appTok,
          config_token: configTok,
          team: extra.team_id ?? null,
          bot_user: extra.bot_user_id ?? null,
          allowed: bot.allowed_user_id,
          workspace: bot.workspace_id,
          channel: extra.direct_channel_id ?? null,
          prefix: extra.command_prefix ?? null,
          enabled: bot.enabled,
          status: bot.status,
          last_error: bot.last_error,
          last_connected: bot.last_connected_at,
          created: bot.created_at,
          updated: bot.updated_at,
        });
        result.slackMigrated++;
        continue;
      }
    } catch (err) {
      result.errors.push({
        id: bot.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
