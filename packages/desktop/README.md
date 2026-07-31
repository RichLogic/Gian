# Gian Desktop

The macOS desktop package is a hardened Electron shell over the existing Gian
web UI. It does not embed or replace the Gian host:

- development loads `http://127.0.0.1:5191` and checks the GianDev host on
  `http://127.0.0.1:8991`;
- a packaged app loads the production host-owned UI on
  `http://127.0.0.1:8990`;
- when the packaged production host is unavailable, the app may start the
  existing `com.gian.host` LaunchAgent and then polls `/health`;
- on macOS the web topbar shares the native titlebar row with the inset traffic
  lights, while interactive controls remain clickable and the open area drags
  the window;
- quitting the desktop UI leaves the host and active agent sessions running.

## Commands

```sh
# Start the isolated 8991/5191 stack, wait for readiness, then open GianDev.app.
pnpm dev

# Start the same hot-reload stack without opening Electron.
pnpm dev:web

# Start only the Electron shell after 8991/5191 are already running.
pnpm desktop:dev

# Build an unpacked Gian.app under packages/desktop/release.
pnpm desktop:pack

# Build unsigned DMG and ZIP artifacts.
pnpm desktop:dmg
```

The packaged shell expects the normal Gian host installation from
`scripts/install.sh`. Signing, notarization, auto-update, and a combined
host-plus-desktop installer are separate release work.

For isolated testing, `GIAN_DESKTOP_HOST_URL` and `GIAN_DESKTOP_WEB_URL` can
override the two origins. Setting `GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT=1`
prevents launchd operations.
