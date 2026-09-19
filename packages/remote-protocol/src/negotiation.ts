import { REMOTE_MAJOR_VERSION, REMOTE_MAX_MINOR_VERSION, REMOTE_MIN_MINOR_VERSION, REMOTE_PROTOCOL, WIRE_FEATURES } from './constants.js';
import { helloOkSchema, helloSchema, negotiateHello, type Hello, type HelloOk } from './control.js';
import { RemoteProtocolError } from './errors.js';
import { parseClosed } from './validation.js';

export function createRemoteHello(deviceId: string, clientVersion: string): Hello {
  return helloSchema.parse({ type: 'hello', protocol: REMOTE_PROTOCOL, client_version: clientVersion, major_version: REMOTE_MAJOR_VERSION, min_minor_version: REMOTE_MIN_MINOR_VERSION, max_minor_version: REMOTE_MAX_MINOR_VERSION, capabilities: [...WIRE_FEATURES], device_id: deviceId });
}
export function acceptRemoteHello(raw: unknown, identity: { deviceId: string; connectionId: string; hostGeneration: string; hostVersion: string }, now = Date.now()): HelloOk {
  const hello = parseClosed(helloSchema, raw);
  if (hello.device_id !== identity.deviceId) throw new RemoteProtocolError('INVALID_FRAME', 'hello device does not match the authenticated route');
  const selected = negotiateHello({ peer_min_minor: hello.min_minor_version, peer_max_minor: hello.max_minor_version, peer_capabilities: hello.capabilities });
  return helloOkSchema.parse({ type: 'hello.ok', protocol: REMOTE_PROTOCOL, host_version: identity.hostVersion, host_generation: identity.hostGeneration, connection_id: identity.connectionId, negotiated_major_version: REMOTE_MAJOR_VERSION, ...selected, server_time: now });
}
export function validateRemoteHelloReply(raw: unknown, offer: Hello, connectionId: string, hostGeneration: string): HelloOk {
  const reply = parseClosed(helloOkSchema, raw);
  if (reply.connection_id !== connectionId || reply.host_generation !== hostGeneration
    || reply.negotiated_minor_version < offer.min_minor_version || reply.negotiated_minor_version > offer.max_minor_version
    || reply.negotiated_capabilities.some(feature => !offer.capabilities.includes(feature))) {
    throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'hello reply differs from the offered protocol or authenticated connection');
  }
  return reply;
}
