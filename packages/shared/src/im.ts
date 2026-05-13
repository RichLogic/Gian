import type { Executor, IMPlatform } from './model.js';

export interface FileRef {
  path: string;
  op: 'add' | 'mod' | 'del';
}

export interface IMTextMessage {
  kind: 'text';
  session_id: string;
  session_name: string;
  executor: Executor;
  text: string;
  files_changed?: FileRef[];
}

export interface IMErrorMessage {
  kind: 'error';
  session_id: string;
  session_name: string;
  title: string;
  description: string;
}

export interface IMJobUpdateMessage {
  kind: 'job_update';
  session_id: string;
  session_name: string;
  turn: number;
  turns_limit: number;
  summary: string;
}

export type JobOutcome = 'success' | 'stopped' | 'limit_reached' | 'error';

export interface IMJobCompleteMessage {
  kind: 'job_complete';
  session_id: string;
  session_name: string;
  outcome: JobOutcome;
  title: string;
  summary: string;
  stats: {
    turns: number;
    ops: number;
    tokens: number;
    files_changed: number;
    duration: string;
  };
}

export interface IMSessionSummary {
  kind: 'session_summary';
  session_id: string;
  session_name: string;
  executor: Executor;
  status: string;
  recent_activity: string;
}

export type IMOutboundMessage =
  | IMTextMessage
  | IMErrorMessage
  | IMJobUpdateMessage
  | IMJobCompleteMessage
  | IMSessionSummary;

export interface InboundAttachment {
  name: string;
  url: string;
  content_type: string;
  size: number;
}

export interface IMInboundMessage {
  bot_id: string;
  platform: IMPlatform;
  user_id: string;
  channel_id: string;
  message_id: string;
  text: string;
  attachments?: InboundAttachment[];
}

export type IMSlashCommand =
  | '/new'
  | '/switch'
  | '/alter'
  | '/stop'
  | '/reset'
  | '/status';

export interface IMSlashAction {
  bot_id: string;
  platform: IMPlatform;
  user_id: string;
  channel_id: string;
  command: IMSlashCommand;
  args: Record<string, string>;
}

export interface IMAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  send(msg: IMOutboundMessage): Promise<void>;
  update(messageId: string, msg: IMOutboundMessage): Promise<void>;
}

export interface IMCallbacks {
  onMessage(action: IMInboundMessage): void;
  onSlashCommand(action: IMSlashAction): void;
  onConnectionChange(connected: boolean): void;
}
