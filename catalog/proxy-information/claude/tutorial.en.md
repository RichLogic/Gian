# Claude Code

## 1. What it does in Gian

Claude Code Integration connects Claude Code coding sessions to Gian. Gian manages workspaces, conversations, file authorization, tool activity, permission requests and managed programs; the vendor CLI performs the actual model tasks and project operations.

This is neither a generic HTTP chat client nor a wrapper around the Claude website. The Gian Proxy adapts protocols. An LLM reverse proxy forwards model requests and is a separate configuration layer.

## 2. Capabilities and limitations

- Supports text, local files and images, subject to Host path, size and authorization checks. File input does not imply a dedicated parser for every format.
- Supports renaming, native session discovery and history replay, questions and permission interactions.
- Supports Sidechat, session forks and forks at available Turn boundaries. Availability also depends on the current session, active Turns and pending interactions.
- Supports reasoning, usage events and protocol 2.3 read-only customization inventory. Model, thinking and mode choices come from the current Proxy/CLI rather than a fixed list in this guide.
- Does not declare native-history deletion or turn.steer. Undeclared operations cannot be supplied by inventing a button or command.

Claude Code permissions still govern tool execution, including automation behind the UI. Gian does not guarantee full Claude Code compatibility for third-party model endpoints.

## 3. Runtime architecture

```text
Gian Host
  -> Claude Proxy for this Gian Session
      -> claude -p child process for this Turn
          -> configured model service
```

The Proxy has session scope. It uses structured requests and events, not terminal-screen scraping. Each Turn starts a structured CLI child process; later Turns resume the saved vendor session identity. Sidechat and forks use separate native-session boundaries, not temporary writes into the parent conversation.

The CLI maintenance terminal is for vendor login and configuration, not a Session TTY runtime. Billing follows the vendor's rules; website or interactive-terminal subscription coverage is not promised.

## 4. Installation and dependencies

Select Claude Code in Agent Integrations and install it. Gian downloads the signed Catalog's Proxy/CLI combination, verifies digests and the Proxy installation plan, checks the actual executable version and activates the complete combination atomically.

```text
<dataDir>/runtimes/claude/<runtime-version>/<artifact-sha256>/bin/claude
```

This is not the Claude executable on your system PATH. Do not replace the managed binary or its links. Gian App/Host supplies Node. The Catalog determines the installation target; do not substitute an upstream latest release.

Web-only debugging and Desktop environments may have different download and credential-broker capabilities. Being able to browse the Catalog does not prove installation is available. Diagnose broker failures rather than bypassing origin or integrity checks.

## 5. First use

1. Install the Integration and wait for the full Runtime combination to activate. Seeing Proxy files alone is insufficient.
2. Add an Agent with a new managed HOME, or explicitly select an existing HOME whose vendor configuration you intend to reuse.
3. Open that Agent's CLI maintenance terminal and use the vendor's login or service-configuration flow. Never paste credentials into an ordinary conversation, Catalog document or Issue.
4. Exit maintenance commands and check the Agent status. Program installation and account/endpoint readiness are separate checks.
5. Create a session for an authorized project. Start with a small task and confirm the workspace, model and permission prompts.

On failure, retain the Agent, HOME and history. Retrying installation should not recreate accounts or clear conversations.

## 6. HOME and isolation

CLAUDE_CONFIG_DIR points to the selected Agent HOME. A managed HOME typically lives at:

```text
<dataDir>/homes/claude/<agentId>/
```

It holds CLI configuration, authentication and native history. Agents can share program versions without sharing HOME. Explicitly selecting the same existing HOME shares vendor configuration and history, so those Agents are not account-isolated.

Gian does not automatically copy, clear or migrate custom HOME directories. The CLI normally reads and writes its own state. HOME separation is not a filesystem sandbox; workspace authorization and CLI policy still apply. Existing sessions retain their original HOME bindings.

## 7. Reverse proxies and custom endpoints

Configure supported vendor endpoints and authentication in this Agent's HOME/CLI settings. Changing the Gian Host address, Catalog URL or Proxy installation path does not select a model service.

When reusing a setup such as claude-mix, reuse its configuration HOME, not its wrapper script as another CLI path. Check whether that wrapper performs additional behavior outside HOME; its name alone does not establish equivalence.

First verify the CLI in the same Agent's maintenance terminal. Anthropic message-format compatibility does not guarantee matching streaming, tools, reasoning or context semantics. Reduce unsupported extensions or return to a verified service when necessary.

## 8. Operational notes

- Updates affect the shared program combination for this Proxy type, not just one Agent. Finish its active Turns and maintenance terminals first.
- Hiding a terminal does not stop it. Diagnose actual Runtime users rather than deleting lock files.
- Do not update the CLI or Proxy independently, or alter certification records. Retained older programs are not a guarantee that migrated vendor data can be downgraded.
- Deleting an Agent is not the same as deleting native vendor history. Clearing HOME is not a default repair.
- Report error codes, stages, Proxy/CLI versions and redacted logs, not a complete HOME directory.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Empty Integration list | Catalog status and network error | Refresh; never bypass signature, sequence or digest failures with an untrusted source |
| Proxy version exists but Runtime is missing | Whether a complete generation is active | Install the Runtime in Integration details; do not edit a CLI path |
| Agent still needs setup after installation | Configuration in that Agent's HOME | Use its own maintenance terminal, not another account's HOME |
| Valid login but model requests fail | Endpoint, model and permission prompts | Diagnose the vendor service in the same HOME; remove unverified proxy extensions |
| Tools or file input are denied | Capabilities, workspace authorization and CLI policy | Use supported inputs and normal permission interactions |
| Fork or Sidechat is unavailable | Boundaries, active Turn and pending interactions | Wait for a supported state; do not edit native session IDs |
| Update keeps waiting | Active Turns and maintenance terminals | Stop actual users normally and retry; do not force-delete locks or programs |
