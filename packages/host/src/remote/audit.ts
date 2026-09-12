import { randomUUID } from 'node:crypto';
import type { RemoteMethod } from '@gian/remote-protocol';
import type { Db } from '../storage/db.js';

export const REMOTE_AUDIT_LIMIT_PER_DEVICE = 1000;

export type RemoteAuditCategory =
  | 'accepted'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired'
  | 'unknown_outcome'
  | 'precondition_failed';

export interface RemoteAuditRecord {
  id: string;
  deviceId: string;
  method: RemoteMethod;
  commandId: string;
  resultCategory: RemoteAuditCategory;
  createdAt: string;
}

export class RemoteMutationAudit {
  constructor(
    private readonly db: Db,
    private readonly limit = REMOTE_AUDIT_LIMIT_PER_DEVICE,
  ) {}

  write(input: {
    deviceId: string;
    method: RemoteMethod;
    commandId: string;
    resultCategory: RemoteAuditCategory;
  }): RemoteAuditRecord {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO remote_mutation_audit
          (id, device_id, method, command_id, result_category, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.deviceId, input.method, input.commandId, input.resultCategory, createdAt);
      this.db.prepare(
        `DELETE FROM remote_mutation_audit
          WHERE device_id = ?
            AND id NOT IN (
              SELECT id FROM remote_mutation_audit
               WHERE device_id = ?
               ORDER BY created_at DESC
               LIMIT ?
            )`,
      ).run(input.deviceId, input.deviceId, this.limit);
    })();
    return {
      id,
      deviceId: input.deviceId,
      method: input.method,
      commandId: input.commandId,
      resultCategory: input.resultCategory,
      createdAt,
    };
  }

  list(deviceId: string): RemoteAuditRecord[] {
    return (this.db.prepare(
      `SELECT id, device_id, method, command_id, result_category, created_at
         FROM remote_mutation_audit
        WHERE device_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(deviceId, this.limit) as Array<{
      id: string;
      device_id: string;
      method: RemoteMethod;
      command_id: string;
      result_category: RemoteAuditCategory;
      created_at: string;
    }>).map(row => ({
      id: row.id,
      deviceId: row.device_id,
      method: row.method,
      commandId: row.command_id,
      resultCategory: row.result_category,
      createdAt: row.created_at,
    }));
  }
}
