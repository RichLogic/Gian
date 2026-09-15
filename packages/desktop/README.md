# Gian Desktop

The production Electron package is the complete local Gian application. It
ships the Gian Host and Web UI, starts the Host as a child process, waits for
its health check, and stops it when the App quits. No LaunchAgent or separate
Node.js installation is required.

Production uses `http://127.0.0.1:8990` internally, but the Host requires a
random per-launch credential injected by Electron and validates the Electron
origin for WebSockets. Direct browser access is not a supported production
surface.

First-run initialization uses GitHub OAuth Device Flow. Register a GitHub
OAuth App, enable Device Flow, and provide its public Client ID through
`GIAN_GITHUB_CLIENT_ID`. Gian requests no OAuth scopes and stores the returned
token encrypted with Electron/macOS secure storage. No client secret or Gian
login server is required.

Agent proxies are not baked into the App. Settings downloads the matching
versioned proxy asset from the Gian GitHub Release, verifies its SHA-256 digest,
and activates it under `~/.gian/plugins/`. Agent CLIs are detected from
configured and common official paths or installed through vendor installers.

## Commands

```sh
# Ensure the worktree-owned 8991/5191 stack is healthy and open GianDev.
pnpm dev

# Inspect or recover the managed development runtime.
pnpm dev:status
pnpm dev:restart
pnpm dev:down

# Open the browser-only Web debugging surface. GianDev remains the default
# product preview and Desktop acceptance surface.
pnpm dev:chrome

# Build an unpacked macOS Apple Silicon App.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm desktop:pack

# Run the source gate, build an unsigned .app, then verify its bundled
# Host/Web/Node/native resources plus clean quit and reopen on an isolated port.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm quality:package

# Build local DMG and ZIP artifacts.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm desktop:dmg

# Build signed/notarized release artifacts and latest-mac.yml without
# publishing them. The release environment listed below is required.
pnpm --filter @gian/desktop make:mac:release

# Build the proxy assets uploaded alongside the App release.
pnpm release:proxies
```

## Preparing the signed release and automatic update channel

`make:mac:release` builds the Apple Silicon DMG and ZIP with a Developer ID
Application signature and App Store Connect notarization, then generates
`latest-mac.yml` for the public
[`RichLogic/Gian`](https://github.com/RichLogic/Gian) GitHub Releases update
channel. It uses `--publish never`; running it does not upload an artifact.
Release credentials are fail-closed: the command stops before building when
any signing, notarization, or OAuth value is missing, and Electron Builder also
requires a real signing identity.

For a local release build, import the Developer ID identity into a dedicated,
unlocked temporary keychain and provide its path as `CSC_KEYCHAIN`. Also
provide `APPLE_API_KEY` (the path to the `.p8` file), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, and `GIAN_GITHUB_CLIENT_ID` in the process environment.
Do not pass `CSC_LINK` directly to Electron Builder 26: the protected workflow
decodes that secret itself and uses a separate random keychain password before
invoking the build.

The intended protected GitHub Actions job uses these configuration names
(never commit their values to the repository):

- `CSC_LINK` — Actions secret containing the base64-encoded Developer ID
  Application `.p12` certificate.
- `CSC_KEY_PASSWORD` — Actions secret containing that `.p12` password.
- `APPLE_API_KEY_BASE64` — Actions secret containing the base64-encoded App
  Store Connect API `.p8` key.
- `APPLE_API_KEY_ID` — Actions secret containing the App Store Connect key ID.
- `APPLE_API_ISSUER` — Actions secret containing the App Store Connect issuer
  UUID.
- `GIAN_GITHUB_CLIENT_ID` — Actions repository variable containing the public
  GitHub OAuth Device Flow Client ID.

The tag-triggered `.github/workflows/release.yml` is the signed stable
publisher. It requires the protected Developer ID certificate and App Store
Connect API-key secrets, runs the packaged product gate, notarizes the App,
verifies it with `codesign`, `spctl`, and `stapler`, and stages the DMG, ZIP,
their blockmaps, `latest-mac.yml`, and checksums in a draft Release. The
workflow verifies every uploaded size and SHA-256 digest before promoting that
draft to the public latest channel. Proxy plugins remain on their independent
`proxy-*-v*` workflow.

Local `package:mac` and `make:mac` builds remain unsigned and do not embed the
stable release marker, so native notification delivery and automatic updates
stay disabled in those artifacts.

Unsigned releases cannot enter the App update channel. Install the first
signed stable release manually; automatic App updates then apply to later
signed releases on the `latest` channel.

The development controller stores worktree-bound PID/state files and component
logs under `.gian-runtime/`. Host/Web outlive the Electron window; a hanging
shell can be replaced with `pnpm dev:restart -- desktop` without restarting
the services. For isolated test harnesses, `GIAN_DESKTOP_HOST_URL` and
`GIAN_DESKTOP_WEB_URL` can still override the two origins.
