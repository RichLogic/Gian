/** Executors exposed by the current Gian release UI.
 *
 * Grok remains a supported persisted executor so existing data and protocol
 * tests keep working, but it is intentionally absent from the 0.5.0 product
 * surface until its Proxy is ready to ship again.
 */
export function isReleaseExecutor(id: string): boolean {
  return id !== 'grok';
}

export function releaseAgents<T extends { id: string }>(agents: readonly T[]): T[] {
  return agents.filter(agent => isReleaseExecutor(agent.id));
}
