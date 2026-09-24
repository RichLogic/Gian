# ZCode

## 1. What it does in Gian

ZCode Integration connects the Runtime embedded in ZCode.app and projects coding sessions and model configuration into Gian. It does not control ZCode Desktop windows or read a running desktop process's private communication channels or account tokens.

ZCode is an external-App exception: Gian manages its Proxy, not ZCode.app installation or updates. Matching CLI version strings do not guarantee matching resources, protocols or standalone behavior across App builds.

## 2. Capabilities and limitations

- Supports text sessions, configuration resolution, native-session discovery, history replay, reasoning and usage events.
- Permissions depend on Runtime and Proxy configuration. Models, Providers and Thinking choices come from the actual Runtime catalog.
- Does not declare images, ordinary file attachments, renaming, native-history deletion, Sidechat, forks, Steer or Gian MCP integration. ZCode Desktop features are not automatically Gian features.
- Tools appear as activity events; unsupported Step/Request protocol capabilities are not invented.

Known upstream limitation: ZCode.app 3.12.3 broke resource lookup needed for standalone embedding and changed native methods and Provider injection. Proxy 0.3.2 adds earlier diagnostics, not a fix for those upstream issues. Later App builds require renewed verification even if they still report CLI 0.16.5.

## 3. Runtime architecture

```text
Gian Host
  -> shared-scope ZCode Proxy
      -> app-server Runtime pool keyed by canonical workspace
          -> zcode.cjs embedded in ZCode.app
              -> native sessions, Providers and model service
```

The inner connection uses structured ZCode Protocol over stdio; the outer connection uses Gian Proxy protocol. A workspace can reuse its inner Runtime while different workspaces retain process-failure isolation. A shared Proxy does not imply one inner process for every workspace.

Closing in Gian uses detach semantics: unsubscribe and release ownership, rather than invoke native close/delete. Some native close operations delete empty sessions and must not be mapped directly to ordinary Gian closure.

## 4. Installation and dependencies

Install and configure ZCode.app normally. Gian discovers its embedded Runtime only in supported standard App locations, such as /Applications or the user's Applications directory. The Host discovers and validates the path; arbitrary user-entered executable paths are not accepted.

Installing/preparing ZCode Integration downloads Gian's Proxy and discovers/verifies the existing external Runtime. It does not download, mirror, upgrade or downgrade ZCode.app.

```text
<verified ZCode.app>/Contents/Resources/glm/zcode.cjs
```

The actual discovery result determines the entry. Resource layout, fingerprints and standalone startup are compatibility boundaries beyond a CLI version string. Gian's Node launcher cannot bypass private ZCode desktop context.

## 5. First use

1. Install ZCode.app and use its official Provider setup.
2. Run discovery/preparation from ZCode details in Gian and inspect upstream incompatibility or missing-resource diagnostics.
3. Create an Agent only after Runtime checks pass and the actual configuration catalog is available.
4. Try a small workspace task, checking model choices, permissions and text execution.
5. If the App build cannot be embedded independently, resolve upstream compatibility first. A different API key or cleared history is not a startup fix.

This guide does not certify the current machine or an arbitrary latest ZCode build. Process startup, a nonempty catalog and a successful model task are distinct checks.

## 6. HOME and isolation

The external App and its official configuration directories, commonly ~/.zcode, own ZCode state. It does not offer the same Gian-managed or Custom HOME isolation as Claude, Codex, Kimi or DSH.

Multiple Gian ZCode Agents do not create independent ZCode accounts/configuration spaces. Do not apply another Agent type's HOME variables to ZCode.

Gian does not generate, migrate, delete or patch the external App's private account state. Preserve native history. Do not extract process credentials, alter private desktop settings or copy tokens to satisfy standalone startup requirements.

## 7. Reverse proxies and custom endpoints

Use only endpoints and authentication supported by ZCode's official Provider configuration. Gian neither supplies a second external CLI path nor requests authentication headers from private ZCode Desktop services.

A working desktop configuration does not prove that standalone app-server supports the same Provider initialization. If the independent Runtime returns no models, first confirm the upstream public embedding contract instead of exporting desktop memory/configuration tokens into Gian.

The Gian Proxy, ZCode Provider settings and model reverse proxy are separate layers. A custom endpoint cannot repair an App resource-layout error or a removed protocol method.

## 8. Operational notes

- ZCode.app updates can change Runtime bytes/resources without changing the CLI version string.
- On fingerprint changes or standalone errors, stop and report the reason; do not silently select unsupported paths.
- Pinning an older App build is an explicit user decision using trusted sources, not a background Gian downgrade.
- Do not delete empty or old native sessions as a startup repair. Detaching and deleting data are different operations.
- Historical verification covers a particular build and its observed capabilities, not every future App version.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| ZCode.app not detected | Supported standard App locations | Install normally and rediscover; do not enter an arbitrary CLI path |
| Built-in Provider configuration missing | App build and known resource-layout limitations | Use a verifiable supported build or await an upstream fix, not fabricated resource files |
| app-server starts but has no models | Public standalone Provider initialization support | Confirm upstream capabilities; never extract Desktop tokens |
| Same CLI version but startup rejected | Changed App bytes, resources or protocol | Preserve diagnostics and reverify, not just edit a version allowlist |
| Attachments, forks or renaming unavailable | Declared Proxy capabilities | Use supported text/workspace flows |
| Concern about history after closure | Whether Gian only detached | Check history using official tools; do not additionally invoke native deletion |
| Permission/authentication request unsupported | Public native-method contract | Use official configuration without bypassing account boundaries |
