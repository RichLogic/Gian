#!/usr/bin/env bash
set -euo pipefail
# Linux host, Docker Compose v2, flock. Runtime credentials already live on host.
base=${1:?deployment directory required}
revision=${2:?revision required}
image=${3:?immutable image required}
schema=${4:?migration fingerprint required}
[[ "$base" =~ ^/[a-zA-Z0-9_/-]+$ && "$base" != / && "$base" != /home && "$base" != /opt && "$base" != /srv && "$base" != *..* ]] || exit 64
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$schema" =~ ^[a-f0-9]{64}$ ]] || exit 64
[[ "$image" =~ ^ghcr.io/richlogic/gian-remote@sha256:[a-f0-9]{64}$ ]] || exit 64
cd "$base"
[[ -f runtime.env && ! -L runtime.env && ! -L releases && ! -L releases/$revision ]] || { echo 'Missing regular runtime.env or unsafe release directory'; exit 65; }
release="$base/releases/$revision"
[[ -f "$release/compose.yaml" ]] || exit 65
exec 9>deploy.lock
flock -n 9 || { echo 'Another Remote deployment is running'; exit 75; }
umask 077
port=${REMOTE_PORT:-8787}
project=${REMOTE_COMPOSE_PROJECT:-gian-remote}
volume=${REMOTE_DATA_VOLUME:-${project}_remote-data}
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 64
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || exit 64
printf 'REMOTE_IMAGE=%s\nREMOTE_RUNTIME_ENV=%s/runtime.env\nREMOTE_PORT=%s\nREMOTE_DATA_VOLUME=%s\n' "$image" "$base" "$port" "$volume" > "$release/deploy.env"
printf '%s\n' "$schema" > "$release/data-schema"
compose() { docker compose --project-name "$project" --env-file "$1/deploy.env" -f "$1/compose.yaml" "${@:2}"; }
healthy() {
  local directory=$1 id state
  for ((attempt=0; attempt<${REMOTE_DEPLOY_HEALTH_ATTEMPTS:-30}; attempt++)); do
    id=$(compose "$directory" ps -q remote)
    if [[ -n "$id" ]]; then
      state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
      [[ "$state" == healthy ]] && return 0
      [[ "$state" == unhealthy ]] && return 1
    fi
    sleep 2
  done
  return 1
}
previous=''
if [[ -L current ]]; then
  previous=$(readlink current)
  [[ "$previous" =~ ^releases/[a-f0-9]{40}$ && -f "$previous/deploy.env" && -f "$previous/data-schema" ]] || exit 65
  previous="$base/$previous"
elif [[ -e current ]]; then
  echo 'current must be a managed release symlink'; exit 65
fi
docker pull "$image"
if [[ "$previous" == "$release" ]] && healthy "$release"; then
  echo 'This exact release is already healthy'; exit 0
fi
changed=0
rollback() {
  local status=$?
  trap - EXIT
  if [[ "$status" != 0 && "$changed" == 1 ]]; then
    compose "$release" stop remote || true
    if [[ -n "$previous" && "$(<"$previous/data-schema")" == "$schema" ]]; then
      if compose "$previous" up -d --no-build remote && healthy "$previous"; then
        echo 'Deployment failed; previous image restored (unchanged database migration set).'
      else
        echo 'Deployment and rollback both failed; operator intervention required.'
      fi
    else
      echo 'Deployment failed; automatic rollback withheld because the database migration set changed or this is the first deployment. Stopped service; preserve data and use the backup for manual recovery.'
    fi
  fi
  exit "$status"
}
trap rollback EXIT
if [[ -n "$previous" ]]; then
  compose "$previous" stop remote
  changed=1
  backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-$revision"
  mkdir -p "$backup"
  # The old process is stopped: SQLite, WAL and server identity are a consistent set.
  docker run --rm --network none --user 0 --entrypoint tar \
    -v "$volume:/data:ro" -v "$backup:/backup" \
    "$image" -czf /backup/data.tar.gz -C /data .
fi
changed=1
compose "$release" up -d --no-build remote
healthy "$release"
next="$base/current.next.$revision.$$"
ln -s "releases/$revision" "$next"
mv -Tf "$next" "$base/current"
changed=0
echo "Remote deployment healthy: $revision"
