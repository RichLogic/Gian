# Welcome to Gian

## How We Use Claude

Based on Acme's usage over the last 30 days:

Work Type Breakdown:
  Build Feature      ████████░░░░░░░░░░░░  40%
  Plan Design        ██████░░░░░░░░░░░░░░  30%
  Debug Fix          ████░░░░░░░░░░░░░░░░  20%
  Write Docs         ██░░░░░░░░░░░░░░░░░░  10%

Top Skills & Commands:
  /remote-control    ████████████████████  10x/month
  /effort            ██████░░░░░░░░░░░░░░  3x/month
  /plugin            ██████░░░░░░░░░░░░░░  3x/month
  /resume            ████░░░░░░░░░░░░░░░░  2x/month
  /compact           ████░░░░░░░░░░░░░░░░  2x/month
  /model             ██░░░░░░░░░░░░░░░░░░  1x/month
  /clear             ██░░░░░░░░░░░░░░░░░░  1x/month
  /login             ██░░░░░░░░░░░░░░░░░░  1x/month
  /ide               ██░░░░░░░░░░░░░░░░░░  1x/month

Top MCP Servers:
  claude-in-chrome   ████████████████████  419 calls
  test-channel       █░░░░░░░░░░░░░░░░░░░  1 call

## Your Setup Checklist

### Codebases
- [ ] gian — github.com/acme/gian

### MCP Servers to Activate
- [ ] claude-in-chrome — Drives a Chrome tab from Claude (screenshots, JS exec, click/drag, navigate). The team uses it heavily for verifying UI changes end-to-end. Install via the Claude in Chrome extension and connect from Claude Code.
- [ ] test-channel — Lightweight test channel MCP, low-frequency. Ask the team for setup if you need it.

### Skills to Know About
- /remote-control — Pair Claude Code on your machine with a remote control session (the team's most-used command — used for nearly every interactive session).
- /effort — Switch reasoning effort (low/medium/high/xhigh/max) for the current session. Bump up for hard problems, down for routine ones.
- /plugin — Manage Claude Code plugins (install, list, configure).
- /resume — Resume a previous conversation by session ID; useful when picking up where you left off after a break or a `/clear`.
- /compact — Compress the conversation history when context gets long but you still need to keep going in the same session.
- /model — Switch between models mid-session (e.g. Sonnet ↔ Opus).
- /clear — Wipe the conversation and start fresh in the same terminal.
- /login — Authenticate against Claude.
- /ide — Connect Claude Code to your IDE (VS Code / JetBrains) for in-editor diagnostics.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
