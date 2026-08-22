import type { ConfigValue } from './model.js';

export type SideChatStatus = 'open' | 'closing' | 'unavailable';

export type SideChatAnchor =
  | { type: 'empty' }
  | { type: 'turn'; turn_id: string; source_turn_id: string }
  | { type: 'activeInput'; turn_id: string; source_turn_id: string };

export interface SideChatAvailableAction {
  enabled: boolean;
  reason?: string;
}

export interface SideChatUserInput {
  turn_id: string;
  input: unknown;
  created_at: string;
}

export interface SideChatPublicSnapshot {
  id: string;
  parent_session_id: string;
  stream_id: string | null;
  state: 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';
  status: SideChatStatus;
  anchor: SideChatAnchor;
  session_config: Record<string, ConfigValue>;
  last_error: string | null;
  uncertain_turn_id: string | null;
  events: unknown[];
  user_inputs: SideChatUserInput[];
  created_at: string;
  updated_at: string;
}

export interface SessionOrigin {
  kind: 'fork';
  session_id: string;
  turn_id: string;
  source_turn_id: string;
}

export interface SessionAvailableAction {
  enabled: boolean;
  reason?: string;
}

export type SessionAvailableActions = Record<string, SessionAvailableAction>;

export interface CatalogActionDescriptor {
  id: string;
  supported: boolean;
  reason?: string;
}
