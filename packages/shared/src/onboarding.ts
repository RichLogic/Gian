import type { AgentInstallStatus } from './agents.js';

export interface OnboardingState {
  completed: boolean;
  workspaceRoot: string;
  workspaceDirectory: string;
  agents: AgentInstallStatus[];
}

export interface OnboardingWorkspaceResult {
  workspaceRoot: string;
  workspaceDirectory: string;
}
