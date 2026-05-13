import { SLACK_SECRET_KEY_FILE } from '../config.js';
import { decryptSecret, encryptSecret } from '../messaging/secrets.js';

export async function encryptSlackSecret(value: string) {
  return encryptSecret(SLACK_SECRET_KEY_FILE, value);
}

export async function decryptSlackSecret(payload: string) {
  return decryptSecret(SLACK_SECRET_KEY_FILE, payload);
}
