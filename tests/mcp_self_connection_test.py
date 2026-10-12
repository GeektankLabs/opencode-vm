"""D5 bounded proof: the declared self-MCP config plus the real adapter make a
real OpenCode runtime report the self-connection as connected.

Uses the canonical production functions (mcp_self_register/mcp_self_connect
extracted from the materialized web lib) against a disposable runtime.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers.managed_runtime import Runtime, ROOT, wait  # noqa: E402


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    if not shutil.which("opencode") or not (ROOT / "adapters/mcp/dist/main.js").exists():
        print("SKIP self-connection proof (opencode binary or built adapter missing)")
        return 0
    fixture = Runtime()
    adapter = None
    try:
        port = free_port()
        token = uuid4().hex + uuid4().hex
        share = fixture.root / "share"
        # No orchestrator skill directory on purpose: since 0.7.34 the
        # self-connection follows the MCP connector, not the skill opt-in
        # (regression proof for the U1 "skill inactive -> no tools" gap).
        (share / "mcp").mkdir(parents=True, exist_ok=True)
        (share / "mcp").chmod(0o700)
        (share / "mcp/credential").write_text(token + "\n")
        (share / "mcp/credential").chmod(0o600)
        (share / "config/opencode").mkdir(parents=True)
        (share / "config/opencode/opencode.json").write_text('{"mcp":{}}')

        script = ROOT / "opencode-vm.sh"
        src = fixture.root / "src"
        src.mkdir()
        funcs = src / "self-funcs.sh"
        subprocess.check_output(
            [
                "bash",
                "-c",
                'set -euo pipefail; '
                'export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1; '
                'src="$OCVM_W4_SCRIPT"; share="$OCVM_W4_SHARE"; out="$OCVM_W4_OUT"; '
                'source "$src"; install_web_lib "$share" >/dev/null; '
                '{ awk "/^mcp_self_unregister\\(\\) \\{/,/^\\}$/" "$share/lib/web.sh"; '
                'awk "/^mcp_self_register\\(\\) \\{/,/^\\}$/" "$share/lib/web.sh"; '
                'awk "/^mcp_self_connect\\(\\) \\{/,/^\\}$/" "$share/lib/web.sh"; '
                'awk "/^web_jq_inplace\\(\\) \\{/,/^\\}$/" "$share/lib/web.sh"; } > "$out"',
            ],
            text=True,
            env={
                **os.environ,
                "HOME": str(fixture.root / "home"),
                "OCVM_W4_SCRIPT": str(script),
                "OCVM_W4_SHARE": str(share),
                "OCVM_W4_OUT": str(funcs),
            },
        )
        for name in ("mcp_self_unregister", "mcp_self_register", "mcp_self_connect"):
            assert f"{name}() {{" in funcs.read_text(), f"{name} not extracted"
        subprocess.check_output(
            [
                "bash",
                "-c",
                'set -euo pipefail; source "$1"; OC_MCP_ENABLED=1 OC_MCP_PORT="$3" SESS_SHARE="$2" mcp_self_register',
                "bash",
                str(funcs),
                str(share),
                str(port),
            ],
            text=True,
        )
        config = json.loads((share / "config/opencode/opencode.json").read_text())
        entry = config["mcp"]["ocvm-self"]
        assert entry["type"] == "remote"
        assert entry["url"] == f"http://127.0.0.1:{port}/mcp"
        assert entry["headers"]["X-OCVM-MCP-Token"] == token
        assert entry["enabled"] is True

        fixture.cfg["mcp"] = {"ocvm-self": entry}
        fixture.start()

        runtime_dir = fixture.root / "adapter"
        runtime_dir.mkdir()
        runtime_dir.chmod(0o700)
        credential = share / "mcp/credential"
        version = subprocess.check_output([shutil.which("opencode"), "--version"], text=True).strip()
        runtime_path = runtime_dir / "runtime.json"
        runtime_path.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "project": os.path.realpath(fixture.project),
                    "projectHash": "fixtureself",
                    "projectName": "fixtureself",
                    "backendUrl": fixture.url,
                    "generation": "fixturegen",
                    "opencodeVersion": version,
                    "credentialFile": str(credential),
                    "listenHost": "127.0.0.1",
                    "listenPort": port,
                }
            )
        )
        runtime_path.chmod(0o600)
        adapter_log = (fixture.root / "adapter.log").open("a")
        adapter = subprocess.Popen(
            ["node", str(ROOT / "adapters/mcp/dist/main.js")],
            env={**os.environ, "OCVM_MCP_RUNTIME": str(runtime_path)},
            stdout=adapter_log,
            stderr=adapter_log,
        )
        wait(lambda: (runtime_dir / "ready.json").exists(), 30)

        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=3)
            raise AssertionError("adapter accepted an unauthenticated request")
        except urllib.error.HTTPError as error:
            assert error.code in (401, 403), error.code

        subprocess.check_output(
            [
                "bash",
                "-c",
                'set -euo pipefail; source "$1"; mcp_self_connect',
                "bash",
                str(funcs),
            ],
            text=True,
            env={
                **os.environ,
                "SESS_SHARE": str(share),
                "OC_MCP_ENABLED": "1",
                "OC_PORT_INTERNAL": str(fixture.url.rsplit(":", 1)[1]),
                "PROJ_DIR": str(fixture.project),
            },
        )
        status = wait(
            lambda: (lambda value: value if value.get("ocvm-self", {}).get("status") == "connected" else None)(
                fixture.api("GET", "/mcp")
            ),
            30,
        )
        evidence = {
            "status": status,
            "ready": json.loads((runtime_dir / "ready.json").read_text()),
            "project_id": str(fixture.project),
        }
        logs = ""
        for path in (fixture.root / "runtime.log", fixture.root / "adapter.log"):
            if path.exists():
                logs += path.read_text(errors="replace")
        assert token not in logs, "credential leaked into runtime logs"
        print("PASS self-MCP connected:", json.dumps(evidence), flush=True)
    finally:
        if adapter is not None:
            adapter.terminate()
            try:
                adapter.wait(timeout=10)
            except subprocess.TimeoutExpired:
                adapter.kill()
                adapter.wait()
        fixture.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())