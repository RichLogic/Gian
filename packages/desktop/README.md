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
and activates it under `~/.config/gian/plugins/`. Agent CLIs are detected from
configured and common official paths or installed through vendor installers.

## Commands

```sh
# Start the isolated 8991/5191 development stack and open GianDev.
pnpm dev

# Build an unpacked macOS Apple Silicon App.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm desktop:pack

# Build local DMG and ZIP artifacts.
GIAN_GITHUB_CLIENT_ID=<your-oauth-client-id> pnpm desktop:dmg

# Build the proxy assets uploaded alongside the App release.
pnpm release:proxies
```

The tag workflow builds, signs, notarizes, validates, checksums, and publishes
the App and proxy assets. Local builds remain unsigned unless signing
credentials are present.

For isolated development, `GIAN_DESKTOP_HOST_URL` and
`GIAN_DESKTOP_WEB_URL` can override the two origins.
