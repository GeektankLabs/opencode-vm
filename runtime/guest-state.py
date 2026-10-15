"""Owned guest-only monitor/dependency paths. No legacy import or copyback."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

NATIVE = {"ext2/ext3", "ext4", "tmpfs", "overlayfs", "xfs", "btrfs"}


def checked(path):
    """Check every existing component without following links, including mountpoints."""
    path = Path(path)
    if not path.is_absolute() or os.path.normpath(str(path)) != str(path):
        raise ValueError("guest path must be absolute and normalized")
    current = Path(path.anchor)
    for component in (None, *path.parts[1:]):
        if component is not None:
            current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"unsafe guest path component: {current}")
        if info.st_uid not in (0, os.getuid()):
            raise ValueError(f"foreign guest path owner: {current}")
        if info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX):
            raise ValueError(f"writable guest path component: {current}")
        fs = subprocess.run(["stat", "-f", "-c", "%T", str(current)],
                            capture_output=True, text=True, check=True).stdout.strip()
        if fs not in NATIVE:
            raise ValueError(f"not a guest-native filesystem: {current} ({fs}); no host fallback")
    return path


def identity(project):
    project = os.path.abspath(project)
    original = os.environ.get("OCVM_PROJECT_PATH", project)
    if os.path.realpath(original) != os.path.realpath(project):
        raise ValueError("monitor project identity conflicts with runtime workspace")
    phash = hashlib.md5(original.encode()).hexdigest()
    supplied = os.environ.get("OCVM_PROJ_HASH")
    if supplied and supplied != phash:
        raise ValueError("project hash does not match exact launcher project identity")
    return original, phash


def private_file(path, content=None):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"unsafe ownership file: {path}")
        return path.read_text()
    if content is None:
        return None
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(content)
    try:
        os.link(temp, path)
    except FileExistsError:
        pass
    finally:
        temp.unlink()
    return private_file(path)


def make_private(path):
    home = Path.home()
    for component in reversed([path, *path.parents]):
        try:
            component.mkdir(mode=0o700)
        except FileExistsError:
            pass
        try:
            info = component.lstat()
        except OSError:
            continue
        # Owned group/other-writable directories inside the user's own home
        # (never home itself, never system paths) are tightened instead of
        # rejected: a umask-0002 parent would otherwise fail every resolve.
        if (stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and component != home and home in component.parents
                and info.st_mode & 0o077):
            try:
                os.chmod(component, 0o700)
            except OSError:
                pass
    checked(path)


def resolve(project, kind, create=False):
    original, phash = identity(project)
    base = Path(os.environ.get("OCVM_ARTIFACT_ROOT", str(Path.home() / ".opencode-vm/artifacts")))
    if create:
        make_private(base)
    base = checked(base)
    path = checked(base / phash / kind)
    if kind == "monitor":
        override = os.environ.get("OCVM_MONITOR_STATE_DIR")
        if override and override != str(path):
            raise ValueError("monitor state override differs from canonical project guest path")
    if create:
        make_private(base)
    gid = private_file(base / ".ocvm-guest-id", str(uuid.uuid4()) if create else None) if base.exists() else None
    owner = {"schema": 1, "project": original, "kind": kind, "guest_id": gid}
    if path.exists():
        if path.stat().st_uid != os.getuid():
            raise ValueError(f"foreign artifact directory: {path}")
        marker = private_file(path / ".ocvm-owner.json")
        if marker is None:
            if not create or any(path.iterdir()):
                raise ValueError(f"unowned artifact directory retained: {path}")
        elif json.loads(marker) != owner:
            raise ValueError(f"artifact identity mismatch: {path}")
    if create:
        make_private(path)
        checked(path)
        private_file(path / ".ocvm-owner.json", json.dumps(owner, sort_keys=True))
    return path


def dependencies(project, package, kind, mode):
    """Install on guest disk, then bind node_modules. Never delete an old target."""
    package = Path(package).absolute()
    if package.is_symlink() or not package.is_dir():
        raise ValueError("dependency package must be a real directory")
    for name in ("package.json", "package-lock.json"):
        p = package / name
        if p.is_symlink():
            raise ValueError(f"dependency manifest must not be a link: {p}")
    source = package / "node_modules"
    if source.exists() and not source.is_symlink():
        raise ValueError(f"existing real node_modules retained; explicit migration required: {source}")
    root = resolve(project, "dependencies", True)
    payload = (package / "package.json").read_bytes()
    lock = (package / "package-lock.json").read_bytes() if (package / "package-lock.json").exists() else b""
    node = subprocess.check_output(["node", "--version"]).strip()
    fingerprint = hashlib.sha256(str(package).encode() + payload + lock + node + mode.encode()).hexdigest()
    destination = checked(root / kind / fingerprint)
    expected = {"source": str(package), "fingerprint": fingerprint, "mode": mode}
    # Lock is in our owned guest class, never in a foreign target.
    fd = os.open(root / ".install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        previous = os.readlink(source) if source.is_symlink() else None
        if previous:
            old = checked(Path(previous).parent)
            oldmarker = private_file(old / ".ocvm-dependencies.json")
            if oldmarker is None or json.loads(oldmarker).get("source") != str(package) or not old.is_relative_to(root):
                raise ValueError("foreign node_modules symlink retained")
        if destination.exists():
            mark = private_file(destination / ".ocvm-dependencies.json")
            if mark is None or json.loads(mark) != expected:
                raise ValueError("foreign dependency destination retained")
        else:
            make_private(destination)
            private_file(destination / ".ocvm-dependencies.json", json.dumps(expected, sort_keys=True))
        if not (destination / ".ready").exists():
            data = json.loads(payload)
            # npm's file: dependencies retain their original source-relative meaning.
            for group in ("dependencies", "devDependencies", "optionalDependencies"):
                for key, value in data.get(group, {}).items():
                    if isinstance(value, str) and value.startswith("file:") and not value[5:].startswith("/"):
                        if mode != "config":
                            raise ValueError("relative local dependencies require config install mode")
                        data[group][key] = "file:" + str((package / value[5:]).resolve())
            (destination / "package.json").write_text(json.dumps(data))
            if lock:
                (destination / "package-lock.json").write_bytes(lock)
            cmd = ["npm", "install" if mode == "config" else "ci", "--no-audit", "--no-fund", "--loglevel=error"]
            if mode == "release":
                cmd += ["--omit=dev"]
            if kind != "openlive-adapter" and mode != "config" or mode == "release":
                cmd += ["--ignore-scripts"]
            subprocess.run(cmd, cwd=destination, check=True, stdout=sys.stderr, umask=0o077)
            (destination / ".ready").touch(mode=0o600)
        checked(destination / "node_modules")
        # Atomic link publication with a final unchanged-source check.
        if source.is_symlink():
            if os.readlink(source) != previous:
                raise ValueError("node_modules ownership changed during install")
        elif source.exists():
            raise ValueError("node_modules appeared during install; retained")
        temp = package / (".node_modules-link-" + uuid.uuid4().hex)
        temp.symlink_to(destination / "node_modules")
        os.replace(temp, source)
    return str(destination / "node_modules")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["resolve", "dependencies"])
    p.add_argument("project")
    p.add_argument("kind")
    p.add_argument("args", nargs="*")
    p.add_argument("--create", action="store_true")
    a = p.parse_args()
    if a.kind not in {"monitor", "dependencies", "mcp-adapter", "dashboard-adapter", "openlive-adapter", "oc-config"}:
        raise ValueError("invalid guest artifact class")
    if a.action == "resolve":
        path = resolve(a.project, a.kind, a.create)
        if a.args:
            child = Path(a.args[0])
            if child.is_absolute() or ".." in child.parts:
                raise ValueError("invalid guest child path")
            path = checked(path / child)
        print(path)
    else:
        print(dependencies(a.project, a.args[0], a.kind, a.args[1]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[guest-state] {error}", file=sys.stderr)
        raise SystemExit(1)
