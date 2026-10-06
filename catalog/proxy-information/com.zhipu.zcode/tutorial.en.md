# ZCode

## 1. What it does in Gian

ZCode Integration brings ZCode CLI coding sessions, model configuration and activity into Gian. Version 0.4.2 uses the pinned and verified ZCode CLI 0.16.9 shipped with the Proxy release. It no longer depends on the Runtime embedded in ZCode.app or reads desktop-process credentials.

## 2. Capabilities and limitations

It supports session creation and resume, history replay, model/configuration snapshots, tool activity, permission interactions, attachments, renaming, forks, current-turn Steer, subagent activity and per-session Gian MCP injection. Available choices come from actual Runtime snapshots. Native history deletion is unsupported; ordinary closure only detaches Gian ownership. Real Provider requests require separate acceptance: installation alone does not certify a model turn.

## 3. Runtime architecture

```text
Gian Host → ZCode Proxy → workspace-isolated ZCode CLI 0.16.9 Runtime → Provider
```

The inner connection uses structured ZCode Protocol over stdio, and the outer connection uses Gian Proxy protocol. A shared Proxy can manage separate Runtime processes by workspace. Closing a Gian session detaches it without deleting native history.

## 4. Installation and dependencies

Install ZCode Integration from Gian's official Catalog. Gian verifies and prepares both the Proxy and its pinned CLI Runtime. ZCode.app is not required, and Gian does not extract a Runtime from the desktop app. Arbitrary executable paths cannot bypass version and digest verification.

## 5. First use

1. Install and prepare ZCode Integration in Gian; confirm Proxy 0.4.2 and CLI 0.16.9 verification.
2. Configure the Provider through the installed CLI's `zcode login` or ZCode TUI.
3. Select a model and workspace for the Agent, then try a small text task. Other capabilities depend on the actual model and Provider.

This guide does not claim that a real model request has succeeded on the current machine.

## 6. HOME and isolation

ZCode CLI user configuration normally lives at `~/.zcode/v2/provider_config.json`; the CLI can import legacy `~/.zcode/cli/config.json`. The Runtime should use the Agent's selected nonempty HOME. Accounts and configuration from different HOME directories are not interchangeable. Do not copy tokens or clear native history as a repair step.

## 7. Reverse proxies and custom endpoints

Use only endpoints and authentication supported by official ZCode Provider configuration. Gian Proxy, ZCode Provider settings and model reverse proxy are separate layers; endpoint settings cannot repair a Runtime version or protocol mismatch.

## 8. Operational notes

- Pinned version and digest are compatibility boundaries; upgrades need a new release and verification.
- Model choices come from actual Runtime snapshots, not guesses parsed from config files.
- Close, cancel and native deletion are different actions; do not delete session data for troubleshooting.
- Real Provider requests may incur charges and should be accepted separately.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Runtime fails to start | Installation digest, CLI version, workspace path | Reprepare the official release and retain diagnostics |
| No models | Official Provider login and configuration | Run `zcode login` or the TUI under the selected HOME |
| Config missing after login | Whether Agent and login HOME match | Log in under the correct HOME |
| Attachments or forks fail | Actual model capabilities and Runtime error | Do not assume a capability absent from the Runtime |
| Concern about history after closure | Whether Gian only detached | Check with the official CLI; do not additionally delete data |
