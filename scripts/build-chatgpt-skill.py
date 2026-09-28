#!/usr/bin/env python3
"""Build/check the inventoried, instruction-only ChatGPT skill (stdlib only)."""

import argparse
import hashlib
import io
import ipaddress
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import sys
import unicodedata
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = Path("integrations/chatgpt")
PRIVATE = re.compile(
    r"\b(?:tunnel_[A-Za-z0-9_-]{16,}|(?:ses|msg)_[A-Za-z0-9]{16,}|"
    r"sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|"
    r"github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16})\b|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|/Users/|/home/|[A-Za-z]:\\Users\\"
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_text(path):
    require(not path.is_symlink() and path.is_file(), f"Not a regular source file: {path.name}")
    text = path.read_text(encoding="utf-8")  # Canonical UTF-8/LF on all build hosts.
    require(not PRIVATE.search(text), f"Possible private identifier/credential/path in {path.name}")
    require(all(ch in "\n\t" or unicodedata.category(ch) not in {"Cc", "Cf"} for ch in text),
            f"Unexpected invisible/control character in {path.name}")
    for value in re.findall(r'https?://[^\s<>"\)]+', text):
        url = urlsplit(value)
        host = url.hostname or ""
        require(not url.username and not url.password and host != "localhost"
                and not host.endswith((".local", ".internal", ".lan")),
                f"Private/credentialed URL in {path.name}")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            continue
        require(address.is_global, f"Private IP address in {path.name}")
    return text


def package_content(root):
    base = root / PACKAGE
    require(not (root / "integrations").is_symlink() and not base.is_symlink(),
            "Symlinked package directories are not allowed")
    manifest = json.loads(read_text(base / "bundle.json"))
    require(isinstance(manifest, dict) and manifest.get("schema") == 1, "Unsupported bundle inventory schema")
    name, revision, files = (manifest.get(key) for key in ("name", "revision", "files"))
    require(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name), "Invalid skill name")
    require(isinstance(revision, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}-r[1-9]\d*", revision), "Invalid revision")
    require(isinstance(files, list) and files and all(isinstance(item, str) for item in files), "Invalid inventory")
    require(len(files) == len(set(files)), "Duplicate inventory member")
    for relative in files:
        path = PurePosixPath(relative)
        require(re.fullmatch(r"[A-Za-z0-9_./-]+", relative) and not path.is_absolute()
                and str(path) == relative and all(not part.startswith(".") for part in path.parts)
                and path.suffix in {".md", ".yaml", ".svg"}, f"Unsafe/unsupported member: {relative}")
    source = base / name
    require(source.is_dir() and not source.is_symlink(), "Missing or symlinked skill directory")
    actual = set()
    for path in source.rglob("*"):
        require(not path.is_symlink(), "Symlinks are not allowed in skill sources")
        if path.is_dir():
            continue
        require(path.is_file(), "Non-regular skill source")
        actual.add(path.relative_to(source).as_posix())
    require(actual == set(files), f"Inventory mismatch: missing={sorted(set(files) - actual)}, extra={sorted(actual - set(files))}")
    content = {relative: read_text(source / relative) for relative in files}
    require({"SKILL.md", "CHANGELOG.md", "agents/openai.yaml", "assets/icon.svg"} <= content.keys(),
            "Required skill source files are missing")
    require("SKILL.md" in content and sum(PurePosixPath(item).name.lower() == "skill.md" for item in files) == 1,
            "Exactly one root SKILL.md is required")
    skill = content["SKILL.md"]
    require(skill.startswith("---\n") and "\n---\n" in skill[4:], "Missing skill front matter")
    front = skill[4:].split("\n---\n", 1)[0]
    require(f"name: {name}" in front.splitlines(), "Skill name differs from folder/inventory")
    description = re.search(r"^description: (.+)$", front, re.M)
    require(description and 0 < len(description[1]) <= 1024, "Invalid one-line skill description")
    require(f"**{revision}**" in skill and f"## {revision}\n" in content["CHANGELOG.md"], "Revision markers differ")
    require("license: MIT" in front.splitlines(), "Expected MIT license declaration")

    for relative, text in content.items():
        if not relative.endswith(".md"):
            continue
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if target.startswith(("https://", "http://", "#")):
                continue
            target = target.split("#", 1)[0]
            linked = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
            require(linked in content, f"Missing/out-of-bundle link in {relative}: {target}")
    metadata = content["agents/openai.yaml"]
    require(not re.search(r"^dependencies:", metadata, re.M), "Generic skill must not bind a fixed MCP dependency")
    icons = re.findall(r'^  icon_(?:small|large): "([^"\n]+)"$', metadata, re.M)
    require(len(icons) == 2 and all(posixpath.normpath(icon) in content for icon in icons), "Invalid icon references")
    svg = content["assets/icon.svg"]
    require("<!DOCTYPE" not in svg and "<!ENTITY" not in svg, "SVG entities are not allowed")
    require(not re.search(r"<\?(?!xml\s)", svg), "SVG processing instructions are not allowed")
    element = ET.fromstring(svg)
    allowed = {f"{{http://www.w3.org/2000/svg}}{tag}" for tag in
               ("svg", "title", "desc", "defs", "linearGradient", "stop", "rect", "path")}
    require(element.tag == "{http://www.w3.org/2000/svg}svg", "Invalid SVG root")
    attributes = {"id", "width", "height", "viewBox", "role", "aria-labelledby",
                  "x", "y", "rx", "d", "x1", "x2", "y1", "y2", "gradientUnits",
                  "offset", "stop-color", "fill", "stroke", "stroke-opacity",
                  "stroke-width", "stroke-linecap", "stroke-linejoin"}
    for child in element.iter():
        require(child.tag in allowed, "Unexpected active/external SVG element")
        for key, value in child.attrib.items():
            require(key in attributes, "Unexpected SVG attribute")
            if key in {"fill", "stroke", "stop-color"}:
                require(re.fullmatch(r"#[A-Fa-f0-9]{3,8}|none|url\(#[A-Za-z0-9_-]+\)", value),
                        "Unsupported/external SVG paint")
            require("url(" not in value or re.fullmatch(r"url\(#[A-Za-z0-9_-]+\)", value), "External SVG resource")
    content["LICENSE"] = read_text(root / "LICENSE")
    return manifest, content


def archive_bytes(root):
    manifest, content = package_content(root)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for relative, text in sorted(content.items()):
            entry = zipfile.ZipInfo(f'{manifest["name"]}/{relative}', (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, text.encode("utf-8"))
    return manifest, buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, help="Optional ZIP output path")
    parser.add_argument("--check", action="store_true", help="Verify ZIP and checksum without writing")
    args = parser.parse_args()
    manifest, data = archive_bytes(ROOT)
    destination = args.output or ROOT / PACKAGE / f'{manifest["name"]}.zip'
    require(destination.suffix == ".zip" and not destination.is_symlink(), "Output must be a regular .zip path")
    require((ROOT / PACKAGE / manifest["name"]).resolve() not in destination.resolve().parents,
            "Output must be outside the skill source directory")
    checksum = destination.with_name(destination.name + ".sha256")
    require(not checksum.is_symlink(), "Checksum output must not be a symlink")
    digest = hashlib.sha256(data).hexdigest()
    expected = f"{digest}  {destination.name}\n"
    if args.check:
        require(destination.is_file() and destination.read_bytes() == data, "ZIP missing or stale; rebuild it")
        require(checksum.is_file() and checksum.read_text(encoding="utf-8") == expected, "Checksum missing or stale")
        latest = destination.parent / "latest.json"
        latest_data = json.loads(latest.read_text(encoding="utf-8")) if latest.is_file() else {}
        require(latest_data == {
            "schema": 1,
            "name": manifest["name"],
            "revision": manifest["revision"],
            "download": "https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip",
            "sha256": digest,
            "checksum": "integrations/chatgpt/opencode-session-orchestrator.zip.sha256",
            "docs": "https://github.com/GeektankLabs/opencode-vm/blob/main/docs/CHATGPT.md",
        }, "latest.json missing or stale")
        print(f'OK: {manifest["name"]} {manifest["revision"]}, inventory/ZIP/checksum match')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        checksum.write_bytes(expected.encode("utf-8"))
        latest = destination.parent / "latest.json"
        latest.write_text(json.dumps({
            "schema": 1,
            "name": manifest["name"],
            "revision": manifest["revision"],
            "download": "https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip",
            "sha256": digest,
            "checksum": "integrations/chatgpt/opencode-session-orchestrator.zip.sha256",
            "docs": "https://github.com/GeektankLabs/opencode-vm/blob/main/docs/CHATGPT.md",
        }, indent=2) + "\n", encoding="utf-8")
        print(f"{destination}\nSHA-256: {digest}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, ET.ParseError) as error:
        sys.exit(f"Skill package error: {error}")
