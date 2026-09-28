#!/usr/bin/env python3
"""Project-scoped Agent Control Hub for opencode-vm.

The service intentionally uses only the Python standard library. It reads a
small allowlist of host/session files and never returns credentials or raw
configuration blobs.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from .policy import PolicyStore, PolicyError, PolicyConflict, PROFILES, check_selection, validate_selection
    from .catalog import read_catalog
except ImportError:  # Executed directly as hub/server.py by the host launcher.
    from policy import PolicyStore, PolicyError, PolicyConflict, PROFILES, check_selection, validate_selection
    from catalog import read_catalog


ROOT = Path(__file__).resolve().parent
SHARE_ROOT = Path(os.environ.get("OCVM_SHARE_ROOT", Path.home() / ".opencode-vm"))
PROJECT = Path(os.environ.get("HUB_PROJECT", os.getcwd())).resolve()
MAX_LOG_BYTES = 64 * 1024
MAX_EVENTS = 12
SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:api[-_ ]?key|token|secret|password)[=: ]+)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"\b(?:sk|gh[pousr])[-_A-Za-z0-9]{16,}\b"), "[REDACTED]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]"),
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def project_hash() -> str:
    return hashlib.md5(os.fsencode(PROJECT)).hexdigest()


def safe_id(value: str, length: int = 12) -> str:
    return value[:length] if value else "unknown"


def parse_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.is_file() or path.is_symlink():
        return result
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(?:\"([^\"]*)\"|'([^']*)'|([^#]*))", line)
            if match:
                result[match.group(1)] = next((part for part in match.groups()[1:] if part is not None), "").strip()
    except OSError:
        return {}
    return result


def read_json(path: Path) -> Any:
    if not path.is_file() or path.is_symlink():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def redact(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:1000]


def event(severity: str, source: str, message: str, timestamp: str | None = None) -> dict[str, str]:
    return {"severity": severity, "source": source, "message": redact(message), "timestamp": timestamp or now()}


def read_events(paths: list[tuple[Path, str]]) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    for path, source in paths:
        if not path.is_file() or path.is_symlink():
            continue
        try:
            data = path.read_bytes()[-MAX_LOG_BYTES:]
            lines = data.decode("utf-8", "replace").splitlines()[-MAX_EVENTS:]
        except OSError:
            continue
        for line in lines:
            level = "error" if re.search(r"(?i)error|fail|fatal", line) else "info"
            events.append(event(level, source, line))
    return events[-MAX_EVENTS:]


def project_assignment() -> dict[str, Any] | None:
    registry = read_json(SHARE_ROOT / "mcp-tunnel/openai/registry.json")
    if not isinstance(registry, dict) or not isinstance(registry.get("projects"), dict):
        return None
    canonical = str(PROJECT)
    for value in registry["projects"].values():
        if isinstance(value, dict) and value.get("path") and os.path.realpath(value["path"]) == canonical:
            return {"id": value.get("id", "unknown"), "keyId": value.get("keyId", "unknown"), "tunnelId": value.get("tunnelId", "unknown")}
    return None


def tracked_sessions() -> list[tuple[Path, dict[str, str]]]:
    result = []
    directory = SHARE_ROOT / "sessions"
    if not directory.is_dir():
        return result
    for path in sorted(directory.glob("*.env")):
        values = parse_env(path)
        if values.get("SESS_PROJ") and os.path.realpath(values["SESS_PROJ"]) == str(PROJECT):
            result.append((path, values))
    return result


def probe_http(url: str, secret: str | None = None) -> tuple[bool, dict[str, Any] | None]:
    headers = {"Authorization": f"Bearer {secret}"} if secret else {}
    try:
        with urlopen(Request(url, headers=headers), timeout=1.5) as response:
            body = response.read(128 * 1024)
            return 200 <= response.status < 300, json.loads(body.decode("utf-8")) if body else None
    except (OSError, ValueError, URLError):
        return False, None


def probe_port(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def vm_running(name: str) -> bool | None:
    if os.environ.get("HUB_DISABLE_PROBES") == "1" or not name:
        return None
    try:
        result = subprocess.run(["limactl", "list", name, "--format", "{{.Status}}"], capture_output=True, text=True, timeout=2, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    status = result.stdout.strip().lower()
    return True if status == "running" else False if status in {"stopped", "nonexistent", ""} else None


def status_card(card_id: str, name: str, kind: str, configured: bool, runtime: str, health: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"id": card_id, "name": name, "type": kind, "configured": configured, "runtimeStatus": runtime, "healthStatus": health, "statusReason": reason, "lastCheck": now(), "diagnosticsAvailable": bool(extra.pop("diagnosticsAvailable", False)), "logCapability": bool(extra.pop("logCapability", False)), **extra}


def build_model() -> dict[str, Any]:
    sessions = tracked_sessions()
    assignment = project_assignment()
    integrations: list[dict[str, Any]] = []
    log_paths: list[tuple[Path, str]] = []

    if assignment:
        runtime = "inactive/stopped"
        health = "unknown/stale"
        reason = "Konfiguration vorhanden; für dieses Projekt ist keine verifizierte Laufzeit aktiv."
        session = sessions[0][1] if sessions else {}
        share = SHARE_ROOT / "sessions" / next((p.stem for p, _ in sessions), "")
        runtime_file = share / "mcp/runtime.json"
        runtime_data = read_json(runtime_file)
        if session and runtime_data:
            running = vm_running(session.get("SESS_NAME", ""))
            runtime = "active/healthy" if running is True else "unknown/stale" if running is None else "inactive/stopped"
            health = "unknown/stale" if running is not True else "warning/degraded"
            reason = "Runtime-Datei vorhanden; Tunnel-Health bleibt ohne verifizierte Control-Plane-Antwort unbekannt."
            if runtime_data.get("connected") is True:
                health = "active/healthy"
                reason = "Der lokale Runtime-Status meldet eine erfolgreiche Tunnel-Verbindung."
        log_paths += [(share / "mcp/tunnel.log", "secure-mcp-tunnel"), (share / "mcp/backend.log", "mcp-backend")]
        integrations.append(status_card("secure-mcp-tunnel", "OpenAI Secure MCP Tunnel", "secure-mcp-tunnel", True, runtime, health, reason, endpointClass="outbound HTTPS / tunnel", safeId=safe_id(str(assignment.get("tunnelId", "")), 14), setupRef="docs/MCP-TUNNEL.md", diagnosticsAvailable=True, logCapability=True))

    for _, values in sessions:
        if values.get("SESS_MCP_ENABLED") != "1":
            continue
        port = int(values.get("SESS_MCP_PORT") or 0) if values.get("SESS_MCP_PORT", "").isdigit() else 0
        available = probe_port(port) if port else False
        integrations.append(status_card("incoming-mcp", "OpenCode MCP Connector", "incoming-mcp", True, "active/healthy" if available else "unknown/stale", "active/healthy" if available else "unknown/stale", "Loopback-Adapter und Host-Weiterleitung wurden nicht bestätigt." if not available else "Loopback-Port ist erreichbar; der Adapter bleibt projektgebunden.", endpointClass=f"loopback :{port}" if port else "loopback", setupRef="docs/MCP-INTERFACE.md", diagnosticsAvailable=True, logCapability=True))

    for _, values in sessions:
        if values.get("SESS_MODE") != "web":
            continue
        port = int(values.get("SESS_PORT") or 0) if values.get("SESS_PORT", "").isdigit() else 0
        a2a_port = port + 3
        card_url = f"http://127.0.0.1:{a2a_port}/.well-known/agent-card.json"
        ok, card = probe_http(card_url)
        health_ok = False
        if ok and isinstance(card, dict):
            interfaces = card.get("supportedInterfaces", [])
            authoritative = next((item.get("url") for item in interfaces if isinstance(item, dict) and item.get("protocolBinding") == "JSONRPC" and item.get("url")), None)
            if authoritative:
                card_url = authoritative.rstrip("/") + "/.well-known/agent-card.json"
            auth = parse_env(SHARE_ROOT / "sessions" / next((p.stem for p, _ in sessions), "") / "auth.env")
            secret = auth.get("OPENCODE_SERVER_PASSWORD") or "opencode-vm"
            health_ok, _ = probe_http(card_url.replace("/.well-known/agent-card.json", "/health"), secret)
        integrations.append(status_card("a2a", "A2A Agent Interface", "a2a", True, "active/healthy" if health_ok else "unknown/stale", "active/healthy" if health_ok else "error/unhealthy" if ok else "unknown/stale", "Agent Card und Health sind erreichbar." if health_ok else "A2A-Endpoint oder authentifizierter Healthcheck ist nicht erreichbar.", endpointClass=f"HTTP :{a2a_port}", safeId=values.get("SESS_PROJ", "").split("/")[-1], setupRef="docs/A2A-INTERFACE.md", diagnosticsAvailable=True, logCapability=False))

    openlive = SHARE_ROOT / "openlive/bin/opencode"
    if openlive.is_file() and not openlive.is_symlink():
        openlive_runtime = next((read_json(SHARE_ROOT / "sessions" / path.stem / "openlive/runtime.json") for path, _ in sessions if (SHARE_ROOT / "sessions" / path.stem / "openlive/runtime.json").is_file()), None)
        live = isinstance(openlive_runtime, dict) and bool(openlive_runtime.get("pid"))
        integrations.append(status_card("openlive", "OpenLive ACP", "openlive-acp", True, "active/healthy" if live else "unknown/stale", "active/healthy" if live else "unknown/stale", "Ein OpenLive-Runtime-Descriptor ist vorhanden." if live else "OpenLive-Bridge ist installiert; ein laufender Voice-Call wird nicht behauptet.", endpointClass="ACP over local bridge", safeId="installed", setupRef="PLAN_OPENLIVE.md", diagnosticsAvailable=False, logCapability=False))

    events = read_events(log_paths)
    configured_ids = {item["id"] for item in integrations}
    notices = []
    if not integrations:
        notices.append({"tone": "info", "title": "Keine projektbezogene Verbindung konfiguriert", "body": "Die lokalen Registries und Session-Marker enthalten für dieses Projekt keine aktive Connector-Konfiguration."})
    for item in integrations:
        if item["healthStatus"] != "active/healthy":
            notices.append({"tone": "warning", "title": item["name"], "body": item["statusReason"], "integrationId": item["id"]})

    latest = read_json(ROOT.parent / "integrations/chatgpt/latest.json") or {}
    return {"schema": 1, "generatedAt": now(), "project": {"name": PROJECT.name, "pathAvailable": True}, "integrations": integrations, "events": events, "notices": notices[:8], "skill": latest, "setupGuides": [
        {"id": "secure-mcp-tunnel", "title": "Secure MCP Tunnel", "when": "not configured or inactive", "steps": ["OpenAI Tunnel und eingeschränkten Tunnel API-Key anlegen.", "opencode-vm provider mcp new openai im Projektverzeichnis ausführen.", "Mit opencode-vm web starten und provider mcp status openai prüfen."], "docs": "docs/MCP-TUNNEL.md"},
        {"id": "a2a", "title": "A2A Agent Interface", "when": "web session required", "steps": ["Eine Web-Session mit opencode-vm web starten.", "Agent Card und /health über den dokumentierten A2A-Port verifizieren.", "Für Diagnose opencode-vm a2a status oder a2a check verwenden."], "docs": "docs/A2A-INTERFACE.md"},
        {"id": "openlive", "title": "OpenLive ACP", "when": "bridge installed separately", "steps": ["OpenLive-Bridge mit opencode-vm openlive install einrichten.", "Die Web-Session als gemeinsamer Runtime-Endpunkt bereitstellen.", "Status und Diagnose mit opencode-vm openlive status prüfen."], "docs": "PLAN_OPENLIVE.md"},
    ], "security": {"connectionsReadOnly": True, "policyWritable": True, "secretsExposed": False, "allowedLogSources": sorted({source for _, source in log_paths}), "configuredIntegrationIds": sorted(configured_ids)}}


def control_snapshot():
    policy = PolicyStore(PROJECT).read()
    catalog = read_catalog(SHARE_ROOT, tracked_sessions(), project_hash())
    return {"policy": policy, "catalog": catalog, "validation": {
        name: check_selection(policy["profiles"][name], catalog) for name in PROFILES
    }, "capabilities": {"mcp": "supported", "a2a": "unsupported", "openlive": "unsupported"},
        "catalogStatus": "unavailable" if catalog is None else "incomplete" if catalog["truncated"] else "complete"}


def private_peer(address):
    try:
        peer = ipaddress.ip_address(address)
    except ValueError:
        return False
    return peer.is_loopback or any(peer in block for block in (
        ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("192.168.0.0/16"), ipaddress.ip_network("100.64.0.0/10"),
        ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fc00::/7"),
        ipaddress.ip_network("fe80::/10")) if peer.version == block.version)


class Handler(BaseHTTPRequestHandler):
    def allowed(self, write=False):
        if not private_peer(self.client_address[0]):
            self.send_error(403)
            return False
        if write:
            host = self.headers.get("Host", "")
            origin = self.headers.get("Origin", "")
            try:
                name = urlsplit("http://" + host).hostname
            except ValueError:
                name = None
            if (not host or not origin or origin != "http://" + host
                    or "/" in host or "@" in host or " " in host
                    or (name != "localhost" and not private_peer(name or ""))):
                self.send_error(403)
                return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0]
        if path in {"/api/read-model", "/api/status"}:
            self.send_json(200, build_model())
        elif path == "/healthz":
            self.send_json(200, {"status": "ok", "service": "agent-connectivity-hub", "readOnly": False,
                                  "projectHash": project_hash()})
        elif path == "/api/control":
            try:
                self.send_json(200, control_snapshot())
            except PolicyError:
                self.send_json(409, {"error": "Unsupported or invalid project policy."})
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            relative = "index.html" if path in {"/", "/index.html"} else path.removeprefix("/")
            asset = (ROOT / relative).resolve()
            if ROOT not in asset.parents or not asset.is_file() or asset.is_symlink():
                self.send_error(404)
                return
            content_type = "text/html; charset=utf-8" if asset.suffix == ".html" else "text/css; charset=utf-8" if asset.suffix == ".css" else "application/javascript; charset=utf-8"
            data = asset.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    def do_PUT(self) -> None:  # noqa: N802
        if not self.allowed(write=True):
            return
        match = re.fullmatch(r"/api/control/profiles/(deep|standard|execution)", self.path)
        if not match:
            self.send_error(404)
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            self.send_error(415)
            return
        length = self.headers.get("Content-Length", "")
        if not length.isdecimal() or not 0 < int(length) <= 4096:
            self.send_error(413)
            return
        try:
            payload = json.loads(self.rfile.read(int(length)))
            if not isinstance(payload, dict) or set(payload) != {"revision", "selection"}:
                raise PolicyError("Invalid request.")
            selection = validate_selection(payload["selection"])
            if selection is not None:
                catalog = read_catalog(SHARE_ROOT, tracked_sessions(), project_hash())
                if catalog is None or catalog["truncated"]:
                    self.send_json(503, {"error": "Complete runtime catalog unavailable; policy unchanged."})
                    return
                if check_selection(selection, catalog) != "available":
                    self.send_json(422, {"error": "Selection is unavailable; policy unchanged."})
                    return
            updated = PolicyStore(PROJECT).update(match.group(1), selection, payload["revision"])
            self.send_json(200, {"policy": updated})
        except PolicyConflict:
            self.send_json(409, {"error": "Policy changed; reload before saving."})
        except (PolicyError, ValueError, UnicodeError):
            self.send_json(400, {"error": "Invalid or unsupported policy request."})

    def send_json(self, code: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=4180)
    parser.add_argument("--project-hash", help="Verify the fixed project identity before accepting requests")
    args = parser.parse_args()
    if args.project_hash and args.project_hash != project_hash():
        parser.error("Hub project identity does not match the configured project")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Agent Connectivity Hub: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
