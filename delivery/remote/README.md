# Gian Remote

Remote Server and Remote Web are one independently built and deployed product.
Development happens in GianDev. `.gian-source.json` records the exact source
commit, shared package snapshots and file hashes. Do not hand-edit these
snapshots in the distribution repository.

## Local source checks

Requires Node 24 and pnpm 10.33.2:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

The workspace contains remote-server, remote-web, shared and chat-ui.
`@gian/remote-protocol` is an external package published by public
[Gian](https://github.com/RichLogic/Gian), not a source directory in this repo.
It does not require access to private GianDev, a checkout of the whole Gian
repository, Electron or any Provider Proxy.
GianDev retains the shared source-scan and Host/Web cross-product integration
tests. Public Remote CI runs all Remote package tests and deployment-script
regression, and builds/boots the real container.

## Remote Protocol dependency

The protocol source and public release entrypoint belong to Gian at
`packages/remote-protocol`. Pushing an immutable `remote-protocol-vX.Y.Z` tag
triggers its dedicated package workflow. Only after qualification succeeds does
the GitHub Release contain the installable `.tgz`, coordinate and checksums.
The protocol release never becomes the Desktop application's latest release.

For example, after version 1.0.0 is actually published:

```sh
npm install https://github.com/RichLogic/Gian/releases/download/remote-protocol-v1.0.0/gian-remote-protocol-1.0.0.tgz
```

This is a normal package named `@gian/remote-protocol`; imports use that name.
It is a GitHub Release archive, not an npm Registry publication. A Git tag alone
is not an installable package, and `npm install @gian/remote-protocol@1.0.0`
would require a separate Registry publication.

The generated package.json files use the exact public Gian archive URL.
pnpm-lock.yaml records the same URL and SHA-512 integrity; protocol-package.json
also records SHA-256, size and public source commit. No GitHub token is required
to download the public package. Do not substitute a mutable branch, latest URL,
private GianDev reference or a temporary signed CDN URL.

The exporter refuses a pending first publication. Import real release metadata
after verifying the published tag and archive, then export again; never invent
an archive digest to make a not-yet-published dependency appear installable.
See [pnpm's supported package sources](https://pnpm.io/cli/add#supported-package-sources).

## Connect a Gian computer

With the Remote Server running, create a one-time enrollment token inside its
service environment:

```sh
gian-remote-server enrollment create --label 'Home Mac'
# For the shipped Compose service:
docker compose exec remote gian-remote-server enrollment create --label 'Home Mac'
```

The command prints the Server URL, token and expiry. Enter these in Gian's
Settings → Remote within 10 minutes. The token is single-use; normal reconnects
do not need another. The CLI uses the existing local admin API and the server's
`GIAN_REMOTE_ADMIN_TOKEN`, without printing the admin key. Run it inside the
container/service environment; public proxies should keep the admin API blocked.

Once connected, rename the computer in Gian if needed and generate a device
pairing QR/link. A browser may pair with several computers independently and
switch using the Host menu. Open invitations in the browser you want to use
before confirming. Pairing still requires approval on the corresponding Mac.

Deploy a Server supporting `/api/v1/host/profile` before a Desktop offering
Rename. Names are metadata; renaming preserves Host identity and pairings.

## Stable release

`release.json` owns the Remote product version. Its version is independent of
the Desktop version and the communication protocol. Update it in GianDev,
export a committed revision, review/sync that output to this repository and
create an immutable `vX.Y.Z` tag on main.

Run **Release Remote** on main with that tag. It checks the exact tag commit,
builds and tests native linux/amd64 and linux/arm64 images, pushes those tested
images, creates their multi-platform manifest, and publishes a stable GitHub
Release with `remote-release.json` and `SHA256SUMS`. That receipt binds source,
image digest and the database migration fingerprint. A published tag cannot
be rebuilt through this release entrypoint. Deployment retries consume the
published receipt and never rebuild an image.

The runtime bundle copies the frozen install's actual production dependency
graph and native build outputs. It does not resolve semver ranges again or
depend on package metadata in a developer's pnpm cache.

Release Remote directly calls Deploy Remote after publication. A release
created with GITHUB_TOKEN does not normally trigger another event workflow;
this direct call avoids a missing deployment. Deploy Remote also handles
human-published stable releases and manual retries. Drafts and prereleases
are not deployed; only the latest published stable release is eligible.
See [GitHub workflow trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## One-time cloud host setup

Use a dedicated Linux host/account with Docker Engine, Docker Compose v2,
`flock`, tar and SSH. The account must be allowed to run Docker. No inbound
Agent or workspace access is required. The server must be able to pull the
image from GHCR. In upload mode, either make the image package public or
configure a read-only registry login on the machine. Restricted mode uses the
current workflow's short-lived packages:read token on stdin and removes its
temporary Docker authentication directory when deployment finishes.

Choose a dedicated directory, for example `/opt/gian-remote`. It must be
writable by the deployment account. Install `runtime.env` there with mode
0600, using `runtime.env.example` as the field reference. Set a random admin
token and the real HTTPS origin; do not put those secrets in Git or Actions
logs. The data volume preserves pairing records and the server identity.

For an existing Compose-managed Remote, prefer preserving its project and data
volume. An administrator can prepare a separate deployment directory with
`scripts/prepare-existing.py --container <name> --directory <new-path> --tooling <staging-directory>`.
The staging directory must contain compose.yaml, deploy.sh and ssh-entrypoint.sh.
The helper refuses an existing destination, reads the healthy container and
original Compose configuration, and records its exact image and migration set
for rollback. Runtime secrets stay on the server in mode-0600 files. It neither
restarts the container nor copies/modifies its data volume. Nonstandard ports,
bind-mounted data or unavailable original configuration require explicit review.

In restricted mode, install a new deployment-only public key in authorized_keys
with `restrict` and a fixed forced command, for example:

```text
restrict,command="/bin/bash /srv/gian-remote-ci/tooling/ssh-entrypoint.sh /srv/gian-remote-ci current current_remote-data" ssh-ed25519 <deployment-public-key> gian-remote-ci
```

Use the actual project and volume from adoption.json. The key permits only
`health` and a validated `deploy <commit> <owned-image-digest> <migration-hash>`
operation. It cannot request a shell, upload scripts, or forward ports. The
administrator maintains the root-owned deployment tooling; CI only supplies
release identities. Never upload a personal SSH private key to GitHub.

Remote binds only `127.0.0.1:8787` on the host by default. Configure your HTTPS
reverse proxy to forward HTTP and WebSocket upgrades there; set appropriate
WebSocket timeouts. `GIAN_REMOTE_TRUSTED_PROXY=1` is appropriate only if that
proxy overwrites forwarding headers and untrusted clients cannot bypass it.
The workflow does not change DNS, certificates, firewalls or an existing proxy.

In GitHub configure environment **remote-production**:

| Kind | Name | Value |
|---|---|---|
| Variable | REMOTE_SSH_HOST | Cloud host DNS name or IPv4 address |
| Variable | REMOTE_SSH_USER | Dedicated deployment user |
| Variable | REMOTE_SSH_PORT | SSH port; default 22 |
| Variable | REMOTE_DEPLOY_DIR | Dedicated absolute directory |
| Variable | REMOTE_SSH_MODE | `restricted` for a forced-command key; `upload` for the original installer flow |
| Secret | REMOTE_SSH_PRIVATE_KEY | Deployment SSH private key |
| Secret | REMOTE_SSH_KNOWN_HOSTS | Independently verified OpenSSH known_hosts entry (include port syntax for non-22) |

Set repository variable **REMOTE_DEPLOY_ENABLED=true** only after the host and
these settings are ready. Without it deployment is disabled, while source
checks and releases remain usable. Environment reviewer rules, if configured,
will deliberately pause each deployment; omit required reviewers if automatic
deployment after an authorized stable release is desired.

## Deployment and failure handling

The runner verifies the published receipt/tag and uses pinned SSH host keys.
SSH sends a keepalive every 15 seconds and allows up to 60 minutes per transfer
or deployment for slow registry links (65-minute job budget). Transport tooling
comes from main so connection fixes can retry existing immutable releases.
Upload mode copies the versioned compose/deployment scripts; restricted mode
invokes the administrator-installed entrypoint. It then asks the host to pull
the exact `ghcr.io/richlogic/gian-remote@sha256:...` image. It uses a deployment
lock, stops the previous service, backs up the stopped data volume, and starts
the candidate. A short interruption is expected; existing clients reconnect.
The host's healthcheck validates the running source revision; release CI also
checks the served Web page. The `current` symlink advances only after health.

If health fails with an unchanged migration set, the script restarts the
previous image and still returns failure to CI. If migrations changed, or on
the first deployment, it stops the failed service and requests manual recovery.
It never automatically restores a database backup, overwrites the identity,
deletes volumes or removes old release images. Backups live in the deployment
directory and require an operator retention policy and restricted access.
Confirm public HTTPS and real device reconnection after the first deployment;
local/container health alone cannot prove the cloud network route.

## Protocol rollout

New Host/Web exchange an encrypted hello after the cryptographic handshake.
The selected protocol and capabilities are bound to the device, connection and
Host generation. Explicit negotiation errors or connection failure never fall
back. To preserve already deployed Hosts that ignore hello, Web permits a
bounded 1.5-second silent-peer fallback to the existing legacy behavior. Old
Web clients may send their first business command to a new Host without hello.
This transition is not proof that arbitrary historical peers are compatible.
Remove it only as a separately planned compatibility break.

Deploying Remote does not update the user's Gian Desktop. The paired Host
change must reach a Gian release for new connections to report negotiated mode.
