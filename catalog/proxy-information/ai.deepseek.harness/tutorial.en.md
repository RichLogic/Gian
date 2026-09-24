# DeepSeek Harness

## 1. What it does in Gian

DeepSeek Harness Integration connects the DSH Agent runtime to Gian. It is not a thin chat client calling a model endpoint: the Proxy, Bridge, DSH program and profile work together.

You choose a workspace and task settings in Gian; DSH executes through its own Agent/Provider model. Provider, Model, Reasoning and Agent Preset have distinct meanings and are not one ambiguous model-name setting.

## 2. Capabilities and limitations

- Supports text tasks, native-state replay, configuration resolution, reasoning, usage, Step and Request events.
- Trusted existing Gian sessions can resume with binding proof. This is not permission to import arbitrary external native DSH session IDs.
- Permission interactions are available only when the Bridge declares them and can round-trip native requests. Permission presets retain DSH semantics.
- Does not declare arbitrary native-history discovery/deletion, renaming, images, ordinary file attachments, Sidechat or forks. Internal methods are not automatically public Host capabilities.
- Customization inventory distinguishes readable, partially visible and upstream-unsupported data. Unsupported does not mean absent.

Do not treat all tool activity as successful or claim complete question/MCP integration without Bridge evidence.

## 3. Runtime architecture

```text
Gian Host
  -> DSH Proxy (gian.proxy)
      -> gian profile in the DSH process
          -> @gian/dsh-bridge (gian.dsh.bridge/1.0)
              -> native DSH sessions, Agents, Providers and model service
```

The Proxy has shared scope. The Bridge runs in the DSH profile, converts native behavior to the explicit bridge protocol, and the Proxy converts that to Gian's protocol. The Bridge is not a network reverse proxy or another user-selected CLI path.

Processes, binding proofs and native-session ownership constrain restoration. Do not take over another active owner. Closing a Gian session must not implicitly delete vendor history.

## 4. Installation and dependencies

The complete installation needs Gian's Node environment, managed DSH Runtime, DSH Proxy and matching Bridge/profile. The new-repository DSH Proxy bundles its Bridge rather than waiting for an App release to supply it.

```text
<dataDir>/runtimes/deepseek-harness/<runtime-version>/<artifact-sha256>/
  node_modules/@deepseek-ai/dsh/lib/bin.js

<verified DSH Proxy directory>/
  proxy.mjs
  bridge/
```

These are program components, not account settings. Install the complete signed Catalog archive and plan; do not run npm update inside managed directories or replace the Bridge independently. An unchanged component version still needs to belong to the current combination.

Before actual startup, the Proxy prepares/checks the gian profile in DSH_HOME so the Bridge resolves. This controlled profile is distinct from the user's model-service configuration.

## 5. First use

1. Install DeepSeek Harness Integration and wait for the Proxy, DSH Runtime and dependencies to pass checks and activate.
2. Add an Agent with a new managed HOME or an explicitly selected existing DSH HOME.
3. Configure a Provider through this Agent's maintenance terminal using the current DSH flow. A working configuration in another profile does not prove the gian profile is ready.
4. Check the Provider, Model, Reasoning and Agent Preset options actually returned by DSH/Bridge.
5. Try a small workspace task and inspect tools, permission presets and completion. Program installation does not complete Provider account setup.

On Bridge/profile failure, preserve diagnostics and directory state, repair dependencies and retry. Do not disguise an empty new native session as recovery.

## 6. HOME and isolation

DSH_HOME points to the Agent's state directory:

```text
<dataDir>/homes/ai.deepseek.harness/<agentId>/
  profiles/gian/
```

DSH manages configuration, authentication and sessions in its HOME/profile; exact files depend on the DSH version. The Bridge in the Proxy archive is program code. Do not mix these locations or copy them over one another as a dependency repair.

Agents default to separate HOME directories. Reusing one shares vendor state. Gian does not clear custom HOME directories; the CLI and controlled profile preparation may normally read/write them. HOME isolation does not replace workspace permissions or DSH execution policy.

## 7. Reverse proxies and custom endpoints

Custom endpoints belong to DSH Provider configuration. Configure the selected HOME and actual gian profile using the current DSH format, and verify the model's association with that Provider.

The Bridge stdio channel and Gian Catalog URL are not model Base URLs. DSH has its own Provider and Agent Preset layers; another CLI's environment-variable names are not automatically equivalent.

Verify DSH can read the Provider configuration before diagnosing the Bridge/Proxy. Keep credentials in vendor configuration, not Catalog data, Manifests or distribution archives.

## 8. Operational notes

- Update the coordinated component set, not a single npm package. Mixing Bridge versions can break protocols or configuration.
- Do not edit session IDs, binding proofs or profile links to seize another process's session.
- Respect the scopes of Provider, Model, Reasoning and session-bound Agent Preset; changing one can require resolving the others again.
- Do not infer permission semantics from labels such as Full access. Use the native preset and actual requests returned by DSH.
- Logs should identify failure stages and component versions, without complete Provider settings, account files or HMAC material.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| @gian/dsh-bridge missing | Complete published Proxy package | Restore/reinstall the complete Integration, not an unknown Bridge copy |
| gian profile will not start | Profile completeness and matched components | Repair through normal installation/startup; retain HOME |
| Empty models or Providers | Current HOME and gian profile settings | Configure in the same maintenance terminal, not another profile |
| Native restoration rejected | Active owner and Gian binding proof | End the old owner normally; do not bypass binding proof |
| Attachments or forks unavailable | Declared public capabilities | Use supported text/workspace tools; do not silently discard attachments |
| Permission interaction missing | Bridge declaration and native round trip | Report redacted protocol/version evidence, not invented permission labels |
| Node/program startup fails | Gian Node, DSH and Bridge integrity | Restore the certified combination for the failed stage, not the machine-wide Node installation |
