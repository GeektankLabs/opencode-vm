"""Repository-owned A2A launcher. Process-local admission hooks, no site patch."""
import http.client
import asyncio
import json
import os
import socket


def adopt(session_id):
    path = os.environ.get("OCVM_MANAGED_POLICY_SOCKET")
    if not path:
        raise RuntimeError("MANAGED_POLICY_UNAVAILABLE")
    connection = http.client.HTTPConnection("localhost", timeout=8)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(8)
    sock.connect(path)
    connection.sock = sock
    try:
        connection.request("POST", "/adopt", json.dumps({"session_id": session_id, "ingress": "a2a"}), {"Content-Type": "application/json"})
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
