/**
 * Provider Home resolution shared by the runtime spawn path and the MCP
 * disk scan, so both always read the same directory.
 *
 * The Host-provided constrained GIAN_AGENT_HOME wins; an inherited GROK_HOME
 * is only a compatibility fallback for the pre-gate Host generation.
 */
export function agentHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GIAN_AGENT_HOME !== undefined && env.GIAN_AGENT_HOME !== '') return env.GIAN_AGENT_HOME;
  return env.GROK_HOME;
}

/** Provider-specific child env: translates the Host's constrained
 *  GIAN_AGENT_HOME into GROK_HOME so the CLI reads its state from the served
 *  Agent's HOME and never from a stale machine-wide value. */
export function grokChildHomeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const home = agentHome(env);
  return home !== undefined ? { GROK_HOME: home } : {};
}
