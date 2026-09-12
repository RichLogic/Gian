import { randomInt } from 'node:crypto';

import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  normalizePairingCode,
} from '@gian/remote-protocol';

export function generatePairingCode(): string {
  let raw = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    raw += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  }
  return formatPairingCode(raw);
}

export { normalizePairingCode, formatPairingCode };
