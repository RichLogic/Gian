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

# Confirm it's new enough (v22+).
NODE_VERSION="$(node --version)"         # e.g. "v22.4.0"
NODE_MAJOR="${NODE_VERSION#v}"           # strip leading "v"
NODE_MAJOR="${NODE_MAJOR%%.*}"           # keep only major number
if (( NODE_MAJOR < 22 )); then
  die "Node v22+ required (found ${NODE_VERSION}). better-sqlite3 bindings fail on older versions."
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
