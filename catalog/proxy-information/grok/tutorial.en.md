# Grok Build

## 1. What it does in Gian

Grok Build Integration runs coding sessions through the official Grok CLI ACP stdio interface. Gian owns Sessions, messages, approvals and history presentation; the Grok Runtime owns model execution and native sessions.

## 2. Capabilities and limitations

The certified combination supports text, local files, images, tool approval, reasoning, usage and replay. The published CLI 1.0.41 stdio surface does not register the x.ai Steer, Rename, Fork, Side Chat or native-delete methods, so Gian does not advertise them.

## 3. Runtime architecture

```text
Gian Host -> Grok Proxy -> grok agent --no-leader stdio -> Grok service
```

The session-scoped Proxy forces the workspace sandbox. Agent HOME directories and login state remain isolated.

## 4. Installation and dependencies

Install from Agent Integrations. Gian downloads Proxy 0.3.6 and official Grok CLI 1.0.41 from the signed Catalog, then verifies URL, size, SHA-256, version, Manifest and installation receipt before activation.

## 5. First use

After installation, create a Grok Agent and complete OAuth in that Agent's maintenance terminal. Return to Gian, choose Grok 4.7 and the desired reasoning effort, and begin with a small message/tool-approval task.

## 6. HOME and isolation

Grok authentication, configuration, caches and native history live in the managed Agent HOME. An existing `~/.grok` is not copied automatically and should not be shared to bypass isolation.

## 7. Reverse proxies and custom endpoints

Use authentication and endpoint configuration supported by the Grok CLI. Never place API keys in task messages, Catalog data or Proxy configuration, and do not change the Gian Host address to select a model endpoint.

## 8. Operational notes

- Gian disables independent Runtime auto-update; upgrades use a newly certified Catalog combination.
- Tool decisions must be returned while the Turn is active.
- A Method-not-found result narrows capability; it is never reported as success.
- Finish active Turns before update or removal. Closing UI does not prove model/tool processes stopped.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Grok is absent from Catalog | Catalog sequence includes the Grok release | Sync again; do not substitute local source |
| Installation fails | GitHub/x.ai network, digests and receipt | Keep the previous activation and follow the exact error |
| Authentication fails | The selected Agent HOME | Repeat OAuth in that Agent's maintenance terminal |
| Steer, Rename or Fork is absent | Real CLI 1.0.41 stdio capability | Use supported actions; do not fabricate extensions |
| A tool waits indefinitely | An interaction.requested event is pending | Approve in Gian or interrupt the Turn |
