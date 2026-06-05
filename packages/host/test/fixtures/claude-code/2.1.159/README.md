# Claude Code 2.1.159 Event Fixtures

These fixtures pin the event shapes Gian depends on for Claude Code 2.1.159.

- `jsonl/` contains native Claude Code transcript JSONL shapes.
- `proxy-notifications/` contains cc-proxy structured notification shapes.
- `hooks/` contains Claude Code HTTP hook payload shapes.
- `golden/` contains stable normalized event signatures expected by Gian.

When upgrading Claude Code, capture new raw samples under a new version
directory, copy/update the golden files intentionally, and run
`packages/host/test/cc-events-regression.test.ts`.
