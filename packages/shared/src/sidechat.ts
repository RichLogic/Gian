import type { ConfigOption, ConfigValue } from './model.js';
import type { MessageContextItem } from './context.js';
import type { ComposerDocument } from './context.js';

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
  context_items?: MessageContextItem[];
  composer_document?: ComposerDocument;
}

export interface SideChatPublicSnapshot {
  id: string;
  parent_session_id: string;
  /** Stable creation-order label within the parent Session. */
  ordinal: number;
  /** Agent-derived title after the first completed conversation turn. */
  name: string | null;
  stream_id: string | null;
  state: 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';
  status: SideChatStatus;
  anchor: SideChatAnchor;
  session_config: Record<string, ConfigValue>;
  /** Host-owned next-turn draft. Independent from the parent after creation. */
  turn_config?: Record<string, ConfigValue>;
  /** Proxy-advertised Turn-bound controls for this Side Chat route. */
  turn_config_options?: ConfigOption[];
  turn_config_revision?: string | null;
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
