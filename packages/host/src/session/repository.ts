import type {
  ConfigOption,
  ExecutorConfigState,
  NativeConfigOption,
  Session,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

const EMPTY_EXECUTOR_CONFIG: ExecutorConfigState = {
  schemaVersion: 1,
  values: {},
};

type SessionRow = Omit<
  Session,
  'executor_config' | 'native_config_options' | 'turn_config' | 'turn_config_options' | 'origin' | 'available_actions'
> & {
  executor_config_json?: string | null;
  turn_config_json?: string | null;
  turn_config_options_json?: string | null;
  fork_from_session_id?: string | null;
  origin_kind?: string | null;
  origin_session_id?: string | null;
  origin_turn_id?: string | null;
  origin_source_turn_id?: string | null;
  origin_source_stream_id?: string | null;
  origin_anchor_type?: 'head' | 'turn' | null;
  available_actions_json?: string | null;
  runtime_profile_json?: string | null;
};

function parseRuntimeProfile(
  value: string | null | undefined,
): Session['runtime_profile'] | undefined {
  if (!value) return undefined;
  try {
    const profile = JSON.parse(value) as Record<string, unknown>;
    const skill = profile.skill as Record<string, unknown> | undefined;
    if (
      typeof profile.id === 'string'
      && typeof profile.agentId === 'string'
      && (profile.proxy === 'codex' || profile.proxy === 'claude'
        || profile.proxy === 'kimi' || profile.proxy === 'dsh')
      && typeof profile.cliPath === 'string'
      && typeof profile.cliVersion === 'string'
      && (profile.configHome === null || typeof profile.configHome === 'string')
      && (profile.cliFingerprint === null || typeof profile.cliFingerprint === 'string')
      && typeof profile.proxyVersion === 'string'
      && Array.isArray(profile.verifiedCliVersions)
      && profile.verifiedCliVersions.every(item => typeof item === 'string')
      && (profile.verification === 'verified' || profile.verification === 'unverified')
      && skill?.name === 'gian-session'
      && typeof skill.version === 'string'
      && (skill.state === 'ready' || skill.state === 'missing'
        || skill.state === 'conflict' || skill.state === 'invalid')
    ) {
      return profile as unknown as NonNullable<Session['runtime_profile']>;
    }
  } catch {
    // Malformed snapshots fail closed to the legacy Agent resolver.
  }
  return undefined;
}

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

function parseTurnConfig(value: string | null | undefined): Record<string, string | boolean | number | null> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string | boolean | number | null>;
    }
  } catch {
    // Malformed drafts are ignored; startTurn falls back to role columns.
  }
  return {};
}

function parseAvailableActions(
  value: string | null | undefined,
): Session['available_actions'] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Session['available_actions'];
    }
  } catch {
    // Malformed action snapshots are ignored until the next session.updated.
  }
  return undefined;
}

function parseTurnConfigOptions(value: string | null | undefined): ConfigOption[] | undefined {
  if (value == null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed as ConfigOption[];
  } catch {
    // Malformed snapshots fall back to the process catalog.
  }
  return undefined;
}

export function executorConfigFromOptions(
  options: NativeConfigOption[],
): ExecutorConfigState {
  return {
    schemaVersion: 1,
    values: Object.fromEntries(
      options
        .filter((option) => option.scope === 'session')
        .map((option) => [option.id, option.currentValue]),
    ),
  };
}

export class SessionRepository {
  private nativeOptions = new Map<string, NativeConfigOption[]>();

  constructor(private db: Db) {}

  get(id: string): Session {
    const session = this.find(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  find(id: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? this.hydrate(row) : null;
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

  setNativeOptions(sessionId: string, options: NativeConfigOption[]): void {
    this.nativeOptions.set(sessionId, options);
  }

  forget(sessionId: string): void {
    this.nativeOptions.delete(sessionId);
  }

  private hydrate(row: SessionRow): Session {
    const {
      executor_config_json: executorConfigJson,
      turn_config_json: turnConfigJson,
      turn_config_options_json: turnConfigOptionsJson,
      fork_from_session_id: _forkFromSessionId,
      origin_kind: originKind,
      origin_session_id: originSessionId,
      origin_turn_id: originTurnId,
      origin_source_turn_id: originSourceTurnId,
      origin_source_stream_id: _originSourceStreamId,
      origin_anchor_type: _originAnchorType,
      available_actions_json: availableActionsJson,
      runtime_profile_json: runtimeProfileJson,
      created_by_actor_kind: createdByActorKind,
      created_by_actor_id: createdByActorId,
      created_by_session_id: createdBySessionId,
      native_session_id: nativeSessionId,
      ...stored
    } = row;
    const turnConfigOptions = parseTurnConfigOptions(turnConfigOptionsJson);
    const availableActions = parseAvailableActions(availableActionsJson);
    return {
      ...stored,
      native_session_id: nativeSessionId || null,
      executor_config: parseExecutorConfig(executorConfigJson),
      turn_config: parseTurnConfig(turnConfigJson),
      ...(turnConfigOptions !== undefined ? { turn_config_options: turnConfigOptions } : {}),
      ...(parseRuntimeProfile(runtimeProfileJson) !== undefined
        ? { runtime_profile: parseRuntimeProfile(runtimeProfileJson) }
        : {}),
      native_config_options: this.nativeOptions.get(row.id) ?? [],
      ...(createdByActorKind && createdByActorId
        ? {
            created_by_actor_kind: createdByActorKind,
            created_by_actor_id: createdByActorId,
            created_by_session_id: createdBySessionId ?? null,
          }
        : {}),
      ...(originKind === 'fork' && originSessionId && originTurnId && originSourceTurnId
        ? {
            origin: {
              kind: 'fork' as const,
              session_id: originSessionId,
              turn_id: originTurnId,
              source_turn_id: originSourceTurnId,
            },
          }
        : {}),
      ...(availableActions ? { available_actions: availableActions } : {}),
    } as Session;
  }
}
