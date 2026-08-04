import type { AgentInstallStatus } from './agents.js';

export interface OnboardingState {
  completed: boolean;
  projectRoot: string;
  agents: AgentInstallStatus[];
}

export interface OnboardingProjectRootResult {
  projectRoot: string;
}
