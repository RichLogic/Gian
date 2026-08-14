export const GROK_PERMISSION_MODES = [
  'default',
  'auto',
  'always_approve',
] as const;

export type GrokPermissionMode = (typeof GROK_PERMISSION_MODES)[number];

export interface GrokPermissionSpec {
  id: GrokPermissionMode;
  displayName: string;
  description: string;
  isDefault: boolean;
  approval: 'relay' | 'auto' | 'never';
  workspace: 'workspace-write';
  network: 'allow';
  createMeta: { yoloMode: boolean; autoMode: boolean };
  runtime: {
    permission_mode: 'default' | 'auto' | 'always-approve';
    yolo_mode: boolean;
    auto_mode: boolean;
  };
}

export const GROK_PERMISSION_SPECS: readonly GrokPermissionSpec[] = [
  {
    id: 'default',
    displayName: '默认（逐次确认）',
    description: 'Ask before running tools.',
    isDefault: true,
    approval: 'relay',
    workspace: 'workspace-write',
    network: 'allow',
    createMeta: { yoloMode: false, autoMode: false },
    runtime: { permission_mode: 'default', yolo_mode: false, auto_mode: false },
  },
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Approve safe tools automatically.',
    isDefault: false,
    approval: 'auto',
    workspace: 'workspace-write',
    network: 'allow',
    createMeta: { yoloMode: false, autoMode: true },
    runtime: { permission_mode: 'auto', yolo_mode: false, auto_mode: true },
  },
  {
    id: 'always_approve',
    displayName: 'Always approve',
    description: 'Skip tool permission prompts. Workspace sandbox stays on.',
    isDefault: false,
    approval: 'never',
    workspace: 'workspace-write',
    network: 'allow',
    createMeta: { yoloMode: true, autoMode: false },
    runtime: { permission_mode: 'always-approve', yolo_mode: true, auto_mode: false },
  },
];

export function parseGrokPermissionMode(value: string | null | undefined): GrokPermissionMode | null {
  if (value === 'default' || value === 'auto' || value === 'always_approve') return value;
  return null;
}

export function grokPermissionSpec(id: GrokPermissionMode): GrokPermissionSpec {
  return GROK_PERMISSION_SPECS.find(spec => spec.id === id)!;
}

export function migrateLegacyGrokMode(
  storedMode: string,
  storedThinking: string,
): { mode: GrokPermissionMode; thinking: string } {
  if (parseGrokPermissionMode(storedMode)) {
    return { mode: storedMode as GrokPermissionMode, thinking: storedThinking };
  }
  const effortLike = /^(none|minimal|low|medium|high|xhigh|max)$/i.test(storedMode);
  return {
    mode: 'default',
    thinking: !storedThinking && effortLike ? storedMode : storedThinking,
  };
}
