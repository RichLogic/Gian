#!/usr/bin/env python3
"""Administrator-only, non-disruptive adoption of an existing Remote container.

Reads Docker configuration; prepares a separate deployment root. Does not stop,
restart or recreate a container and never copies or modifies the data volume.
Existing runtime secrets remain on this machine in mode-0600 files.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def output(args):
    return subprocess.check_output(args, text=True)


def prepare(container, directory, tooling):
    base = Path(directory)
    if not re.fullmatch(r"/[A-Za-z0-9_/-]+", directory) or directory in ["/", "/root", "/opt", "/srv", "/home"] or ".." in directory:
        raise ValueError("Use a dedicated absolute deployment directory")
    if base.exists() or base.is_symlink():
        raise ValueError("Deployment directory already exists; refusing to overwrite")
    info = json.loads(output(["docker", "inspect", container]))[0]
    if info["State"].get("Health", {}).get("Status") != "healthy":
        raise ValueError("Existing container must be healthy before adoption")
    if info["Config"].get("User") not in ["node", "1000", "1000:1000"]:
        raise ValueError("Review data ownership before adopting a container with a different runtime user")
    labels = info["Config"].get("Labels", {})
    project = labels.get("com.docker.compose.project", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project) or labels.get("com.docker.compose.service") != "remote":
        raise ValueError("Expected a Compose-managed remote service")
    mounts = [m for m in info["Mounts"] if m["Destination"] == "/data" and m["Type"] == "volume"]
    if len(mounts) != 1 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", mounts[0]["Name"]):
        raise ValueError("Expected one named persistent data volume")
    volume = mounts[0]["Name"]
    ports = info["HostConfig"].get("PortBindings", {}).get("8787/tcp", [])
    if ports != [{"HostIp": "127.0.0.1", "HostPort": "8787"}]:
        raise ValueError("Review the nonstandard existing port mapping before adoption")
    values = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
    revision = values.get("GIAN_REMOTE_BUILD_ID", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or not re.fullmatch(r"sha256:[a-f0-9]{64}", info["Image"]):
        raise ValueError("Existing source revision/image identity is missing")
    required = ["GIAN_REMOTE_PUBLIC_ORIGIN", "GIAN_REMOTE_ADMIN_TOKEN"]
    if any(not values.get(key) for key in required):
        raise ValueError("Existing runtime configuration is incomplete")
    env_keys = required + ["GIAN_REMOTE_ALLOWED_ORIGINS", "GIAN_REMOTE_TRUSTED_PROXY"]
    runtime = ""
    for key in env_keys:
        if key not in values:
            continue
        value = values[key]
        if any(c in value for c in "\n\r$'"):
            raise ValueError("Existing environment needs reviewed literal encoding; no files changed")
        runtime += key + "='" + value + "'\n"
    config_files = labels.get("com.docker.compose.project.config_files", "").split(",")
    if not config_files or any(not Path(p).is_file() for p in config_files):
        raise ValueError("Original Compose files are unavailable")
    compose_command = ["docker", "compose", "--project-name", project]
    for path in config_files:
        compose_command += ["-f", path]
    old_compose = json.loads(output(compose_command + ["config", "--format", "json"]))
    old_compose["services"]["remote"]["image"] = info["Image"]
    old_compose["services"]["remote"].pop("build", None)
    entry = next((arg for arg in info["Config"].get("Cmd", []) if arg.endswith("/cli.js")), None)
    if not entry:
        raise ValueError("Cannot locate the running Remote migration set")
    entry = Path(info["Config"].get("WorkingDir") or "/") / entry
    migrations = str(entry.parent.parent / "migrations")
    schema = output(["docker", "exec", container, "node", "-e", "const fs=require('fs'),c=require('crypto');const p=process.argv[1],h=c.createHash('sha256');for(const n of fs.readdirSync(p).sort())h.update(n+'\\0').update(fs.readFileSync(p+'/'+n)).update('\\0');process.stdout.write(h.digest('hex'))", migrations]).strip()
    if not re.fullmatch(r"[a-f0-9]{64}", schema):
        raise ValueError("Invalid migration fingerprint")
    staging = Path(tempfile.mkdtemp(prefix=".gian-remote-ci-", dir=base.parent))
    try:
        def write(path, text):
            path.write_text(text)
            path.chmod(0o600)
        (staging / "tooling").mkdir(mode=0o700)
        for name in ["compose.yaml", "deploy.sh", "ssh-entrypoint.sh"]:
            shutil.copyfile(Path(tooling) / name, staging / "tooling" / name)
            (staging / "tooling" / name).chmod(0o600)
        write(staging / "runtime.env", runtime)
        old = staging / "releases" / revision
        old.mkdir(parents=True, mode=0o700)
        write(old / "compose.yaml", json.dumps(old_compose, indent=2) + "\n")
        write(old / "deploy.env", "REMOTE_IMAGE=" + info["Image"] + "\nREMOTE_RUNTIME_ENV=" + str(base / "runtime.env") + "\nREMOTE_PORT=8787\nREMOTE_DATA_VOLUME=" + volume + "\n")
        write(old / "data-schema", schema + "\n")
        write(staging / "adoption.json", json.dumps({"container": container, "project": project, "volume": volume, "revision": revision, "image": info["Image"], "dataSchema": schema}, indent=2) + "\n")
        (staging / "current").symlink_to("releases/" + revision)
        staging.rename(base)
    except Exception:
        shutil.rmtree(staging)
        raise
    return {"directory": str(base), "project": project, "volume": volume, "sourceRevision": revision, "runningContainerChanged": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--tooling", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.container, args.directory, args.tooling)))
