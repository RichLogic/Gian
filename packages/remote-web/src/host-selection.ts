import type { RemoteHostEntry } from './controller/types.js';

export interface HostSelectionStore {
  get(): string | null;
  set(hostId: string | null): void;
}

/** Device-local preference only; the server's paired Host list is authoritative. */
export function createHostSelectionStore(): HostSelectionStore {
  const key = 'gian.remote.selected_host';
  let memory: string | null = null;
  return {
    get() {
      try { return globalThis.localStorage?.getItem(key) ?? memory; } catch { return memory; }
    },
    set(id) {
      memory = id;
      try {
        if (id) globalThis.localStorage?.setItem(key, id);
        else globalThis.localStorage?.removeItem(key);
      } catch { /* A blocked store must not prevent selecting a Host. */ }
    },
  };
}

export function hostDisplayName(host: RemoteHostEntry, hosts: RemoteHostEntry[]): string {
  const duplicates = hosts.filter(other => other.id !== host.id && other.name === host.name);
  if (!duplicates.length) return host.name;
  const shortId = host.id.slice(0, 8);
  const id = duplicates.some(other => other.id.slice(0, 8) === shortId) ? host.id : shortId;
  return `${host.name} · ${id}`;
}
