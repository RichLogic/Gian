import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type GianBrowserLifecycle,
  type GianBrowserPageReference,
} from '@gian/shared';

export interface BrowserTabMetadata {
  id: string;
  profileId: string;
  sourceSessionId: string | null;
  pageGeneration: number;
  lifecycle: GianBrowserLifecycle;
  requestedVisible: boolean;
  presented: boolean;
  control: 'idle' | 'controlled';
}

export interface BrowserControlLease {
  id: string;
  tabId: string;
  ownerId: string;
  acquiredAt: number;
}

export class BrowserControlConflictError extends Error {
  constructor(tabId: string) {
    super(`Browser tab ${tabId} is already controlled`);
    this.name = 'BrowserControlConflictError';
  }
}

interface BrowserTabRecord extends Omit<BrowserTabMetadata, 'control'> {
  lease: BrowserControlLease | null;
}

interface BrowserDomainOptions {
  idFactory?: () => string;
  now?: () => number;
  profileId?: string;
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`${label} is invalid`);
  return normalized;
}

function metadata(record: BrowserTabRecord): BrowserTabMetadata {
  return {
    id: record.id,
    profileId: record.profileId,
    sourceSessionId: record.sourceSessionId,
    pageGeneration: record.pageGeneration,
    lifecycle: record.lifecycle,
    requestedVisible: record.requestedVisible,
    presented: record.presented,
    control: record.lease ? 'controlled' : 'idle',
  };
}

/** Main-process Browser identity and lifecycle state. It deliberately has no
 * Electron dependency so Browser presentation, persistence, and future Agent
 * adapters share one deterministic contract. */
export class BrowserDomain {
  private readonly tabs = new Map<string, BrowserTabRecord>();
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly profileId: string;

  constructor(options: BrowserDomainOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.profileId = requireId(options.profileId ?? DEFAULT_BROWSER_PROFILE_ID, 'Browser profile id');
  }

  createTab(input: { tabId?: string; sourceSessionId?: string | null } = {}): BrowserTabMetadata {
    const tabId = requireId(input.tabId ?? `browser-${this.idFactory()}`, 'Browser tab id');
    return this.ensureTab(tabId, input.sourceSessionId);
  }

  ensureTab(tabId: string, sourceSessionId?: string | null): BrowserTabMetadata {
    const id = requireId(tabId, 'Browser tab id');
    const existing = this.tabs.get(id);
    if (existing) {
      if (existing.sourceSessionId === null && sourceSessionId) {
        existing.sourceSessionId = requireId(sourceSessionId, 'Source Session id');
      }
      return metadata(existing);
    }
    const record: BrowserTabRecord = {
      id,
      profileId: this.profileId,
      sourceSessionId: sourceSessionId ? requireId(sourceSessionId, 'Source Session id') : null,
      pageGeneration: 0,
      lifecycle: 'empty',
      requestedVisible: false,
      presented: false,
      lease: null,
    };
    this.tabs.set(id, record);
    return metadata(record);
  }

  getTab(tabId: string): BrowserTabMetadata | null {
    const record = this.tabs.get(tabId);
    return record ? metadata(record) : null;
  }

  listTabs(): BrowserTabMetadata[] {
    return [...this.tabs.values()].map(metadata);
  }

  replacePage(tabId: string): GianBrowserPageReference {
    const record = this.requireTab(tabId);
    record.pageGeneration += 1;
    record.lifecycle = 'empty';
    return this.pageReference(record);
  }

  beginNavigation(tabId: string): GianBrowserPageReference {
    const record = this.requireTab(tabId);
    record.pageGeneration += 1;
    record.lifecycle = 'loading';
    return this.pageReference(record);
  }

  markLoading(tabId: string): void {
    this.requireTab(tabId).lifecycle = 'loading';
  }

  markReady(tabId: string): void {
    this.requireTab(tabId).lifecycle = 'ready';
  }

  finishLoading(tabId: string, hasPage: boolean): void {
    const record = this.requireTab(tabId);
    if (record.lifecycle === 'error' || record.lifecycle === 'crashed') return;
    record.lifecycle = hasPage ? 'ready' : 'empty';
  }

  markEmpty(tabId: string): void {
    this.requireTab(tabId).lifecycle = 'empty';
  }

  markError(tabId: string): void {
    this.requireTab(tabId).lifecycle = 'error';
  }

  markCrashed(tabId: string): void {
    this.requireTab(tabId).lifecycle = 'crashed';
  }

  setVisibility(tabId: string, requestedVisible: boolean, presented: boolean): void {
    const record = this.requireTab(tabId);
    record.requestedVisible = requestedVisible;
    record.presented = requestedVisible && presented;
  }

  currentPage(tabId: string): GianBrowserPageReference {
    return this.pageReference(this.requireTab(tabId));
  }

  isCurrentPage(reference: GianBrowserPageReference): boolean {
    const record = this.tabs.get(reference.tabId);
    return !!record && record.pageGeneration === reference.pageGeneration;
  }

  acquireControl(tabId: string, ownerId: string): BrowserControlLease {
    const record = this.requireTab(tabId);
    const owner = requireId(ownerId, 'Browser control owner id');
    if (record.lease) {
      if (record.lease.ownerId === owner) return { ...record.lease };
      throw new BrowserControlConflictError(tabId);
    }
    record.lease = {
      id: `browser-control-${this.idFactory()}`,
      tabId: record.id,
      ownerId: owner,
      acquiredAt: this.now(),
    };
    return { ...record.lease };
  }

  releaseControl(lease: Pick<BrowserControlLease, 'id' | 'tabId'>): boolean {
    const record = this.tabs.get(lease.tabId);
    if (!record?.lease || record.lease.id !== lease.id) return false;
    record.lease = null;
    return true;
  }

  closeTab(tabId: string): BrowserTabMetadata | null {
    const record = this.tabs.get(tabId);
    if (!record) return null;
    this.tabs.delete(tabId);
    return metadata(record);
  }

  private requireTab(tabId: string): BrowserTabRecord {
    const record = this.tabs.get(tabId);
    if (!record) throw new Error(`Unknown Browser tab: ${tabId}`);
    return record;
  }

  private pageReference(record: BrowserTabRecord): GianBrowserPageReference {
    return { tabId: record.id, pageGeneration: record.pageGeneration };
  }
}
