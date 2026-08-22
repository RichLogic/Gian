#!/usr/bin/env node
/** Fake Claude Code runtime for cc-proxy protocol-v2 CLI tests.
 *
 *  It intentionally never contacts a Provider. It answers `--help` for
 *  billing-safe capability discovery and emits a deterministic stream-json
 *  turn when spawned as `claude -p ... --output-format stream-json`. */

const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write(`Usage: claude [options]\n
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")\n
  --effort <level>          Reasoning effort (choices: "low", "medium", "high", "max")\n`);
  process.exit(0);
}

if (args.includes('-p') && args.includes('--output-format')) {
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  write({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' });
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
  }, 30);
  timer.unref();
  // Exit after the timer has written the turn. The unref'd timer would not
  // keep the process alive by itself, but stream writes need a tick to flush.
  setTimeout(() => process.exit(0), 80);
} else {
  process.exit(0);
}
