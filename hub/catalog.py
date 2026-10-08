"""Bounded, project-bound read of the admitted guest MCP runtime."""

import json
import os
from pathlib import Path
import stat
from urllib.request import Request, urlopen


class CatalogUnavailable(Exception):
    pass


# Declared master tasks/work packages are recognized by the existing canonical
# document sidecar roles; the open native statuses are used only to narrow a
# scan that exceeded the adapter budget. No new index or membership store.
DECLARED_DOCUMENT_ROLES = {"compact_context", "concept_plan"}
BOARD_SCAN_STATUSES = ("todo", "in_progress")
MAX_CANDIDATE_TASKS = 50


def _tool_error_code(result):
    payload = result.get("result") if isinstance(result, dict) else None
    meta = payload.get("_meta") if isinstance(payload, dict) else None
    error = meta.get("opencode-vm/error") if isinstance(meta, dict) else None
    return error.get("code") if isinstance(error, dict) and isinstance(error.get("code"), str) else None


def _list_project_tasks(connection, arguments):
    """One bounded list_project_tasks call. Returns (tasks, error_code)."""
    result = _request(connection["base"] + "/mcp", connection["token"],
                      {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                       "params": {"name": "list_project_tasks", "arguments": arguments}})
    payload = result.get("result")
    if not isinstance(payload, dict):
        return None, "TASKBOARD_ERROR"
    if payload.get("isError"):
        return None, _tool_error_code(result) or "TASKBOARD_ERROR"
    content = payload.get("structuredContent")
    tasks = content.get("tasks") if isinstance(content, dict) else None
    return (tasks, None) if isinstance(tasks, list) else (None, "TASKBOARD_ERROR")


def _parse_declared_tasks(tasks):
    """Project the declared tasks; None marks an unusable board response."""
    declared, seen = [], set()
    for item in tasks:
        if (not isinstance(item, dict) or not isinstance(item.get("task_id"), str)
                or not isinstance(item.get("title"), str) or not isinstance(item.get("status"), str)):
            return None
        if item["task_id"] in seen:
            continue
        documents = item.get("documents")
        roles = {reference.get("role") for reference in documents if isinstance(reference, dict)} \
            if isinstance(documents, list) else set()
        if roles & DECLARED_DOCUMENT_ROLES:
            seen.add(item["task_id"])
            declared.append({"task_id": item["task_id"], "title": item["title"], "status": item["status"]})
    return declared


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


def mcp_connection(runtime, session_root, project_hash):
    """Read the current session's MCP endpoint from admitted guest facts only."""
    if not isinstance(runtime, dict) or runtime.get("enabled") is not True:
        return {"state": "not_ready", "reason": "MCP ist für diese Session nicht aktiviert (z. B. --no-mcp)."}
    port = runtime.get("port")
    generation = runtime.get("generation")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535 or not isinstance(generation, str):
        return {"state": "unverified", "reason": "MCP-Runtimeinput ist nicht prüfbar."}
    root = Path(session_root)
    credential = root / "mcp/credential"
    try:
        root_info = root.lstat()
        parent_info = credential.parent.lstat()
        info = credential.lstat()
        if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.getuid() or root_info.st_mode & 0o077
                or not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o077
                or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 512 or credential.is_symlink()):
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
                or health.get("generation") != generation):
            return {"state": "not_ready", "reason": "MCP-Health bestätigt Dienst, Projekt und Generation nicht."}
        return {"state": "ready", "reason": "Authentifizierter MCP-Health bestätigt Projekt und Generation.",
                "base": base, "token": token}
    except (OSError, ValueError, TypeError, AttributeError, CatalogUnavailable):
        return {"state": "not_ready", "reason": "Authentifizierter MCP-Healthcheck fehlgeschlagen."}


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


def read_board_tasks(runtime, session_root, project_hash, *, connection=None, limit=MAX_CANDIDATE_TASKS):
    """Bounded project-local read of declared master tasks/work packages.

    A task counts as declared when the existing canonical document sidecar binds
    a `compact_context` or `concept_plan` role; the terminal native status `done`
    is excluded by the existing include_terminal filter of list_project_tasks.

    One bounded unfiltered scan first; when the adapter reports its scan budget
    (`TASK_SEARCH_INCOMPLETE`), the existing backend `status` filter narrows the
    read per open status instead of surfacing an empty list. Incomplete coverage
    is reported explicitly (`completeness`/`reason`/`missing_statuses`) and a
    capped list is marked `truncated` — an allowed limit is never presented as
    "no candidates". Returns None only when the board is not readable at all.
    """
    connection = connection if connection is not None else mcp_connection(runtime, session_root, project_hash)
    if connection.get("state") != "ready":
        return None
    try:
        tasks, error = _list_project_tasks(connection, {"include_terminal": False})
        completeness, reason, missing = "complete", None, []
        if tasks is None:
            if error != "TASK_SEARCH_INCOMPLETE":
                return None
            tasks = []
            for status in BOARD_SCAN_STATUSES:
                page, page_error = _list_project_tasks(connection, {"include_terminal": False, "status": status})
                if page is None:
                    missing.append(status)
                    continue
                tasks.extend(page)
            if len(missing) == len(BOARD_SCAN_STATUSES):
                return None
            completeness, reason = "partial", "task-scan-budget"
        declared = _parse_declared_tasks(tasks)
        if declared is None:
            return None
        return {"tasks": declared[:limit], "completeness": completeness, "reason": reason,
                "missing_statuses": missing, "truncated": len(declared) > limit, "scanned": len(declared)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, CatalogUnavailable):
        return None


def read_catalog(runtime, session_root, project_hash, *, connection=None):
    connection = connection if connection is not None else mcp_connection(runtime, session_root, project_hash)
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
