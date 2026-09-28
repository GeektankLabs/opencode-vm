#!/usr/bin/env python3
"""Exercise the conservative HTML-only launcher path through the real proxy."""
import gzip
import http.client
import json
import re
import base64
from html.parser import HTMLParser
import os
from pathlib import Path
import socket
import socketserver
import ssl
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()
PYTHON_PROXY = re.search(
    r"read -r -d '' OCVM_WEB_REDIRECT_PY <<'PYSRC' \|\| true\n(.*?)\nPYSRC",
    SCRIPT,
    re.S,
).group(1)

KEY = "cHJvamVjdA"
PROJECT_PATH = "/" + KEY
HTML = b"<!doctype html><html><head><meta charset=utf-8><title>OpenCode</title><link rel=icon href=/favicon-v3.svg><script type=module src=/assets/app.js></script></head><body><main id=app>Workspace</main></body></html>"
CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'"


class BackendHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = b""
        while b"\r\n\r\n" not in request:
            data = self.request.recv(8192)
            if not data:
                return
            request += data
        head, _, buffered = request.partition(b"\r\n\r\n")
        line = head.split(b"\r\n", 1)[0].split()
        if len(line) < 2:
            return
        method, target = line[0], line[1].decode("ascii")
        path = target.split("?", 1)[0]
        headers = {}
        for field in head.split(b"\r\n")[1:]:
            name, separator, value = field.partition(b":")
            if separator:
                headers[name.strip().lower()] = value.strip()
        self.server.seen.append((method, path, headers))
        if path == "/ws":
            self.request.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                b"Connection: Upgrade\r\n\r\n"
            )
            payload = self.request.recv(4)
            self.request.sendall(payload)
            return
        if getattr(self.server, "require_auth", False) and (path.startswith(PROJECT_PATH) or path == "/new-session") and b"authorization" not in headers:
            self._respond(401, [(b"WWW-Authenticate", b'Basic realm="OpenCode"'),
                                (b"Content-Type", b"text/html; charset=utf-8")], b"login")
            return
        suffix = path[len(PROJECT_PATH):] if path.startswith(PROJECT_PATH) else path
        if method == b"POST":
            length = int(headers.get(b"content-length", b"0"))
            while len(buffered) < length:
                buffered += self.request.recv(length - len(buffered))
            self._respond(200, [(b"Content-Type", b"application/octet-stream")], buffered[:length])
        elif suffix == "/no-csp":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", b"script-src 'nonce-only'; style-src 'self'")], HTML)
        elif suffix == "/csp-elem":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", b"script-src 'self'; script-src-elem 'nonce-only'; style-src 'self'")], HTML)
        elif suffix == "/csp-strict":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", b"script-src 'self' 'strict-dynamic'; style-src 'self'")], HTML)
        elif suffix == "/meta-csp":
            body = b'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src nonce-x"></head><body>meta</body></html>'
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", CSP.encode())], body)
        elif suffix == "/compressed":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Encoding", b"gzip"), (b"Content-Security-Policy", CSP.encode())], gzip.compress(HTML))
        elif suffix == "/chunked":
            self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                                 b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
            self.request.sendall(("%x\r\n" % len(HTML)).encode() + HTML + b"\r\n0\r\n\r\n")
        elif suffix == "/no-length":
            self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n" + HTML)
        elif suffix == "/not-spa-shell":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", CSP.encode())],
                          b"<html><head></head><body><main>Unknown HTML document</main></body></html>")
        elif path == "/doc":
            self._respond(200, [(b"Content-Type", b"application/json")], b'{"openapi":"test"}')
        elif path == "/upload":
            self._respond(200, [(b"Content-Type", b"application/octet-stream")], b"upload-ok")
        elif path == "/keepalive":
            body = b"alive"
            self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\n"
                                 b"Content-Length: 5\r\n\r\n" + body)
        elif suffix in ("", "/deep/session") or path == "/new-session":
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8"),
                                (b"Content-Security-Policy", CSP.encode()),
                                (b"ETag", b'"original"')], HTML)
        else:
            self._respond(200, [(b"Content-Type", b"text/html; charset=utf-8")], b"<html><head></head><body>other</body></html>")

    def _respond(self, status, headers, body):
        reasons = {200: b"OK", 401: b"Unauthorized"}
        fields = b"".join(name + b": " + value + b"\r\n" for name, value in headers)
        self.request.sendall(b"HTTP/1.1 " + str(status).encode() + b" " + reasons[status] + b"\r\n" +
                             fields + b"Content-Length: " + str(len(body)).encode() +
                             b"\r\nConnection: close\r\n\r\n" + body)


class Backend(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), BackendHandler)
        self.seen = []
        self.require_auth = False


class HealthHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = self.request.recv(4096)
        if b"GET /healthz " not in request:
            self.request.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        body = b'{"status":"alive"}'
        self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                             str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)


class BoardHealthHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = self.request.recv(4096)
        if b"GET /api/projects " not in request:
            self.request.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                             b"Content-Length: 2\r\nConnection: close\r\n\r\n[]")


class TLSHealthServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, port, context):
        self.context = context
        super().__init__(("127.0.0.1", port), HealthHandler)

    def get_request(self):
        sock, address = super().get_request()
        return self.context.wrap_socket(sock, server_side=True), address


class LauncherMarkup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.mount = None
        self.resources = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id") == "ocvm-vm-launcher":
            self.mount = attrs
        if (tag == "script" and attrs.get("src")) or (tag == "link" and attrs.get("href")):
            self.resources.append(attrs.get("src") or attrs.get("href"))


def http_request(port, path, *, method="GET", headers=None, body=None, timeout=3):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers={"Connection": "close", **(headers or {})})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def free_port_block(size):
    for _ in range(100):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        base = probe.getsockname()[1]
        probe.close()
        sockets = []
        try:
            for port in range(base, base + size):
                item = socket.socket()
                item.bind(("127.0.0.1", port))
                sockets.append(item)
            return base
        except OSError:
            pass
        finally:
            for item in sockets:
                item.close()
    raise RuntimeError("could not reserve a test port block")


def serve_browser_fixture():
    """Start isolated local HTTP/HTTPS fixtures for Playwright/manual viewport checks."""
    temporary = tempfile.TemporaryDirectory(prefix="ocvm-launcher-browser-")
    root = Path(temporary.name)
    base = free_port_block(5)
    key = KEY
    project_hash = "launcher-browser-fixture"
    share = root / "share"
    editor_dir = share / "editor"
    editor_dir.mkdir(parents=True, mode=0o700)
    editor_dir.chmod(0o700)
    runtime = {"schema": 1, "share": str(share), "projectHash": project_hash,
               "editorPort": base + 4, "backendPort": base - 1,
               "mcpEnabled": False, "mcpPort": 0}
    runtime_file = editor_dir / "runtime.json"
    runtime_file.write_text(json.dumps(runtime))
    runtime_file.chmod(0o600)
    certificate, private_key = root / "cert.pem", root / "key.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", str(private_key), "-out", str(certificate), "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(certificate), str(private_key))
    editor = TLSHealthServer(base + 4, context)
    editor_thread = threading.Thread(target=editor.serve_forever, daemon=True)
    editor_thread.start()
    backend = Backend()
    backend_thread = threading.Thread(target=backend.serve_forever, daemon=True)
    backend_thread.start()
    proxy_file = root / "proxy.py"
    proxy_file.write_text(PYTHON_PROXY)
    proxy = subprocess.Popen([
        sys.executable, str(proxy_file), str(base), str(backend.server_address[1]), key,
        "", "", "0", "", "", "ocvm-launcher-browser-fixture", str(share), project_hash,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if proxy.poll() is not None:
                raise RuntimeError("launcher proxy failed to start")
            try:
                with socket.create_connection(("127.0.0.1", base), timeout=.1):
                    break
            except OSError:
                time.sleep(.02)
        else:
            raise RuntimeError("launcher proxy readiness timed out")
        print(f"Browser fixture: http://127.0.0.1:{base}/", flush=True)
        print(f"Editor target: https://127.0.0.1:{base + 4}/", flush=True)
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        pass
    finally:
        proxy.terminate()
        proxy.wait(timeout=4)
        editor.shutdown()
        editor.server_close()
        backend.shutdown()
        backend.server_close()
        editor_thread.join(timeout=2)
        backend_thread.join(timeout=2)
        temporary.cleanup()


def serve_real_browser_fixture(launcher_enabled="1", tls=False):
    """Run a disposable real OpenCode server behind the real launcher proxy."""
    binary = shutil.which("opencode")
    if not binary:
        raise RuntimeError("OpenCode executable not found on PATH")
    temporary = tempfile.TemporaryDirectory(prefix="ocvm-launcher-real-browser-")
    root = Path(temporary.name)
    project = root / "project"
    project.mkdir()
    (project / "README.md").write_text("# Disposable OpenCode launcher browser fixture\n")
    project_key = base64.urlsafe_b64encode(str(project.resolve()).encode()).decode().rstrip("=")
    for name in ("home", "config", "data", "state"):
        (root / name).mkdir()
    env = dict(os.environ, HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "config"),
               XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"))
    port_window = free_port_block(7)
    public_port = port_window + 1
    backend_port = public_port - 1
    share = root / "share"
    editor_dir = share / "editor"
    editor_dir.mkdir(parents=True, mode=0o700)
    editor_dir.chmod(0o700)
    project_hash = "launcher-real-browser-fixture"
    runtime_file = editor_dir / "runtime.json"
    runtime_file.write_text(json.dumps({"schema": 1, "share": str(share), "projectHash": project_hash,
                                        "editorPort": public_port + 4, "backendPort": backend_port,
                                        "mcpEnabled": False, "mcpPort": 0}))
    runtime_file.chmod(0o600)
    board_dir = share / "taskboard"
    board_dir.mkdir(mode=0o700)
    board_file = board_dir / "runtime.json"
    board_file.write_text(json.dumps({"schema": 1, "share": str(share), "projectHash": project_hash,
                                      "taskboardPort": public_port + 5}))
    board_file.chmod(0o600)
    certificate, private_key = root / "cert.pem", root / "key.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", str(private_key), "-out", str(certificate), "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls_context.load_cert_chain(str(certificate), str(private_key))
    editor = TLSHealthServer(public_port + 4, tls_context)
    editor_thread = threading.Thread(target=editor.serve_forever, daemon=True)
    editor_thread.start()
    board = socketserver.ThreadingTCPServer(("127.0.0.1", public_port + 5), BoardHealthHandler)
    board.daemon_threads = True
    board_thread = threading.Thread(target=board.serve_forever, daemon=True)
    board_thread.start()
    proxy_file = root / "proxy.py"
    proxy_file.write_text(PYTHON_PROXY)
    log = (root / "fixture.log").open("wb")
    opencode = subprocess.Popen([binary, "web", "--hostname", "127.0.0.1", "--port", str(backend_port)],
                                cwd=project, env=env, stdout=log, stderr=log)
    proxy = None
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if opencode.poll() is not None:
                log.flush()
                raise RuntimeError("OpenCode exited: " + (root / "fixture.log").read_text(errors="replace"))
            try:
                status, _, _ = http_request(backend_port, "/", headers={"Accept": "text/html"}, timeout=2)
                if status == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.2)
        else:
            log.flush()
            raise TimeoutError("OpenCode web UI readiness timed out: " + (root / "fixture.log").read_text(errors="replace"))
        proxy = subprocess.Popen([
            sys.executable, str(proxy_file), str(public_port), str(backend_port), project_key,
            str(certificate) if tls else "", str(private_key) if tls else "", "0", "", "",
            "ocvm-launcher-real-browser", str(share), project_hash, launcher_enabled, project.name,
        ], stdout=subprocess.DEVNULL, stderr=log)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", public_port), timeout=.1):
                    break
            except OSError:
                if proxy.poll() is not None:
                    raise RuntimeError("launcher proxy failed")
                time.sleep(.025)
        else:
            raise TimeoutError("launcher proxy readiness timed out")
        print(f"Real OpenCode fixture: {'https' if tls else 'http'}://127.0.0.1:{public_port}/", flush=True)
        print(f"Mock ready Editor link: https://127.0.0.1:{public_port + 4}/", flush=True)
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        pass
    finally:
        if proxy is not None:
            proxy.terminate()
            proxy.wait(timeout=4)
        opencode.terminate()
        try:
            opencode.wait(timeout=10)
        except subprocess.TimeoutExpired:
            opencode.kill()
            opencode.wait(timeout=4)
        editor.shutdown()
        editor.server_close()
        editor_thread.join(timeout=2)
        board.shutdown()
        board.server_close()
        board_thread.join(timeout=2)
        log.close()
        temporary.cleanup()


class LauncherProxyTest(unittest.TestCase):
    def test_safe_project_html_only_and_ready_editor_catalog(self):
        with tempfile.TemporaryDirectory(prefix="ocvm-launcher-") as temporary:
            root = Path(temporary)
            share = root / "share"
            editor = share / "editor"
            editor.mkdir(parents=True, mode=0o700)
            editor.chmod(0o700)
            base = free_port_block(6)
            key = "cHJvamVjdA"
            project_hash = "launcher-test-project"
            runtime = {"schema": 1, "share": str(share), "projectHash": project_hash,
                       "editorPort": base + 4, "backendPort": base - 1,
                       "mcpEnabled": False, "mcpPort": 0}
            runtime_file = editor / "runtime.json"
            runtime_file.write_text(json.dumps(runtime))
            runtime_file.chmod(0o600)
            board_dir = share / "taskboard"
            board_dir.mkdir(mode=0o700)
            board_file = board_dir / "runtime.json"
            board_runtime = {"schema": 1, "share": str(share), "projectHash": project_hash,
                             "taskboardPort": base + 5}
            board_file.write_text(json.dumps(board_runtime))
            board_file.chmod(0o600)

            certificate = root / "cert.pem"
            private_key = root / "key.pem"
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-keyout", str(private_key), "-out", str(certificate), "-subj", "/CN=localhost",
                "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls_context.load_cert_chain(str(certificate), str(private_key))
            health = TLSHealthServer(base + 4, tls_context)
            health_thread = threading.Thread(target=health.serve_forever, daemon=True)
            health_thread.start()
            board = socketserver.ThreadingTCPServer(("127.0.0.1", base + 5), BoardHealthHandler)
            board.daemon_threads = True
            board_thread = threading.Thread(target=board.serve_forever, daemon=True)
            board_thread.start()
            backend = Backend()
            backend.require_auth = True
            backend_thread = threading.Thread(target=backend.serve_forever, daemon=True)
            backend_thread.start()

            proxy_file = root / "proxy.py"
            proxy_file.write_text(PYTHON_PROXY)
            subprocess.run([sys.executable, "-m", "py_compile", str(proxy_file)], check=True)
            proxy_log = (root / "proxy.log").open("wb")
            proxy = subprocess.Popen([
                sys.executable, str(proxy_file), str(base), str(backend.server_address[1]), key,
                "", "", "0", "", "", "ocvm-web-test", str(share), project_hash, "1", "bi-mcrepo",
            ], stdout=subprocess.DEVNULL, stderr=proxy_log)
            other_proxy = None
            try:
                deadline = time.monotonic() + 4
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", base), timeout=.1):
                            break
                    except OSError:
                        if proxy.poll() is not None:
                            raise AssertionError("proxy exited before accepting a connection")
                        if time.monotonic() > deadline:
                            raise AssertionError("proxy did not start")
                        time.sleep(.02)

                status, headers, root_body = http_request(base, "/", headers={"Accept": "text/html"})
                self.assertEqual(status, 200)
                self.assertIn(b'location.replace("/" + key)', root_body)
                self.assertNotIn(b"Choose a project app", root_body)
                self.assertNotIn(b"Taskboard -&gt;", root_body)
                self.assertIn(b"<title>bi-mcrepo</title>", root_body)

                auth = {"Accept": "text/html", "Authorization": "Basic dXNlcjpwYXNz"}
                try:
                    status, headers, body = http_request(
                        base, PROJECT_PATH,
                        headers=auth | {"Accept-Encoding": "gzip, deflate, br", "If-None-Match": '"cached"'})
                except Exception as error:
                    time.sleep(.05)
                    proxy_log.flush()
                    raise AssertionError(proxy_log.name + ": " + Path(proxy_log.name).read_text()) from error
                self.assertEqual(status, 200)
                self.assertIn(b"<title>bi-mcrepo</title>", body)
                self.assertEqual(body.count(b"<link rel=icon href=/favicon-v3.svg>"), 1)
                markup = LauncherMarkup()
                markup.feed(body.decode("utf-8"))
                self.assertIsNotNone(markup.mount)
                apps = json.loads(markup.mount["data-apps"])
                self.assertEqual([app["id"] for app in apps], ["editor", "taskboard"])
                self.assertEqual(apps[0]["scheme"], "https")
                self.assertEqual(apps[0]["port"], base + 4)
                self.assertEqual(apps[1], {"id": "taskboard", "label": "Projektmanagement", "icon": "board",
                                           "scheme": "http", "port": base + 5})
                self.assertIn("/__ocvm/launcher.css", markup.resources)
                self.assertIn("/__ocvm/launcher.js", markup.resources)
                self.assertEqual(headers["Content-Length"], str(len(body)))
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn("ETag", headers)
                rewritten_request = next(request_headers for _, path, request_headers in backend.seen if path == PROJECT_PATH)
                self.assertEqual(rewritten_request.get(b"accept-encoding"), b"identity")
                self.assertEqual(rewritten_request.get(b"cache-control"), b"no-cache")
                self.assertNotIn(b"if-none-match", rewritten_request)

                # Two live proxy instances must never share title state.
                other_port = free_port_block(1)
                other_proxy = subprocess.Popen([
                    sys.executable, str(proxy_file), str(other_port), str(backend.server_address[1]), key,
                    "", "", "0", "", "", "ocvm-second-project", str(share), project_hash, "1", "raspiblitz",
                ], stdout=subprocess.DEVNULL, stderr=proxy_log)
                deadline = time.monotonic() + 4
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", other_port), timeout=.1):
                            break
                    except OSError:
                        if other_proxy.poll() is not None or time.monotonic() > deadline:
                            self.fail("second project proxy did not start")
                        time.sleep(.02)
                for port, title in ((base, b"bi-mcrepo"), (other_port, b"raspiblitz"), (base, b"bi-mcrepo")):
                    status, _, project_body = http_request(port, PROJECT_PATH, headers=auth)
                    self.assertEqual(status, 200)
                    self.assertIn(b"<title>" + title + b"</title>", project_body)
                    self.assertIn(b"<link rel=icon href=/favicon-v3.svg>", project_body)

                board_file.write_text(json.dumps({**board_runtime, "taskboardPort": base + 4}))
                status, _, wrong_port = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                markup = LauncherMarkup()
                markup.feed(wrong_port.decode("utf-8"))
                self.assertEqual([app["id"] for app in json.loads(markup.mount["data-apps"])], ["editor"])
                board_file.write_text(json.dumps({**board_runtime, "projectHash": "other-project"}))
                status, _, wrong_project = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                markup = LauncherMarkup()
                markup.feed(wrong_project.decode("utf-8"))
                self.assertEqual([app["id"] for app in json.loads(markup.mount["data-apps"])], ["editor"])
                board_file.write_text(json.dumps(board_runtime))
                board_file.chmod(0o600)

                status, _, deep_body = http_request(base, PROJECT_PATH + "/deep/session", headers=auth)
                self.assertEqual(status, 200)
                self.assertIn(b"ocvm-vm-launcher", deep_body)
                self.assertIn(b"<title>bi-mcrepo</title>", deep_body)

                status, new_headers, new_body = http_request(
                    base, "/new-session?draftId=test", headers=auth | {"If-None-Match": '"cached"'})
                self.assertEqual(status, 200)
                self.assertIn(b'id="ocvm-vm-launcher"', new_body)
                self.assertIn(b"/__ocvm/launcher.js", new_body)
                self.assertIn(b"<title>bi-mcrepo</title>", new_body)
                self.assertEqual(new_headers["Cache-Control"], "no-store")
                self.assertNotIn("ETag", new_headers)

                status, _, unauthorized_new = http_request(base, "/new-session?draftId=test", headers={"Accept": "text/html"})
                self.assertEqual(status, 401)
                self.assertNotIn(b"ocvm-vm-launcher", unauthorized_new)

                status, _, unauthorized = http_request(base, PROJECT_PATH, headers={"Accept": "text/html"})
                self.assertEqual(status, 401)
                self.assertNotIn(b"ocvm-vm-launcher", unauthorized)

                for suffix in ("/no-csp", "/csp-elem", "/csp-strict", "/meta-csp", "/compressed", "/chunked", "/no-length", "/not-spa-shell"):
                    status, response_headers, response_body = http_request(base, PROJECT_PATH + suffix, headers=auth)
                    self.assertEqual(status, 200)
                    self.assertNotIn(b"ocvm-vm-launcher", response_body)
                    if suffix == "/compressed":
                        self.assertEqual(gzip.decompress(response_body), HTML)
                        self.assertEqual(response_headers["Content-Encoding"], "gzip")

                for path, expected_type in (("/__ocvm/launcher.js", "application/javascript; charset=utf-8"),
                                            ("/__ocvm/launcher.css", "text/css; charset=utf-8")):
                    status, asset_headers, asset_body = http_request(base, path)
                    self.assertEqual(status, 200)
                    self.assertEqual(asset_headers["Content-Type"], expected_type)
                    self.assertEqual(asset_headers["X-Content-Type-Options"], "nosniff")
                    self.assertTrue(asset_body)
                self.assertFalse(any(path.startswith("/__ocvm/") for _, path, _ in backend.seen))

                status, headers, api_body = http_request(
                    base, "/doc", headers={"Accept": "text/html", "Sec-Fetch-Mode": "cors", "Connection": "keep-alive"})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(api_body), {"openapi": "test"})
                self.assertNotIn("ocvm-vm-launcher", api_body.decode())
                api_request = next(request_headers for _, path, request_headers in backend.seen if path == "/doc")
                self.assertEqual(api_request[b"connection"], b"close")
                status, response_headers, keepalive_body = http_request(
                    base, "/keepalive", headers={"Sec-Fetch-Mode": "no-cors", "Accept": "image/*"})
                self.assertEqual(status, 200)
                self.assertEqual(keepalive_body, b"alive")
                self.assertEqual(response_headers["Connection"], "close")
                status, _, other_body = http_request(base, "/new-session-extra", headers=auth)
                self.assertEqual(status, 200)
                self.assertNotIn(b"ocvm-vm-launcher", other_body)
                status, _, upload_body = http_request(base, "/upload", method="POST", body=b"file-bytes",
                                                        headers={"Content-Type": "application/octet-stream", "Sec-Fetch-Mode": "cors"})
                self.assertEqual(status, 200)
                self.assertEqual(upload_body, b"file-bytes")

                with socket.create_connection(("127.0.0.1", base), timeout=2) as websocket:
                    websocket.sendall((f"GET /ws HTTP/1.1\r\nHost: localhost:{base}\r\nUpgrade: websocket\r\n"
                                       "Connection: Upgrade\r\nSec-Fetch-Mode: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                                       "Sec-WebSocket-Version: 13\r\n\r\n").encode())
                    response = b""
                    while b"\r\n\r\n" not in response:
                        response += websocket.recv(4096)
                    self.assertTrue(response.startswith(b"HTTP/1.1 101"))
                    websocket.sendall(b"PING")
                    self.assertEqual(websocket.recv(4), b"PING")
                ws_request = next(request_headers for _, path, request_headers in backend.seen if path == "/ws")
                self.assertEqual(ws_request[b"connection"], b"Upgrade")

                health.shutdown()
                health.server_close()
                health_thread.join(timeout=2)
                status, _, unavailable = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                markup = LauncherMarkup()
                markup.feed(unavailable.decode("utf-8"))
                self.assertEqual([app["id"] for app in json.loads(markup.mount["data-apps"])], ["taskboard"])
                board.shutdown()
                board.server_close()
                board_thread.join(timeout=2)
                status, _, stopped_board = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                markup = LauncherMarkup()
                markup.feed(stopped_board.decode("utf-8"))
                self.assertEqual(json.loads(markup.mount["data-apps"]), [])

                proxy.terminate()
                proxy.wait(timeout=4)
                proxy = subprocess.Popen([
                    sys.executable, str(proxy_file), str(base), str(backend.server_address[1]), key,
                    "", "", "0", "", "", "ocvm-web-test", str(share), project_hash, "0", "<Test & Spaß>",
                ], stdout=subprocess.DEVNULL, stderr=proxy_log)
                deadline = time.monotonic() + 4
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", base), timeout=.1):
                            break
                    except OSError:
                        if proxy.poll() is not None or time.monotonic() > deadline:
                            self.fail("opt-out proxy did not start")
                        time.sleep(.02)
                status, _, seed = http_request(base, "/", headers={"Accept": "text/html"})
                self.assertEqual(status, 200)
                self.assertIn(b'location.replace("/" + key)', seed)
                self.assertIn("<title>&lt;Test &amp; Spaß&gt;</title>".encode(), seed)
                status, _, plain = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                self.assertIn("<title>&lt;Test &amp; Spaß&gt;</title>".encode(), plain)
                self.assertNotIn(b"ocvm-vm-launcher", plain)
                self.assertIn(b"<link rel=icon href=/favicon-v3.svg>", plain)
                status, _, direct_session = http_request(base, PROJECT_PATH + "/deep/session", headers=auth)
                self.assertEqual(status, 200)
                self.assertIn("<title>&lt;Test &amp; Spaß&gt;</title>".encode(), direct_session)
                status, _, new_session = http_request(base, "/new-session?draftId=reload", headers=auth)
                self.assertEqual(status, 200)
                self.assertIn("<title>&lt;Test &amp; Spaß&gt;</title>".encode(), new_session)
                status, _, strict_title = http_request(base, PROJECT_PATH + "/no-csp", headers=auth)
                self.assertEqual(status, 200)
                self.assertIn("<title>&lt;Test &amp; Spaß&gt;</title>".encode(), strict_title)
                self.assertNotIn(b"ocvm-vm-launcher", strict_title)
                status, _, no_asset = http_request(base, "/__ocvm/launcher.js")
                self.assertEqual(status, 200)
                self.assertNotIn(b"ocvm-vm-launcher", no_asset)
                status, _, still_api = http_request(base, "/doc", headers={"Accept": "application/json"})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(still_api), {"openapi": "test"})

                proxy.terminate()
                proxy.wait(timeout=4)
                proxy = subprocess.Popen([
                    sys.executable, str(proxy_file), str(base), str(backend.server_address[1]), key,
                    "", "", "0", "", "", "ocvm-web-test", str(share), project_hash, "0",
                ], stdout=subprocess.DEVNULL, stderr=proxy_log)
                deadline = time.monotonic() + 4
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", base), timeout=.1):
                            break
                    except OSError:
                        if proxy.poll() is not None or time.monotonic() > deadline:
                            self.fail("no-project-name proxy did not start")
                        time.sleep(.02)
                status, _, fallback_seed = http_request(base, "/", headers={"Accept": "text/html"})
                self.assertEqual(status, 200)
                self.assertIn(b"<title>OpenCode</title>", fallback_seed)
                status, _, fallback = http_request(base, PROJECT_PATH, headers=auth)
                self.assertEqual(status, 200)
                self.assertEqual(fallback, HTML)
            finally:
                if other_proxy is not None:
                    other_proxy.terminate()
                    other_proxy.wait(timeout=4)
                proxy.terminate()
                proxy.wait(timeout=4)
                proxy_log.close()
                health.shutdown()
                health.server_close()
                board.shutdown()
                board.server_close()
                backend.shutdown()
                backend.server_close()
                health_thread.join(timeout=2)
                board_thread.join(timeout=2)
                backend_thread.join(timeout=2)

    @unittest.skipUnless(os.environ.get("OCVM_LAUNCHER_OPENCODE_INTEGRATION"), "real OpenCode/proxy opt-in")
    def test_real_opencode_document_is_enhanced_without_replacing_the_ui(self):
        binary = shutil.which("opencode")
        self.assertIsNotNone(binary, "OpenCode binary is required for this opt-in test")
        with tempfile.TemporaryDirectory(prefix="ocvm-launcher-opencode-") as temporary:
            root = Path(temporary)
            project = root / "project"
            project.mkdir()
            home = root / "home"
            home.mkdir()
            for name in ("config", "data", "state"):
                (root / name).mkdir()
            env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(root / "config"),
                       XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "state"))
            web_base = free_port_block(2)
            backend_port = web_base
            proxy_port = web_base + 1
            key = base64.urlsafe_b64encode(str(project.resolve()).encode()).decode().rstrip("=")
            proxy_source = root / "proxy.py"
            proxy_source.write_text(PYTHON_PROXY)
            log = (root / "opencode.log").open("wb")
            opencode = subprocess.Popen([binary, "web", "--hostname", "127.0.0.1", "--port", str(backend_port)],
                                        cwd=project, env=env, stdout=log, stderr=log)
            proxy = None
            try:
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if opencode.poll() is not None:
                        log.flush()
                        self.fail("OpenCode failed to start: " + (root / "opencode.log").read_text(errors="replace"))
                    try:
                        with socket.create_connection(("127.0.0.1", backend_port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.1)
                else:
                    self.fail("OpenCode readiness timed out")

                # Wait for the UI endpoint, not just the TCP listener: OpenCode
                # binds before the bundled/remote web UI has finished starting.
                deadline = time.monotonic() + 45
                while True:
                    try:
                        root_status, _, _ = http_request(backend_port, "/", headers={"Accept": "text/html"}, timeout=5)
                        if root_status == 200:
                            break
                    except (OSError, http.client.HTTPException):
                        pass
                    if opencode.poll() is not None or time.monotonic() > deadline:
                        log.flush()
                        self.fail("OpenCode UI did not become ready: " + (root / "opencode.log").read_text(errors="replace"))
                    time.sleep(.2)

                proxy = subprocess.Popen([
                    sys.executable, str(proxy_source), str(proxy_port), str(backend_port), key,
                    "", "", "0", "", "", "ocvm-real-opencode-test", "", "", "1", project.name,
                ], stdout=subprocess.DEVNULL, stderr=log)
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", proxy_port), timeout=.1):
                            break
                    except OSError:
                        if proxy.poll() is not None:
                            self.fail("proxy failed to start")
                        time.sleep(.025)
                else:
                    self.fail("proxy readiness timed out")

                direct_status, direct_headers, direct_body = http_request(
                    backend_port, "/" + key, headers={"Accept": "text/html", "Accept-Encoding": "identity"}, timeout=20)
                self.assertEqual(direct_status, 200)
                self.assertIn("text/html", direct_headers.get("Content-Type", ""))
                proxied_status, proxied_headers, proxied_body = http_request(
                    proxy_port, "/" + key, headers={"Accept": "text/html", "Accept-Encoding": "gzip, deflate, br"}, timeout=20)
                self.assertEqual(proxied_status, direct_status)
                self.assertEqual(proxied_headers.get("Content-Security-Policy"), direct_headers.get("Content-Security-Policy"))
                self.assertRegex(direct_body.lower(), rb"<script\b[^>]*\bsrc\s*=")
                self.assertIn(b"id=\"ocvm-vm-launcher\"", proxied_body)
                self.assertIn(b"/__ocvm/launcher.js", proxied_body)
                self.assertIn(b"/__ocvm/launcher.css", proxied_body)
                self.assertIn(b"<title>project</title>", proxied_body)
                self.assertIn(b"<title>OpenCode</title>", direct_body)
                for favicon in (b"/favicon-96x96-v3.png", b"/favicon-v3.svg", b"/favicon-v3.ico"):
                    self.assertEqual(direct_body.count(favicon), proxied_body.count(favicon))
                self.assertEqual(int(proxied_headers["Content-Length"]), len(proxied_body))
                new_status, _, new_body = http_request(
                    proxy_port, "/new-session?draftId=check", headers={"Accept": "text/html"}, timeout=20)
                self.assertEqual(new_status, 200)
                self.assertIn(b'id="ocvm-vm-launcher"', new_body)
                self.assertIn(b"<title>project</title>", new_body)
                api_status, api_headers, api_body = http_request(
                    proxy_port, "/doc", headers={"Accept": "application/json", "Sec-Fetch-Mode": "cors"})
                self.assertEqual(api_status, 200)
                self.assertEqual(api_headers["Connection"], "close")
                self.assertNotIn(b"ocvm-vm-launcher", api_body)
            finally:
                if proxy is not None:
                    proxy.terminate()
                    proxy.wait(timeout=4)
                opencode.terminate()
                try:
                    opencode.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    opencode.kill()
                    opencode.wait(timeout=4)
                log.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve-browser"]:
        serve_browser_fixture()
    elif sys.argv[1:] == ["--serve-real-browser"]:
        serve_real_browser_fixture()
    elif sys.argv[1:] == ["--serve-real-browser-no-launcher"]:
        serve_real_browser_fixture("0")
    elif sys.argv[1:] == ["--serve-real-browser-tls"]:
        serve_real_browser_fixture(tls=True)
    else:
        unittest.main()
