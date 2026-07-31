import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/storage/db.js';
import { DiscordCodingRepository } from '../src/im/discord/repository.js';
import { SlackCodingRepository } from '../src/im/slack/repository.js';

test('IM repositories use canonical sessions and retain only platform state', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-im-routing-'));
  const db = openDatabase(dataDir);
  t.after(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const tables = (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all() as Array<{ name: string }>).map(row => row.name);
  for (const obsolete of [
    'discord_coding_sessions',
    'discord_coding_turns',
    'discord_coding_queued_turns',
    'slack_coding_sessions',
    'slack_coding_turns',
    'slack_coding_queued_turns',
  ]) {
    assert.equal(tables.includes(obsolete), false, `${obsolete} must be removed`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO discord_bots (
      id, owner_user_id, owner_username, label, token_ciphertext,
      selected_session_id, enabled, status, created_at, updated_at
    ) VALUES ('discord-on', 'local', 'local', 'on', 'secret', 'session-a', 1, 'connected', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO discord_bots (
      id, owner_user_id, owner_username, label, token_ciphertext,
      selected_session_id, enabled, status, created_at, updated_at
    ) VALUES ('discord-off', 'local', 'local', 'off', 'secret', 'session-a', 0, 'disabled', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO slack_bots (
      id, owner_user_id, owner_username, label,
      bot_token_ciphertext, app_token_ciphertext,
      selected_session_id, enabled, status, created_at, updated_at
    ) VALUES ('slack-on', 'local', 'local', 'on', 'bot', 'app', 'session-a', 1, 'connected', ?, ?)
  `).run(now, now);

  const discord = new DiscordCodingRepository(db);
  const slack = new SlackCodingRepository(db);
  assert.deepEqual(
    (await discord.listBotRecordsForSession('session-a')).map(bot => bot.id),
    ['discord-on'],
  );
  assert.deepEqual(
    (await slack.listBotRecordsForSession('session-a')).map(bot => bot.id),
    ['slack-on'],
  );
  assert.deepEqual(await discord.listBotRecordsForSession('other-session'), []);

  for (const table of ['discord_outbox', 'slack_outbox']) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
    }>;
    assert.ok(
      foreignKeys.some(fk => fk.table === 'sessions' && fk.from === 'session_id'),
      `${table}.session_id must reference canonical sessions`,
    );
  }
});
