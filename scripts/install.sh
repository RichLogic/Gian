#!/usr/bin/env bash
# install.sh — Register Gian host as a user-level daemon.
#
# Usage:
#   ./scripts/install.sh           # install (refuses to overwrite existing)
#   ./scripts/install.sh --force   # overwrite an existing install
#
# Supports: macOS (launchd LaunchAgent) and Linux (systemd --user).
# Requires: Node v22+ on $PATH, pre-built packages/host/dist/.

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

info() { echo "[gian] $*"; }

# ── args ─────────────────────────────────────────────────────────────────────

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) die "unknown argument: $arg" ;;
  esac
done

# ── resolve paths ─────────────────────────────────────────────────────────────

# SCRIPT_DIR is this file's directory; INSTALL_DIR is the repo root (one level up).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Sanity-check: the host entry point must exist.
ENTRY="${INSTALL_DIR}/packages/host/dist/index.js"
if [[ ! -f "${ENTRY}" ]]; then
  die "Built entry point not found at ${ENTRY}. Run: pnpm install && pnpm -F @gian/shared build && pnpm -F @gian/host build"
fi

# Resolve the absolute path to node — launchd/systemd don't inherit $PATH.
NODE_BIN="$(command -v node)" || die "node not found on \$PATH"

# Confirm it's new enough (v22+) and not Node v25+ (better-sqlite3 breaks).
NODE_VERSION="$(node --version)"         # e.g. "v22.4.0"
NODE_MAJOR="${NODE_VERSION#v}"           # strip leading "v"
NODE_MAJOR="${NODE_MAJOR%%.*}"           # keep only major number
if (( NODE_MAJOR < 22 )); then
  die "Node v22+ required (found ${NODE_VERSION}). better-sqlite3 bindings fail on older versions."
fi
if (( NODE_MAJOR >= 25 )); then
  die "Node v25+ silently breaks better-sqlite3 bindings (found ${NODE_VERSION}). Use Node 22–24 (\`nvm use 22\`). If which-node disagrees with nvm, brew is shadowing nvm: \`export PATH=~/.nvm/versions/node/v22.18.0/bin:\$PATH\`."
fi

# Resolve runtime tool paths so launchd's bare PATH doesn't ENOENT on the
# probe. Both are optional at install time — the daemon emits a clearer
# error later if they're missing — but if present, bake their dirs into the
# plist's EnvironmentVariables.PATH so cc-proxy/codex-proxy can spawn them.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
CODEX_BIN="$(command -v codex 2>/dev/null || true)"

# Build a deduplicated PATH for the launchd plist. launchd's default PATH is
# `/usr/bin:/bin:/usr/sbin:/sbin` — not enough for ~/.local/bin (claude) or
# /opt/homebrew/bin (codex). We include the dirnames of claude/codex/node
# (when found), then append standard locations so anything not yet installed
# resolves once it lands in the usual spots.
_path_dirs=()
[[ -n "${CLAUDE_BIN}" ]] && _path_dirs+=("$(dirname "${CLAUDE_BIN}")")
[[ -n "${CODEX_BIN}"  ]] && _path_dirs+=("$(dirname "${CODEX_BIN}")")
_path_dirs+=("$(dirname "${NODE_BIN}")")
# Common user-bin (claude installer's default) + standard system dirs as
# fallbacks for tools the user installs after running install.sh.
_path_dirs+=("${HOME}/.local/bin" "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin")

# Dedupe while preserving order — awk-based one-pass scan.
LAUNCHD_PATH="$(printf '%s\n' "${_path_dirs[@]}" | awk '!seen[$0]++' | paste -sd: -)"

if [[ -z "${CLAUDE_BIN}" ]]; then
  echo "  warn: claude not found on \$PATH — daemon will probe ENOENT until it's installed." >&2
fi
if [[ -z "${CODEX_BIN}" ]]; then
  echo "  warn: codex not found on \$PATH — daemon will probe ENOENT until it's installed." >&2
fi

# ── platform detection ────────────────────────────────────────────────────────

PLATFORM="$(uname -s)"
case "${PLATFORM}" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) die "Unsupported platform: ${PLATFORM}" ;;
esac

# ── platform-specific target paths ───────────────────────────────────────────

if [[ "${PLATFORM}" == macos ]]; then
  AGENTS_DIR="${HOME}/Library/LaunchAgents"
  UNIT_DEST="${AGENTS_DIR}/com.gian.host.plist"
  TEMPLATE="${SCRIPT_DIR}/install/macos/com.gian.host.plist"
else
  UNIT_DIR="${HOME}/.config/systemd/user"
  UNIT_DEST="${UNIT_DIR}/gian.service"
  TEMPLATE="${SCRIPT_DIR}/install/linux/gian.service"
fi

# ── overwrite guard ───────────────────────────────────────────────────────────

if [[ -f "${UNIT_DEST}" ]] && [[ "${FORCE}" != true ]]; then
  die "Gian is already installed at ${UNIT_DEST}. Use --force to overwrite."
fi

# ── create log directory ──────────────────────────────────────────────────────

LOG_DIR="${HOME}/.config/gian/logs"
mkdir -p "${LOG_DIR}"
info "Log directory: ${LOG_DIR}"

# ── substitute template variables ────────────────────────────────────────────
#
# We use sed rather than envsubst so we control exactly which variables are
# expanded — no risk of accidentally expanding shell variables in user-supplied
# content that ends up in the template.

substitute() {
  local src="$1" dst="$2"
  sed \
    -e "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" \
    -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    -e "s|{{LAUNCHD_PATH}}|${LAUNCHD_PATH}|g" \
    "${src}" > "${dst}"
}

# ── install unit file ─────────────────────────────────────────────────────────

if [[ "${PLATFORM}" == macos ]]; then
  mkdir -p "${AGENTS_DIR}"
  substitute "${TEMPLATE}" "${UNIT_DEST}"
  info "Wrote plist → ${UNIT_DEST}"

  # Unload a previous version if --force was passed; ignore errors if not loaded.
  if [[ "${FORCE}" == true ]]; then
    launchctl bootout "gui/${UID}" "${UNIT_DEST}" 2>/dev/null || true
  fi

  # bootstrap registers the agent and starts it immediately.
  launchctl bootstrap "gui/${UID}" "${UNIT_DEST}"
  info "Registered with launchd (gui/${UID})"

else  # linux
  mkdir -p "${UNIT_DIR}"
  substitute "${TEMPLATE}" "${UNIT_DEST}"
  info "Wrote unit → ${UNIT_DEST}"

  systemctl --user daemon-reload

  if [[ "${FORCE}" == true ]]; then
    systemctl --user stop gian.service 2>/dev/null || true
  fi

  systemctl --user enable --now gian.service
  info "Enabled and started gian.service"
fi

# ── final status ──────────────────────────────────────────────────────────────

echo ""
echo "Gian is now installed and running."
echo "  Install dir : ${INSTALL_DIR}"
echo "  Node        : ${NODE_BIN} (${NODE_VERSION})"
echo "  Logs        : ${LOG_DIR}/"
echo ""
echo "To check live logs:"
if [[ "${PLATFORM}" == macos ]]; then
  echo "  tail -f ${LOG_DIR}/host.out"
  echo "  tail -f ${LOG_DIR}/host.err"
else
  echo "  tail -f ${LOG_DIR}/host.out"
  echo "  systemctl --user status gian.service"
fi
