/**
 * Sandbox profile selected for the Grok child at process start.
 * `GROK_SANDBOX` is set to this value. Enterprise managed requirements can
 * still override the process, so this is the requested profile, not a
 * confirmed effective sandbox.
 */
export const GROK_SANDBOX_PROFILES = ['workspace', 'read-only', 'strict', 'off'] as const;

export type GrokSandboxProfile = (typeof GROK_SANDBOX_PROFILES)[number];

export interface GrokSandboxSpec {
  id: GrokSandboxProfile;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export const GROK_SANDBOX_SPECS: readonly GrokSandboxSpec[] = [
  {
    id: 'workspace',
    displayName: 'Workspace',
    description: 'Default. The child is started with GROK_SANDBOX=workspace.',
    isDefault: true,
  },
  {
    id: 'read-only',
    displayName: 'Read only',
    description: 'The child is started with GROK_SANDBOX=read-only.',
    isDefault: false,
  },
  {
    id: 'strict',
    displayName: 'Strict',
    description: 'The child is started with GROK_SANDBOX=strict.',
    isDefault: false,
  },
  {
    id: 'off',
    displayName: 'Off',
    description: 'Explicitly widens access. Filesystem and network are unrestricted relative to sandboxed profiles. Approval mode is unchanged.',
    isDefault: false,
  },
];

export function parseGrokSandboxProfile(value: string | null | undefined): GrokSandboxProfile | null {
  if (value === 'workspace' || value === 'read-only' || value === 'strict' || value === 'off') return value;
  return null;
}

export function grokSandboxSpec(id: GrokSandboxProfile): GrokSandboxSpec {
  return GROK_SANDBOX_SPECS.find((spec) => spec.id === id)!;
}
