import {
  generateCanonicalId,
  type RemoteStateSnapshot,
  type RelayFrame,
} from '../src/index.js';

export function sampleSnapshot(overrides: Partial<RemoteStateSnapshot> = {}): RemoteStateSnapshot {
  return {
    type: 'state.snapshot',
    snapshot_id: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    revision: 'rev-1',
    event_sequence: 3,
    host: {
      id: generateCanonicalId(),
      name: 'Office Mac',
      online: true,
      version: '0.5.3',
    },
    workspaces: [{ id: generateCanonicalId(), name: 'gian' }],
    tasks: [],
    sessions: [],
    interactions: [],
    capabilities: {
      'catalog.read': { state: 'supported' },
      'session.send': { state: 'supported' },
    },
    attention: [],
    catalog_revision: 'cat-1',
    ...overrides,
  };
}

export function sampleRelayFrame(overrides: Partial<RelayFrame> = {}): RelayFrame {
  return {
    protocol: 'gian.relay/1',
    frame_id: generateCanonicalId(),
    frame_class: 'control',
    route_id: generateCanonicalId(),
    host_id: generateCanonicalId(),
    device_id: generateCanonicalId(),
    connection_id: generateCanonicalId(),
    transport_sequence: 0,
    transport_ack: 0,
    sent_at: 1_700_000_000_000,
    ciphertext: 'YWJj',
    ...overrides,
  };
}
