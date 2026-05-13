#!/usr/bin/env bash
# uninstall.sh — Remove the Gian host daemon registration.
#
# Usage:
#   ./scripts/uninstall.sh           # stop daemon + remove unit file; keep data/logs
#   ./scripts/uninstall.sh --purge   # also delete ~/.config/gian/ (IRREVERSIBLE)
#
# --purge deletes the SQLite database (gian.db) and all logs.
# This is intentionally explicit and not the default.

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

info() { echo "[gian] $*"; }

# ── args ─────────────────────────────────────────────────────────────────────

PURGE=false
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    *) die "unknown argument: $arg" ;;
  esac
done

# ── platform detection ────────────────────────────────────────────────────────

PLATFORM="$(uname -s)"
case "${PLATFORM}" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) die "Unsupported platform: ${PLATFORM}" ;;
esac

# ── platform-specific unit paths ─────────────────────────────────────────────

if [[ "${PLATFORM}" == macos ]]; then
  UNIT_DEST="${HOME}/Library/LaunchAgents/com.gian.host.plist"
else
  UNIT_DEST="${HOME}/.config/systemd/user/gian.service"
fi

DATA_DIR="${GIAN_DATA_DIR:-${HOME}/.config/gian}"

# ── stop and remove ───────────────────────────────────────────────────────────

if [[ "${PLATFORM}" == macos ]]; then
  if [[ -f "${UNIT_DEST}" ]]; then
    # bootout stops the process and unregisters the agent.
    # Suppress "not loaded" errors in case it crashed before we got here.
    launchctl bootout "gui/${UID}" "${UNIT_DEST}" 2>/dev/null || true
    rm -f "${UNIT_DEST}"
    info "Removed ${UNIT_DEST}"
  else
    info "No plist found at ${UNIT_DEST} — nothing to remove."
  fi

else  # linux
  if systemctl --user is-enabled --quiet gian.service 2>/dev/null; then
    systemctl --user disable --now gian.service
    info "Disabled and stopped gian.service"
  elif systemctl --user is-active --quiet gian.service 2>/dev/null; then
    # Running but not enabled (e.g. started manually).
    systemctl --user stop gian.service
    info "Stopped gian.service"
  else
    info "gian.service is not running — nothing to stop."
  fi

  if [[ -f "${UNIT_DEST}" ]]; then
    rm -f "${UNIT_DEST}"
    info "Removed ${UNIT_DEST}"
    systemctl --user daemon-reload
  else
    info "No unit file found at ${UNIT_DEST} — nothing to remove."
  fi
fi

# ── optional purge ────────────────────────────────────────────────────────────

if [[ "${PURGE}" == true ]]; then
  echo ""
  echo "WARNING: --purge will permanently delete ${DATA_DIR}"
  echo "This includes gian.db (all sessions, workspaces, bots) and all logs."
  echo ""
  read -r -p "Type 'yes' to confirm: " confirm
  if [[ "${confirm}" == yes ]]; then
    rm -rf "${DATA_DIR}"
    info "Deleted ${DATA_DIR}"
  else
    info "Purge cancelled — data left intact."
  fi
else
  echo ""
  info "Data and logs preserved at ${DATA_DIR}"
  info "Run with --purge to delete them (irreversible)."
fi

echo ""
echo "Gian host daemon uninstalled."
