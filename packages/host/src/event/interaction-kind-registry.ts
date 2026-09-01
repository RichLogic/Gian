/**
 * Session-projector state for ACP permission-option kinds.
 *
 * The proxy passes the native `optionId -> ACP PermissionOption.kind` mapping
 * inside the schema-valid `interaction.requested.context` extension
 * (`permissionOptionKinds`). `interaction.resolved` is a strict schema that
 * carries only the opaque `actionId`, so the Host must remember the mapping
 * from the requested event to derive the Gian approval decision for the
 * resolved event BEFORE it is persisted or broadcast.
 *
 * Entries are keyed by `(sessionId, interactionId)`: protocol interactionIds
 * are only unique within one session, never globally. Live ingestion and
 * database replay both observe notifications in stream order through the same
 * registry — including replay notifications that are already persisted and
 * therefore skip projection — keeping every surface's decision identical.
 */
export class InteractionKindRegistry {
  private static readonly CAP = 256;
  /** (sessionId, interactionId) -> optionId -> ACP kind. */
  private readonly entries = new Map<string, Map<string, string>>();

  private static key(sessionId: string, approvalId: string): string {
    return `${sessionId}\u0000${approvalId}`;
  }

  record(
    sessionId: string,
    approvalId: string,
    nativeOptionsOrKinds: unknown,
  ): void {
    if (!sessionId || !approvalId) return;
    const kinds = new Map<string, string>();
    if (Array.isArray(nativeOptionsOrKinds)) {
      for (const option of nativeOptionsOrKinds) {
        if (!option || typeof option !== 'object') continue;
        const record = option as Record<string, unknown>;
        const optionId = typeof record.optionId === 'string' ? record.optionId : '';
        const kind = typeof record.kind === 'string' ? record.kind : '';
        if (optionId && kind) kinds.set(optionId, kind);
      }
    } else if (nativeOptionsOrKinds && typeof nativeOptionsOrKinds === 'object') {
      for (const [optionId, kind] of Object.entries(nativeOptionsOrKinds)) {
        if (typeof kind === 'string' && kind) kinds.set(optionId, kind);
      }
    }
    if (kinds.size === 0) return;
    const key = InteractionKindRegistry.key(sessionId, approvalId);
    if (!this.entries.has(key) && this.entries.size >= InteractionKindRegistry.CAP) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, kinds);
  }

  lookup(sessionId: string, approvalId: string): ReadonlyMap<string, string> | undefined {
    return this.entries.get(InteractionKindRegistry.key(sessionId, approvalId));
  }

  forget(sessionId: string, approvalId: string): void {
    this.entries.delete(InteractionKindRegistry.key(sessionId, approvalId));
  }

  /** Session teardown (close/quarantine/rotation/exit) must not leave stale
   *  mappings behind to collide with a future session's ids. */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
