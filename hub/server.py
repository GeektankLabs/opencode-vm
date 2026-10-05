#!/usr/bin/env python3
"""Project-scoped Agent Control Hub for opencode-vm.

The service intentionally uses only the Python standard library. It reads one
admitted guest runtime input and never returns credentials or raw configuration
blobs.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import ssl
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from .policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, check_selection, validate_selection, resolve_profile
    from .catalog import read_catalog, mcp_connection, read_capabilities
except ImportError:  # Executed directly as hub/server.py by the guest service.
    from policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, check_selection, validate_selection, resolve_profile
    from catalog import read_catalog, mcp_connection, read_capabilities


ROOT = Path(__file__).resolve().parent
PROJECT = Path.cwd().resolve()
SESSION_ROOT: Path | None = None
RUNTIME: dict[str, Any] = {}
AUTH_CREDENTIALS: tuple[str, str] | None = None
REQUEST_SCHEME = "https"
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
    configured = RUNTIME.get("projectHash")
    if isinstance(configured, str) and re.fullmatch(r"[0-9a-f]{32}", configured):
        return configured
    return hashlib.md5(os.fsencode(PROJECT)).hexdigest()


def safe_id(value: str, length: int = 12) -> str:
    return value[:length] if value else "unknown"


def read_private_json(path: Path, limit: int) -> Any:
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > limit or path.is_symlink()):
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def configure_runtime(runtime_path: Path, project: Path, expected_project_hash: str) -> None:
    """Admit one private guest runtime descriptor before opening a listener."""
    global PROJECT, SESSION_ROOT, RUNTIME, AUTH_CREDENTIALS

    runtime_path = Path(runtime_path)
    if not runtime_path.is_absolute():
        runtime_path = Path.cwd() / runtime_path
    if runtime_path.name != "runtime-input.json" or runtime_path.parent.name != "hub":
        raise ValueError("Hub runtime input has an invalid location")
    session_root = runtime_path.parent.parent
    try:
        directory = session_root.lstat()
        hub_directory = runtime_path.parent.lstat()
    except OSError as error:
        raise ValueError("Hub runtime directory is unavailable") from error
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077
            or not stat.S_ISDIR(hub_directory.st_mode) or hub_directory.st_uid != os.getuid() or hub_directory.st_mode & 0o077
            or session_root.is_symlink() or runtime_path.parent.is_symlink()):
        raise ValueError("Hub runtime directory is unsafe")
    runtime = read_private_json(runtime_path, 16384)
    if not isinstance(runtime, dict):
        raise ValueError("Hub runtime input is unavailable")
    mcp = runtime.get("mcp")
    auth = runtime.get("auth")
    if (runtime.get("schema") != 1 or not isinstance(runtime.get("projectHash"), str)
            or not re.fullmatch(r"[0-9a-f]{32}", runtime["projectHash"])
            or not isinstance(runtime.get("generation"), str)
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", runtime["generation"])
            or not isinstance(runtime.get("hubPort"), int) or isinstance(runtime["hubPort"], bool)
            or not 1026 <= runtime["hubPort"] <= 65535
            or not isinstance(runtime.get("authEnabled"), bool)
            or not isinstance(runtime.get("a2aEnabled"), bool)
            or not isinstance(runtime.get("tunnelConfigured"), bool)
            or not isinstance(runtime.get("openliveConfigured"), bool)
            or not isinstance(mcp, dict) or not isinstance(mcp.get("enabled"), bool)
            or not isinstance(mcp.get("generation"), str)
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", mcp["generation"])
            or not isinstance(mcp.get("port"), int) or isinstance(mcp["port"], bool)
            or not 0 <= mcp["port"] <= 65535):
        raise ValueError("Hub runtime input is invalid")
    if mcp["enabled"] and (not 1 <= mcp["port"] <= 65535 or mcp["generation"] != runtime["generation"]):
        raise ValueError("Hub MCP runtime input is invalid")
    if runtime["authEnabled"]:
        if (not isinstance(auth, dict) or set(auth) != {"username", "password"}
                or not isinstance(auth["username"], str) or not 1 <= len(auth["username"]) <= 255
                or ":" in auth["username"] or any(ord(char) < 32 for char in auth["username"])
                or not isinstance(auth["password"], str) or not 1 <= len(auth["password"]) <= 4096):
            raise ValueError("Hub authentication is unavailable")
    elif auth is not None:
        raise ValueError("Hub runtime authentication is invalid")
    project = project.resolve()
    if not isinstance(expected_project_hash, str) or not re.fullmatch(r"[0-9a-f]{32}", expected_project_hash):
        raise ValueError("Hub project identity is invalid")
    if expected_project_hash != runtime["projectHash"]:
        raise ValueError("Hub project identity does not match runtime input")
    if not project.is_dir():
        raise ValueError("Hub project directory is unavailable")
    credentials = (auth["username"], auth["password"]) if runtime["authEnabled"] else None

    PROJECT = project
    SESSION_ROOT = session_root
    RUNTIME = runtime
    AUTH_CREDENTIALS = credentials


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


def status_card(card_id, name, configured, state, reason, scope="configuration-only", **extra):
    health = {"ready": "active/healthy", "not_ready": "warning/degraded"}.get(state, "unknown/stale")
    return {"id": card_id, "name": name, "type": card_id, "configured": configured, "state": state,
            "runtimeStatus": health, "healthStatus": health, "statusReason": reason,
            "lastCheck": now(), "checkScope": scope, "diagnosticsAvailable": True,
            "logCapability": card_id in {"incoming-mcp", "secure-mcp-tunnel"}, **extra}


def build_model(*, connection=None) -> dict[str, Any]:
    """Return connectivity facts from this Guest's admitted runtime only."""
    if SESSION_ROOT is None:
        raise RuntimeError("Hub runtime is not configured")
    mcp_runtime = RUNTIME["mcp"]
    connection = connection if connection is not None else mcp_connection(mcp_runtime, SESSION_ROOT, project_hash())
    tunnel_configured = RUNTIME["tunnelConfigured"]
    openlive_configured = RUNTIME["openliveConfigured"]
    a2a_configured = RUNTIME["a2aEnabled"]
    integrations = [
        status_card("secure-mcp-tunnel", "OpenAI Secure MCP Tunnel", tunnel_configured,
                    "unverified" if tunnel_configured else "not_configured",
                    "Zuordnung im Guest-Runtimeinput; Tunnelverbindung nicht bestätigt." if tunnel_configured
                    else "Keine Tunnelzuordnung für diese Session eingerichtet.", setupRef="docs/MCP-TUNNEL.md"),
        status_card("incoming-mcp", "OpenCode MCP Connector", mcp_runtime["enabled"],
                    connection["state"], connection["reason"],
                    "local-mcp-health" if mcp_runtime["enabled"] and connection["state"] in {"ready", "not_ready"}
                    else "configuration-only", setupRef="docs/MCP-INTERFACE.md"),
        status_card("a2a", "A2A Agent Interface", a2a_configured,
                    "unverified" if a2a_configured else "not_configured",
                    "A2A ist für diese Websession konfiguriert; Clientzugang wurde nicht geprüft." if a2a_configured
                    else "Nicht aktiviert · benötigt eine Websession.", setupRef="docs/A2A-INTERFACE.md"),
        status_card("openlive", "OpenLive ACP", openlive_configured,
                    "unverified" if openlive_configured else "not_configured",
                    "Bridge für diese Session vorbereitet; kein Voice-Call-Nachweis." if openlive_configured
                    else "OpenLive-Bridge ist nicht für diese Session eingerichtet.", setupRef="PLAN_OPENLIVE.md"),
    ]
    log_paths: list[tuple[Path, str]] = []
    if tunnel_configured:
        log_paths.append((SESSION_ROOT / "mcp/tunnel.log", "secure-mcp-tunnel"))
    if mcp_runtime["enabled"]:
        log_paths.append((SESSION_ROOT / "mcp/backend.log", "incoming-mcp"))
    events = read_events(log_paths)
    configured_ids = {item["id"] for item in integrations if item["configured"] is True}
    notices = [{"tone": "warning", "title": item["name"], "body": item["statusReason"], "integrationId": item["id"]}
               for item in integrations if item["healthStatus"] != "active/healthy"]
    return {"schema": 2, "generatedAt": now(), "project": {"name": PROJECT.name, "pathAvailable": True}, "integrations": integrations, "events": events, "notices": notices[:8], "skill": {}, "setupGuides": [
        {"id": "lm-studio", "title": "LM Studio · lokale Modelle", "steps": ["LM Studio auf dem Mac starten und den lokalen Server auf Port 1234 aktivieren.", "Port 1234 ist in der OpenCode-VM-Standardpolicy bereits erlaubt. Bei geänderter Policy mit `opencode-vm ports host add 1234` sicherstellen (mehrfach ausführbar). Die Host-Port-Policy gilt für alle VMs.", "In der OpenCode-Web-UI unter Provider Management den nativen Provider „LM Studio“ verbinden. Bei aktivem Standard-Forwarding erreicht OpenCode ihn im Lima-Gast über `localhost:1234`; eine Custom-Base-URL ist nicht nötig."], "docs": "README.md#network-policy-commands"},
        {"id": "secure-mcp-tunnel", "title": "Secure MCP Tunnel", "when": "not configured or inactive", "steps": ["OpenAI Tunnel und eingeschränkten Tunnel API-Key anlegen.", "opencode-vm provider mcp new openai im Projektverzeichnis ausführen.", "Mit opencode-vm web starten und provider mcp status openai prüfen."], "docs": "docs/MCP-TUNNEL.md"},
        {"id": "a2a", "title": "A2A Agent Interface", "when": "web session required", "steps": ["Eine Web-Session mit opencode-vm web starten.", "Agent Card und /health über den dokumentierten A2A-Port verifizieren.", "Für Diagnose opencode-vm a2a status oder a2a check verwenden."], "docs": "docs/A2A-INTERFACE.md"},
        {"id": "openlive", "title": "OpenLive ACP", "when": "bridge installed separately", "steps": ["OpenLive-Bridge mit opencode-vm openlive install einrichten.", "Die Web-Session als gemeinsamer Runtime-Endpunkt bereitstellen.", "Status und Diagnose mit opencode-vm openlive status prüfen."], "docs": "PLAN_OPENLIVE.md"},
    ], "security": {"connectionsReadOnly": True, "policyWritable": True, "secretsExposed": False, "allowedLogSources": sorted({source for _, source in log_paths}), "configuredIntegrationIds": sorted(configured_ids)}}


def control_snapshot():
    if SESSION_ROOT is None:
        raise RuntimeError("Hub runtime is not configured")
    policy = PolicyStore(PROJECT).read()
    connection = mcp_connection(RUNTIME["mcp"], SESSION_ROOT, project_hash())
    catalog = read_catalog(RUNTIME["mcp"], SESSION_ROOT, project_hash(), connection=connection)
    return {"policy": policy, "catalog": catalog, "validation": {
        name: check_selection(policy["profiles"][name], catalog) for name in PROFILES
    }, "resolutions": {name: resolve_profile(policy, name, catalog) for name in PROFILES},
        "fallbacks": FALLBACKS,
        "capabilities": {"mcp": "supported", "optionalProfiles": read_capabilities(connection),
                         "a2a": "unsupported", "openlive": "unsupported"},
        "catalogStatus": "unavailable" if catalog is None else "incomplete" if catalog["truncated"] else "complete",
        "readModel": build_model(connection=connection)}


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
    def allowed(self, write=False, require_auth=True):
        if not private_peer(self.client_address[0]):
            self.send_error(403)
            return False
        if require_auth and AUTH_CREDENTIALS is not None:
            username, password = AUTH_CREDENTIALS
            expected = "Basic " + base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="opencode-vm Hub", charset="UTF-8"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
        if write:
            host = self.headers.get("Host", "")
            origin = self.headers.get("Origin", "")
            try:
                name = urlsplit(REQUEST_SCHEME + "://" + host).hostname
            except ValueError:
                name = None
            if (not host or not origin or origin != REQUEST_SCHEME + "://" + host
                    or "/" in host or "@" in host or " " in host
                    or (name != "localhost" and not private_peer(name or ""))):
                self.send_error(403)
                return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if not self.allowed(require_auth=path != "/healthz"):
            return
        if path in {"/api/read-model", "/api/status"}:
            self.send_json(200, build_model())
        elif path == "/healthz":
            self.send_json(200, {"status": "ok", "service": "agent-connectivity-hub", "readOnly": False,
                                   "schema": 1, "projectHash": project_hash(), "generation": RUNTIME["generation"]})
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
                if SESSION_ROOT is None:
                    raise PolicyError("Hub runtime is not configured")
                connection = mcp_connection(RUNTIME["mcp"], SESSION_ROOT, project_hash())
                capable = read_capabilities(connection)
                if not capable:
                    self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm optional profiles and schema 2."})
                    return
            if selection is not None:
                if SESSION_ROOT is None:
                    raise PolicyError("Hub runtime is not configured")
                catalog = read_catalog(RUNTIME["mcp"], SESSION_ROOT, project_hash(), connection=connection)
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
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--project-hash", required=True)
    parser.add_argument("--runtime-input", type=Path, required=True)
    parser.add_argument("--tls-cert", type=Path, required=True)
    parser.add_argument("--tls-key", type=Path, required=True)
    args = parser.parse_args()
    if args.host != "127.0.0.1":
        parser.error("Hub must bind only to 127.0.0.1")
    try:
        configure_runtime(args.runtime_input, args.project, args.project_hash)
        if args.port != RUNTIME["hubPort"]:
            raise ValueError("Hub port does not match runtime input")
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.tls_cert, args.tls_key)
    except (OSError, ValueError, ssl.SSLError) as error:
        parser.error(str(error))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    print(f"Agent Connectivity Hub: https://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
