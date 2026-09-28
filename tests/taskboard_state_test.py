"""Offline Taskboard state migration and bounded-log contract tests."""

import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen


SCRIPT = (Path(__file__).resolve().parents[1] / "opencode-vm.sh").read_text()
GUARD = re.search(r"^taskboard_state_guard\(\) \{\n.*?^\}", SCRIPT, re.M | re.S).group()
WRITER = SCRIPT.split("read -r -d '' OC_TASKBOARD_LOG_WRITER_PY <<'BOARD_LOG' || true\n", 1)[1].split("\nBOARD_LOG", 1)[0]


def database(path, versions):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)")
        connection.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)")
        connection.execute("INSERT INTO projects VALUES ('existing', 'Keep me')")
        connection.executemany("INSERT INTO schema_migrations VALUES (?)", [(version,) for version in versions])


class TaskboardStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.project = root / "project"
        self.project.mkdir()
        self.db = self.project / ".opencode-vm/taskboard/taskboard.db"
        self.legacy = root / "old-project-state/taskboard/taskboard.db"

    def tearDown(self):
        self.temp.cleanup()

    def guard(self, action="preflight", *, check=True):
        code = GUARD + '\nPROJ_DIR="$1"\nOC_TASKBOARD_DB="$2"\nOC_TASKBOARD_LEGACY_DB="$3"\nOC_TASKBOARD_LEGACY_EXPECTED="$(test -f "$3" && printf 1 || printf 0)"\ntaskboard_state_guard "$4"\n'
        result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + code, "fixture", str(self.project), str(self.db),
                                 str(self.legacy), action], capture_output=True, text=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_legacy_import_survives_new_vm_and_preserves_source_and_sidecar(self):
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        database(self.legacy, ["001_initial.sql", "002_add_project_description.sql"])
        sidecar = self.legacy.with_name("taskboard.metadata.json")
        sidecar.write_text('{"schema":1,"links":{"task":["reference"]}}')
        self.guard()
        self.assertEqual(self.db.with_name(sidecar.name).read_bytes(), sidecar.read_bytes())
        self.assertEqual(sqlite3.connect(self.db).execute("SELECT name FROM projects").fetchone()[0], "Keep me")
        self.assertTrue(self.legacy.exists())
        self.assertIn(".opencode-vm/", (self.project / ".gitignore").read_text())
        self.assertEqual(subprocess.run(["git", "check-ignore", "-q", str(self.db)],
                                        cwd=self.project).returncode, 0)
        self.guard()  # a fresh VM reads the same project-backed DB without overwriting it
        self.guard("verify")

    def test_supported_old_schema_has_backup_before_upstream_migration(self):
        database(self.db, ["001_initial.sql"])
        self.guard()
        backup = self.db.with_name("taskboard.pre-v0.6.0.db")
        self.assertEqual(sqlite3.connect(backup).execute("SELECT name FROM projects").fetchone()[0], "Keep me")
        self.assertNotEqual(self.guard("verify", check=False).returncode, 0)
        # Upstream v0.6.0 applies its 002 migration transactionally after preflight.
        with sqlite3.connect(self.db) as connection:
            connection.execute("ALTER TABLE projects ADD COLUMN description TEXT DEFAULT ''")
            connection.execute("INSERT INTO schema_migrations VALUES ('002_add_project_description.sql')")
        self.guard("verify")

    def test_current_schema_restarts_without_backup_or_data_changes(self):
        database(self.db, ["001_initial.sql", "002_add_project_description.sql"])
        before = self.db.read_bytes()
        self.guard()
        self.guard("verify")
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse(self.db.with_name("taskboard.pre-v0.6.0.db").exists())

    def test_unknown_newer_schema_fails_without_modifying_data(self):
        database(self.db, ["001_initial.sql", "002_add_project_description.sql", "003_future.sql"])
        before = self.db.read_bytes()
        self.assertNotEqual(self.guard(check=False).returncode, 0)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse(self.db.with_name("taskboard.pre-v0.6.0.db").exists())

    def test_unmounted_existing_legacy_db_cannot_be_replaced_by_empty_state(self):
        code = GUARD + '\nPROJ_DIR="$1"\nOC_TASKBOARD_DB="$2"\nOC_TASKBOARD_LEGACY_DB="$3"\nOC_TASKBOARD_LEGACY_EXPECTED=1\ntaskboard_state_guard preflight\n'
        result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + code, "fixture", str(self.project),
                                 str(self.db), str(self.legacy)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.db.exists())

    def test_log_writer_is_bounded_and_keeps_one_rotation(self):
        self.db.parent.mkdir(parents=True)
        log = self.db.with_name("taskboard.log")
        for _ in range(2):
            result = subprocess.run([sys.executable, "-u", "-c", WRITER, str(log)],
                                    input=b"x" * 2_400_000, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLessEqual(log.stat().st_size, 1024 * 1024)
            self.assertLessEqual(log.with_name("taskboard.log.1").stat().st_size, 1024 * 1024)
        self.assertFalse(log.with_name("taskboard.log.2").exists())

    @unittest.skipUnless(os.environ.get("OCVM_TASKBOARD_BIN") and os.environ.get("OCVM_TASKBOARD_SQL_DIR"),
                         "pinned binary and its upstream SQL fixtures were not supplied")
    def test_pinned_binary_migrates_and_restarts_with_project_state(self):
        sql_dir = Path(os.environ["OCVM_TASKBOARD_SQL_DIR"])
        self.db.parent.mkdir(parents=True)
        with sqlite3.connect(self.db) as connection:
            connection.executescript((sql_dir / "001_initial.sql").read_text())
            connection.execute("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)")
            connection.execute("INSERT INTO schema_migrations VALUES ('001_initial.sql')")
            connection.execute("INSERT INTO projects (id,name,prefix) VALUES ('keep-id','Keep me','KEEP')")
        self.guard()
        self.assertTrue(self.db.with_name("taskboard.pre-v0.6.0.db").exists())
        for _ in range(2):  # a new process represents a rebuilt disposable VM
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen([os.environ["OCVM_TASKBOARD_BIN"], "--db", str(self.db),
                                        "start", "--foreground", "--port", str(port)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for attempt in range(100):
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/api/projects", timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        pass
                    time.sleep(0.05)
                else:
                    self.fail("pinned Taskboard did not become ready")
            finally:
                process.terminate()
                process.wait(timeout=5)
            self.guard("verify")
            self.assertEqual(sqlite3.connect(self.db).execute("SELECT name FROM projects WHERE id='keep-id'").fetchone()[0], "Keep me")


if __name__ == "__main__":
    unittest.main()
