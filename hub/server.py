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
    from .policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, check_selection, validate_selection, resolve_profile
    from .catalog import read_catalog, mcp_connection, read_capabilities
except ImportError:  # Executed directly as hub/server.py by the host launcher.
    from policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, check_selection, validate_selection, resolve_profile
    from catalog import read_catalog, mcp_connection, read_capabilities


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
            with path.open("rb") as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell() - MAX_LOG_BYTES))
                data = stream.read(MAX_LOG_BYTES)
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
        if isinstance(value, dict) and isinstance(value.get("path"), str) and os.path.realpath(value["path"]) == canonical:
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
    if result.returncode != 0:
        return None
    status = result.stdout.strip().lower()
    return True if status == "running" else False if status == "stopped" else None


def status_card(card_id, name, configured, state, reason, scope="configuration-only", **extra):
    health = {"ready": "active/healthy", "not_ready": "warning/degraded"}.get(state, "unknown/stale")
    return {"id": card_id, "name": name, "type": card_id, "configured": configured, "state": state,
            "runtimeStatus": health, "healthStatus": health, "statusReason": reason,
            "lastCheck": now(), "checkScope": scope, "diagnosticsAvailable": True,
            "logCapability": card_id in {"incoming-mcp", "secure-mcp-tunnel"}, **extra}


def build_model(*, sessions=None, connection=None) -> dict[str, Any]:
    sessions = tracked_sessions() if sessions is None else sessions
    assignment = project_assignment()
    integrations: list[dict[str, Any]] = []
    log_paths: list[tuple[Path, str]] = []

    session_file, session = sessions[0] if len(sessions) == 1 else (None, {})
    running = vm_running(session.get("SESS_NAME", "")) if session else None
    registry_path = SHARE_ROOT / "mcp-tunnel/openai/registry.json"
    registry = read_json(registry_path)
    registry_unknown = (registry_path.exists() or registry_path.is_symlink()) and (
        not isinstance(registry, dict) or not isinstance(registry.get("projects"), dict)
        or any(not isinstance(value, dict) or not isinstance(value.get("path"), str)
               for value in registry["projects"].values())
        or sum(isinstance(value, dict) and isinstance(value.get("path"), str)
               and os.path.realpath(value["path"]) == str(PROJECT) for value in registry["projects"].values()) > 1)
    if registry_unknown:
        assignment = None
    tunnel_state = "unverified" if assignment or registry_unknown else "not_configured"
    tunnel_reason = ("Zuordnung vorhanden; Tunnelverbindung nicht bestätigt. Adaptermarker sind kein Tunnel-Health."
                     if assignment else "Konfiguration nicht lesbar – Status nicht bestätigt." if registry_unknown
                     else "Keine Tunnelzuordnung für dieses Projekt eingerichtet.")
    if assignment and running is False:
        tunnel_state, tunnel_reason = "not_ready", "Projekt-VM ist bestätigt gestoppt; Tunnel benötigt eine laufende Session."
    integrations.append(status_card("secure-mcp-tunnel", "OpenAI Secure MCP Tunnel", None if registry_unknown else bool(assignment),
        tunnel_state, tunnel_reason, setupRef="docs/MCP-TUNNEL.md"))
    for path, values in sessions:
        share = SHARE_ROOT / "sessions" / path.stem
        if assignment:
            log_paths.append((share / "mcp/tunnel.log", "secure-mcp-tunnel"))
        if values.get("SESS_MCP_ENABLED") == "1":
            log_paths.append((share / "mcp/backend.log", "incoming-mcp"))

    if sessions:
        connection = connection if connection is not None else mcp_connection(SHARE_ROOT, sessions, project_hash())
        configured = session.get("SESS_MCP_ENABLED") == "1" if session else None
        integrations.append(status_card("incoming-mcp", "OpenCode MCP Connector", configured,
            connection["state"], connection["reason"], "local-mcp-health" if configured and connection["state"] in {"ready", "not_ready"} else "configuration-only",
            setupRef="docs/MCP-INTERFACE.md"))
    else:
        integrations.append(status_card("incoming-mcp", "OpenCode MCP Connector", False, "not_configured",
            "Nicht aktiviert · eine Projekt-Session mit MCP ist erforderlich.", setupRef="docs/MCP-INTERFACE.md"))

    a2a_state, a2a_reason = "not_configured", "Nicht aktiviert · benötigt eine Websession."
    web = session.get("SESS_MODE") == "web"
    if len(sessions) > 1:
        a2a_state, a2a_reason = "unverified", "Keine eindeutige Projekt-Session bestätigt."
    elif web:
        a2a_state, a2a_reason = "unverified", "A2A-Dienstzuordnung nicht bestätigt."
        port = session.get("SESS_PORT", "")
        if port.isdecimal() and 1 <= int(port) <= 65532:
            ok, card = probe_http(f"http://127.0.0.1:{int(port) + 3}/.well-known/agent-card.json")
            if not ok:
                a2a_state, a2a_reason = "not_ready", "Lokale Agent-Card-Probe fehlgeschlagen."
            elif isinstance(card, dict) and isinstance(card.get("supportedInterfaces"), list):
                urls = [item.get("url") for item in card["supportedInterfaces"] if isinstance(item, dict)
                        and item.get("protocolBinding") == "JSONRPC" and isinstance(item.get("url"), str)]
                if len(urls) == 1:
                    try:
                        effective = urlsplit(urls[0])
                        effective_port = effective.port
                    except ValueError:
                        effective, effective_port = None, None
                    # Use the card's effective port on host loopback, never its host as a credential destination.
                    if effective and effective.scheme == "http" and private_peer(effective.hostname or "") and effective_port and not effective.username and not effective.password and not effective.query and not effective.fragment and effective.path in {"", "/"}:
                        auth = parse_env(SHARE_ROOT / "sessions" / session_file.stem / "auth.env")
                        secret = auth.get("OPENCODE_SERVER_PASSWORD")
                        if secret:
                            health_ok, body = probe_http(f"http://127.0.0.1:{effective_port}/health", secret)
                            if health_ok and isinstance(body, dict) and body.get("status") == "ok" and body.get("service") == "opencode-a2a":
                                a2a_state, a2a_reason = "ready", "Agent Card und authentifizierter lokaler A2A-Servicehealth bestätigt; kein Client-/LAN-Test."
                            else:
                                a2a_state, a2a_reason = "not_ready", "Authentifizierter A2A-Servicehealth fehlgeschlagen."
    integrations.append(status_card("a2a", "A2A Agent Interface", web if len(sessions) <= 1 else None,
        a2a_state, a2a_reason, "local-a2a-health" if a2a_state in {"ready", "not_ready"} else "configuration-only", setupRef="docs/A2A-INTERFACE.md"))

    openlive = SHARE_ROOT / "openlive/bin/opencode"
    installed = openlive.is_file() and not openlive.is_symlink()
    live_state = "unverified" if installed else "not_configured"
    live_reason = "Bridge installiert · Projektbereitschaft nicht bestätigt; kein Voice-Call-Nachweis." if installed else "OpenLive-Bridge ist nicht eingerichtet."
    if openlive.is_symlink() or (openlive.exists() and not installed):
        installed, live_state, live_reason = None, "unverified", "Bridge-Konfiguration nicht lesbar – Status nicht bestätigt."
    elif installed and not any(values.get("SESS_MODE") == "web" for _, values in sessions):
        live_state, live_reason = "not_ready", "Bridge installiert; erforderliche Projekt-Websession fehlt. Voice-Calls werden nicht überwacht."
    integrations.append(status_card("openlive", "OpenLive ACP", installed, live_state, live_reason, setupRef="PLAN_OPENLIVE.md"))

    events = read_events(log_paths)
    configured_ids = {item["id"] for item in integrations if item["configured"] is True}
    notices = []
    if not integrations:
        notices.append({"tone": "info", "title": "Keine projektbezogene Verbindung konfiguriert", "body": "Die lokalen Registries und Session-Marker enthalten für dieses Projekt keine aktive Connector-Konfiguration."})
    for item in integrations:
        if item["healthStatus"] != "active/healthy":
            notices.append({"tone": "warning", "title": item["name"], "body": item["statusReason"], "integrationId": item["id"]})

    latest = read_json(ROOT.parent / "integrations/chatgpt/latest.json") or {}
    return {"schema": 2, "generatedAt": now(), "project": {"name": PROJECT.name, "pathAvailable": True}, "integrations": integrations, "events": events, "notices": notices[:8], "skill": latest, "setupGuides": [
        {"id": "lm-studio", "title": "LM Studio · lokale Modelle", "steps": ["LM Studio auf dem Mac starten und den lokalen Server auf Port 1234 aktivieren.", "Port 1234 ist in der OpenCode-VM-Standardpolicy bereits erlaubt. Bei geänderter Policy mit `opencode-vm ports host add 1234` sicherstellen (mehrfach ausführbar). Die Host-Port-Policy gilt für alle VMs.", "In der OpenCode-Web-UI unter Provider Management den nativen Provider „LM Studio“ verbinden. Bei aktivem Standard-Forwarding erreicht OpenCode ihn im Lima-Gast über `localhost:1234`; eine Custom-Base-URL ist nicht nötig."], "docs": "README.md#network-policy-commands"},
        {"id": "secure-mcp-tunnel", "title": "Secure MCP Tunnel", "when": "not configured or inactive", "steps": ["OpenAI Tunnel und eingeschränkten Tunnel API-Key anlegen.", "opencode-vm provider mcp new openai im Projektverzeichnis ausführen.", "Mit opencode-vm web starten und provider mcp status openai prüfen."], "docs": "docs/MCP-TUNNEL.md"},
        {"id": "a2a", "title": "A2A Agent Interface", "when": "web session required", "steps": ["Eine Web-Session mit opencode-vm web starten.", "Agent Card und /health über den dokumentierten A2A-Port verifizieren.", "Für Diagnose opencode-vm a2a status oder a2a check verwenden."], "docs": "docs/A2A-INTERFACE.md"},
        {"id": "openlive", "title": "OpenLive ACP", "when": "bridge installed separately", "steps": ["OpenLive-Bridge mit opencode-vm openlive install einrichten.", "Die Web-Session als gemeinsamer Runtime-Endpunkt bereitstellen.", "Status und Diagnose mit opencode-vm openlive status prüfen."], "docs": "PLAN_OPENLIVE.md"},
    ], "security": {"connectionsReadOnly": True, "policyWritable": True, "secretsExposed": False, "allowedLogSources": sorted({source for _, source in log_paths}), "configuredIntegrationIds": sorted(configured_ids)}}


def control_snapshot():
    policy = PolicyStore(PROJECT).read()
    sessions = tracked_sessions()
    connection = mcp_connection(SHARE_ROOT, sessions, project_hash())
    catalog = read_catalog(SHARE_ROOT, sessions, project_hash(), connection=connection)
    return {"policy": policy, "catalog": catalog, "validation": {
        name: check_selection(policy["profiles"][name], catalog) for name in PROFILES
    }, "resolutions": {name: resolve_profile(policy, name, catalog) for name in PROFILES},
        "fallbacks": FALLBACKS,
        "capabilities": {"mcp": "supported", "optionalProfiles": read_capabilities(connection),
                         "a2a": "unsupported", "openlive": "unsupported"},
        "catalogStatus": "unavailable" if catalog is None else "incomplete" if catalog["truncated"] else "complete",
        "readModel": build_model(sessions=sessions, connection=connection)}


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
                self.send_json(409, {"code": "POLICY_FORMAT_UNSUPPORTED", "error": "Unsupported or invalid project policy."})
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
        match = re.fullmatch(r"/api/control/profiles/(deep|standard|execution|design|review)", self.path)
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
            store = PolicyStore(PROJECT)
            try:
                current = store.read()
            except PolicyError:
                self.send_json(409, {"code": "POLICY_FORMAT_UNSUPPORTED", "error": "Unsupported or invalid project policy."})
                return
            capable = False
            connection = None
            if selection is not None and (match.group(1) in FALLBACKS or current["schemaVersion"] == 2):
                connection = mcp_connection(SHARE_ROOT, tracked_sessions(), project_hash())
                capable = read_capabilities(connection)
                if not capable:
                    self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm optional profiles and schema 2."})
                    return
            if selection is not None:
                catalog = read_catalog(SHARE_ROOT, tracked_sessions(), project_hash(), connection=connection)
                if catalog is None or catalog["truncated"]:
                    self.send_json(503, {"code": "CATALOG_UNAVAILABLE", "error": "Complete runtime catalog unavailable; policy unchanged."})
                    return
                if check_selection(selection, catalog) != "available":
                    self.send_json(422, {"code": "SELECTION_UNAVAILABLE", "reason": check_selection(selection, catalog), "error": "Selection is unavailable; policy unchanged."})
                    return
            updated = store.update(match.group(1), selection, payload["revision"], optional_capable=capable)
            self.send_json(200, {"policy": updated})
        except PolicyConflict:
            self.send_json(409, {"code": "POLICY_REVISION_CONFLICT", "error": "Policy changed; reload before saving."})
        except PolicyCapabilityError:
            self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active adapter capability unavailable."})
        except (PolicyError, ValueError, UnicodeError):
            self.send_json(400, {"code": "POLICY_REQUEST_INVALID", "error": "Invalid or unsupported policy request."})
        except (BrokenPipeError, ConnectionResetError):
            return  # A lost response is reconciled by a read, never another write.
        except OSError:
            self.send_json(503, {"code": "POLICY_SAVE_UNCONFIRMED", "error": "Policy publication not confirmed; read back before another write."})

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
