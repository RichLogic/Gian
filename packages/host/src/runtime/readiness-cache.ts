import type { CatalogRuntimeState } from '@gian/shared';
import type { OpenRuntimeProfile } from '@gian/shared';

import type { RuntimeObservation } from './resolver.js';

export interface RuntimeReadinessSnapshot {
  pluginId: string;
  pluginVersion: string;
  selectedPath: string | null;
  profileIdentity: string | null;
  state: CatalogRuntimeState;
  displayName: string | null;
  readinessIssue?: { code: string; message: string; repairable: boolean };
  profile?: OpenRuntimeProfile;
  observation?: RuntimeObservation;
  invalidated?: boolean;
}

function versionKey(pluginId: string, pluginVersion: string): string {
  return `${pluginId}\0${pluginVersion}`;
}

function exactKey(pluginId: string, pluginVersion: string, selectedPath: string | null): string {
  return `${versionKey(pluginId, pluginVersion)}\0${selectedPath ?? ''}`;
}

/**
 * Side-effect-free Catalog projection of the last explicit discover/probe.
 * Never substitutes for the final Agent/session mutation checks.
 * `invalidated` sentinels keep Catalog/status non-ready after a mutation
 * until a later explicit probe republishes a complete profile.
 */
export class RuntimeReadinessCache {
  private readonly exact = new Map<string, RuntimeReadinessSnapshot>();
  private readonly latest = new Map<string, string>();

  get(
    pluginId: string,
    pluginVersion: string,
    selectedPath?: string | null,
  ): RuntimeReadinessSnapshot | null {
    if (selectedPath !== undefined) {
      return this.exact.get(exactKey(pluginId, pluginVersion, selectedPath)) ?? null;
    }
    const latest = this.latest.get(versionKey(pluginId, pluginVersion));
    return latest ? this.exact.get(latest) ?? null : null;
  }

  isInvalidated(
    pluginId: string,
    pluginVersion: string,
    selectedPath?: string | null,
  ): boolean {
    const snapshot = this.get(pluginId, pluginVersion, selectedPath);
    if (snapshot?.invalidated) return true;
    if (selectedPath !== undefined) return false;
    for (const item of this.exact.values()) {
      if (item.pluginId === pluginId && item.pluginVersion === pluginVersion && item.invalidated) {
        return true;
      }
    }
    return false;
  }

  publish(snapshot: RuntimeReadinessSnapshot): void {
    const key = exactKey(snapshot.pluginId, snapshot.pluginVersion, snapshot.selectedPath);
    this.exact.set(key, { ...snapshot, invalidated: false });
    this.latest.set(versionKey(snapshot.pluginId, snapshot.pluginVersion), key);
  }

  observations(): RuntimeObservation[] {
    const result: RuntimeObservation[] = [];
    for (const snapshot of this.exact.values()) {
      if (snapshot.observation && !snapshot.invalidated) {
        result.push(snapshot.observation);
      }
    }
    return result;
  }

  invalidate(pluginId: string, pluginVersion?: string, selectedPath?: string | null): void {
    for (const [key, snapshot] of this.exact) {
      if (snapshot.pluginId !== pluginId) continue;
      if (pluginVersion && snapshot.pluginVersion !== pluginVersion) continue;
      if (selectedPath !== undefined && snapshot.selectedPath !== selectedPath) continue;
      this.exact.set(key, {
        ...snapshot,
        state: 'invalid',
        invalidated: true,
        profile: undefined,
        profileIdentity: null,
      });
    }
    for (const [key] of this.latest) {
      if (!key.startsWith(`${pluginId}\0`)) continue;
      if (pluginVersion && key !== versionKey(pluginId, pluginVersion)) continue;
      const latest = this.latest.get(key);
      if (latest) {
        const snapshot = this.exact.get(latest);
        if (snapshot && selectedPath !== undefined && snapshot.selectedPath !== selectedPath) {
          continue;
        }
      }
    }
  }
}
