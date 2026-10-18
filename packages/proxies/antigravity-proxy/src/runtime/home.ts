import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { AntigravityRuntimeError } from './errors.js';

/**
 * Gemini root for this process.
 *
 * `GIAN_AGENT_HOME` is that root when the Host set it. Otherwise an explicit
 * `GEMINI_HOME` is kept. With neither, the official default is `~/.gemini`.
 * The value is the Gemini root itself, never an `antigravity-acp/` child.
 * This function does not read Keychain or copy credential files.
 */
export function resolveGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = firstExplicitHome(env);
  if (explicit) return expandGeminiPath(explicit, env);
  return join(homeDir(env), '.gemini');
}

/**
 * Environment for an Antigravity child. `HOME` is copied through unchanged.
 * `GEMINI_HOME` is set only for an explicit Agent home or an explicit
 * `GEMINI_HOME`; otherwise it is omitted so the server uses `~/.gemini`.
 * The paired harness path is applied by the process spawner, not here.
 */
export function antigravityChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const agentHome = nonEmpty(env.GIAN_AGENT_HOME);
  const geminiHome = nonEmpty(env.GEMINI_HOME);
  if (agentHome) {
    next.GEMINI_HOME = expandGeminiPath(agentHome, env);
  } else if (geminiHome) {
    next.GEMINI_HOME = expandGeminiPath(geminiHome, env);
  } else {
    delete next.GEMINI_HOME;
  }
  return next;
}

function firstExplicitHome(env: NodeJS.ProcessEnv): string | undefined {
  return nonEmpty(env.GIAN_AGENT_HOME) ?? nonEmpty(env.GEMINI_HOME);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  if (typeof env.HOME === 'string' && isAbsolute(env.HOME)) return env.HOME;
  return homedir();
}

function expandGeminiPath(value: string, env: NodeJS.ProcessEnv): string {
  let expanded = value;
  if (value === '~') expanded = homeDir(env);
  else if (value.startsWith('~/')) expanded = join(homeDir(env), value.slice(2));
  if (!isAbsolute(expanded) || expanded.includes('\0')) {
    throw new AntigravityRuntimeError('Gemini home must be an absolute path or start with ~.');
  }
  return expanded;
}
