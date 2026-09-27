/** Loose inner shapes for the Kimi local server API (kimi-code 2.1.1,
 *  kap-server OpenAPI/AsyncAPI). Only fields the proxy consumes are typed;
 *  everything else stays opaque. */

export type KimiPermissionMode = 'manual' | 'yolo' | 'auto';

export interface KimiUsageSnapshot {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  total_cost_usd?: number;
  context_tokens?: number;
  context_limit?: number;
  turn_count?: number;
}

export interface KimiAgentConfig {
  model?: string;
  thinking?: string;
  permission_mode?: KimiPermissionMode;
  plan_mode?: boolean;
}

export interface KimiSessionInfo {
  id: string;
  workspace_id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  busy?: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived?: boolean;
  metadata?: { cwd?: string };
  agent_config?: KimiAgentConfig;
  usage?: KimiUsageSnapshot;
  message_count?: number;
  last_seq?: number;
}

export interface KimiWorkspace {
  id: string;
  root: string;
  name?: string;
  session_count?: number;
}

export interface KimiModelInfo {
  provider?: string;
  model: string;
  display_name?: string;
  max_context_size?: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

/** Prompt content part (POST /sessions/{id}/prompts `content[]` union). */
export type KimiContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input?: unknown }
  | { type: 'tool_result'; tool_call_id: string; output?: unknown; is_error?: boolean }
  | { type: 'image'; source: KimiMediaSource; name?: string }
  | { type: 'video'; source: KimiMediaSource; name?: string }
  | { type: 'file'; file_id?: string; path?: string; name?: string; media_type?: string; size?: number }
  | { type: 'thinking'; thinking: string; signature?: string };

export type KimiMediaSource =
  | { kind: 'url'; url: string; id?: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string }
  | { kind: 'session_media'; file_id: string }
  | { kind: 'path'; path: string };

export interface KimiMessage {
  id: string;
  session_id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: KimiContentPart[];
  created_at?: string;
  prompt_id?: string;
  parent_message_id?: string;
  metadata?: Record<string, unknown>;
}

export interface KimiMessagePage {
  items: KimiMessage[];
  has_more?: boolean;
}

/** Wire approval (event.approval.requested / GET approvals). */
export interface KimiApproval {
  approval_id: string;
  session_id: string;
  agent_id?: string;
  turn_id?: number;
  tool_call_id?: string;
  tool_name: string;
  action: string;
  tool_input_display?: unknown;
  created_at?: string;
  expires_at?: string;
}

export interface KimiQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface KimiQuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: KimiQuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
}

export interface KimiQuestion {
  question_id: string;
  session_id: string;
  agent_id?: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: KimiQuestionItem[];
  created_at?: string;
}

export interface KimiFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions?: number;
  deletions?: number;
  binary?: boolean;
  oversize?: boolean;
}

export interface KimiFileCheckpoint {
  version: number;
  content?: string;
  binary?: boolean;
}

export interface KimiTask {
  id: string;
  session_id?: string;
  kind: 'subagent' | 'bash' | 'tool';
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  command?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  model?: string;
  agent_id?: string;
  subagent_type?: string;
  parent_tool_call_id?: string;
  run_in_background?: boolean;
}

/** Tool display payload (tool.call.started `display` union) — used for the
 *  structured plan/todo facts. Only the shapes the projector consumes are
 *  spelled out; everything else is carried opaquely in details. */
export interface KimiToolDisplay {
  kind: string;
  command?: string;
  path?: string;
  operation?: string;
  query?: string;
  url?: string;
  agent_name?: string;
  skill_name?: string;
  task_id?: string;
  plan?: string;
  options?: Array<{ label: string; description?: string }>;
  items?: Array<{ title: string; status: string }>;
  summary?: string;
  detail?: string;
  [key: string]: unknown;
}
