"""Bounded, project-bound read of the existing MCP runtime catalog."""

import json
import os
from pathlib import Path
import stat
from urllib.request import Request, urlopen


class CatalogUnavailable(Exception):
    pass


def _request(url, token, payload=None):
    headers = {"X-OCVM-MCP-Token": token, "Accept": "application/json, text/event-stream"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    with urlopen(request, timeout=3) as response:
        if response.status != 200:
            raise CatalogUnavailable("MCP is not ready.")
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise CatalogUnavailable("MCP catalog exceeds the read budget.")
        return json.loads(body)


def mcp_connection(share_root, sessions, project_hash):
    if len(sessions) != 1:
        return {"state": "unverified", "reason": "Keine eindeutige Projekt-Session bestätigt."}
    for session_file, values in sessions:
        if values.get("SESS_MCP_ENABLED") != "1":
            return {"state": "not_ready", "reason": "MCP ist für diese Session nicht aktiviert (z. B. --no-mcp)."}
        port_text = values.get("SESS_MCP_PORT", "")
        if not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
            return {"state": "unverified", "reason": "MCP-Port ist nicht prüfbar."}
        port = int(port_text)
        credential = Path(share_root) / "sessions" / session_file.stem / "mcp/credential"
        try:
            info = credential.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size > 512 or credential.parent.is_symlink()):
                return {"state": "unverified", "reason": "Private MCP-Prüfcredential nicht verfügbar."}
            token = credential.read_text(encoding="ascii").strip()
            if not token:
                return {"state": "unverified", "reason": "Private MCP-Prüfcredential nicht verfügbar."}
            base = f"http://127.0.0.1:{port}"
        except (OSError, ValueError):
            return {"state": "unverified", "reason": "Private MCP-Prüfcredential nicht verfügbar."}
        try:
            health = _request(base + "/healthz", token)
            if (health.get("healthy") is not True or health.get("project", {}).get("id") != project_hash
                    or health.get("generation") != values.get("SESS_CONTROLLER")):
                return {"state": "not_ready", "reason": "MCP-Health bestätigt Dienst, Projekt und Generation nicht."}
            return {"state": "ready", "reason": "Authentifizierter MCP-Health bestätigt Projekt und Generation.",
                    "base": base, "token": token}
        except (OSError, ValueError, TypeError, AttributeError, CatalogUnavailable):
            return {"state": "not_ready", "reason": "Authentifizierter MCP-Healthcheck fehlgeschlagen."}
    return {"state": "unverified", "reason": "MCP nicht prüfbar."}


def read_capabilities(connection):
    """Discover the *active* input/output contract, never infer it from a version."""
    if connection.get("state") != "ready":
        return False
    try:
        result = _request(connection["base"] + "/mcp", connection["token"],
                          {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = {tool["name"]: tool for tool in result["result"]["tools"]}
        recommendation = tools["get_recommended_runtime"]
        roles = recommendation["inputSchema"]["properties"]["profile"]["enum"]
        output = tools["get_project_model_policy"]["outputSchema"]["properties"]
        version = output["schema_version"]
        supports_two = 2 in version.get("enum", []) or version.get("const") == 2 or any(
            part.get("const") == 2 or 2 in part.get("enum", []) for part in version.get("anyOf", []))
        return (supports_two and {"design", "review"}.issubset(roles)
                and {"design", "review"}.issubset(output["profiles"]["properties"])
                and {"resolution_path", "resolved_profile"}.issubset(recommendation["outputSchema"]["properties"]))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, CatalogUnavailable):
        return False


def read_catalog(share_root, sessions, project_hash, *, connection=None):
    connection = connection if connection is not None else mcp_connection(share_root, sessions, project_hash)
    if connection.get("state") == "ready":
        try:
            base, token = connection["base"], connection["token"]
            result = _request(base + "/mcp", token, {"jsonrpc": "2.0", "id": 1,
                              "method": "tools/call", "params": {"name": "get_session_runtime_options", "arguments": {}}})
            content = result.get("result", {}).get("structuredContent")
            if not isinstance(content, dict) or result.get("result", {}).get("isError"):
                return None
            if not isinstance(content.get("truncated"), bool) or not isinstance(content.get("models"), list) or not isinstance(content.get("providers"), list):
                return None
            return {"providers": [{"provider_id": item["provider_id"], "name": item["name"]}
                                  for item in content["providers"] if isinstance(item, dict)
                                  and isinstance(item.get("provider_id"), str) and isinstance(item.get("name"), str)],
                    "models": [{"provider_id": item["provider_id"], "model_id": item["model_id"],
                                "name": item["name"], "variants": item["variants"]}
                               for item in content["models"] if isinstance(item, dict)
                               and all(isinstance(item.get(key), str) for key in ("provider_id", "model_id", "name"))
                               and isinstance(item.get("variants"), list)
                               and all(isinstance(value, str) for value in item["variants"])],
                    "truncated": content["truncated"]}
        except (OSError, ValueError, KeyError, TypeError, AttributeError, CatalogUnavailable):
            return None
    return None
