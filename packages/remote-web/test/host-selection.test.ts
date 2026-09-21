import { describe, expect, it } from 'vitest';
import { createHostSelectionStore, hostDisplayName } from '../src/host-selection.js';

describe('browser Host selection preference', () => {
  it('keeps even matching short IDs distinguishable when names collide', () => {
    const hosts = ['aaaaaaaa-1111', 'aaaaaaaa-2222'].map(id => ({ id, name: 'Gian Host', online: true, sessionCount: 0 }));
    expect(hostDisplayName(hosts[0]!, hosts)).toBe('Gian Host · aaaaaaaa-1111');
    expect(hostDisplayName(hosts[1]!, hosts)).toBe('Gian Host · aaaaaaaa-2222');
  });
  it('remembers selection across page controllers without storing an authorization credential', () => {
    createHostSelectionStore().set('home-host-id');
    expect(createHostSelectionStore().get()).toBe('home-host-id');
    createHostSelectionStore().set(null);
    expect(createHostSelectionStore().get()).toBeNull();
  });
});
