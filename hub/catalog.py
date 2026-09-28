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


def read_catalog(share_root, sessions, project_hash):
    for session_file, values in sessions:
        if values.get("SESS_MCP_ENABLED") != "1":
            continue
        port_text = values.get("SESS_MCP_PORT", "")
        if not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
            continue
        port = int(port_text)
        credential = Path(share_root) / "sessions" / session_file.stem / "mcp/credential"
        try:
            info = credential.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size > 512 or credential.parent.is_symlink()):
                continue
            token = credential.read_text(encoding="ascii").strip()
            if not token:
                continue
            base = f"http://127.0.0.1:{port}"
            health = _request(base + "/healthz", token)
            if (health.get("healthy") is not True or health.get("project", {}).get("id") != project_hash
                    or health.get("generation") != values.get("SESS_CONTROLLER")):
                continue
            result = _request(base + "/mcp", token, {"jsonrpc": "2.0", "id": 1,
                              "method": "tools/call", "params": {"name": "get_session_runtime_options", "arguments": {}}})
            content = result.get("result", {}).get("structuredContent")
            if not isinstance(content, dict) or result.get("result", {}).get("isError"):
                continue
            if not isinstance(content.get("truncated"), bool) or not isinstance(content.get("models"), list) or not isinstance(content.get("providers"), list):
                continue
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
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return None
