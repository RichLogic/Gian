import type { ProtocolV2Host } from './protocol-v2-session-client.js';

interface HostRetirement {
  host: ProtocolV2Host;
  promise: Promise<void> | null;
  failure?: { error: unknown; reported: boolean };
}

/**
 * Provider-neutral shared-host registry. Keys are exact launch identities;
 * this module must not branch on plugin or executor literals.
 */
export class ProxySupervisor {
  private readonly sharedHosts = new Map<string, ProtocolV2Host>();
  private readonly sharedHostInits = new Map<string, Promise<ProtocolV2Host>>();
  private readonly initOwners = new Map<string, string>();
  private readonly retirements = new Map<ProtocolV2Host, HostRetirement>();
  private readonly ownerByHost = new WeakMap<ProtocolV2Host, string>();
  private readonly keyByHost = new WeakMap<ProtocolV2Host, string>();

  getShared(key: string): ProtocolV2Host | undefined {
    return this.sharedHosts.get(key);
  }

  hasShared(host: ProtocolV2Host): boolean {
    return [...this.sharedHosts.values()].includes(host);
  }

  listShared(): ProtocolV2Host[] {
    return [...this.sharedHosts.values()];
  }

  ownerOf(host: ProtocolV2Host): string | undefined {
    return this.ownerByHost.get(host);
  }

  setShared(key: string, host: ProtocolV2Host, ownerKey: string): void {
    this.sharedHosts.set(key, host);
    this.ownerByHost.set(host, ownerKey);
    this.keyByHost.set(host, key);
  }

  keyOf(host: ProtocolV2Host): string | undefined {
    return this.keyByHost.get(host);
  }

  deleteShared(key: string, host?: ProtocolV2Host): void {
    const current = this.sharedHosts.get(key);
    if (host && current !== host) return;
    this.sharedHosts.delete(key);
  }

  deleteHost(host: ProtocolV2Host): void {
    const key = this.keyByHost.get(host);
    if (key) this.deleteShared(key, host);
    for (const [currentKey, current] of this.sharedHosts) {
      if (current === host) this.sharedHosts.delete(currentKey);
    }
  }

  hostsForOwner(ownerKey: string): ProtocolV2Host[] {
    return this.listShared().filter((host) => this.ownerByHost.get(host) === ownerKey);
  }

  pendingInitsFor(ownerKey: string): Promise<ProtocolV2Host>[] {
    return [...this.sharedHostInits.entries()]
      .filter(([key]) => this.initOwners.get(key) === ownerKey)
      .map(([, pending]) => pending);
  }

  async getOrStart(
    key: string,
    ownerKey: string,
    start: () => Promise<ProtocolV2Host>,
  ): Promise<ProtocolV2Host> {
    const current = this.sharedHosts.get(key);
    if (current) return current;
    let pending = this.sharedHostInits.get(key);
    if (!pending) {
      pending = start();
      this.sharedHostInits.set(key, pending);
      this.initOwners.set(key, ownerKey);
    }
    try {
      return await pending;
    } finally {
      if (this.sharedHostInits.get(key) === pending) this.sharedHostInits.delete(key);
      if (this.initOwners.get(key) === ownerKey && !this.sharedHostInits.has(key)) {
        this.initOwners.delete(key);
      }
    }
  }

  isRetiring(host: ProtocolV2Host): boolean {
    return this.retirements.has(host);
  }

  hasRetirementsFor(ownerKey: string): boolean {
    for (const host of this.retirements.keys()) {
      if (this.ownerByHost.get(host) === ownerKey) return true;
    }
    return false;
  }

  retirementHosts(ownerKey?: string): ProtocolV2Host[] {
    const hosts = [...this.retirements.keys()];
    if (ownerKey === undefined) return hosts;
    return hosts.filter((host) => this.ownerByHost.get(host) === ownerKey);
  }

  rememberOwner(host: ProtocolV2Host, ownerKey: string): void {
    this.ownerByHost.set(host, ownerKey);
  }

  detachForRetirement(host: ProtocolV2Host): string[] {
    const keys: string[] = [];
    for (const [key, current] of this.sharedHosts) {
      if (current === host) {
        this.sharedHosts.delete(key);
        keys.push(key);
      }
    }
    if (!this.retirements.has(host)) {
      this.retirements.set(host, { host, promise: null });
    }
    return keys;
  }

  beginRetirement(
    host: ProtocolV2Host,
    attempt: Promise<void>,
    onSettled: (ok: boolean, error?: unknown) => void,
  ): Promise<void> {
    this.detachForRetirement(host);
    const record = this.retirements.get(host)!;
    if (record.promise) return record.promise;
    record.failure = undefined;
    record.promise = attempt;
    void attempt.then(
      () => {
        if (this.retirements.get(host) === record) this.retirements.delete(host);
        onSettled(true);
      },
      (error: unknown) => {
        if (this.retirements.get(host) === record) {
          record.promise = null;
          record.failure = { error, reported: false };
        }
        onSettled(false, error);
      },
    );
    return attempt;
  }

  retirementPromise(host: ProtocolV2Host): Promise<void> | null {
    return this.retirements.get(host)?.promise ?? null;
  }
}
