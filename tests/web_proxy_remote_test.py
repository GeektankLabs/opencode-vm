#!/usr/bin/env python3
import json
import re
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.request.recv(8192)
            if not chunk:
                return
            data += chunk
        body = self.server.identity.encode()
        self.request.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, identity):
        super().__init__(("127.0.0.1", 0), Handler)
        self.identity = identity


if len(sys.argv) > 1 and sys.argv[1] == "--backend":
    backend = Server(sys.argv[2])
    print(backend.server_address[1], flush=True)
    backend.serve_forever()
    raise SystemExit


def request(port, path):
    with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
        sock.sendall(
            f"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode()
        )
        response = b""
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            response += chunk
    return response.partition(b"\r\n\r\n")[2].decode()


root = Path(__file__).resolve().parent.parent
script = (root / "opencode-vm.sh").read_text()
match = re.search(
    r"read -r -d '' OCVM_WEB_REDIRECT_PY <<'PYSRC' \|\| true\n(.*?)\nPYSRC",
    script,
    re.DOTALL,
)
if not match:
    raise RuntimeError("could not extract web proxy source")
web_lib = re.search(
    r"read -r -d '' OCVM_WEB_LIB_SH <<'WEBLIB' \|\| true\n(.*?)\nWEBLIB",
    script,
    re.DOTALL,
)
if not web_lib:
    raise RuntimeError("could not extract web library source")

target = Server("opencode")
threads = []
for server in (target,):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    threads.append(thread)

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
proxy_port = listener.getsockname()[1]
listener.close()

with tempfile.TemporaryDirectory() as directory:
    proxy_file = Path(directory) / "proxy.py"
    proxy_file.write_text(match.group(1))
    web_file = Path(directory) / "web.sh"
    web_file.write_text(web_lib.group(1))
    ready_file = Path(directory) / "gateway-ready.json"
    subprocess.run(["bash", "-n", str(web_file)], check=True)
    subprocess.run([sys.executable, "-m", "py_compile", str(proxy_file)], check=True)
    remote = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--backend",
            "openlive",
            "dist/remote/server.js",
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    remote_port = int(remote.stdout.readline())
    proxy = subprocess.Popen(
        [
            sys.executable,
            str(proxy_file),
            str(proxy_port),
            str(target.server_address[1]),
            "",
            "",
            "",
            str(ready_file),
            "test-project",
            "test-generation",
            "dist/remote/server.js",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    ready_file.write_text(
        json.dumps(
            {
                "schema": 1,
                "port": remote_port,
                "pid": remote.pid,
                "executable": sys.executable,
                "script": "dist/remote/server.js",
                "projectId": "test-project",
                "generation": "test-generation",
            }
        )
    )
    try:
        deadline = time.time() + 3
        while True:
            try:
                with socket.create_connection(("127.0.0.1", proxy_port), timeout=0.1):
                    break
            except OSError:
                if time.time() > deadline:
                    raise RuntimeError("web proxy did not start")
                time.sleep(0.025)
        assert request(proxy_port, "/api/test") == "opencode"
        assert request(proxy_port, "/openlive/info") == "openlive"
        assert request(proxy_port, "/openlive/acp") == "openlive"
        assert request(proxy_port, "/openlive/info?unexpected=1") == "opencode"
        ready_file.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "port": remote_port,
                    "pid": remote.pid,
                    "executable": sys.executable,
                    "script": "dist/remote/server.js",
                    "projectId": "another-project",
                    "generation": "test-generation",
                }
            )
        )
        assert request(proxy_port, "/openlive/info") == (
            '{"error":"remote_openlive_unavailable"}'
        )
        ready_file.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "port": target.server_address[1],
                    "pid": remote.pid,
                    "executable": sys.executable,
                    "script": "dist/remote/server.js",
                    "projectId": "test-project",
                    "generation": "test-generation",
                }
            )
        )
        assert request(proxy_port, "/openlive/info") == (
            '{"error":"remote_openlive_unavailable"}'
        )
        remote.terminate()
        remote.wait(timeout=3)
        remote = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--backend",
                "openlive",
                "dist/remote/server.js",
            ],
            stdout=subprocess.PIPE,
            text=True,
        )
        remote_port = int(remote.stdout.readline())
        ready_file.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "port": remote_port,
                    "pid": remote.pid,
                    "executable": sys.executable,
                    "script": "dist/remote/server.js",
                    "projectId": "test-project",
                    "generation": "test-generation",
                }
            )
        )
        assert request(proxy_port, "/openlive/info") == "openlive"
        ready_file.unlink()
        assert request(proxy_port, "/openlive/info") == (
            '{"error":"remote_openlive_unavailable"}'
        )
    finally:
        proxy.terminate()
        proxy.wait(timeout=3)
        if remote.poll() is None:
            remote.terminate()
            remote.wait(timeout=3)
        for server in (target,):
            server.shutdown()
            server.server_close()

print("Web proxy remote routing passed.")
