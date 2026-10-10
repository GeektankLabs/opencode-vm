#!/usr/bin/env python3
"""Offline/synthetic tests for the opt-in OCVM diagnostic logger worker
(be951293). No network, no real provider requests, no VM needed: the worker
is extracted from opencode-vm.sh via `opencode-vm diaglog script` and driven
against synthetic sources in a temp dir."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_EXTRACT = [sys.executable, "-c", """
import subprocess, sys
out = subprocess.run(['bash', sys.argv[1], 'diaglog', 'script'], capture_output=True, text=True)
assert out.returncode == 0, out.stderr
sys.stdout.write(out.stdout)
""", str(ROOT / "opencode-vm.sh")]

WORKER = Path(tempfile.mkdtemp(prefix="ocvm-diaglog-worker-")) / "ocvm-diag-logger.py"
WORKER.write_text(subprocess.run(WORKER_EXTRACT, capture_output=True, text=True, check=True).stdout)


def run_worker(args, timeout=30):
    return subprocess.run([sys.executable, str(WORKER)] + [str(a) for a in args],
                          capture_output=True, text=True, timeout=timeout)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def read_json(path):
    return json.loads(Path(path).read_text())


def seed_env(base):
    xdg = base / "xdg"
    share = base / "share"
    write(xdg / "opencode" / "log" / "opencode.log",
          'timestamp=2026-10-10T10:00:00.000Z level=INFO run=r1 message="llm request completed" '
          'providerID=zai modelID=glm session.id=ses_m status=200 provider.requestID="pr-777"\n'
          'totally unknown free-form line that must never persist\n'
          'timestamp=2026-10-10T10:00:01.000Z level=WARN run=r1 message="stream error" '
          'providerID=zai modelID=glm session.id=ses_m authorization="Bearer sk-tokensentinel" status=503\n')
    write(share / "monitor" / "server.log",
          'timestamp=2026-10-10T10:00:02.000Z level=INFO run=r2 message="wake dispatched" session.id=ses_m\n')
    return xdg, share


def claim(base, xdg, share, extra=None):
    out = run_worker(["claim", base / "state", "--xdg", xdg, "--share", share])
    assert out.returncode == 0, out.stderr
    episode = base / "state" / out.stdout.strip()
    # small limits for offline tests, applied before `run`
    config = read_json(episode / "config.json")
    config["limits"].update({"tick_seconds": 0.2, "max_file_bytes": 300, "max_total_bytes": extra or 100_000_000})
    write(episode / "config.json", json.dumps(config))
    return episode


class DiagLoggerTest(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="ocvm-diaglog-test-"))

    def test_selftest(self):
        out = run_worker(["selftest"])
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("selftest ok", out.stdout)

    def test_time_limit_ends_a_quiet_episode_honestly(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share)
        config = read_json(episode / "config.json")
        config["limits"]["max_episode_seconds"] = 1  # controlled time, no real 24 h wait
        config["limits"]["tick_seconds"] = 0.2
        write(episode / "config.json", json.dumps(config))
        log = open(episode / "run.log", "w")
        self.addCleanup(log.close)
        proc = subprocess.Popen([sys.executable, str(WORKER), "run", str(self.base / "state")],
                                stdout=log, stderr=subprocess.STDOUT)
        # no signal, no restart loop: the worker ends itself at the limit
        self.assertEqual(proc.wait(timeout=10), 0)
        meta = read_json(episode / "meta.json")
        self.assertTrue(meta["final"]["clean"], meta["final"])
        self.assertEqual(meta["final"]["reason"], "time-limit")
        status = json.loads(run_worker(["status", self.base / "state", "--json"]).stdout)
        self.assertEqual(status["state"], "not_running")
        self.assertTrue(status["final"]["clean"])
        stop = run_worker(["stop", self.base / "state"])
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertIn("stopped_clean: time-limit", stop.stdout)

    def test_invalid_time_limit_is_a_config_error(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share)
        config = read_json(episode / "config.json")
        config["limits"]["max_episode_seconds"] = -5
        write(episode / "config.json", json.dumps(config))
        out = run_worker(["run", self.base / "state"], timeout=20)
        self.assertEqual(out.returncode, 2, out.stderr)
        self.assertIn("max_episode_seconds", out.stderr)
        meta = read_json(episode / "meta.json")
        self.assertIsNone(meta["final"])

    def test_claim_run_stop_clean_and_redaction(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share)
        log = open(episode / "run.log", "w")
        self.addCleanup(log.close)
        proc = subprocess.Popen([sys.executable, str(WORKER), "run", str(self.base / "state")],
                                stdout=log, stderr=subprocess.STDOUT)
        time.sleep(1.2)
        status = json.loads(run_worker(["status", self.base / "state", "--json"]).stdout)
        self.assertEqual(status["state"], "running")
        self.assertTrue(status["identity_verified"])
        self.assertGreater(status["totals"]["events"], 0)
        self.assertGreaterEqual(status["totals"]["unknown"], 1)
        # growth evidence: appending lines moves the observed totals forward
        events_before = status["totals"]["events"]
        with open(xdg / "opencode" / "log" / "opencode.log", "a") as handle:
            handle.write('timestamp=2026-10-10T10:05:00.000Z level=INFO run=r1 message="later line" '
                         'providerID=zai modelID=glm session.id=ses_m status=202 provider.requestID="pr-778"\n')
            handle.write('timestamp=2026-10-10T10:05:01.000Z level=INFO run=r1 message="retry ok" '
                         'providerID=zai modelID=glm session.id=ses_m status=200 provider.requestID="req_real_openai_9f3a"\n')
            handle.write('timestamp=2026-10-10T10:05:02.000Z level=INFO run=r1 message="uuid id" '
                         'providerID=zai modelID=glm session.id=ses_m status=200 provider.requestID="0f4e2c5a-1111-4111-8111-111111111111"\n')
        time.sleep(1.0)
        status2 = json.loads(run_worker(["status", self.base / "state", "--json"]).stdout)
        self.assertGreater(status2["totals"]["events"], events_before, "appended source lines are observed")
        self.assertIn("growth", status2)
        # F-D2b: provider source + explicit provider label = evidence, any format
        events_text = "".join(p.read_text() for p in sorted(episode.glob("events*.jsonl")))
        self.assertIn('"request_id":"req_real_openai_9f3a"', events_text)
        self.assertIn('"request_id":"0f4e2c5a-1111-4111-8111-111111111111"', events_text)
        self.assertNotIn("internal-trace-42", events_text)
        self.assertFalse(status2["growth"]["monitor"]["grew_since_heartbeat"], "static source is not growth")
        # stop writes a clean final and the process exits
        stop = run_worker(["stop", self.base / "state"])
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertIn("stopped_clean: signal", stop.stdout)
        proc.wait(timeout=10)
        meta = read_json(episode / "meta.json")
        self.assertTrue(meta["final"]["clean"], meta["final"])
        # redaction: sentinel values never persisted; unknown line never persisted
        events = "".join(p.read_text() for p in sorted(episode.glob("events*.jsonl")))
        self.assertNotIn("tokensentinel", events)
        self.assertNotIn("totally unknown", events)
        for line in events.splitlines():
            event = json.loads(line)
            self.assertNotIn("cookie", event)
            self.assertNotIn("authorization", event)
        provider_events = [json.loads(line) for line in events.splitlines() if "http_status" in line]
        self.assertTrue(any(e.get("http_status") == 200 and e.get("request_id") == "pr-777" for e in provider_events))
        self.assertTrue(any(e.get("http_status") == 503 for e in provider_events))
        self.assertTrue(all(e.get("request_id") != "req_whatever" for e in provider_events))

    def test_double_start_claim_conflict(self):
        xdg, share = seed_env(self.base)
        claim(self.base, xdg, share)
        log = open(self.base / "run.log", "w")
        self.addCleanup(log.close)
        proc = subprocess.Popen([sys.executable, str(WORKER), "run", str(self.base / "state")],
                                stdout=log, stderr=subprocess.STDOUT)
        time.sleep(0.8)
        conflict = run_worker(["claim", self.base / "state", "--xdg", xdg, "--share", share])
        self.assertEqual(conflict.returncode, 5, conflict.stdout + conflict.stderr)
        run_worker(["stop", self.base / "state"])
        proc.wait(timeout=10)

    def test_stale_state_rotated_and_pid_reuse_refused(self):
        xdg, share = seed_env(self.base)
        claim(self.base, xdg, share)
        state_path = self.base / "state" / "state.json"
        # PID of a live process (this test runner) with a WRONG starttime: a
        # classic PID-reuse forgery must not count as our logger.
        state = read_json(state_path)
        state["pid"] = os.getpid()
        state["pid_starttime"] = 1
        write(state_path, json.dumps(state))
        stale_before = sorted((self.base / "state").glob("state-stale-*.json"))
        out = run_worker(["claim", self.base / "state", "--xdg", xdg, "--share", share])
        self.assertEqual(out.returncode, 0, out.stderr)
        stale_after = sorted((self.base / "state").glob("state-stale-*.json"))
        self.assertEqual(len(stale_after), len(stale_before) + 1, "stale state preserved as evidence")
        # stop against a forged/dead identity reports honestly, never cleans up
        forged = read_json(state_path)
        forged["pid"] = os.getpid()
        forged["pid_starttime"] = 1
        write(state_path, json.dumps(forged))
        stop = run_worker(["stop", self.base / "state"])
        self.assertEqual(stop.returncode, 4)
        self.assertIn("stopped_unclean", stop.stdout)

    def test_rotation_keeps_old_files_and_hard_cap_stops_honestly(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share, extra=600)
        src = xdg / "opencode" / "log" / "opencode.log"
        with open(src, "a") as handle:
            for index in range(120):
                handle.write('timestamp=2026-10-10T11:%02d:00.000Z level=INFO run=r message="e%d" '
                             'providerID=p modelID=m session.id=ses_m\n' % (index % 60, index))
        out = run_worker(["run", self.base / "state"], timeout=20)
        self.assertEqual(out.returncode, 4, out.stdout + out.stderr)  # stopped without clean final (size cap)
        meta = read_json(episode / "meta.json")
        self.assertIsNotNone(meta["final"])
        self.assertFalse(meta["final"]["clean"])
        self.assertIn("budget", meta["final"]["reason"])
        files = sorted(episode.glob("events*.jsonl"))
        self.assertGreater(len(files), 1, "rotation produced multiple files")
        self.assertGreaterEqual(meta["rotations"], 1)
        total_lines = sum(len(f.read_text().splitlines()) for f in files)
        self.assertGreater(total_lines, 0, "no event files were deleted")

    def test_events_budget_enforced_on_serialized_bytes(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share, extra=700)
        src = xdg / "opencode" / "log" / "opencode.log"
        # many short raw lines whose JSON events EXPAND versus the input
        with open(src, "a") as handle:
            for index in range(60):
                handle.write('timestamp=2026-10-10T12:%02d:00.000Z level=INFO run=r message="x" '
                             'providerID=zai modelID=glm session.id=ses_m status=200\n' % (index % 60))
        out = run_worker(["run", self.base / "state"], timeout=20)
        self.assertEqual(out.returncode, 4, out.stdout + out.stderr)
        meta = read_json(episode / "meta.json")
        self.assertIsNotNone(meta["final"])
        self.assertFalse(meta["final"]["clean"])
        self.assertIn("budget", meta["final"]["reason"])
        # the TRUE bound: serialized event bytes never exceed the configured budget
        event_files = sorted(episode.glob("events*.jsonl"))
        total = sum(f.stat().st_size for f in event_files)
        self.assertLessEqual(total, 700)
        # dropped remainder counted honestly; admitted lines are never torn
        self.assertGreaterEqual(meta.get("dropped_events", 0), 1)
        for f in event_files:
            for line in f.read_text().splitlines():
                json.loads(line)
        # after the honest stop nothing grows further
        sizes = {f.name: f.stat().st_size for f in event_files}
        time.sleep(0.5)
        for f in event_files:
            self.assertEqual(f.stat().st_size, sizes[f.name])
        # bounded, named administrative state
        for name in ("meta.json", "heartbeat.json", "config.json"):
            admin = episode / name
            if admin.exists():
                self.assertLess(admin.stat().st_size, 64 * 1024, name)

    def test_persistent_io_stop_path_no_false_final(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share)
        # make the whole episode dir read-only: neither events nor a final can
        # be written -> worker must exit 3 WITHOUT a final, never claim clean
        os.chmod(episode, 0o500)
        try:
            proc = subprocess.Popen([sys.executable, str(WORKER), "run", str(self.base / "state")],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            _, err = proc.communicate(timeout=20)
            self.assertEqual(proc.returncode, 3, err.decode()[-500:])
            meta = read_json(episode / "meta.json")
            self.assertIsNone(meta["final"], "no clean-looking final without the ability to write one")
        finally:
            os.chmod(episode, 0o700)

    def test_sigkill_is_reported_unclean_not_clean(self):
        xdg, share = seed_env(self.base)
        claim(self.base, xdg, share)
        proc = subprocess.Popen([sys.executable, str(WORKER), "run", str(self.base / "state")],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.8)
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)
        stop = run_worker(["stop", self.base / "state"])
        self.assertEqual(stop.returncode, 4)
        self.assertIn("stopped_unclean", stop.stdout)

    def test_corrupt_config_is_a_hard_abort(self):
        xdg, share = seed_env(self.base)
        episode = claim(self.base, xdg, share)
        write(episode / "config.json", "{ this is not json")
        out = run_worker(["run", self.base / "state"], timeout=20)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("JSONDecodeError", out.stderr)  # ValueError subclass: hard abort
        meta = read_json(episode / "meta.json")
        self.assertIsNone(meta["final"], "a config error never fabricates a clean end")

    def test_status_unclaimed_and_release(self):
        out = run_worker(["status", self.base / "state", "--json"])
        self.assertEqual(out.returncode, 0)
        self.assertEqual(json.loads(out.stdout)["state"], "unclaimed")
        claim(self.base, *seed_env(self.base))
        run_worker(["release", self.base / "state"])
        out = run_worker(["status", self.base / "state", "--json"])
        self.assertEqual(json.loads(out.stdout)["state"], "unclaimed")


if __name__ == "__main__":
    unittest.main()
