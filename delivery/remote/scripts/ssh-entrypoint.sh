#!/usr/bin/env bash
set -euo pipefail
# Administrator installs this root-owned program as an authorized_keys forced
# command with three FIXED arguments. CI never receives an unrestricted shell.
base=${1:?fixed deployment directory required}
project=${2:?fixed compose project required}
volume=${3:?fixed data volume required}
[[ "$base" =~ ^/[a-zA-Z0-9_/-]+$ && "$base" != *..* && "$base" != / && "$base" != /root ]] || exit 64
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 64
original=${SSH_ORIGINAL_COMMAND:-}
if [[ "$original" == health ]]; then
  exec docker compose --project-name "$project" --env-file "$base/current/deploy.env" -f "$base/current/compose.yaml" ps --format json remote
fi
[[ "$original" != *$'\n'* ]] || exit 64
read -r operation revision image schema extra <<< "$original"
[[ "$operation" == deploy && -z "${extra:-}" ]] || exit 64
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$schema" =~ ^[a-f0-9]{64}$ && "$image" =~ ^ghcr.io/richlogic/gian-remote@sha256:[a-f0-9]{64}$ ]] || exit 64
# The workflow supplies a short-lived, repository-scoped packages:read token
# on stdin. Never store it in arguments, runtime.env or persistent Docker auth.
IFS= read -r -n 256 registry_user
IFS= read -r -n 8193 registry_token
[[ "$registry_user" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ && -n "$registry_token" && ${#registry_token} -le 8192 && "$registry_token" != *$'\r'* ]] || exit 64
umask 077
auth=$(mktemp -d "$base/registry-auth.XXXXXX")
trap 'rm -rf -- "$auth"' EXIT
export DOCKER_CONFIG="$auth"
printf '%s\n' "$registry_token" | docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
unset registry_token
release="$base/releases/$revision"
[[ ! -L "$release" ]]
mkdir -p "$release"
cp "$base/tooling/compose.yaml" "$release/compose.yaml"
export REMOTE_COMPOSE_PROJECT="$project" REMOTE_DATA_VOLUME="$volume"
bash "$base/tooling/deploy.sh" "$base" "$revision" "$image" "$schema"
