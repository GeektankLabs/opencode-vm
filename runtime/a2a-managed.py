"""Repository-owned A2A launcher. Process-local admission hooks, no site patch."""
import http.client
import asyncio
import json
import os
import socket


def scope_dirs():
    """Operator-authorized external directories (OCVM_A2A_SCOPE_DIRS, os-path
    separated). Validated like the plugin contract; empty/absent means none.
    The plugin revalidates and stays the authority (deny precedence)."""
    raw = os.environ.get("OCVM_A2A_SCOPE_DIRS", "").strip()
    if not raw:
        return []
    dirs = []
    for item in raw.split(os.pathsep):
        item = item.strip().rstrip("/") or "/"
        if not item.startswith("/") or len(item) > 512 or any(c in item for c in "\x00\r\n"):
            raise RuntimeError("MANAGED_SCOPE_INVALID")
        if item == "/" or "/../" in item or item.endswith("/..") or "/./" in item:
            raise RuntimeError("MANAGED_SCOPE_INVALID")
        dirs.append(item)
    if len(dirs) > 16:
        raise RuntimeError("MANAGED_SCOPE_LIMIT")
    return dirs


def adopt(session_id):
    path = os.environ.get("OCVM_MANAGED_POLICY_SOCKET")
    if not path:
        raise RuntimeError("MANAGED_POLICY_UNAVAILABLE")
    dirs = scope_dirs()
    payload = {"session_id": session_id, "ingress": "a2a"}
    if dirs:
        payload["scope_dirs"] = dirs
    connection = http.client.HTTPConnection("localhost", timeout=8)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(8)
    sock.connect(path)
    connection.sock = sock
    try:
        connection.request("POST", "/adopt", json.dumps(payload), {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = json.loads(response.read())
        if response.status != 200 or result.get("session_id") != session_id or result.get("agent_managed") is not True:
            raise RuntimeError("MANAGED_POLICY_ADOPTION_FAILED")
    finally:
        connection.close()


def install_hooks(client_type):
    create = client_type.create_session

    async def create_session(self, *args, **kwargs):
        session_id = await create(self, *args, **kwargs)
        await asyncio.to_thread(adopt, session_id)
        return session_id

    client_type.create_session = create_session
    for name in ("send_message", "session_prompt_async", "session_command"):
        original = getattr(client_type, name)

        def wrap(method):
            async def work(self, session_id, *args, **kwargs):
                await asyncio.to_thread(adopt, session_id)
                return await method(self, session_id, *args, **kwargs)
            return work

        setattr(client_type, name, wrap(original))


if __name__ == "__main__":
    from opencode_a2a.opencode_upstream_client import OpencodeUpstreamClient
    import runpy
    import sys

    install_hooks(OpencodeUpstreamClient)
    executable = sys.argv.pop(1)
    sys.argv[0] = executable
    runpy.run_path(executable, run_name="__main__")
