import { createRuntimeInstallPlanner, type RuntimeInstallPlanParams } from '@gian/proxy-protocol';
import type { ManagedRuntimeInstallPlan } from '@gian/shared';

export async function fixtureInstallPlan(_plan: ManagedRuntimeInstallPlan, input: RuntimeInstallPlanParams) {
  return createRuntimeInstallPlanner({
    runtimeId: input.runtimeId,
    kind: input.distribution.kind,
    ...(input.distribution.kind === 'managed' ? {
      format: input.distribution.format, entryRelativePath: input.distribution.entryRelativePath,
    } : {}),
  })(input);
}
