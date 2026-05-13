import { DISCORD_SECRET_KEY_FILE } from '../config.js';
import { decryptSecret, encryptSecret } from '../messaging/secrets.js';

export async function encryptDiscordSecret(value: string) {
  return encryptSecret(DISCORD_SECRET_KEY_FILE, value);
}

export async function decryptDiscordSecret(payload: string) {
  return decryptSecret(DISCORD_SECRET_KEY_FILE, payload);
}
