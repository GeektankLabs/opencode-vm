#!/usr/bin/env python3
"""Exercise the embedded editor payload and host port allocation without Lima.

OCVM_EDITOR_INTEGRATION=1 additionally runs the real pinned server/systemd unit.
OCVM_EDITOR_KEEP=1 retains that fixture for manual browser acceptance.
"""
import json
import http.client
import os
from pathlib import Path
import re
import subprocess
import ssl
import socket
import tempfile
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()


def function(name):
    return re.search(r"^" + re.escape(name) + r"\(\) \{\n.*?^\}", SCRIPT, re.M | re.S).group()


def payload(name, marker):
    return SCRIPT.split(f"read -r -d '' {name} <<'{marker}' || true\n", 1)[1].split(f"\n{marker}\n", 1)[0]


def shell(code, *args, check=True):
    result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + code, "test", *map(str, args)],
                            text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(f"Shell exited {result.returncode}:\n{result.stdout}\n{result.stderr}")
    return result


def stage(directory):
    # Materialize exactly the production payload, including the managed extension.
    variables = []
    for name, marker in [("OCVM_WEB_LIB_SH", "WEBLIB"), ("OCVM_WEB_REDIRECT_PY", "PYSRC"),
                         ("OCVM_EDITOR_INSTALL_SH", "EDITOR_INSTALL"), ("OCVM_EDITOR_EXTENSION_JS", "EDITOR_JS")]:
        variables.append(f"read -r -d '' {name} <<'PAYLOAD' || true\n{payload(name, marker)}\nPAYLOAD")
    shell("\n".join(variables) + "\n" + function("install_web_lib") + '\ninstall_web_lib "$1"', directory)


class EditorTest(unittest.TestCase):
    def test_flags_and_tracking(self):
        code = "DEFAULT_OC_PORT=4096\n" + function("parse_web_flags") + "\n" + function("web_editor_enabled")
        code += '\nparse_web_flags --editor --no-auth\n[ "$SESSION_EDITOR_MODE" = enable ]\n'
        code += 'parse_web_flags --no-editor\n[ "$SESSION_EDITOR_MODE" = disable ]\n'
        code += 'parse_web_flags\n[ -z "$SESSION_EDITOR_MODE" ]\n'
        code += '[ "$(web_editor_enabled web)" = 1 ]\n[ "$(web_editor_enabled web 1)" = 0 ]\n[ "$(web_editor_enabled tui)" = 0 ]\n'
        shell(code)
        self.assertEqual(shell(code + "parse_web_flags --editor --no-editor", check=False).returncode, 2)
        with tempfile.TemporaryDirectory() as tmp:
            shell(function("write_senv") + '\nwrite_senv "$1/state" vm /project hash web 4096 0 1 generation controller 1 40960 0 1\n'
                  '. "$1/state"\n[ "$SESS_EDITOR_ENABLED" = 0 ]\n[ "$SESS_EDITOR_DISABLED" = 1 ]\n'
                  'write_senv "$1/state" vm /project hash tui 4096 0\n'
                   '. "$1/state"\n[ "$SESS_EDITOR_ENABLED" = 0 ]\n[ "$SESS_EDITOR_DISABLED" = 0 ]', tmp)

    def test_launcher_defaults_on_for_web_and_attach_with_invocation_opt_out(self):
        code = 'DEFAULT_OC_PORT=4096\n' + function('parse_web_flags') + '\n' + function('parse_attach_flags')
        shell(code + '\nparse_web_flags\n[ "$SESSION_LAUNCHER_ENABLED" = 1 ]\n'
              'parse_web_flags --no-launcher --editor\n[ "$SESSION_LAUNCHER_ENABLED" = 0 ]\n'
              'parse_web_flags --launcher\n[ "$SESSION_LAUNCHER_ENABLED" = 1 ]\n'
              'parse_attach_flags --no-launcher\n[ "$SESSION_LAUNCHER_ENABLED" = 0 ]\n'
              'parse_attach_flags\n[ "$SESSION_LAUNCHER_ENABLED" = 1 ]\n'
              'parse_attach_flags --launcher\n[ "$SESSION_LAUNCHER_ENABLED" = 1 ]')
        self.assertEqual(shell(code + '\nparse_attach_flags --unknown', check=False).returncode, 2)
        self.assertEqual(SCRIPT.count('OC_LAUNCHER_ENABLED="${19:-1}"'), 2)
        self.assertEqual(SCRIPT.count('"${SESSION_LAUNCHER_ENABLED:-1}" "$(project_state_dir'), 1)
        self.assertEqual(SCRIPT.count('"${SESSION_LAUNCHER_ENABLED:-1}" "$proj_state/taskboard/taskboard.db" "$(test -f'), 1)

        with tempfile.TemporaryDirectory() as tmp:
            stage(Path(tmp) / 'share')
            web_code = function('start_web_proxies') + '''
load_session_auth() { :; }
_stop_legacy_redirector() { :; }
ensure_web_tls() { OC_TLS_CERT=""; OC_TLS_KEY=""; }
start_proxy() { printf '%s:%s:%s\\n' "$1" "${12:-unset}" "${13:-unset}" >> "$TEST_OUTPUT"; }
SESS_SHARE="$1/share"
PROJ_DIR="$1/bi-mcrepo"
OC_PROXY_PY="$1/running-proxy.py"
OC_PORT=4096
OC_DIR_KEY=project
OC_A2A=0
OC_OPENLIVE_REMOTE_TARGET=0
OC_OPENLIVE_PROJECT_HASH=project-hash
OC_OPENLIVE_REMOTE_GENERATION=""
TEST_OUTPUT="$1/forwarded"
OC_LAUNCHER_ENABLED=0
start_web_proxies
OC_LAUNCHER_ENABLED=1
start_web_proxies
'''
            shell(web_code, tmp)
            self.assertEqual((Path(tmp) / 'forwarded').read_text().splitlines(),
                             ['web-tls:0:bi-mcrepo', 'web-plain:0:bi-mcrepo',
                              'web-tls:1:bi-mcrepo', 'web-plain:1:bi-mcrepo'])

    def test_attach_upgrades_old_default_but_retains_explicit_opt_out(self):
        choice = '  local sess_editor_disabled=' + SCRIPT.split('  local sess_editor_disabled=', 1)[1].split('  local prior_mcp_enabled=', 1)[0]
        code = function("web_editor_enabled") + '\nresolve_editor() {\n' + choice + '\nprintf "%s %s\\n" "$sess_editor_enabled" "$sess_editor_disabled"\n}\n'
        # Legacy web sessions wrote SESS_EDITOR_ENABLED=0, which is not an opt-out.
        code += 'sess_mode=web SESS_EDITOR_ENABLED=0 SESSION_EDITOR_MODE=""\n'
        self.assertEqual(shell(code + 'unset SESS_EDITOR_DISABLED\nresolve_editor').stdout.strip(), '1 0')
        self.assertEqual(shell(code + 'SESS_EDITOR_DISABLED=1\nresolve_editor').stdout.strip(), '0 1')
        self.assertEqual(shell(code + 'SESS_EDITOR_DISABLED=1 SESSION_EDITOR_MODE=enable\nresolve_editor').stdout.strip(), '1 0')
        self.assertEqual(shell(code + 'SESS_EDITOR_DISABLED=0 SESSION_EDITOR_MODE=disable\nresolve_editor').stdout.strip(), '0 1')
        self.assertEqual(shell(code + 'sess_mode=tui SESSION_EDITOR_MODE=enable\nresolve_editor').stdout.strip(), '0 0')

    def test_default_public_port_block_includes_editor(self):
        code = 'BROWSER_UNSAFE_PORTS=(6000)\nis_valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 )); }\n'
        code += function('is_browser_unsafe_port') + '\n' + function('validate_web_port') + '\n'
        shell(code + 'SESSION_EDITOR_MODE=""\nvalidate_web_port 65530')
        self.assertEqual(shell(code + 'SESSION_EDITOR_MODE=""\nvalidate_web_port 65531', check=False).returncode, 2)
        self.assertEqual(shell(code + 'SESSION_EDITOR_MODE=""\nvalidate_web_port 5996', check=False).returncode, 2)
        shell(code + 'SESSION_EDITOR_MODE=disable\nvalidate_web_port 65530\nvalidate_web_port 5994')

    def test_port_boundaries_and_private_mcp_overlap(self):
        code = 'BROWSER_UNSAFE_PORTS=(6000)\n' + function("is_browser_unsafe_port") + "\n" + function("select_web_guest_base")
        self.assertEqual(shell(code + "\nselect_web_guest_base 4096 4100 1").stdout.strip(), "4103")
        self.assertEqual(shell(code + "\nselect_web_guest_base 4096 4100 0").stdout.strip(), "4103")
        self.assertEqual(shell(code + "\nselect_web_guest_base 5996 '' 1").stdout.strip(), "6001")
        self.assertNotEqual(shell(code + "\nselect_web_guest_base 65532 '' 1", check=False).returncode, 0)
        self.assertEqual(shell(code + "\nselect_web_guest_base 65530 '' 1").stdout.strip(), "65530")

    def test_host_collision_moves_entire_five_port_block(self):
        code = '\n'.join(function(name) for name in ["start_web_tunnels", "is_browser_unsafe_port"])
        code += r'''
BROWSER_UNSAFE_PORTS=()
load_policy() { :; }
lima_guest_user() { printf guest; }
limactl() { printf 2222; }
stop_web_tunnels() { :; }
editor_guest_port_available() { [ "$2" != 4105 ]; }
_port_free_for_bind() { [ "$1" != 4100 ]; }
pgrep() { printf 12345; }
ssh() {
  case " $* " in
    *" -f -N "*) printf '%s\n' "$@" > "$TEST_DIR/forward" ;;
  esac
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            result = shell(code + '\nTEST_DIR="$1"\nstart_web_tunnels oc-editor-test 4096 "" 1\nprintf "BASE=%s\\n" "$WEB_PORT_BASE"', tmp)
            self.assertIn("BASE=4102", result.stdout)
            forwards = (Path(tmp) / "forward").read_text()
            for port in range(4102, 4108):
                self.assertIn(f"0.0.0.0:{port}:127.0.0.1:{port}", forwards)
            self.assertNotIn("0.0.0.0:4100:", forwards)
            Path("/tmp/ocvm-tunnel-oc-editor-test-4102.pid").unlink(missing_ok=True)

    def test_editor_guest_port_collision_moves_entire_block(self):
        code = '\n'.join(function(name) for name in ["start_web_tunnels", "is_browser_unsafe_port"])
        code += r'''
BROWSER_UNSAFE_PORTS=()
load_policy() { :; }
lima_guest_user() { printf guest; }
limactl() { printf 2222; }
stop_web_tunnels() { :; }
_port_free_for_bind() { return 0; }
editor_guest_port_available() { [ "$2" != 4100 ]; }
pgrep() { printf 12345; }
ssh() { case " $* " in *" -f -N "*) printf '%s\n' "$@" > "$TEST_DIR/forward" ;; esac; }
'''
        with tempfile.TemporaryDirectory() as tmp:
            result = shell(code + '\nTEST_DIR="$1"\nstart_web_tunnels oc-editor-guest-test 4096 "" 1\nprintf "BASE=%s\\n" "$WEB_PORT_BASE"', tmp)
            self.assertIn("BASE=4097", result.stdout)
            forwards = (Path(tmp) / "forward").read_text()
            for port in range(4097, 4103):
                self.assertIn(f"0.0.0.0:{port}:127.0.0.1:{port}", forwards)
            self.assertNotIn("0.0.0.0:4096:", forwards)
            Path("/tmp/ocvm-tunnel-oc-editor-guest-test-4097.pid").unlink(missing_ok=True)

    def test_guest_probe_detects_an_existing_listener(self):
        code = 'vm_exec() { bash -c "$2" _ "${@:3}"; }\n' + function("editor_guest_port_available")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertNotEqual(shell(code + '\neditor_guest_port_available test "$1"', port, check=False).returncode, 0)
        shell(code + '\neditor_guest_port_available test "$1"', port)

    def test_payload_syntax_and_preferences(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage(root / "share")
            subprocess.run(["bash", "-n", str(root / "share/lib/web.sh")], check=True)
            subprocess.run(["shellcheck", "-s", "bash", "--severity=error", str(root / "share/lib/web.sh"), str(root / "share/lib/editor-install.sh")], check=True)
            extension = root / "share/editor/extensions/ocvm.project-tools-0.1.0"
            subprocess.run(["node", "--check", str(extension / "extension.js")], check=True)
            installer = root / "taskboard-install.sh"
            installer.write_text(payload("OCVM_TASKBOARD_INSTALL_SH", "TASKBOARD_INSTALL"))
            subprocess.run(["bash", "-n", str(installer)], check=True)
            self.assertEqual(json.loads((extension / "package.json").read_text())["extensionKind"], ["workspace"])
            user = root / "share/editor/user-data/User"
            user.mkdir(parents=True)
            (user / "settings.json").write_text('{"files.autoSave":"afterDelay"}')
            shell(function("editor_sync_preferences") + '\neditor_sync_preferences "$1/share" "$1/state"\neditor_sync_preferences "$1/state" "$1/new"', root)
            self.assertEqual((root / "new/editor/user-data/User/settings.json").read_text(), (user / "settings.json").read_text())
            self.assertFalse((root / "new/editor/config.yaml").exists())

    def test_launcher_catalog_registers_taskboard_on_its_runtime_port(self):
        redirector = payload("OCVM_WEB_REDIRECT_PY", "PYSRC")
        launcher = SCRIPT.split('LAUNCHER_JS = r"""\n', 1)[1].split('\n"""\n\nLAUNCHER_CSS', 1)[0]
        registry = SCRIPT.split("LAUNCHER_APP_REGISTRY = (", 1)[1].split("\n)", 1)[0]
        self.assertEqual(registry.count('"id":'), 2)
        self.assertIn('"id": "editor"', registry)
        self.assertIn('"port_offset": 4', registry)
        self.assertIn('"id": "taskboard"', registry)
        self.assertIn('"label": "Projektmanagement"', registry)
        self.assertIn('"runtime_file": "taskboard/runtime.json"', registry)
        self.assertIn('"port_offset": 5', registry)
        self.assertIn('for app in LAUNCHER_APP_REGISTRY', redirector)
        self.assertIn('"board"', launcher)
        self.assertIn('link.target = "_blank"', launcher)
        self.assertIn('app.icon', launcher)

    def test_taskboard_runtime_descriptor_tracks_service_lifecycle(self):
        code = "\n".join(function(name) for name in
                           ("taskboard_runtime_dir", "taskboard_failure", "taskboard_prepare_runtime",
                            "stop_taskboard", "start_taskboard")) + '\n'
        code += '''taskboard_state_guard() { :; }
OC_TASKBOARD_LOG_WRITER_PY=fixture
systemctl() {
  if [ "$1" = is-active ]; then return 0; fi
  printf '%s\\n' not-found
}
sudo() { return 0; }
curl() { return 0; }
ss() { return 0; }
SESS_SHARE="$1/share"
PROJ_DIR="$1"
OCVM_TASKBOARD_RUNTIME_DIR="$1/.opencode-vm/taskboard"
OC_TASKBOARD_DB="$1/data/taskboard.db"
OC_TASKBOARD_BIN=/bin/true
OC_OPENLIVE_PROJECT_HASH=project-hash
OC_TASKBOARD_ENABLED=1
OC_PORT=4096
mkdir -p "$SESS_SHARE"
start_taskboard
[ "$OC_TASKBOARD_READY" = 1 ]
[ -f "$OCVM_TASKBOARD_RUNTIME_DIR/runtime.json" ]
stop_taskboard
[ ! -f "$OCVM_TASKBOARD_RUNTIME_DIR/runtime.json" ]
start_taskboard
'''
        with tempfile.TemporaryDirectory() as tmp:
            shell(code, tmp)
            descriptor = Path(tmp) / '.opencode-vm/taskboard/runtime.json'
            self.assertEqual(json.loads(descriptor.read_text()),
                             {'schema': 1, 'projectHash': 'project-hash',
                              'runtimeDir': str(Path(tmp) / '.opencode-vm/taskboard'),
                              'log': str(Path(tmp) / '.opencode-vm/taskboard/taskboard.log'),
                              'taskboardPort': 4101})
            self.assertFalse((Path(tmp) / 'share/taskboard.log').exists())
            self.assertTrue((Path(tmp) / '.opencode-vm/taskboard/taskboard.log').exists())
            self.assertEqual(descriptor.stat().st_mode & 0o777, 0o600)
            self.assertEqual(descriptor.parent.stat().st_mode & 0o777, 0o700)

    def test_taskboard_runtime_is_project_local_and_editor_exposes_the_path(self):
        self.assertIn('OCVM_TASKBOARD_RUNTIME_DIR="$PROJ_DIR/.opencode-vm/taskboard"', SCRIPT)
        self.assertIn('--setenv="OCVM_TASKBOARD_RUNTIME_DIR=${OCVM_TASKBOARD_RUNTIME_DIR:-}"', SCRIPT)
        self.assertIn("'{schema:1,projectHash:$hash,runtimeDir:$dir,log:$log,taskboardPort:$port}'", SCRIPT)
        self.assertNotIn('StandardOutput=append:$SESS_SHARE/taskboard.log', SCRIPT)

    def test_taskboard_failed_start_publishes_vm_local_diagnostic(self):
        code = "\n".join(function(name) for name in
                           ("taskboard_runtime_dir", "taskboard_failure", "taskboard_prepare_runtime",
                            "stop_taskboard", "start_taskboard"))
        code += '''
taskboard_state_guard() { :; }
OC_TASKBOARD_LOG_WRITER_PY=fixture
systemctl() { printf '%s\n' not-found; }
SESS_SHARE="$1/share"
PROJ_DIR="$1"
OCVM_TASKBOARD_RUNTIME_DIR="$1/.opencode-vm/taskboard"
OC_TASKBOARD_ENABLED=1
OC_TASKBOARD_BIN="$1/missing-taskboard"
OC_PORT=4096
OC_OPENLIVE_PROJECT_HASH=project-hash
start_taskboard || true
[ -f "$OCVM_TASKBOARD_RUNTIME_DIR/failure.json" ]
[ ! -f "$OCVM_TASKBOARD_RUNTIME_DIR/runtime.json" ]
[ -f "$OCVM_TASKBOARD_RUNTIME_DIR/taskboard.log" ]
[ ! -e "$SESS_SHARE/taskboard.log" ]
'''
        shell(code, tempfile.mkdtemp())

    def test_dark_theme_default_preserves_personal_choice(self):
        config = SCRIPT.split("<<'EDITOR_CONFIG'\n", 1)[1].split('\nEDITOR_CONFIG', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "editor"
            user = root / "user-data/User"
            user.mkdir(parents=True)
            settings = user / "settings.json"

            def configure():
                subprocess.run(["python3", "-c", config, str(root), str(root.parent), str(root.parent),
                                "4100", "/tmp/cert", "/tmp/key", "4095", "0", "0", "hash"], check=True)

            configure()
            profile = json.loads(settings.read_text())
            self.assertEqual(profile["workbench.colorTheme"], "Dark Modern")
            profile.pop("workbench.colorTheme")  # pre-change generated profile
            profile["editor.fontSize"] = 17
            settings.write_text(json.dumps(profile))
            configure()
            profile = json.loads(settings.read_text())
            self.assertEqual(profile["workbench.colorTheme"], "Dark Modern")
            self.assertEqual(profile["editor.fontSize"], 17)
            profile["workbench.colorTheme"] = "Light Modern"
            settings.write_text(json.dumps(profile))
            configure()
            self.assertEqual(json.loads(settings.read_text())["workbench.colorTheme"], "Light Modern")

    def test_stop_rejects_foreign_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage(Path(tmp) / "share")
            code = 'OC_PORT=4096; SESS_SHARE="$1/share"\n. "$SESS_SHARE/lib/web.sh"\n'
            code += 'sudo() { exit 99; }\nsystemctl() { case "$*" in *LoadState*) printf loaded ;; *) printf foreign ;; esac; }\nstop_editor'
            result = shell(code, tmp, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("another runtime", result.stderr)

    def test_banner_uses_effective_port_and_only_advertises_ready_editor(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage(Path(tmp) / "share")
            code = '''
OC_PORT=4300; OC_HOST_IP=192.0.2.1; SESS_SHARE="$1/share"; OC_TLS=0
. "$SESS_SHARE/lib/web.sh"
OC_A2A=0; OC_DIR_KEY=test; OC_EDITOR_ENABLED=1; OC_EDITOR_READY=1; OC_PASSWORD=test-password
print_web_banner
'''
            output = shell(code, tmp).stdout
            self.assertIn("https://192.0.2.1:4304", output)
            self.assertNotIn("test-password", output)
            output = shell(code + "OC_LAN_UP=0\nprint_web_banner", tmp).stdout
            self.assertIn("https://127.0.0.1:4304", output)
            output = shell(code.replace("OC_EDITOR_READY=1", "OC_EDITOR_READY=0"), tmp).stdout
            self.assertNotIn("https://192.0.2.1:4304", output)
            self.assertIn("unavailable", output)

    def test_managed_extension_rejects_symlink_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage(root / "share")
            victim = root / "keep.js"
            victim.write_text("user file")
            managed = root / "share/editor/extensions/ocvm.project-tools-0.1.0/extension.js"
            managed.unlink()
            managed.symlink_to(victim)
            with self.assertRaisesRegex(AssertionError, "symlinked"):
                stage(root / "share")
            self.assertEqual(victim.read_text(), "user file")

    @unittest.skipUnless(os.environ.get("OCVM_EDITOR_INTEGRATION"), "real code-server/systemd opt-in")
    def test_real_editor(self):
        self.assertEqual(subprocess.check_output(["systemctl", "show", "ocvm-editor.service", "-p", "LoadState", "--value"], text=True).strip(), "not-found")
        root = Path(tempfile.mkdtemp(prefix="editor-", dir="/tmp/opencode"))
        stage(root / "share")
        project = root / "project with spaces"
        project.mkdir()
        (project / "README.md").write_text("# Editor acceptance\n\nA shared project file.\n")
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(project), "-c", "user.name=Editor Test", "-c", "user.email=editor@example.test", "commit", "-qm", "Initial fixture"], check=True)
        code = '''
SESS_SHARE="$1/share"; PROJ_DIR="$1/project with spaces"
OC_PORT=18496; OC_HOST_IP=192.168.16.152; OC_TLS=1
OC_EDITOR_ENABLED=1; OC_MCP_ENABLED=0; OC_MCP_PORT=40960; OC_OPENLIVE_PROJECT_HASH=test
. "$SESS_SHARE/lib/web.sh"
'''
        try:
            shell(payload("OCVM_EDITOR_INSTALL_SH", "EDITOR_INSTALL") + "\ninstall_editor")
            result = shell(code + "start_editor", root)
            print(result.stdout)
            self.assertIn("Ready on HTTPS port 18500", result.stdout)
            profile = root / "share/editor/user-data/User/settings.json"
            settings = json.loads(profile.read_text())
            self.assertTrue(settings["chat.disableAIFeatures"])
            self.assertEqual(settings["workbench.colorTheme"], "Dark Modern")
            self.assertFalse(settings["git.autofetch"])
            self.assertEqual(settings["files.autoSave"], "off")
            settings["editor.fontSize"] = 17
            del settings["workbench.colorTheme"]  # older profile, no explicit theme
            profile.write_text(json.dumps(settings))
            shell(code + "stop_editor\nstart_editor", root)
            self.assertEqual(json.loads(profile.read_text())["editor.fontSize"], 17)
            self.assertEqual(json.loads(profile.read_text())["workbench.colorTheme"], "Dark Modern")
            settings = json.loads(profile.read_text())
            settings["workbench.colorTheme"] = "Light Modern"
            profile.write_text(json.dumps(settings))
            # Password lives only in private config, and --no-tls for the web
            # listener must not downgrade the editor's HTTPS endpoint.
            auth = root / "share/auth.env"
            auth.write_text("OPENCODE_SERVER_PASSWORD='editor-fixture-password'\nOPENCODE_SERVER_USERNAME=opencode\n")
            auth.chmod(0o600)
            result = shell(code + "OC_TLS=0\nstop_editor\nstart_editor", root)
            self.assertNotIn("editor-fixture-password", result.stdout + result.stderr)
            self.assertEqual(json.loads(profile.read_text())["workbench.colorTheme"], "Light Modern")
            connection = http.client.HTTPSConnection("127.0.0.1", 18500, context=ssl._create_unverified_context())
            connection.request("GET", "/")
            response = connection.getresponse()
            self.assertEqual(response.status, 302)
            self.assertIn("login", response.getheader("Location"))
            response.read()
            connection.request("POST", "/login", urllib.parse.urlencode({"password": "editor-fixture-password"}), {"Content-Type": "application/x-www-form-urlencoded"})
            response = connection.getresponse()
            self.assertEqual(response.status, 302)
            self.assertIn("code-server-session", response.getheader("Set-Cookie"))
            response.read()
            connection.close()
            self.assertEqual((root / "share/editor/config.yaml").stat().st_mode & 0o777, 0o600)
            auth.unlink()
            shell(code + "stop_editor\nstart_editor", root)
            if os.environ.get("OCVM_EDITOR_KEEP"):
                print(f"Browser fixture retained: {root}\nhttps://127.0.0.1:18500")
        finally:
            if not os.environ.get("OCVM_EDITOR_KEEP"):
                shell(code + "stop_editor", root)
                import shutil
                shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
