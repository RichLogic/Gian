import { PROTOCOL_NAME, SUPPORTED_PROTOCOL_VERSIONS } from '@gian/proxy-protocol';
import { manifestSchema } from '@gian/proxy-protocol/schemas';
import { HostProtocolValidator } from '@gian/proxy-protocol/conformance';
import { isRuntimeBootstrapOffer, runBoundedCommand } from '@gian/proxy-protocol/node';

const protocol: 'gian.proxy' = PROTOCOL_NAME;
if (protocol !== 'gian.proxy' || !SUPPORTED_PROTOCOL_VERSIONS.includes('2.2')) {
  throw new Error('Proxy Protocol constants are unavailable');
}
if (typeof manifestSchema.safeParse !== 'function' || typeof HostProtocolValidator !== 'function'
  || typeof isRuntimeBootstrapOffer !== 'function' || typeof runBoundedCommand !== 'function') {
  throw new Error('Proxy Protocol public subpath exports are unavailable');
}
