import {
  exportPublicJwk,
  generateCanonicalId,
  signBytes,
} from '@gian/remote-protocol';

async function generateHostScopedSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface HostScopedIdentity {
  hostId: string;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKey: CryptoKey;
}

export interface BrowserIdentityStore {
  browserInstallationId(): Promise<string>;
  hostIdentity(hostId: string): Promise<HostScopedIdentity>;
  createPending(): Promise<HostScopedIdentity>;
  bindPending(hostId: string): Promise<HostScopedIdentity>;
  listHostIds(): Promise<string[]>;
  clearHost(hostId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export class MemoryBrowserIdentityStore implements BrowserIdentityStore {
  private installationId = generateCanonicalId();
  private readonly hosts = new Map<string, HostScopedIdentity>();
  private pending: HostScopedIdentity | null = null;

  async browserInstallationId(): Promise<string> {
    return this.installationId;
  }

  async hostIdentity(hostId: string): Promise<HostScopedIdentity> {
    const existing = this.hosts.get(hostId);
    if (!existing) {
      throw new Error(`no Host-scoped browser key for ${hostId}`);
    }
    return existing;
  }

  async createPending(): Promise<HostScopedIdentity> {
    const pair = await generateHostScopedSigningKey();
    this.pending = {
      hostId: 'pending',
      publicJwk: await exportPublicJwk(pair.publicKey),
      privateKey: pair.privateKey,
    };
    return this.pending;
  }

  async bindPending(hostId: string): Promise<HostScopedIdentity> {
    const pending = this.pending;
    if (!pending) {
      const existing = this.hosts.get(hostId);
      if (existing) return existing;
    }
    const next = pending ?? await this.createPending();
    const bound = { ...next, hostId };
    this.hosts.set(hostId, bound);
    this.pending = null;
    return bound;
  }

  async listHostIds(): Promise<string[]> {
    return [...this.hosts.keys()];
  }

  async clearHost(hostId: string): Promise<void> {
    this.hosts.delete(hostId);
  }

  async clearAll(): Promise<void> {
    this.hosts.clear();
    this.pending = null;
    this.installationId = generateCanonicalId();
  }

  async signForHost(hostId: string, bytes: Uint8Array): Promise<string> {
    const identity = await this.hostIdentity(hostId);
    return signBytes(identity.privateKey, bytes);
  }

  protected hydrate(identity: HostScopedIdentity): void {
    this.hosts.set(identity.hostId, identity);
  }
}

const INSTALL_KEY = 'gian.remote.browser_installation_id';

export class LocalStorageBrowserIdentityStore extends MemoryBrowserIdentityStore {
  override async browserInstallationId(): Promise<string> {
    try {
      const existing = globalThis.localStorage?.getItem(INSTALL_KEY);
      if (existing) return existing;
      const created = await super.browserInstallationId();
      globalThis.localStorage?.setItem(INSTALL_KEY, created);
      return created;
    } catch {
      return super.browserInstallationId();
    }
  }

  override async hostIdentity(hostId: string): Promise<HostScopedIdentity> {
    try {
      return await super.hostIdentity(hostId);
    } catch {
      const stored = await idbGetIdentity(hostId);
      if (!stored) throw new Error(`no Host-scoped browser key for ${hostId}`);
      this.hydrate(stored);
      return stored;
    }
  }

  override async bindPending(hostId: string): Promise<HostScopedIdentity> {
    const bound = await super.bindPending(hostId);
    await idbPutIdentity(bound);
    return bound;
  }

  override async listHostIds(): Promise<string[]> {
    const memory = await super.listHostIds();
    const stored = await idbListHostIds();
    return [...new Set([...memory, ...stored])];
  }

  override async clearHost(hostId: string): Promise<void> {
    await super.clearHost(hostId);
    await idbClearIdentity(hostId);
  }

  override async clearAll(): Promise<void> {
    await super.clearAll();
    await idbClearIdentity();
    try {
      globalThis.localStorage?.removeItem(INSTALL_KEY);
    } catch {
      // ignore
    }
  }
}

const IDB_NAME = 'gian-remote-identity';
const IDB_STORE = 'host-keys';

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPutIdentity(identity: HostScopedIdentity): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openIdentityDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(identity, identity.hostId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Memory remains the live store.
  }
}

async function idbGetIdentity(hostId: string): Promise<HostScopedIdentity | null> {
  if (!idbAvailable()) return null;
  try {
    const db = await openIdentityDb();
    const value = await new Promise<HostScopedIdentity | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).get(hostId);
      request.onsuccess = () => resolve((request.result as HostScopedIdentity | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch {
    return null;
  }
}

async function idbListHostIds(): Promise<string[]> {
  if (!idbAvailable()) return [];
  try {
    const db = await openIdentityDb();
    const keys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).getAllKeys();
      request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String));
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
  } catch {
    return [];
  }
}

async function idbClearIdentity(hostId?: string): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openIdentityDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      if (hostId) tx.objectStore(IDB_STORE).delete(hostId);
      else tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export function createBrowserIdentityStore(): BrowserIdentityStore {
  return typeof localStorage === 'undefined'
    ? new MemoryBrowserIdentityStore()
    : new LocalStorageBrowserIdentityStore();
}
