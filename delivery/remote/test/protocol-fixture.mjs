import { createHash } from 'node:crypto';
import { protocolCoordinates } from '../scripts/protocol-dependency.mjs';

export const protocolBytes = Buffer.from('fixture protocol archive bytes; never publish');
export function protocolFixture() {
  return { schema: 1, name: '@gian/remote-protocol', repository: 'RichLogic/Gian', version: '1.0.0', ...protocolCoordinates('1.0.0'), sourceCommit: 'a'.repeat(40), size: protocolBytes.length, sha256: createHash('sha256').update(protocolBytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(protocolBytes).digest('base64')}`, dependencies: { zod: '4.4.3' } };
}
export function protocolLockFixture() {
  return `lockfileVersion: '9.0'

importers:

  .: {}

  packages/shared: {}

  packages/chat-ui: {}

  packages/remote-protocol:
    dependencies:
      zod:
        specifier: ^4.3.6
        version: 4.4.3

  packages/host: {}

  packages/remote-server:
    dependencies:
      '@gian/remote-protocol':
        specifier: workspace:*
        version: link:../remote-protocol

  packages/remote-web:
    dependencies:
      '@gian/remote-protocol':
        specifier: workspace:*
        version: link:../remote-protocol

packages:

  zod@4.4.3:
    resolution: {integrity: fixture-only}

snapshots:

  zod@4.4.3: {}
`;
}
