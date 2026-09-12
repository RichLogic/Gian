import { asBufferSource, bytesToBase64Url, base64UrlToBytes } from '@gian/remote-protocol';

export interface EncryptedHostCache {
  put(hostId: string, value: unknown): Promise<void>;
  get<T>(hostId: string): Promise<T | null>;
  clear(hostId?: string): Promise<void>;
}

export interface SealedBlob {
  iv: string;
  ciphertext: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function generateSealedKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function sealWithKey(key: CryptoKey, value: unknown): Promise<SealedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(value)),
  ));
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

async function openWithKey<T>(key: CryptoKey, blob: SealedBlob): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(base64UrlToBytes(blob.iv)) },
    key,
    asBufferSource(base64UrlToBytes(blob.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export class MemoryEncryptedHostCache implements EncryptedHostCache {
  private readonly keys = new Map<string, CryptoKey>();
  private readonly blobs = new Map<string, SealedBlob>();

  async put(hostId: string, value: unknown): Promise<void> {
    const key = this.keys.get(hostId) ?? await generateSealedKey();
    const blob = await sealWithKey(key, value);
    this.keys.set(hostId, key);
    this.blobs.set(hostId, blob);
  }

  async get<T>(hostId: string): Promise<T | null> {
    const key = this.keys.get(hostId);
    const blob = this.blobs.get(hostId);
    if (!key || !blob) return null;
    return openWithKey<T>(key, blob);
  }

  async clear(hostId?: string): Promise<void> {
    if (hostId) {
      this.keys.delete(hostId);
      this.blobs.delete(hostId);
      return;
    }
    this.keys.clear();
    this.blobs.clear();
  }

  sealed(hostId: string): SealedBlob | undefined {
    return this.blobs.get(hostId);
  }

  cryptoKey(hostId: string): CryptoKey | undefined {
    return this.keys.get(hostId);
  }

  hydrate(hostId: string, key: CryptoKey, blob: SealedBlob): void {
    this.keys.set(hostId, key);
    this.blobs.set(hostId, blob);
  }
}

const DB_NAME = 'gian-remote-cache';
const DB_VERSION = 2;
const KEY_STORE = 'keys';
const BLOB_STORE = 'blobs';

export class IndexedDbEncryptedHostCache implements EncryptedHostCache {
  private readonly memory = new MemoryEncryptedHostCache();

  static available(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async put(hostId: string, value: unknown): Promise<void> {
    await this.memory.put(hostId, value);
    const key = this.memory.cryptoKey(hostId);
    const blob = this.memory.sealed(hostId);
    if (key && blob && IndexedDbEncryptedHostCache.available()) {
      await idbPut(KEY_STORE, hostId, key);
      await idbPut(BLOB_STORE, hostId, blob);
    }
  }

  async get<T>(hostId: string): Promise<T | null> {
    const memory = await this.memory.get<T>(hostId);
    if (memory) return memory;
    if (!IndexedDbEncryptedHostCache.available()) return null;
    const key = await idbGet<CryptoKey>(KEY_STORE, hostId);
    const blob = await idbGet<SealedBlob>(BLOB_STORE, hostId);
    if (!key || !blob) return null;
    this.memory.hydrate(hostId, key, blob);
    return openWithKey<T>(key, blob);
  }

  async clear(hostId?: string): Promise<void> {
    await this.memory.clear(hostId);
    if (IndexedDbEncryptedHostCache.available()) {
      await idbClear(KEY_STORE, hostId);
      await idbClear(BLOB_STORE, hostId);
    }
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains('hosts')) db.deleteObjectStore('hosts');
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(store: string, hostId: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, hostId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(store: string, hostId: string): Promise<T | null> {
  const db = await openDb();
  const value = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(hostId);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function idbClear(store: string, hostId?: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    if (hostId) tx.objectStore(store).delete(hostId);
    else tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function createEncryptedHostCache(): EncryptedHostCache {
  return IndexedDbEncryptedHostCache.available()
    ? new IndexedDbEncryptedHostCache()
    : new MemoryEncryptedHostCache();
}
