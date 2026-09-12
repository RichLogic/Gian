import {
  BUSINESS_CAPABILITY_IDS,
  type EffectiveCapabilities,
} from '@gian/remote-protocol';
import type { GianToolMethod } from '@gian/shared';
import type { RemoteDeviceRecord } from './device-store.js';

const GRANT_BY_CAPABILITY: Partial<Record<typeof BUSINESS_CAPABILITY_IDS[number], GianToolMethod | GianToolMethod[]>> = {
  'catalog.read': 'catalog.get_create_options',
  'session.read': 'session.read',
  'session.create': 'session.create',
  'session.update': 'session.update',
  'session.send': 'session.send',
  'session.stop': 'session.stop',
  'queue.update': 'queue.update',
  'queue.remove': 'queue.remove',
  'queue.clear': 'queue.clear',
  'queue.send_now': 'queue.send_now',
  'queue.add': 'session.send',
  'queue.read': 'session.read',
  'interaction.read': 'session.read',
  'interaction.respond': 'interaction.respond',
};

type CapabilityState =
  | { state: 'supported' }
  | { state: 'unsupported'; reason?: string }
  | { state: 'offline'; reason: string }
  | { state: 'denied'; reason: string };

export function effectiveRemoteCapabilities(input: {
  device: RemoteDeviceRecord;
  hostOnline: boolean;
  wireFeatures: readonly string[];
  sessionCanSteer?: boolean;
}): EffectiveCapabilities {
  const capabilities: Record<string, CapabilityState> = {};
  for (const id of BUSINESS_CAPABILITY_IDS) {
    if (!input.hostOnline) {
      capabilities[id] = { state: 'offline', reason: 'Host is offline' };
      continue;
    }
    const grant = GRANT_BY_CAPABILITY[id];
    if (grant) {
      const needed = Array.isArray(grant) ? grant : [grant];
      if (!needed.every(method => input.device.grants.includes(method))) {
        capabilities[id] = { state: 'denied', reason: 'device grant missing' };
        continue;
      }
    }
    if (id === 'turn.steer' && input.sessionCanSteer === false) {
      capabilities[id] = { state: 'unsupported', reason: 'active Agent does not advertise turn.steer' };
      continue;
    }
    void input.wireFeatures;
    capabilities[id] = { state: 'supported' };
  }
  return capabilities as EffectiveCapabilities;
}
