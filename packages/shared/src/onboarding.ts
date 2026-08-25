import type { UserAgentStatus } from './agents.js';

export interface OnboardingState {
  completed: boolean;
  projectRoot: string;
  agents: UserAgentStatus[];
}

export interface OnboardingProjectRootResult {
  projectRoot: string;
}
