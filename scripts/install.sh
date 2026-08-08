#!/usr/bin/env bash
# install.sh — Register Gian host as a user-level daemon.
#
# Usage:
#   ./scripts/install.sh           # install (refuses to overwrite existing)
#   ./scripts/install.sh --force   # overwrite an existing install
#   ./scripts/install.sh --check   # render/validate unit only; do not install
#
# Supports: macOS (launchd LaunchAgent) and Linux (systemd --user).
# Requires: Node v22+ on $PATH, pre-built packages/host/dist/.

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

info() { echo "[gian] $*"; }

# ── args ─────────────────────────────────────────────────────────────────────

FORCE=false
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --check|--dry-run) CHECK=true ;;
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

# Resolve executable lookups to absolute paths — launchd/systemd do not start
# in the installer's cwd, and PATH is allowed to contain relative entries.
resolve_executable() {
  local candidate directory
  candidate="$(type -P -- "$1" 2>/dev/null || true)"
  [[ -n "${candidate}" ]] || return 1
  if [[ "${candidate}" == /* ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  directory="$(cd "$(dirname "${candidate}")" && pwd -P)" || return 1
  printf '%s/%s\n' "${directory}" "$(basename "${candidate}")"
}

NODE_BIN="$(resolve_executable node)" || die "node not found on \$PATH"

# Confirm it's new enough (v22+) and not Node v25+ (better-sqlite3 breaks).
NODE_VERSION="$("${NODE_BIN}" --version)" # e.g. "v22.4.0"
NODE_MAJOR="${NODE_VERSION#v}"           # strip leading "v"
NODE_MAJOR="${NODE_MAJOR%%.*}"           # keep only major number
if (( NODE_MAJOR < 22 )); then
  die "Node v22+ required (found ${NODE_VERSION}). better-sqlite3 bindings fail on older versions."
fi
if (( NODE_MAJOR >= 25 )); then
  die "Node v25+ silently breaks better-sqlite3 bindings (found ${NODE_VERSION}). Use Node 22–24 (\`nvm use 22\`). If which-node disagrees with nvm, brew is shadowing nvm: \`export PATH=~/.nvm/versions/node/v22.18.0/bin:\$PATH\`."
fi

# Resolve runtime tool paths so launchd's bare PATH doesn't ENOENT on the
# probe. All three are optional at install time — the daemon emits a clearer
# error later if they're missing — but if present, bake their dirs into the
# unit's runtime PATH so the provider proxies can spawn them.
CLAUDE_BIN="$(resolve_executable claude || true)"
CODEX_BIN="$(resolve_executable codex || true)"
KIMI_BIN="$(resolve_executable kimi || true)"

# Build a deduplicated PATH for the launchd plist. launchd's default PATH is
# `/usr/bin:/bin:/usr/sbin:/sbin` — not enough for ~/.local/bin (claude) or
# /opt/homebrew/bin (codex). We include the provider and Node directories
# (when found), then append standard locations so anything not yet installed
# resolves once it lands in the usual spots.
_path_dirs=()
[[ -n "${CLAUDE_BIN}" ]] && _path_dirs+=("$(dirname "${CLAUDE_BIN}")")
[[ -n "${CODEX_BIN}"  ]] && _path_dirs+=("$(dirname "${CODEX_BIN}")")
[[ -n "${KIMI_BIN}"   ]] && _path_dirs+=("$(dirname "${KIMI_BIN}")")
_path_dirs+=("$(dirname "${NODE_BIN}")")
# Common user-bin (claude installer's default) + standard system dirs as
# fallbacks for tools the user installs after running install.sh.
_path_dirs+=("${HOME}/.local/bin" "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin")

# Validate and dedupe without newline-delimited shell pipelines: a legitimate
# directory containing a newline would otherwise be silently split into extra
# PATH entries. Colons are rejected because PATH cannot represent them.
_unique_path_dirs=()
_gian_path_initialized=false
for candidate in "${_path_dirs[@]}"; do
  if [[ "${candidate}" == *:* || "${candidate}" == *[[:cntrl:]]* ]]; then
    die "daemon PATH directory contains an unsupported colon or control character: ${candidate}"
  fi
  duplicate=false
  if [[ "${_gian_path_initialized}" == true ]]; then
    for existing in "${_unique_path_dirs[@]}"; do
      if [[ "${candidate}" == "${existing}" ]]; then
        duplicate=true
        break
      fi
    done
  fi
  if [[ "${duplicate}" != true ]]; then
    _unique_path_dirs+=("${candidate}")
    _gian_path_initialized=true
  fi
done
LAUNCHD_PATH="$(IFS=:; printf '%s' "${_unique_path_dirs[*]}")"

if [[ -z "${CLAUDE_BIN}" ]]; then
  echo "  warn: claude not found on \$PATH — daemon will probe ENOENT until it's installed." >&2
fi
if [[ -z "${CODEX_BIN}" ]]; then
  echo "  warn: codex not found on \$PATH — daemon will probe ENOENT until it's installed." >&2
fi
if [[ -z "${KIMI_BIN}" ]]; then
  echo "  warn: kimi not found on \$PATH — daemon will probe ENOENT until it's installed." >&2
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

if [[ "${CHECK}" != true && -f "${UNIT_DEST}" ]] && [[ "${FORCE}" != true ]]; then
  die "Gian is already installed at ${UNIT_DEST}. Use --force to overwrite."
fi

# ── create log directory ──────────────────────────────────────────────────────

LOG_DIR="${HOME}/.gian/logs"
if [[ "${CHECK}" == true ]]; then
  info "Check mode: no unit files will be installed and no daemon will be started."
else
  mkdir -p "${LOG_DIR}"
  info "Log directory: ${LOG_DIR}"
fi

# ── substitute template variables ────────────────────────────────────────────
#
# Render with context-specific XML/systemd escaping. Generic sed replacement
# corrupts paths containing `&`, `|`, backslashes, XML metacharacters, spaces,
# or systemd `%` specifiers.

substitute() {
  local src="$1" dst="$2"
  "${NODE_BIN}" "${SCRIPT_DIR}/render-daemon-unit.mjs" \
    --platform "${PLATFORM}" \
    --template "${src}" \
    --output "${dst}" \
    --install-dir "${INSTALL_DIR}" \
    --node-bin "${NODE_BIN}" \
    --home "${HOME}" \
    --launchd-path "${LAUNCHD_PATH}"
}

if [[ "${CHECK}" == true ]]; then
  [[ -f "${TEMPLATE}" ]] || die "template not found: ${TEMPLATE}"
  TMP_UNIT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gian-unit.XXXXXX")"
  if [[ "${PLATFORM}" == macos ]]; then
    TMP_UNIT="${TMP_UNIT_DIR}/com.gian.host.plist"
  else
    # systemd-analyze derives the unit type from the filename and rejects a
    # source path without a recognized suffix before parsing its contents.
    TMP_UNIT="${TMP_UNIT_DIR}/gian.service"
  fi
  cleanup_tmp_unit() {
    rm -f "${TMP_UNIT}"
    rmdir "${TMP_UNIT_DIR}" 2>/dev/null || true
  }
  trap cleanup_tmp_unit EXIT
  substitute "${TEMPLATE}" "${TMP_UNIT}"
  if [[ "${PLATFORM}" == macos ]]; then
    /usr/bin/plutil -lint "${TMP_UNIT}" >/dev/null \
      || die "rendered launchd plist is invalid"
  elif command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "${TMP_UNIT}" >/dev/null \
      || die "rendered systemd unit is invalid"
  fi
  info "Rendered ${PLATFORM} unit successfully → ${TMP_UNIT}"
  info "Install dir : ${INSTALL_DIR}"
  info "Node        : ${NODE_BIN} (${NODE_VERSION})"
  info "Launch PATH : ${LAUNCHD_PATH}"
  exit 0
fi

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
