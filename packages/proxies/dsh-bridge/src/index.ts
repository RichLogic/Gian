/**
 * Cordis bundle entry for a DSH `gian` profile.
 *
 * The real cordis host (`cordis-host.ts`) binds the bridge server to
 * `ctx.agents` / `ctx.sessions` / `session/event` and the stdio transport. The
 * implementation stays behind `src/cordis-host.ts` so the deterministic
 * contract suite can run the identical server against a fake host with zero
 * model calls.
 */

export type { BridgeHost, BridgeHostEvent } from './host.js';
export { BridgeProtocolError, BridgeWriter, parseBridgeLine, runBridgeInput } from './jsonrpc.js';
export { BridgeServer } from './server.js';
export { CordisDshHost, mountBridge } from './cordis-host.js';
import { apply as applyCordisBridge } from './cordis-host.js';
export {
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  DSH_SESSION_FORMAT_VERSION,
} from './schema.js';

/** Cordis hook name used when the bundle is mounted as a DSH plugin row. */
export const BRIDGE_SERVICE_NAME = 'gian-dsh-bridge';
export const BRIDGE_SERVICE_VERSION = '0.1.2';
export const name = BRIDGE_SERVICE_NAME;
export const inject = ['agents', 'sessions'];

/**
 * Cordis `apply` entry used by the generated profile row. Keeping this export
 * in the package root is what lets the real DSH loader mount the stdio bridge.
 */
export const apply = applyCordisBridge;

export default apply;
