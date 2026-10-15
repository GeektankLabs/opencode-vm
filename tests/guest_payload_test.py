"""Real start/attach -> real vm_exec -> transport capture (no guest execution)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GuestPayloadTest(unittest.TestCase):
    def test_real_transport_payloads(self):
        for entry in ("attach", "fresh"):
            for mode in ("tui", "web", "tui-mcp"):
                with self.subTest(entry=entry, mode=mode), tempfile.TemporaryDirectory(prefix="ocvm-payload-") as tmp:
                    home = Path(tmp)
                    project = home / "project with spaces ä"
                    project.mkdir()
                    (home / ".opencode-vm").mkdir()
                    (home / ".lima/oc-base").mkdir(parents=True)
                    (home / ".lima/oc-base/lima.yaml").write_text('portForwards:\n- guestIPMustBeZero: true\n')
                    (home / "share/xdg-data/opencode").mkdir(parents=True)
                    (home / "state/config/opencode").mkdir(parents=True)
                    (home / "config.json").write_text('{}')
                    if entry == "attach":
                        (home / "session.env").write_text(f'SESS_NAME="stub-vm"\nSESS_MODE="{mode}"\nSESS_EDITOR_DISABLED=1\n')
                    result = subprocess.run(["bash", str(ROOT / "tests/helpers/guest_payload_capture.sh")],
                        cwd=project, capture_output=True, text=True, timeout=30,
                        env={**os.environ, "HOME": tmp, "TMPDIR": tmp, "SOURCE": str(ROOT),
                             "TEST_ENTRY": entry, "TEST_MODE": mode})
                    payload = home / "final-payload.sh"
                    self.assertTrue(payload.exists(), result.stdout + result.stderr)
                    check = subprocess.run(["bash", "-n", str(payload)], capture_output=True, text=True)
                    self.assertEqual(check.returncode, 0, check.stderr)
                    text = payload.read_text()
                    self.assertIn('init_guest_state || exit 1', text)
                    self.assertIn('sync_vm_to_share', text)
                    self.assertGreater(len(text.splitlines()), 300, "truncated runtime payload")
                    args = (home / "final-arguments.bin").read_bytes().split(b'\0')
                    # vm_exec contributes '_' as bash's $0, then exactly 28 arguments.
                    self.assertEqual(args[0], b'_')
                    self.assertEqual(args[1].decode(), str(project))
                    self.assertEqual(len(args[1:-1]), 28)


if __name__ == '__main__':
    unittest.main()
