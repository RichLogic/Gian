/**
 * Thin compatibility layer over the rvc-shaped `discord_bots` / `slack_bots`
 * tables that preserves the original Gian `Bot` / `BotExtra` wire format
 * exposed by `/api/bots*`. Web UI doesn't need to change.
 *
 * Reads decrypt per-token ciphertexts back into the union `BotExtra` JSON;
 * writes split `extra` apart into the per-platform columns and re-encrypt
 * each token separately. `Bot.mode` (read-only/full-control) is fabricated
 * because rvc dropped that concept — we always return `'full-control'`.
 */

import { randomUUID } from 'node:crypto';
import type {
  Bot,
  BotExtra,
  BotStatus,
  DiscordBotExtra,
  IMPlatform,
  SlackBotExtra,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import {
  decryptDiscordSecret,
  encryptDiscordSecret,
} from './discord/secrets.js';
import {
  decryptSlackSecret,
  encryptSlackSecret,
} from './slack/secrets.js';

interface DiscordBotRow {
  id: string;
  label: string;
  token_ciphertext: string;
  application_id: string | null;
  bot_user_id: string | null;
  allowed_discord_user_id: string | null;
  selected_workspace_id: string | null;
  direct_channel_id: string | null;
  enabled: number;
  status: string;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SlackBotRow {
  id: string;
  label: string;
  bot_token_ciphertext: string;
  app_token_ciphertext: string;
  config_token_ciphertext: string | null;
  team_id: string | null;
  bot_user_id: string | null;
  allowed_slack_user_id: string | null;
  selected_workspace_id: string | null;
  direct_channel_id: string | null;
  command_prefix: string | null;
  enabled: number;
  status: string;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

async function discordRowToBot(row: DiscordBotRow): Promise<Bot> {
  const token = await decryptDiscordSecret(row.token_ciphertext);
  const extra: DiscordBotExtra = {
    token,
    application_id: row.application_id ?? '',
    ...(row.bot_user_id ? { bot_user_id: row.bot_user_id } : {}),
    ...(row.direct_channel_id ? { direct_channel_id: row.direct_channel_id } : {}),
  };
  return {
    id: row.id,
    label: row.label,
    platform: 'discord',
    workspace_id: row.selected_workspace_id,
    // rvc dropped per-bot mode; always present 'full-control' so the web UI
    // doesn't show an empty pill.
    mode: 'full-control',
    allowed_user_id: row.allowed_discord_user_id,
    enabled: row.enabled === 1 ? 1 : 0,
    status: (row.status as BotStatus) ?? 'disabled',
    last_error: row.last_error,
    last_connected_at: row.last_connected_at,
    extra,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function slackRowToBot(row: SlackBotRow): Promise<Bot> {
  const [bot_token, app_token, configClear] = await Promise.all([
    decryptSlackSecret(row.bot_token_ciphertext),
    decryptSlackSecret(row.app_token_ciphertext),
    row.config_token_ciphertext
      ? decryptSlackSecret(row.config_token_ciphertext)
      : Promise.resolve(''),
  ]);
  const extra: SlackBotExtra = {
    bot_token,
    app_token,
    config_token: configClear,
    team_id: row.team_id ?? '',
    ...(row.bot_user_id ? { bot_user_id: row.bot_user_id } : {}),
    ...(row.direct_channel_id ? { direct_channel_id: row.direct_channel_id } : {}),
    command_prefix: row.command_prefix ?? '',
  };
  return {
    id: row.id,
    label: row.label,
    platform: 'slack',
    workspace_id: row.selected_workspace_id,
    mode: 'full-control',
    allowed_user_id: row.allowed_slack_user_id,
    enabled: row.enabled === 1 ? 1 : 0,
    status: (row.status as BotStatus) ?? 'disabled',
    last_error: row.last_error,
    last_connected_at: row.last_connected_at,
    extra,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listAllBots(db: Db): Promise<Bot[]> {
  const discord = db.prepare('SELECT * FROM discord_bots ORDER BY created_at ASC').all() as DiscordBotRow[];
  const slack = db.prepare('SELECT * FROM slack_bots ORDER BY created_at ASC').all() as SlackBotRow[];
  const bots = await Promise.all([
    ...discord.map(discordRowToBot),
    ...slack.map(slackRowToBot),
  ]);
  // Stable order: by created_at across both platforms.
  return bots.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getBotById(db: Db, id: string): Promise<Bot | null> {
  const d = db.prepare('SELECT * FROM discord_bots WHERE id = ?').get(id) as DiscordBotRow | undefined;
  if (d) return discordRowToBot(d);
  const s = db.prepare('SELECT * FROM slack_bots WHERE id = ?').get(id) as SlackBotRow | undefined;
  if (s) return slackRowToBot(s);
  return null;
}

export interface CreateBotInput {
  label: string;
  platform: IMPlatform;
  workspace_id?: string | null;
  allowed_user_id?: string | null;
  extra: BotExtra;
}

export async function createNewBot(db: Db, input: CreateBotInput): Promise<Bot> {
  const id = randomUUID();
  const now = new Date().toISOString();

  if (input.platform === 'discord') {
    const e = input.extra as DiscordBotExtra;
    if (!e.token) throw new Error('discord bot requires extra.token');
    const tokenCiphertext = await encryptDiscordSecret(e.token);
    db.prepare(`
      INSERT INTO discord_bots (
        id, owner_user_id, owner_username, label, token_ciphertext,
        application_id, bot_user_id, allowed_discord_user_id,
        selected_workspace_id, selected_session_id, direct_channel_id,
        enabled, status, created_at, updated_at
      ) VALUES (?, 'local', 'local', ?, ?, ?, ?, ?, ?, NULL, ?, 0, 'disabled', ?, ?)
    `).run(
      id,
      input.label,
      tokenCiphertext,
      e.application_id || null,
      e.bot_user_id ?? null,
      input.allowed_user_id ?? null,
      input.workspace_id ?? null,
      e.direct_channel_id ?? null,
      now,
      now,
    );
  } else if (input.platform === 'slack') {
    const e = input.extra as SlackBotExtra;
    if (!e.bot_token || !e.app_token) {
      throw new Error('slack bot requires extra.bot_token and extra.app_token');
    }
    const [botTok, appTok, configTok] = await Promise.all([
      encryptSlackSecret(e.bot_token),
      encryptSlackSecret(e.app_token),
      e.config_token ? encryptSlackSecret(e.config_token) : Promise.resolve(null),
    ]);
    db.prepare(`
      INSERT INTO slack_bots (
        id, owner_user_id, owner_username, label,
        bot_token_ciphertext, app_token_ciphertext, config_token_ciphertext,
        team_id, bot_user_id, allowed_slack_user_id,
        selected_workspace_id, selected_session_id, direct_channel_id, command_prefix,
        enabled, status, created_at, updated_at
      ) VALUES (?, 'local', 'local', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 'disabled', ?, ?)
    `).run(
      id,
      input.label,
      botTok,
      appTok,
      configTok,
      e.team_id || null,
      e.bot_user_id ?? null,
      input.allowed_user_id ?? null,
      input.workspace_id ?? null,
      e.direct_channel_id ?? null,
      e.command_prefix || null,
      now,
      now,
    );
  } else {
    throw new Error(`unsupported platform: ${input.platform}`);
  }

  const bot = await getBotById(db, id);
  if (!bot) throw new Error('bot insert succeeded but row not found');
  return bot;
}

export interface UpdateBotInput {
  label?: string;
  workspace_id?: string | null;
  allowed_user_id?: string | null;
  extra?: BotExtra;
  status?: BotStatus;
  last_error?: string | null;
  last_connected_at?: string | null;
}

export async function updateBotFields(db: Db, id: string, input: UpdateBotInput): Promise<Bot | null> {
  const existing = await getBotById(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();

  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, value: unknown) => { sets.push(`${col} = ?`); vals.push(value); };

  if (input.label !== undefined) push('label', input.label);
  if ('workspace_id' in input) push('selected_workspace_id', input.workspace_id ?? null);
  if (input.status !== undefined) push('status', input.status);
  if ('last_error' in input) push('last_error', input.last_error ?? null);
  if ('last_connected_at' in input) push('last_connected_at', input.last_connected_at ?? null);

  if (existing.platform === 'discord') {
    if ('allowed_user_id' in input) push('allowed_discord_user_id', input.allowed_user_id ?? null);
    if (input.extra !== undefined) {
      const e = input.extra as DiscordBotExtra;
      if (e.token) push('token_ciphertext', await encryptDiscordSecret(e.token));
      if ('application_id' in e) push('application_id', e.application_id || null);
      if ('bot_user_id' in e) push('bot_user_id', e.bot_user_id ?? null);
      if ('direct_channel_id' in e) push('direct_channel_id', e.direct_channel_id ?? null);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    vals.push(now);
    vals.push(id);
    db.prepare(`UPDATE discord_bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } else {
    if ('allowed_user_id' in input) push('allowed_slack_user_id', input.allowed_user_id ?? null);
    if (input.extra !== undefined) {
      const e = input.extra as SlackBotExtra;
      if (e.bot_token) push('bot_token_ciphertext', await encryptSlackSecret(e.bot_token));
      if (e.app_token) push('app_token_ciphertext', await encryptSlackSecret(e.app_token));
      if (e.config_token !== undefined) {
        push('config_token_ciphertext', e.config_token ? await encryptSlackSecret(e.config_token) : null);
      }
      if ('team_id' in e) push('team_id', e.team_id || null);
      if ('bot_user_id' in e) push('bot_user_id', e.bot_user_id ?? null);
      if ('direct_channel_id' in e) push('direct_channel_id', e.direct_channel_id ?? null);
      if ('command_prefix' in e) push('command_prefix', e.command_prefix || null);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    vals.push(now);
    vals.push(id);
    db.prepare(`UPDATE slack_bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  return getBotById(db, id);
}

export async function setBotEnabled(db: Db, id: string, enabled: boolean): Promise<Bot | null> {
  const existing = await getBotById(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const status = enabled ? 'connecting' : 'disabled';
  const table = existing.platform === 'discord' ? 'discord_bots' : 'slack_bots';
  db.prepare(`UPDATE ${table} SET enabled = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    status,
    now,
    id,
  );
  return getBotById(db, id);
}

export function deleteBotRow(db: Db, id: string, platform: IMPlatform): boolean {
  const table = platform === 'discord' ? 'discord_bots' : 'slack_bots';
  const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return result.changes > 0;
}
