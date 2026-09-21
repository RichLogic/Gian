#!/usr/bin/env bash
set -euo pipefail
image=${1:?image required}
revision=${2:?build ID required}
container=$(docker run -d --network bridge -p 127.0.0.1::8787 \
  -e GIAN_REMOTE_PUBLIC_ORIGIN=http://127.0.0.1 \
  -e GIAN_REMOTE_ADMIN_TOKEN=isolated-ci-smoke-token "$image")
trap 'docker rm -f "$container" >/dev/null' EXIT
for ((i=0; i<30; i++)); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy ]] && exit 1
  sleep 2
done
[[ "$state" == healthy ]]
docker exec -i "$container" node --input-type=module - "$revision" <<'NODE'
const expected = process.argv[2];
const response = await fetch('http://127.0.0.1:8787/health');
const health = await response.json();
if (!response.ok || !health.ok || health.build_id !== expected) throw new Error('Wrong running revision');
const page = await fetch('http://127.0.0.1:8787/');
if (!page.ok || !(await page.text()).includes('<html')) throw new Error('Remote Web unavailable');
NODE
# Verify identity continuity as well as readiness across an actual restart.
identity_before=$(docker exec "$container" node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('/data/server-identity.json')).digest('hex'))")
docker restart "$container" >/dev/null
for ((i=0; i<30; i++)); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  [[ "$state" == healthy ]] && break
  sleep 2
done
[[ "$state" == healthy ]]
identity_after=$(docker exec "$container" node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('/data/server-identity.json')).digest('hex'))")
[[ "$identity_before" == "$identity_after" ]]
