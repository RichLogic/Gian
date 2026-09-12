#!/usr/bin/env node
/** Fake Claude Code runtime for cc-proxy protocol-v2 CLI tests.
 *
 *  It intentionally never contacts a Provider. It answers `--help` for
 *  billing-safe capability discovery and emits a deterministic stream-json
 *  turn when spawned as `claude -p ... --output-format stream-json`. */

const args = process.argv.slice(2);

if (args.includes('--help')) {
  // Test seam: FAKE_CLAUDE_HELP_DELAY_MS delays the capability probe ONLY
  // (never the turn stream), so tests can hold a normal Proxy request open
  // deterministically (e.g. a cold catalog.list probe) while a queued
  // request overlaps it.
  const rawHelpDelay = Number(process.env.FAKE_CLAUDE_HELP_DELAY_MS ?? '0');
  const helpDelayMs = Number.isFinite(rawHelpDelay) && rawHelpDelay > 0 ? rawHelpDelay : 0;
  if (helpDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, helpDelayMs));
  }
  process.stdout.write(`Usage: claude [options]\n
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")\n
  --effort <level>          Reasoning effort (choices: "low", "medium", "high", "max")\n`);
  process.exit(0);
}

if (args.includes('-p') && args.includes('--output-format')) {
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  write({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' });
  // Test seam: FAKE_CLAUDE_TURN_DELAY_MS delays the whole turn stream so
  // concurrency tests can overlap a slow turn with a queued request
  // deterministically. The default keeps the historical 30ms cadence.
  const rawDelay = Number(process.env.FAKE_CLAUDE_TURN_DELAY_MS ?? '0');
  const delayMs = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;
  const timer = setTimeout(() => {
    write({
      type: 'assistant',
      message: {
        id: 'msg_fake_1',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10 },
        content: [
          { type: 'thinking', id: 'think_fake_1', thinking: 'thinking with fake claude' },
          { type: 'text', id: 'text_fake_1', text: 'hello from fake claude' },
        ],
      },
    });
    write({ type: 'web_search', query: 'diagnostic unknown event' });
    write({
      type: 'result',
      subtype: 'success',
      result: 'hello from fake claude',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  }, 30 + delayMs);
  timer.unref();
  // Exit after the timer has written the turn. The unref'd timer would not
  // keep the process alive by itself, but stream writes need a tick to flush.
  setTimeout(() => process.exit(0), 80 + delayMs);
} else {
  process.exit(0);
}
