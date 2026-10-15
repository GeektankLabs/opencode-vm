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
    from .policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, FALLBACK_MODES, STRATEGY_KEYS, check_selection, validate_selection, validate_strategies, profile_fallbacks_view, strategies_view, routing_regime, resolve_profile, disabled_view
    from .catalog import read_catalog, mcp_connection, read_capabilities, read_schema4_capabilities, read_slot_disabled_capabilities, read_policy_capabilities, read_board_tasks
    from . import monitor as monitor_store
except ImportError:  # Executed directly as hub/server.py by the guest service.
    from policy import PolicyStore, PolicyError, PolicyConflict, PolicyCapabilityError, PROFILES, FALLBACKS, FALLBACK_MODES, STRATEGY_KEYS, check_selection, validate_selection, validate_strategies, profile_fallbacks_view, strategies_view, routing_regime, resolve_profile, disabled_view
    from catalog import read_catalog, mcp_connection, read_capabilities, read_schema4_capabilities, read_slot_disabled_capabilities, read_policy_capabilities, read_board_tasks
    import monitor as monitor_store


ROOT = Path(__file__).resolve().parent
PROJECT = Path.cwd().resolve()
SESSION_ROOT: Path | None = None
RUNTIME: dict[str, Any] = {}
AUTH_CREDENTIALS: tuple[str, str] | None = None
REQUEST_SCHEME = "https"
HANDSHAKE_TIMEOUT_SECONDS = 5
MAX_LOG_BYTES = 64 * 1024
MAX_EVENTS = 12
SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:api[-_ ]?key|token|secret|password)[=: ]+)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"\bsk[-_][A-Za-z0-9_-]{10,}\b|\bgh[pousr]_[A-Za-z0-9_]{10,}\b"), "[REDACTED]"),
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
    navigation = runtime.get("navigation")
    if navigation is not None and (
            not isinstance(navigation, dict)
            or not isinstance(navigation.get("web_port"), int) or isinstance(navigation["web_port"], bool)
            or not 1 <= navigation["web_port"] <= 65535
            or not isinstance(navigation.get("opencode_version"), str)
            or not navigation["opencode_version"] or len(navigation["opencode_version"]) > 64):
        raise ValueError("Hub navigation runtime input is invalid")
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


def redact_structure(value: Any) -> Any:
    """QC F-C1 (waveC-qc SHA6040ddf0): every string key/leaf of a structured
    response copy passes the same server-side allowlist redaction as the text
    view before any byte leaves the Hub. Legitimate engine tokens (labels,
    provider/model[/variant] identities, 64-hex fingerprints, enums, ISO times)
    match no secret pattern and therefore pass through unchanged — the Hub
    still performs NO resolution, recomputation or filtering of its own."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {(redact(key) if isinstance(key, str) else key): redact_structure(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_structure(item) for item in value]
    return value


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
    own_fallbacks = profile_fallbacks_view(policy)
    capabilities = read_policy_capabilities(connection)
    return {"policy": policy, "catalog": catalog, "validation": {
        name: check_selection(policy["profiles"][name], catalog) for name in PROFILES
    }, "finalFallbackStatus": check_selection(
        (policy.get("finalFallback") or {}).get("selection") if policy.get("finalFallback") else None, catalog),
        "profileFallbackValidation": {name: check_selection(own_fallbacks[name], catalog) for name in PROFILES},
        "strategies": strategies_view(policy),
        "routing": routing_regime(policy),
        "disabled": disabled_view(policy),
        "resolutions": {name: resolve_profile(policy, name, catalog) for name in PROFILES},
        "fallbacks": FALLBACKS,
        "capabilities": {"mcp": "supported", "optionalProfiles": capabilities["optionalProfiles"],
                         "profileFallbacks": capabilities["profileFallbacks"],
                         "slotDisabled": bool(capabilities.get("slotDisabled", False)),
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
        elif path == "/api/monitor":
            self.handle_monitor_list()
        elif path == "/api/monitor/candidates":
            self.handle_monitor_candidates()
        elif re.fullmatch(r"/api/monitor/[0-9a-f]{32}/history", path):
            self.handle_monitor_history()
        elif re.fullmatch(r"/api/monitor/[0-9a-f]{32}/log", path):
            self.handle_monitor_log()
        elif re.fullmatch(r"/api/monitor/[0-9a-f]{32}", path):
            self.handle_monitor_get()
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
        monitor_put = re.fullmatch(r"/api/monitor/([0-9a-f]{32})", self.path)
        if monitor_put:
            payload = self.read_json_body()
            if payload is None:
                return
            generation = payload.pop("generation", None)
            if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
                self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "generation is required for updates."})
                return
            try:
                result = monitor_store.mutate(
                    PROJECT,
                    lambda registry: self.mutate_update(registry, f"monitor_{monitor_put.group(1)}", payload),
                    expected_generation=generation,
                )
                monitor = next(item for item in result["monitors"] if item["id"] == f"monitor_{monitor_put.group(1)}")
                self.send_json(200, {"monitor": self.monitor_summary(monitor),
                                     "generation": result["generation"], "observed_at": now()})
            except monitor_store.MonitorConflict:
                self.send_json(409, {"code": "MONITOR_REVISION_CONFLICT", "error": "Monitor changed; reload before saving."})
            except monitor_store.MonitorError as error:
                code = "MONITOR_NOT_FOUND" if "does not exist" in str(error) else "MONITOR_REQUEST_INVALID"
                self.monitor_error(code, str(error))
            except OSError:
                self.send_json(503, {"code": "MONITOR_SAVE_UNCONFIRMED", "error": "Monitor publication not confirmed; read back before another write."})
            return
        match = re.fullmatch(r"/api/control/profiles/(deep|standard|execution|design|review)", self.path)
        fallback_match = None if match else re.fullmatch(r"/api/control/fallback", self.path)
        own_fallback_match = None if (match or fallback_match) else re.fullmatch(
            r"/api/control/profiles/(deep|standard|execution|design|review)/fallback", self.path)
        strategies_match = None if (match or fallback_match or own_fallback_match) else re.fullmatch(
            r"/api/control/fallback-strategies", self.path)
        disabled_match = None if (match or fallback_match or own_fallback_match or strategies_match) else re.fullmatch(
            r"/api/control/profiles/(deep|standard|execution|design|review)/disabled", self.path)
        own_disabled_match = None if (match or fallback_match or own_fallback_match or strategies_match or disabled_match) else re.fullmatch(
            r"/api/control/profiles/(deep|standard|execution|design|review)/fallback/disabled", self.path)
        final_disabled_match = None if (match or fallback_match or own_fallback_match or strategies_match
                                        or disabled_match or own_disabled_match) else re.fullmatch(
            r"/api/control/fallback/disabled", self.path)
        if not (match or fallback_match or own_fallback_match or strategies_match
                or disabled_match or own_disabled_match or final_disabled_match):
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
            if not isinstance(payload, dict):
                raise PolicyError("Invalid request.")
            mode = None
            strategies = None
            disabled = None
            if match:
                if set(payload) != {"revision", "selection"}:
                    raise PolicyError("Invalid request.")
                selection = validate_selection(payload["selection"])
            elif own_fallback_match:
                if set(payload) != {"revision", "fallback"}:
                    raise PolicyError("Invalid request.")
                selection = validate_selection(payload["fallback"])
            elif strategies_match:
                if set(payload) != {"revision", "strategies"}:
                    raise PolicyError("Invalid request.")
                strategies = validate_strategies(payload["strategies"])
                selection = None
            elif disabled_match or own_disabled_match or final_disabled_match:
                if set(payload) != {"revision", "disabled"} or type(payload["disabled"]) is not bool:
                    raise PolicyError("Invalid request.")
                disabled = payload["disabled"]
                selection = None
            else:
                if set(payload) != {"revision", "fallback"}:
                    raise PolicyError("Invalid request.")
                requested = payload["fallback"]
                if requested is None:
                    selection = None
                else:
                    if not isinstance(requested, dict) or not {"selection"} <= set(requested) <= {"mode", "selection"}:
                        raise PolicyError("Invalid request.")
                    mode = requested.get("mode", "total")
                    if mode not in FALLBACK_MODES:
                        raise PolicyError("Invalid request.")
                    selection = validate_selection(requested["selection"])
                    if selection is None:
                        raise PolicyError("Invalid request.")
            store = PolicyStore(PROJECT)
            try:
                current = store.read()
            except PolicyError:
                self.send_json(409, {"code": "POLICY_FORMAT_UNSUPPORTED", "error": "Unsupported or invalid project policy."})
                return
            capable = False
            schema4_capable = False
            schema5_capable = False
            connection = None
            wants_schema4 = current["schemaVersion"] < 4 and (
                (own_fallback_match is not None and selection is not None)
                or (strategies_match is not None
                    and any(strategies[key] is not None for key in STRATEGY_KEYS)))
            wants_schema5 = current["schemaVersion"] < 5 and disabled is True
            needs_capability = (selection is not None and (
                (match is not None and (match.group(1) in FALLBACKS or current["schemaVersion"] == 2)) or
                (fallback_match is not None and current["schemaVersion"] == 1))) or (
                wants_schema4 and current["schemaVersion"] == 1) or (
                wants_schema5 and current["schemaVersion"] == 1)
            if needs_capability or wants_schema4 or wants_schema5:
                if SESSION_ROOT is None:
                    raise PolicyError("Hub runtime is not configured")
                connection = mcp_connection(RUNTIME["mcp"], SESSION_ROOT, project_hash())
                if needs_capability:
                    capable = read_capabilities(connection)
                    if not capable:
                        self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm optional profiles and schema 2."})
                        return
                if wants_schema4:
                    schema4_capable = read_schema4_capabilities(connection)
                    if not schema4_capable:
                        self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm schema 4 profile fallbacks and strategies."})
                        return
                if wants_schema5:
                    schema5_capable = read_slot_disabled_capabilities(connection)
                    if not schema5_capable:
                        self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm schema 5 slot disabling."})
                        return
                    # A schema 1/2/3 disable upgrade publishes the schema-4 keys too,
                    # so the same live schema-4 confirmation applies (store contract).
                    if current["schemaVersion"] < 4:
                        schema4_capable = read_schema4_capabilities(connection)
                        if not schema4_capable:
                            self.send_json(409, {"code": "POLICY_CAPABILITY_UNAVAILABLE", "error": "Active MCP adapter does not confirm schema 4 profile fallbacks and strategies."})
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
            if match:
                updated = store.update(match.group(1), selection, payload["revision"], optional_capable=capable)
                self.send_json(200, {"policy": updated})
            elif disabled_match or own_disabled_match or final_disabled_match:
                slot = (("profile", disabled_match.group(1)) if disabled_match
                        else ("profileFallback", own_disabled_match.group(1))
                        if own_disabled_match else ("finalFallback", None))
                # Schema-5 writes can upgrade the document, so the derived
                # readback is part of the commit response like the schema-4 writes.
                updated = store.update_slot_disabled(
                    slot, disabled, payload["revision"], optional_capable=capable,
                    schema4_capable=schema4_capable, schema5_capable=schema5_capable)
                self.send_json(200, {"policy": updated, "routing": routing_regime(updated),
                                     "strategies": strategies_view(updated), "disabled": disabled_view(updated)})
            elif fallback_match:
                updated = store.update_fallback(
                    {"mode": mode, "selection": selection} if selection is not None else None,
                    payload["revision"], optional_capable=capable)
                self.send_json(200, {"policy": updated})
            else:
                # Schema-4 writes can change the routing regime, so the derived
                # readback is part of the commit response instead of a second GET.
                updated = (store.update_profile_fallback(
                    own_fallback_match.group(1), selection, payload["revision"],
                    optional_capable=capable, schema4_capable=schema4_capable)
                    if own_fallback_match else
                    store.update_strategies(strategies, payload["revision"],
                                            optional_capable=capable, schema4_capable=schema4_capable))
                self.send_json(200, {"policy": updated, "routing": routing_regime(updated),
                                     "strategies": strategies_view(updated)})
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

    # ---------------- Monitor section (one canonical registry) ----------------

    def monitor_summary(self, monitor: dict[str, Any]) -> dict[str, Any]:
        last = next((entry for entry in reversed(monitor.get("history", []))
                     if entry.get("type") in {"dispatched", "recovery-continued", "compaction-continued"}), None)
        summary = {
            "monitor_id": monitor["id"],
            "title": monitor["title"],
            "anchor_task_id": monitor["anchor"]["task_id"],
            "scheduler": dict(monitor["scheduler"]),
            "autonomy_profile": monitor["autonomy_profile"],
            "runtime_profile": monitor["runtime_profile"],
            "session_id": monitor["session"].get("session_id"),
            "work_state": monitor["state"]["work"],
            "run_active": bool(monitor["run"].get("active")),
            "abort_requested": monitor.get("abort_request") is not None,
            "last_run_at": last["at"] if last else None,
            "updated_at": monitor["updated_at"],
        }
        if monitor["state"].get("parked_reason"):
            summary["parked_reason"] = monitor["state"]["parked_reason"]
        return summary

    def monitor_freshness(self, monitor: dict[str, Any]) -> str:
        last = next((entry for entry in reversed(monitor.get("history", []))
                     if entry.get("type") in {"dispatched", "recovery-continued", "compaction-continued"}), None)
        if not last:
            return "unknown"
        try:
            parsed = datetime.strptime(last["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return "unknown"
        age = (datetime.now(timezone.utc) - parsed).total_seconds() * 1000
        return "fresh" if age <= monitor["scheduler"]["interval_seconds"] * 2 * 1000 else "stale"

    def monitor_error(self, code: str, message: str) -> None:
        status = 404 if code == "MONITOR_NOT_FOUND" else 409 if code in {"MONITOR_CONFLICT", "MONITOR_STATE_CONFLICT"} else 400
        self.send_json(status, {"code": code, "error": message})

    def find_monitor(self, monitor_id: str) -> dict[str, Any] | None:
        try:
            registry = monitor_store.snapshot(PROJECT)
        except monitor_store.MonitorError as error:
            raise monitor_store.MonitorError(str(error)) from error
        return next((item for item in registry["monitors"] if item["id"] == monitor_id), None)

    def handle_monitor_list(self) -> None:
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params: dict[str, str] = {}
        for part in query.split("&"):
            if not part:
                continue
            key, _, value = part.partition("=")
            params[key] = value
        try:
            registry = monitor_store.snapshot(PROJECT)
        except monitor_store.MonitorError:
            self.send_json(503, {"code": "MONITOR_UNAVAILABLE", "error": "Monitor registry is unavailable."})
            return
        monitors = sorted(registry["monitors"], key=lambda item: (item["created_at"], item["id"]))
        work_state = params.get("work_state")
        if work_state is not None:
            if work_state not in monitor_store.WORK_STATES:
                self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "Invalid work_state filter."})
                return
            monitors = [item for item in monitors if item["state"]["work"] == work_state]
        total = len(monitors)
        cursor = params.get("cursor", "0")
        limit_raw = params.get("limit", "20")
        if not cursor.isdecimal() or not limit_raw.isdecimal():
            self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "Invalid pagination."})
            return
        start, limit = int(cursor), min(50, max(1, int(limit_raw)))
        page = monitors[start:start + limit]
        next_cursor = str(start + limit) if start + limit < total else None
        payload = {
            "schema": 1,
            "generatedAt": now(),
            "generation": registry["generation"],
            "monitors": [self.monitor_summary(item) for item in page],
            "total": total,
            "completeness": "paged" if next_cursor else "complete",
            "observed_at": now(),
        }
        if next_cursor is not None:
            payload["next_cursor"] = next_cursor
        navigation = RUNTIME.get("navigation")
        payload["navigation"] = (
            {"web_port": navigation["web_port"], "opencode_version": navigation["opencode_version"]}
            if isinstance(navigation, dict) and isinstance(navigation.get("web_port"), int)
            and not isinstance(navigation.get("web_port"), bool)
            and isinstance(navigation.get("opencode_version"), str) else None)
        self.send_json(200, payload)

    def handle_monitor_candidates(self) -> None:
        try:
            registry = monitor_store.snapshot(PROJECT)
        except monitor_store.MonitorError:
            self.send_json(503, {"code": "MONITOR_UNAVAILABLE", "error": "Monitor registry is unavailable."})
            return
        connection = mcp_connection(RUNTIME["mcp"], SESSION_ROOT, project_hash())
        result = read_board_tasks(RUNTIME["mcp"], SESSION_ROOT, project_hash(), connection=connection)
        if result is None:
            self.send_json(503, {"code": "MONITOR_CANDIDATES_UNAVAILABLE",
                                 "error": "The project board task list is not readable; no candidates were confirmed."})
            return
        bound = {item["anchor"]["task_id"] for item in registry["monitors"]}
        candidates = [{"task_id": task["task_id"], "title": task["title"]}
                      for task in result["tasks"] if task["task_id"] not in bound]
        payload = {"schema": 1, "candidates": candidates, "total": len(candidates),
                   "completeness": result["completeness"], "truncated": result["truncated"],
                   "generation": registry["generation"], "observed_at": now()}
        if result.get("reason"):
            payload["incomplete_reason"] = result["reason"]
        if result.get("missing_statuses"):
            payload["missing_statuses"] = result["missing_statuses"]
        self.send_json(200, payload)

    def handle_monitor_get(self) -> None:
        monitor_id = self.path.split("?", 1)[0].rsplit("/", 1)[1]
        try:
            monitor = self.find_monitor(f"monitor_{monitor_id}")
        except monitor_store.MonitorError:
            self.send_json(503, {"code": "MONITOR_UNAVAILABLE", "error": "Monitor registry is unavailable."})
            return
        if monitor is None:
            self.monitor_error("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.")
            return
        last = next((entry for entry in reversed(monitor.get("history", []))
                     if entry.get("type", "").startswith("dispatch") or entry.get("type") in
                     {"recovery-continued", "run-aborted", "run-abort-uncertain"}), None)
        self.send_json(200, {
            "monitor": self.monitor_summary(monitor),
            "anchor": dict(monitor["anchor"]),
            "effective": {
                "interval_seconds": monitor["scheduler"]["interval_seconds"],
                "runtime_profile": monitor["runtime_profile"],
                "autonomy_profile": monitor["autonomy_profile"],
            },
            "last_event": {"at": last["at"], "type": last["type"]} if last else None,
            "next_run_at": monitor["scheduler"]["next_run_at"],
            "freshness": self.monitor_freshness(monitor),
            "observed_at": now(),
        })

    def handle_monitor_history(self) -> None:
        monitor_id = self.path.split("?", 1)[0].split("/")[3]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        include_logs = "include_logs=1" in query
        limit = 50
        for part in query.split("&"):
            key, _, value = part.partition("=")
            if key == "limit" and value.isdecimal():
                limit = min(100, max(1, int(value)))
        try:
            monitor = self.find_monitor(f"monitor_{monitor_id}")
        except monitor_store.MonitorError:
            self.send_json(503, {"code": "MONITOR_UNAVAILABLE", "error": "Monitor registry is unavailable."})
            return
        if monitor is None:
            self.monitor_error("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.")
            return
        history = monitor.get("history", [])[-limit:]
        last = next((entry for entry in reversed(monitor.get("history", []))
                     if entry.get("type", "").startswith("dispatch") or entry.get("type") == "recovery-continued"), None)
        payload = {
            "monitor_id": monitor["id"],
            "history": history,
            "last_run_at": last["at"] if last else None,
            "next_run_at": monitor["scheduler"]["next_run_at"],
            "freshness": self.monitor_freshness(monitor),
            "coverage": "paged" if len(monitor.get("history", [])) > limit else "complete",
            "observed_at": now(),
        }
        if include_logs:
            payload["logs"] = monitor.get("logs", [])[-limit:]
        self.send_json(200, payload)

    # -----------------------------------------------------------------
    # Welle C (be951293 §4.8/§4.9): bounded read-only diagnosis source.
    # Registry decision history, registry operational logs, engine heartbeat
    # and the current share's monitor/server.log tail stay clearly separated;
    # the engine's recovery projection (Welle B R2) is passed through
    # verbatim — the Hub performs NO candidate resolution of its own.
    # All text is redacted server-side with the existing allowlist before it
    # reaches the response; failures and partial coverage are never shown
    # as a fresh complete read.
    # -----------------------------------------------------------------
    def _entry_epoch(self, value: Any) -> float | None:
        import calendar
        if not isinstance(value, str):
            return None
        cleaned = re.sub(r"\.\d{3}Z$", "Z", value)
        try:
            return float(calendar.timegm(time.strptime(cleaned, "%Y-%m-%dT%H:%M:%SZ")))
        except ValueError:
            return None

    def handle_monitor_log(self) -> None:
        monitor_id = self.path.split("?", 1)[0].split("/")[3]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        window_hours = monitor_store.DISPLAY_WINDOW_HOURS
        for part in query.split("&"):
            key, _, value = part.partition("=")
            if key == "window_hours" and value.isdecimal():
                window_hours = min(24, max(1, int(value)))
        try:
            monitor = self.find_monitor(f"monitor_{monitor_id}")
        except monitor_store.MonitorError:
            self.send_json(503, {"code": "MONITOR_UNAVAILABLE", "error": "Monitor registry is unavailable."})
            return
        if monitor is None:
            self.monitor_error("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.")
            return
        observed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        cutoff = int(time.time()) - window_hours * 3600
        history = monitor.get("history", [])
        logs = monitor.get("logs", [])
        decisions = [entry for entry in history if (self._entry_epoch(entry.get("at")) or 0) >= cutoff]
        operational = [entry for entry in logs if (self._entry_epoch(entry.get("at")) or 0) >= cutoff]
        decisions_omitted = len(history) - len(decisions)
        operational_omitted = len(logs) - len(operational)
        tail = monitor_store.read_server_log_tail(PROJECT)
        heartbeat = monitor_store.read_heartbeat(PROJECT)
        tail_label_path = tail.get("path") or "monitor/server.log"
        heartbeat_value = heartbeat.get("value") or {}
        if heartbeat["state"] == "ok":
            same_identity = (heartbeat_value.get("projectHash") == project_hash()
                             and heartbeat_value.get("generation") == RUNTIME["generation"])
            heartbeat["state"] = "matching" if same_identity else "mismatch"
        tail_state = tail["state"]
        if tail_state == "ok" and not tail["lines"]:
            tail_state = "empty"
        tail["state"] = tail_state
        sources = [
            {"kind": "registry_history", "label": "Entscheidungslauf (Registry-History, projektlokal)",
             "state": "ok", "count": len(decisions), "omitted": decisions_omitted,
             "truncated": False, "from": decisions[0]["at"] if decisions else None,
             "to": decisions[-1]["at"] if decisions else None},
            {"kind": "registry_logs", "label": "Operational Logs (Registry, projektlokal)",
             "state": "ok", "count": len(operational), "omitted": operational_omitted,
             "truncated": False, "from": operational[0]["at"] if operational else None,
             "to": operational[-1]["at"] if operational else None},
            {"kind": "recovery_projection", "label": "Recovery-Projektion (Engine, nur lesend)",
             "state": "ok",
             "count": len(monitor.get("recovery_resolution") or []),
             "truncated": False,
             "from": None, "to": None},
            {"kind": "heartbeat", "label": "Engine-Heartbeat (Liveness, projektlokal, getrennt)",
             "state": heartbeat["state"], "count": 1 if heartbeat["state"] == "matching" else 0,
             "truncated": False,
             "from": None, "to": heartbeat_value.get("at") if heartbeat["state"] in ("matching", "mismatch") else None},
             {"kind": "server_log_tail", "label": f"Service-Log-Tail ({tail_label_path})",
             "state": tail_state, "count": len(tail.get("lines", [])),
             "truncated": bool(tail.get("truncated_bytes") or tail.get("truncated_lines")),
             "from": None, "to": None},
        ]
        error_states = {"unsafe", "corrupt", "unavailable"}
        partial_states = {"not_configured", "absent", "mismatch", "truncated_only"}
        completeness = ("unavailable" if any(source["state"] in error_states for source in sources)
                        else "partial" if any(source["state"] in partial_states for source in sources)
                        else "complete")

        lines: list[str] = []
        redacted_lines = 0

        def emit(text_line: str) -> None:
            nonlocal redacted_lines
            safe = redact(text_line)
            if safe != text_line:
                redacted_lines += 1
            lines.append(safe)

        emit(f"=== Monitor-Diagnose · {monitor['id']} ===")
        emit(f"Abrufzeitpunkt (UTC): {observed_at}")
        try:
            registry_generation = monitor_store.snapshot(PROJECT)["generation"]
        except monitor_store.MonitorError:
            registry_generation = "unbekannt"
        emit(f"Monitor: „{monitor['title']}“ · Registry-Generation {registry_generation}")
        emit(f"Quellenstand: Share {SESSION_ROOT} · Generation {RUNTIME['generation']} · Projekt-Hash {project_hash()}")
        emit(f"Datenzeitraum: letzte {window_hours} h (strukturierte Einträge) · Service-Log-Tail: letzte ≤{monitor_store.SERVER_LOG_MAX_BYTES // 1024} KiB / ≤{monitor_store.SERVER_LOG_MAX_LINES} Zeilen (zeitunbegrenzte, rein mengenbegrenzte Ansicht)")
        emit(f"Abdeckung: {completeness}"
             + (f" · {redacted_lines} Zeilen serverseitig redigiert" if redacted_lines else ""))
        emit("")
        emit("--- Entscheidungslauf (Registry-History, projektlokal) ---")
        if decisions:
            for entry in decisions:
                detail = f" · {json.dumps(entry['detail'], ensure_ascii=False, sort_keys=True)}" if entry.get("detail") else ""
                emit(f"{entry.get('at')} · {entry.get('type')}{detail}")
            if decisions_omitted > 0:
                emit(f"[GEKÜRZT/ÄLTER: {decisions_omitted} Einträge außerhalb des Fensters oder vor dem History-Fenster — ältere Inhalte nur in der Registry selbst]")
        else:
            emit("Keine Einträge im Fenster." + (f" {decisions_omitted} ältere Einträge vorhanden (außerhalb {window_hours} h)." if decisions_omitted else ""))
        emit("")
        emit("--- Operational Logs (Registry, projektlokal) ---")
        if operational:
            for entry in operational:
                emit(f"{entry.get('at')} · {entry.get('level')} · {entry.get('message')}")
            if operational_omitted > 0:
                emit(f"[GEKÜRZT/ÄLTER: {operational_omitted} Logeinträge außerhalb des Fensters]")
        else:
            emit("Keine Einträge im Fenster." + (f" {operational_omitted} ältere Einträge vorhanden (außerhalb {window_hours} h)." if operational_omitted else ""))
        emit("")
        emit("--- Recovery-Projektion (Engine persistiert; Hub nur lesend, keine eigene Auflösung) ---")
        episode = monitor.get("recovery_episode")
        resolutions = monitor.get("recovery_resolution") or []
        if isinstance(episode, dict):
            emit(f"Episode: started_at={episode.get('started_at')} revision={episode.get('policy_revision')} attempts={len(episode.get('attempts', []))}")
            for attempt in episode.get("attempts", [])[-24:]:
                emit(f"  attempt {attempt.get('at')} · {attempt.get('identity')} · {attempt.get('category')} · {attempt.get('fingerprint')} · {attempt.get('outcome')}")
        else:
            emit("Episode: keine (keine offene Recovery-Episode im Registryrecord)")
        if resolutions:
            for entry in resolutions[-8:]:
                candidates = "; ".join(f"{candidate.get('label')}={candidate.get('identity')}={candidate.get('status')}"
                                       for candidate in entry.get("candidates", []))
                emit(f"resolution {entry.get('at')} · rev={entry.get('policy_revision')} · regime={entry.get('regime')} "
                     f"· profil={entry.get('entry_profile')} · gewählt={entry.get('selected_identity')} · grund={entry.get('reason')}")
                if candidates:
                    emit(f"  kandidaten: {candidates}")
        else:
            emit("resolution: keine persistierten Auflösungsprojektion(en) im Record")
        emit("")
        emit("--- Engine-Heartbeat (Liveness, getrennt von Logs) ---")
        if heartbeat["state"] == "matching":
            emit(f"heartbeat: ok · pid={heartbeat_value.get('pid')} · at={heartbeat_value.get('at')} · generation={heartbeat_value.get('generation')}")
        elif heartbeat["state"] == "mismatch":
            emit(f"heartbeat: NICHT PASSEND zu dieser Laufzeitumgebung! at={heartbeat_value.get('at')} generation={heartbeat_value.get('generation')} (diese Session: {RUNTIME['generation']})")
        elif heartbeat["state"] == "absent":
            emit("heartbeat: nicht vorhanden (Engine schreibt noch keinen Herzschlag)")
        else:
            emit(f"heartbeat: nicht lesbar ({heartbeat['state']})")
        emit("")
        emit(f"--- Service-Log-Tail ({tail_label_path}) ---")
        if tail_state == "ok":
            for raw_line in tail.get("lines", []):
                emit(raw_line)
            if tail.get("truncated_bytes") or tail.get("truncated_lines"):
                emit("[GEKÜRZT: Byte-/Zeilengrenze erreicht — ältere Inhalte nur am Log selbst]")
        elif tail_state == "empty":
            emit("Datei vorhanden, ohne nicht-leere Inhaltzeile im lesbaren Fenster.")
        elif tail_state == "truncated_only":
            # QC F-C3: the file has content, but the bound byte window held no
            # complete line (single oversized line, with or without trailing
            # newline). Honest truncation state — never "empty", never fresh.
            emit("[TRUNKIERT: Die Datei enthält Inhalt, aber das begrenzte Bytefenster ("
                 f"{monitor_store.SERVER_LOG_MAX_BYTES // 1024} KiB) traf keine vollständige Zeile "
                 "(Einzelzeile über der Tail-Grenze) — kein leerer Log, kein frischer Vollstand; "
                 "Inhalt nur am Log selbst]")
        elif tail_state == "not_configured":
            emit("Kein Service-Log in diesem Session-Share (Monitor-Unit schrieb nichts oder ist nicht gestartet).")
        else:
            emit(f"Tail-Quelle nicht lesbar ({tail_state}) — kein frischer Stand, ältere Inhalte nur an der Logdatei selbst.")
        text = "\n".join(lines) + "\n"
        text_bytes = text.encode("utf-8")
        max_total = 512 * 1024
        truncated_text = len(text_bytes) > max_total
        if truncated_text:
            text = text_bytes[:max_total].decode("utf-8", errors="ignore") + "\n[GEKÜRZT: Antwortgrenze erreicht]\n"
        as_of = max((str(source["to"]) for source in sources if source.get("to")), default=observed_at)
        self.send_json(200, {
            "schema": 1,
            "monitor_id": monitor["id"],
            "observed_at": observed_at,
            "as_of": as_of,
            "window_hours": window_hours,
            "limits": {"window_hours_max": 24, "server_log_max_bytes": monitor_store.SERVER_LOG_MAX_BYTES,
                       "server_log_max_lines": monitor_store.SERVER_LOG_MAX_LINES,
                       "response_max_bytes": max_total},
            "source_context": {"share_root": str(SESSION_ROOT), "generation": RUNTIME["generation"],
                               "project_hash": project_hash()},
            "sources": redact_structure(sources),
            "completeness": completeness,
            "truncated": truncated_text,
            "redacted_lines": redacted_lines,
            "recovery_projection": redact_structure(
                {"episode": monitor.get("recovery_episode"),
                 "resolutions": monitor.get("recovery_resolution") or []}),
            "text": text,
        })

    def read_json_body(self, maximum: int = 8192) -> dict[str, Any] | None:
        length = self.headers.get("Content-Length", "")
        if not length.isdecimal() or not 0 < int(length) <= maximum:
            self.send_error(413)
            return None
        try:
            payload = json.loads(self.rfile.read(int(length)))
        except (ValueError, UnicodeError):
            self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "Invalid JSON payload."})
            return None
        if not isinstance(payload, dict):
            self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "Invalid request."})
            return None
        return payload

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/monitor"):
            self.send_error(404)
            return
        if not self.allowed(write=True):
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            self.send_error(415)
            return
        payload = self.read_json_body()
        if payload is None:
            return
        try:
            if path == "/api/monitor":
                result = monitor_store.mutate(PROJECT, lambda registry: self.mutate_create(registry, payload))
                self.send_json(201, {"monitor": self.monitor_summary(result["monitors"][-1]),
                                     "generation": result["generation"], "observed_at": now()})
                return
            match = re.fullmatch(r"/api/monitor/([0-9a-f]{32})/(enable|disable|trigger|cancel|abort|delete)", path)
            if not match:
                self.send_error(404)
                return
            monitor_id, action = match.groups()
            generation = payload.get("generation")
            if generation is not None and (not isinstance(generation, int) or isinstance(generation, bool) or generation < 0):
                self.send_json(400, {"code": "MONITOR_REQUEST_INVALID", "error": "Invalid generation."})
                return
            result = monitor_store.mutate(
                PROJECT,
                lambda registry: self.mutate_action(registry, f"monitor_{monitor_id}", action, payload),
                expected_generation=generation,
            )
            if action == "delete":
                self.send_json(200, {"monitor_id": f"monitor_{monitor_id}", "deleted": True,
                                     "generation": result["generation"]})
                return
            monitor = next(item for item in result["monitors"] if item["id"] == f"monitor_{monitor_id}")
            body = {"monitor": self.monitor_summary(monitor), "generation": result["generation"], "observed_at": now()}
            if action == "abort":
                body["state"] = "requested"
                body["guidance"] = "Abort requested; the engine verifies the native abort and records the stored outcome."
            self.send_json(200, body)
        except monitor_store.MonitorConflict as error:
            message = str(error)
            if path == "/api/monitor" and "already has a monitor" in message:
                existing = None
                try:
                    existing = next((item["id"] for item in monitor_store.snapshot(PROJECT)["monitors"]
                                     if item["anchor"]["task_id"] == payload.get("task_id")), None)
                except (monitor_store.MonitorError, AttributeError, TypeError):
                    existing = None
                body = {"code": "MONITOR_TASK_BOUND", "error": message}
                if existing:
                    body["monitor_id"] = existing
                self.send_json(409, body)
                return
            self.send_json(409, {"code": "MONITOR_REVISION_CONFLICT", "error": "Monitor changed; reload before saving."})
        except monitor_store.MonitorError as error:
            message = str(error)
            code = "MONITOR_NOT_FOUND" if "does not exist" in message else "MONITOR_STATE_CONFLICT" if "running" in message else "MONITOR_REQUEST_INVALID"
            self.monitor_error(code, message)
        except OSError:
            self.send_json(503, {"code": "MONITOR_SAVE_UNCONFIRMED", "error": "Monitor publication not confirmed; read back before another write."})

    def mutate_create(self, registry: dict[str, Any], payload: dict[str, Any]) -> None:
        title = payload.get("title")
        task_id = payload.get("task_id")
        interval = payload.get("interval_seconds", monitor_store.DEFAULT_INTERVAL_SECONDS)
        autonomy = payload.get("autonomy_profile", "mvp")
        runtime = payload.get("runtime_profile", "deep")
        expiry = payload.get("expiry_at")
        if (not isinstance(title, str) or not 1 <= len(title.strip()) <= 160
                or not isinstance(task_id, str) or not monitor_store.valid_task_id(task_id)
                or not isinstance(interval, int) or isinstance(interval, bool) or not 5 <= interval <= 86400
                or autonomy not in monitor_store.AUTONOMY_PROFILES
                or runtime not in monitor_store.RUNTIME_PROFILES
                or (expiry is not None and (not isinstance(expiry, int) or isinstance(expiry, bool) or expiry <= 0))):
            raise monitor_store.MonitorError("Invalid monitor definition.")
        if any(item["anchor"]["task_id"] == task_id for item in registry["monitors"]):
            raise monitor_store.MonitorConflict("This canonical task already has a monitor (unique master-task binding).")
        monitor = monitor_store.default_monitor(title.strip(), task_id, interval, autonomy, runtime, expiry)
        monitor_store.history_entry(monitor, "created", {"interval_seconds": interval})
        registry["monitors"].append(monitor)

    def mutate_action(self, registry: dict[str, Any], monitor_id: str, action: str, payload: dict[str, Any]) -> None:
        monitor = next((item for item in registry["monitors"] if item["id"] == monitor_id), None)
        if monitor is None:
            raise monitor_store.MonitorError("Monitor does not exist in this project registry.")
        at = monitor_store.timestamp()
        if action == "enable":
            monitor["scheduler"]["enabled"] = True
            monitor["scheduler"]["next_run_at"] = int(time.time() * 1000) + monitor["scheduler"]["interval_seconds"] * 1000
            monitor_store.history_entry(monitor, "enabled")
        elif action == "disable":
            monitor["scheduler"]["enabled"] = False
            monitor["scheduler"]["next_run_at"] = None
            monitor_store.history_entry(monitor, "disabled")
        elif action == "trigger":
            monitor["wake_request"] = {"requested_at": at, "reason": "hub-ui"}
            monitor_store.history_entry(monitor, "trigger-requested", {"reason": "hub-ui"})
        elif action == "cancel":
            monitor["wake_request"] = None
            if monitor["scheduler"]["enabled"]:
                monitor["scheduler"]["next_run_at"] = int(time.time() * 1000) + monitor["scheduler"]["interval_seconds"] * 1000
            monitor_store.history_entry(monitor, "future-cancelled")
        elif action == "abort":
            monitor["abort_request"] = {"requested_at": at, "reason": "hub-ui"}
            monitor_store.history_entry(monitor, "abort-requested")
        elif action == "delete":
            if monitor["run"].get("active"):
                raise monitor_store.MonitorError("The monitor has a running action; abort or finish it before deletion.")
            registry["monitors"] = [item for item in registry["monitors"] if item["id"] != monitor_id]
            return
        else:
            raise monitor_store.MonitorError("Invalid monitor action.")
        monitor["updated_at"] = at

    def mutate_update(self, registry: dict[str, Any], monitor_id: str, payload: dict[str, Any]) -> None:
        monitor = next((item for item in registry["monitors"] if item["id"] == monitor_id), None)
        if monitor is None:
            raise monitor_store.MonitorError("Monitor does not exist in this project registry.")
        allowed = {"title", "interval_seconds", "autonomy_profile", "runtime_profile", "expiry_at"}
        if set(payload) - allowed:
            raise monitor_store.MonitorError("Invalid monitor update fields.")
        if "title" in payload:
            title = payload["title"]
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
                raise monitor_store.MonitorError("Invalid monitor title.")
            monitor["title"] = title.strip()
        if "interval_seconds" in payload:
            interval = payload["interval_seconds"]
            if not isinstance(interval, int) or isinstance(interval, bool) or not 5 <= interval <= 86400:
                raise monitor_store.MonitorError("Invalid monitor interval.")
            monitor["scheduler"]["interval_seconds"] = interval
            if monitor["scheduler"]["enabled"]:
                monitor["scheduler"]["next_run_at"] = int(time.time() * 1000) + interval * 1000
        if "autonomy_profile" in payload:
            if payload["autonomy_profile"] not in monitor_store.AUTONOMY_PROFILES:
                raise monitor_store.MonitorError("Invalid autonomy profile.")
            monitor["autonomy_profile"] = payload["autonomy_profile"]
        if "runtime_profile" in payload:
            if payload["runtime_profile"] not in monitor_store.RUNTIME_PROFILES:
                raise monitor_store.MonitorError("Invalid monitor runtime profile.")
            monitor["runtime_profile"] = payload["runtime_profile"]
        if "expiry_at" in payload:
            expiry = payload["expiry_at"]
            if expiry is not None and (not isinstance(expiry, int) or isinstance(expiry, bool) or expiry <= 0):
                raise monitor_store.MonitorError("Invalid expiry.")
            monitor["scheduler"]["expiry_at"] = expiry
        monitor["updated_at"] = monitor_store.timestamp()
        monitor_store.history_entry(monitor, "updated")

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


class HubServer(ThreadingHTTPServer):
    """TLS handshake per connection, in the connection's own thread.

    Wrapping the listening socket would run every handshake in the accept
    loop, where one client that opens a socket and then says nothing stalls
    the whole Hub — including /healthz — while the process stays alive. The
    same rule as the session web proxy, which handshakes per worker thread.
    """

    daemon_threads = True
    tls_context: ssl.SSLContext | None = None

    def process_request_thread(self, request, client_address):
        if self.tls_context is not None:
            request.settimeout(HANDSHAKE_TIMEOUT_SECONDS)
            try:
                request = self.tls_context.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):
                # A stalled or invalid handshake ends quietly here; the accept
                # loop already moved on and the service log stays usable.
                try:
                    request.close()
                except OSError:
                    pass
                return
            request.settimeout(None)
        super().process_request_thread(request, client_address)


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
    server = HubServer((args.host, args.port), Handler)
    server.tls_context = tls
    print(f"Agent Connectivity Hub: https://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
