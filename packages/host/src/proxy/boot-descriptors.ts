import type { Executor } from '@gian/shared';
import { PRODUCT_EXECUTORS, type ProductExecutor } from '@gian/shared';
import type { AgentManager, ProxyLaunchDescriptor } from '../agents/manager.js';

export interface BootProxyDescriptors {
  claude: ProxyLaunchDescriptor;
  codex?: ProxyLaunchDescriptor;
  kimi?: ProxyLaunchDescriptor;
  grok?: ProxyLaunchDescriptor;
  dsh?: ProxyLaunchDescriptor;
}

/**
 * Lazy boot load set (issue #97): only the Proxy kinds referenced by SAVED
 * Agents get a validated launch descriptor at boot — for those kinds the
 * descriptor resolution may realpath the installed plugin and spawn its
 * self-test. Kinds no saved Agent uses get a nominal, unvalidated entry
 * (no realpath, no manifest read, no self-test spawn); their proxies never
 * start because no session can reference them. A load-set change requires
 * an app restart by design, at which point the new kinds resolve for real.
 */
export async function resolveBootProxyDescriptors(
  agents: AgentManager,
): Promise<BootProxyDescriptors> {
  const usedKinds = new Set<ProductExecutor>(
    agents.listAgents().map(agent => agent.proxy),
  );
  const resolve = async (id: Executor): Promise<ProxyLaunchDescriptor> => {
    if (
      (PRODUCT_EXECUTORS as readonly string[]).includes(id)
      && usedKinds.has(id as ProductExecutor)
    ) {
      return agents.proxyLaunchDescriptor(id);
    }
    try {
      return { entryPath: agents.proxyEntry(id) };
    } catch {
      // No entry configured for an unused kind — it can never spawn anyway.
      return { entryPath: '' };
    }
  };
  const [claude, codex, kimi, grok, dsh] = await Promise.all([
    resolve('claude'),
    resolve('codex'),
    resolve('kimi'),
    resolve('grok'),
    resolve('dsh'),
  ]);
  return { claude, codex, kimi, grok, dsh };
}
