import type {
  ExecutorConfigState,
  NativeConfigOption,
  Session,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

const EMPTY_EXECUTOR_CONFIG: ExecutorConfigState = {
  schemaVersion: 1,
  values: {},
};

type SessionRow = Omit<Session, 'executor_config' | 'native_config_options'> & {
  executor_config_json?: string | null;
  fork_from_session_id?: string | null;
};

function parseExecutorConfig(value: string | null | undefined): ExecutorConfigState {
  if (!value) return { ...EMPTY_EXECUTOR_CONFIG, values: {} };
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      values?: unknown;
    };
    if (
      parsed.schemaVersion === 1
      && parsed.values
      && typeof parsed.values === 'object'
      && !Array.isArray(parsed.values)
    ) {
      return {
        schemaVersion: 1,
        values: parsed.values as ExecutorConfigState['values'],
      };
    }
  } catch {
    // Older or malformed snapshots fall back to an empty compatible state.
  }
  return { ...EMPTY_EXECUTOR_CONFIG, values: {} };
}

export function executorConfigFromOptions(
  options: NativeConfigOption[],
): ExecutorConfigState {
  return {
    schemaVersion: 1,
    values: Object.fromEntries(options.map(option => [option.id, option.currentValue])),
  };
}

export class SessionRepository {
  private nativeOptions = new Map<string, NativeConfigOption[]>();

  constructor(private db: Db) {}

  get(id: string): Session {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!row) throw new Error(`session not found: ${id}`);
    return this.hydrate(row);
  }

  list(opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Session[] {
    let where = 'archived = 0';
    if (opts.archivedOnly) where = 'archived = 1';
    else if (opts.includeArchived) where = '1=1';
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY updated_at DESC`)
      .all() as SessionRow[];
    return rows.map(row => this.hydrate(row));
  }

  findManager(taskId: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE task_id = ? AND type = 'manager' LIMIT 1`)
      .get(taskId) as SessionRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  setNativeOptions(sessionId: string, options: NativeConfigOption[]): void {
    this.nativeOptions.set(sessionId, options);
  }

  forget(sessionId: string): void {
    this.nativeOptions.delete(sessionId);
  }

  private hydrate(row: SessionRow): Session {
    const {
      executor_config_json: executorConfigJson,
      fork_from_session_id: _forkFromSessionId,
      ...stored
    } = row;
    return {
      ...stored,
      executor_config: parseExecutorConfig(executorConfigJson),
      native_config_options: this.nativeOptions.get(row.id) ?? [],
    } as Session;
  }
}
