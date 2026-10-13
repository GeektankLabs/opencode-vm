"""Agent Control policy persistence, validation and HTTP boundary."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import hub.server as server
from hub.catalog import read_catalog, mcp_connection, read_capabilities, read_schema4_capabilities, read_policy_capabilities, _supports_slot_disabled
from hub.policy import PolicyStore, PolicyConflict, PolicyError, PolicyCapabilityError, PROFILES, BASE_PROFILES, STRATEGY_KEYS, check_selection, resolve_profile, routing_regime, candidate_order, profile_fallbacks_view, strategies_view, validate_final_fallback, validate_policy, validate_profile_fallbacks, validate_strategies


CATALOG = {"providers": [{"provider_id": "p", "name": "Provider"}],
           "models": [{"provider_id": "p", "model_id": "family/model", "name": "Current",
                       "variants": ["default", "high"]}], "truncated": False}
SELECTION = {"provider_id": "p", "model_id": "family/model", "variant": "high"}


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "project"
        self.project.mkdir()
        self.store = PolicyStore(self.project)

    def tearDown(self):
        self.temp.cleanup()

    def test_missing_policy_is_virtual_and_portable_policy_is_git_ignored(self):
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.assertEqual(self.store.read()["profiles"], dict.fromkeys(PROFILES))
        self.assertFalse(self.store.path.exists())
        saved = self.store.update("deep", SELECTION, 0)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.store.read()["profiles"]["deep"], SELECTION)
        self.assertIn(".opencode-vm/", (self.project / ".gitignore").read_text())
        text = self.store.path.read_text()
        self.assertNotIn(str(self.project), text)
        self.assertNotIn("token", text)
        self.assertEqual(subprocess.run(["git", "check-ignore", "-q", str(self.store.path)],
                                        cwd=self.project).returncode, 0)
        subprocess.run(["git", "add", "-f", ".opencode-vm/agent-control.json"], cwd=self.project, check=True)
        staged = subprocess.check_output(["git", "ls-files"], cwd=self.project, text=True).splitlines()
        self.assertEqual(staged, [".opencode-vm/agent-control.json"])

    def test_future_and_invalid_policy_fail_closed(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_text().replace('"schemaVersion":1', '"schemaVersion":3')
        self.store.path.write_text(original)
        with self.assertRaises(PolicyError):
            self.store.update("execution", SELECTION, 1)
        self.assertEqual(self.store.path.read_text(), original)

    def test_policy_rejects_secret_like_values_and_absolute_paths(self):
        with self.assertRaises(PolicyError):
            self.store.update("deep", {**SELECTION, "provider_id": "sk-" + "x" * 24}, 0)
        with self.assertRaises(PolicyError):
            self.store.update("deep", {**SELECTION, "model_id": "/Users/private/model"}, 0)
        self.assertFalse(self.store.path.exists())

    def test_read_rejects_budget_and_exact_profile_format_without_mutation(self):
        self.store.update("deep", SELECTION, 0)
        valid = json.loads(self.store.path.read_text())
        for data in (b" " * (16 * 1024 + 1),
                     json.dumps({**valid, "schemaVersion": 2}).encode(),
                     json.dumps({**valid, "profiles": {**valid["profiles"], "design": None}}).encode()):
            self.store.path.write_bytes(data)
            with self.assertRaises(PolicyError): self.store.read()
            self.assertEqual(self.store.path.read_bytes(), data)

    def test_concurrent_revision_allows_only_one_write(self):
        outcomes = []
        def write(profile):
            try:
                self.store.update(profile, SELECTION, 0)
                outcomes.append("saved")
            except PolicyConflict:
                outcomes.append("conflict")
        threads = [threading.Thread(target=write, args=(name,)) for name in ("deep", "standard")]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(outcomes, ["saved", "conflict"])
        self.assertEqual(self.store.read()["revision"], 1)

    def test_catalog_validation_distinguishes_missing_and_incomplete(self):
        self.assertEqual(check_selection(SELECTION, CATALOG), "available")
        self.assertEqual(check_selection({**SELECTION, "provider_id": "other"}, CATALOG), "provider_unavailable")
        self.assertEqual(check_selection({**SELECTION, "model_id": "other"}, CATALOG), "model_unavailable")
        self.assertEqual(check_selection({**SELECTION, "variant": "missing"}, CATALOG), "variant_unavailable")
        self.assertEqual(check_selection(SELECTION, {**CATALOG, "truncated": True}), "catalog_incomplete")
        self.assertEqual(check_selection(SELECTION, None), "catalog_unavailable")

    def test_explicit_atomic_upgrade_and_clear_preserve_basics(self):
        self.store.update("deep", SELECTION, 0)
        self.store.update("standard", SELECTION, 1)
        original = self.store.path.read_bytes()
        self.assertEqual(json.loads(original)["schemaVersion"], 1)
        self.assertEqual(len(json.loads(original)["profiles"]), 3)
        with self.assertRaises(PolicyCapabilityError):
            self.store.update("design", SELECTION, 2)
        self.assertEqual(self.store.path.read_bytes(), original)
        updated = self.store.update("design", SELECTION, 2, optional_capable=True)
        backup = self.store.directory / "agent-control.schema1-rev2.backup.json"
        self.assertEqual(backup.read_bytes(), original)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(updated["schemaVersion"], 2)
        self.assertEqual(updated["revision"], 3)
        self.assertEqual(updated["profiles"]["deep"], SELECTION)
        self.assertIsNone(updated["profiles"]["review"])
        self.assertEqual(self.store.update("design", None, 3)["schemaVersion"], 2)

    def test_first_optional_save_without_original_has_no_fictitious_backup(self):
        saved = self.store.update("review", SELECTION, 0, optional_capable=True)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["schemaVersion"], 2)
        self.assertEqual(list(self.store.directory.glob("*.backup.json")), [])
        self.assertIsNone(saved["profiles"]["design"])

    def test_interrupted_upgrade_replay_and_differing_backup_fail_closed(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                self.store.update("review", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(self.store.read()["revision"], 1)
        backup = self.store.directory / "agent-control.schema1-rev1.backup.json"
        backup.write_bytes(b"different")
        with self.assertRaises(PolicyError):
            self.store.update("review", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        backup.write_bytes(original)
        self.assertEqual(self.store.update("review", SELECTION, 1, optional_capable=True)["revision"], 2)

    def test_backup_failure_and_unsafe_paths_do_not_publish(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.link", side_effect=OSError("backup failed")):
            with self.assertRaises(OSError):
                self.store.update("design", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        backup = self.store.directory / "agent-control.schema1-rev1.backup.json"
        backup.symlink_to(self.store.path)
        with self.assertRaises(OSError):
            self.store.update("design", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.store.path.unlink(); self.store.path.symlink_to(backup)
        with self.assertRaises(PolicyError): self.store.read()

    def test_final_fallback_validation_is_strict(self):
        self.assertIsNone(validate_final_fallback(None))
        self.assertEqual(validate_final_fallback({"selection": SELECTION}), {"mode": "total", "selection": SELECTION})
        self.assertEqual(validate_final_fallback({"mode": "degrading", "selection": SELECTION}),
                         {"mode": "degrading", "selection": SELECTION})
        for bad in [{"mode": "total"}, {"mode": "sideways", "selection": SELECTION},
                    {"mode": "total", "selection": None}, {"mode": "total", "selection": SELECTION, "extra": 1},
                    "total"]:
            with self.assertRaises(PolicyError):
                validate_final_fallback(bad)
        with self.assertRaises(PolicyError):
            validate_policy({"schemaVersion": 3, "revision": 1, "updatedAt": "2026-10-07T00:00:00Z",
                             "profiles": {name: None for name in PROFILES}})
        with self.assertRaises(PolicyError):
            validate_policy({"schemaVersion": 2, "revision": 1, "updatedAt": "2026-10-07T00:00:00Z",
                             "finalFallback": None, "profiles": {name: None for name in PROFILES}})

    def test_update_fallback_preserves_slot_on_profile_writes_and_backs_up_exact_bytes(self):
        self.store.update_fallback(None, 0)
        self.assertEqual(self.store.read()["schemaVersion"], 1)
        self.store.update("deep", SELECTION, 1)
        self.store.update_fallback({"mode": "degrading", "selection": SELECTION}, 2, optional_capable=True)
        saved = self.store.read()
        self.assertEqual(saved["schemaVersion"], 3)
        self.assertEqual(saved["finalFallback"], {"mode": "degrading", "selection": SELECTION})
        backup = self.store.directory / "agent-control.schema1-rev2.backup.json"
        self.assertTrue(backup.is_file())
        self.assertEqual(json.loads(backup.read_text())["schemaVersion"], 1)
        self.store.update("standard", SELECTION, 3)
        preserved = self.store.read()
        self.assertEqual(preserved["schemaVersion"], 3)
        self.assertEqual(preserved["finalFallback"], {"mode": "degrading", "selection": SELECTION})
        with self.assertRaises(PolicyConflict):
            self.store.update_fallback(None, 3)
        cleared = self.store.update_fallback(None, 4)
        self.assertEqual(cleared["schemaVersion"], 3)
        self.assertIsNone(cleared["finalFallback"])
        with self.assertRaises(PolicyCapabilityError):
            fresh = Path(self.temp.name) / "fresh-project"
            fresh.mkdir(exist_ok=True)
            PolicyStore(fresh).update_fallback({"mode": "total", "selection": SELECTION}, 0)

    def test_shared_resolution_vectors(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ach1-resolution.json").read_text())
        for vector in vectors:
            policy = self.store.read()
            for role, state in vector["mappings"].items():
                selection = dict(SELECTION)
                if state.endswith("_unavailable"):
                    selection[{"provider_unavailable": "provider_id", "model_unavailable": "model_id",
                                "variant_unavailable": "variant"}[state]] = "gone"
                policy["profiles"][role] = selection
            if vector.get("disabled"):
                policy["disabled"] = {"profiles": {name: name in vector["disabled"] for name in PROFILES},
                                      "profileFallbacks": {name: False for name in PROFILES},
                                      "finalFallback": False}
            catalog = None if vector["catalog"] == "unavailable" else {**CATALOG, "truncated": vector["catalog"] == "incomplete"}
            result = resolve_profile(policy, vector["profile"], catalog)
            for key in ("status", "resolved_profile", "resolution_path"):
                self.assertEqual(result.get(key), vector.get(key), vector)
            self.assertEqual("runtime" in result, vector["status"] == "available")

    def test_schema4_validation_is_strict(self):
        self.assertEqual(validate_profile_fallbacks(dict.fromkeys(PROFILES)), dict.fromkeys(PROFILES))
        self.assertEqual(validate_profile_fallbacks({**dict.fromkeys(PROFILES), "deep": SELECTION})["deep"], SELECTION)
        self.assertEqual(validate_strategies({"degrading": True, "providerSkip": None}),
                         {"degrading": True, "providerSkip": None})
        for bad in [{"degrading": True}, {"degrading": True, "providerSkip": False, "extra": True},
                    {"degrading": 1, "providerSkip": None}, {"degrading": "true", "providerSkip": None},
                    {"degrading": True, "providerSkip": "no"}, "degrading"]:
            with self.assertRaises(PolicyError):
                validate_strategies(bad)
        for bad in [dict.fromkeys(BASE_PROFILES), {**dict.fromkeys(PROFILES), "manager": None},
                    {**dict.fromkeys(PROFILES), "deep": {**SELECTION, "extra": "x"}},
                    {**dict.fromkeys(PROFILES), "deep": {**SELECTION, "provider_id": "/etc/passwd"}}]:
            with self.assertRaises(PolicyError):
                validate_profile_fallbacks(bad)
        complete = {"schemaVersion": 4, "revision": 1, "updatedAt": "2026-10-08T00:00:00Z",
                    "profiles": dict.fromkeys(PROFILES), "finalFallback": None,
                    "profileFallbacks": dict.fromkeys(PROFILES),
                    "strategies": {"degrading": None, "providerSkip": None}}
        self.assertEqual(validate_policy(complete)["schemaVersion"], 4)
        for bad in [{**complete, "strategies": None}, {**complete, "profileFallbacks": None},
                    {**complete, "extra": 1}, {**complete, "schemaVersion": 5},
                    {"schemaVersion": 4, "revision": 1, "updatedAt": "2026-10-08T00:00:00Z",
                     "profiles": dict.fromkeys(PROFILES), "finalFallback": None,
                     "profileFallbacks": dict.fromkeys(PROFILES)},
                    {"schemaVersion": 3, "revision": 1, "updatedAt": "2026-10-08T00:00:00Z",
                     "profiles": dict.fromkeys(PROFILES), "finalFallback": None,
                     "profileFallbacks": dict.fromkeys(PROFILES),
                     "strategies": {"degrading": None, "providerSkip": None}}]:
            with self.assertRaises(PolicyError):
                validate_policy(bad)

    def test_shared_fallback_regime_vectors_match_the_adapter(self):
        """Same vectors the TypeScript reader asserts; one shared fixture file."""
        vectors = json.loads((Path(__file__).parent.parent / "adapters/mcp/tests/fallback-vectors.json").read_text())
        self.assertGreaterEqual(len(vectors), 8)
        for vector in vectors:
            policy = validate_policy(vector["policy"])
            routing = routing_regime(policy)
            self.assertEqual(routing["regime"], vector["regime"], vector["name"])
            self.assertEqual(routing["legacyFinalStageApplies"], vector["legacy_final_stage_applies"], vector["name"])
            self.assertEqual(routing["strategiesEffective"],
                             {"degrading": vector["strategies_effective"]["degrading"],
                              "providerSkip": vector["strategies_effective"]["provider_skip"]}, vector["name"])
            for profile in PROFILES:
                self.assertEqual(candidate_order(policy, profile), vector["candidate_order"][profile],
                                 f'{vector["name"]} / {profile}')

    def test_profile_fallback_and_strategy_writes_upgrade_back_up_and_preserve(self):
        self.store.update("deep", SELECTION, 0)
        self.store.update_fallback({"mode": "degrading", "selection": SELECTION}, 1, optional_capable=True)
        self.assertEqual(self.store.read()["schemaVersion"], 3)
        with self.assertRaises(PolicyCapabilityError):
            self.store.update_profile_fallback("deep", SELECTION, 2)
        saved = self.store.update_profile_fallback("deep", SELECTION, 2, schema4_capable=True)
        self.assertEqual(saved["schemaVersion"], 4)
        self.assertEqual(saved["profileFallbacks"]["deep"], SELECTION)
        self.assertEqual(saved["strategies"], {"degrading": None, "providerSkip": None})
        self.assertEqual(saved["finalFallback"], {"mode": "degrading", "selection": SELECTION})
        backup = self.store.directory / "agent-control.schema3-rev2.backup.json"
        self.assertTrue(backup.is_file())
        self.assertEqual(json.loads(backup.read_text())["schemaVersion"], 3)
        self.assertEqual(list(json.loads(self.store.path.read_text())),
                         ["schemaVersion", "revision", "updatedAt", "profiles", "finalFallback",
                          "profileFallbacks", "strategies"], "canonical key order matches the adapter writer")
        # Every other writer preserves the schema-4 slots and never downgrades.
        self.assertEqual(self.store.update("standard", SELECTION, 3)["schemaVersion"], 4)
        self.assertEqual(self.store.read()["profileFallbacks"]["deep"], SELECTION)
        self.assertEqual(self.store.update_fallback(None, 4)["schemaVersion"], 4)
        self.assertEqual(self.store.read()["finalFallback"], None)
        self.assertEqual(self.store.read()["profileFallbacks"]["deep"], SELECTION)
        with self.assertRaises(PolicyConflict):
            self.store.update_strategies({"degrading": True, "providerSkip": False}, 4)
        switched = self.store.update_strategies({"degrading": True, "providerSkip": False}, 5, schema4_capable=True)
        self.assertEqual(switched["strategies"], {"degrading": True, "providerSkip": False})
        self.assertEqual(switched["profileFallbacks"]["deep"], SELECTION)
        cleared = self.store.update_strategies({"degrading": None, "providerSkip": None}, 6, schema4_capable=True)
        self.assertEqual(cleared["schemaVersion"], 4, "clearing never downgrades")
        self.assertEqual(cleared["strategies"], {"degrading": None, "providerSkip": None})
        removed = self.store.update_profile_fallback("deep", None, 7, schema4_capable=True)
        self.assertEqual(removed["schemaVersion"], 4)
        self.assertIsNone(removed["profileFallbacks"]["deep"])
        self.assertEqual(sorted(path.name for path in self.store.directory.glob("agent-control.*.backup.json")),
                         ["agent-control.schema1-rev1.backup.json", "agent-control.schema3-rev2.backup.json"],
                         "each first upgrade to a new schema backs up exact bytes once; later writes add none")
        # Clearing on schema 1/2 neither upgrades nor invents the new keys.
        fresh = Path(self.temp.name) / "fresh-project"
        fresh.mkdir(exist_ok=True)
        store = PolicyStore(fresh)
        untouched = store.update_profile_fallback("deep", None, 0, schema4_capable=True)
        self.assertEqual(untouched["schemaVersion"], 1)
        self.assertFalse(store.path.exists() and "profileFallbacks" in store.path.read_text())
        self.assertEqual(store.update_strategies({"degrading": None, "providerSkip": None}, 1,
                                                 schema4_capable=True)["schemaVersion"], 1)
        with self.assertRaises(PolicyCapabilityError):
            store.update_strategies({"degrading": True, "providerSkip": True}, 2)
        with self.assertRaises(PolicyCapabilityError):
            store.update_profile_fallback("deep", SELECTION, 2)
        upgraded = store.update_strategies({"degrading": False, "providerSkip": True}, 2,
                                           optional_capable=True, schema4_capable=True)
        self.assertEqual(upgraded["schemaVersion"], 4)
        self.assertEqual(sorted(json.loads(store.path.read_text())["profiles"]), sorted(PROFILES))
        self.assertEqual(upgraded["finalFallback"], None)


    def test_slot_disabled_resolution_skip_and_identical_runtime_in_other_slot(self):
        policy = {"schemaVersion": 5, "revision": 3, "updatedAt": "2026-10-12T00:00:00Z",
                  "profiles": {"deep": SELECTION, "standard": SELECTION, "execution": None,
                               "design": SELECTION, "review": None},
                  "finalFallback": None,
                  "profileFallbacks": {name: None for name in PROFILES},
                  "strategies": {"degrading": None, "providerSkip": None},
                  "disabled": {"profiles": {"deep": True, "standard": False, "execution": False,
                                            "design": True, "review": False},
                               "profileFallbacks": {name: False for name in PROFILES},
                               "finalFallback": False}}
        self.assertEqual(validate_policy(policy)["schemaVersion"], 5)
        # deep has no resolution fallback: its paused main alone ends in a hold —
        # no backend default choice, no substitute model.
        resolved = resolve_profile(policy, "deep", CATALOG)
        self.assertEqual(resolved["status"], "hold_disabled")
        self.assertEqual(resolved["resolution_path"], ["deep"])
        self.assertEqual([c["label"] for c in resolved["candidates"] if c["disabled"]], ["deep.main"])
        # The identical runtime in another ACTIVE slot stays selectable (no identity ban):
        # design walks past its paused main to the same tuple stored in standard.
        design = resolve_profile(policy, "design", CATALOG)
        self.assertEqual(design["status"], "available")
        self.assertEqual(design["resolved_profile"], "standard")
        self.assertEqual(design["resolved_label"], "standard.main")
        self.assertEqual(design["runtime"], SELECTION)
        # review walks review(null), deep(paused) to the active standard main.
        review = resolve_profile(policy, "review", CATALOG)
        self.assertEqual(review["status"], "available")
        self.assertEqual(review["resolved_label"], "standard.main")
        self.assertEqual(review["resolution_path"], ["review", "deep", "standard"])
        # Re-enabling restores the identical stored primary at its original position.
        policy["disabled"]["profiles"]["deep"] = False
        restored = resolve_profile(policy, "deep", CATALOG)
        self.assertEqual(restored["resolved_label"], "deep.main")
        self.assertEqual(restored["runtime"], SELECTION)

class HubApiTest(PolicyTest):
    def setUp(self):
        super().setUp()
        self.share = Path(self.temp.name) / "share"
        self.share.mkdir(mode=0o700)
        self.prior = (server.PROJECT, server.SESSION_ROOT, server.RUNTIME, server.AUTH_CREDENTIALS,
                      server.REQUEST_SCHEME, server.read_catalog)
        server.PROJECT = self.project
        server.SESSION_ROOT = self.share
        server.RUNTIME = {
            "generation": "fixture-generation",
            "mcp": {"enabled": False, "port": 0, "generation": "fixture-generation"},
            "tunnelConfigured": False,
            "openliveConfigured": False,
            "a2aEnabled": False,
        }
        server.AUTH_CREDENTIALS = None
        server.REQUEST_SCHEME = "http"
        server.read_catalog = lambda *args, **kwargs: CATALOG
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.http.server_port}"

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        (server.PROJECT, server.SESSION_ROOT, server.RUNTIME, server.AUTH_CREDENTIALS,
         server.REQUEST_SCHEME, server.read_catalog) = self.prior
        super().tearDown()

    def request(self, selection, revision=0, origin=True, profile="deep"):
        body = json.dumps({"revision": revision, "selection": selection}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + f"/api/control/profiles/{profile}", data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def test_write_requires_origin_and_available_catalog(self):
        self.assertEqual(self.request(SELECTION, origin=False), 403)
        malicious = Request(self.base + "/api/control/profiles/deep", data=json.dumps({"revision": 0, "selection": SELECTION}).encode(),
                            headers={"Content-Type": "application/json", "Host": "public.example:4187", "Origin": "http://public.example:4187"}, method="PUT")
        with self.assertRaises(HTTPError) as refused:
            urlopen(malicious, timeout=3)
        self.assertEqual(refused.exception.code, 403)
        self.assertEqual(self.request({**SELECTION, "variant": "missing"}), 422)
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.request(SELECTION), 200)
        self.assertEqual(self.request(SELECTION), 409)
        server.read_catalog = lambda *args, **kwargs: {**CATALOG, "truncated": True}
        self.assertEqual(self.request(SELECTION, revision=1), 503)
        with urlopen(self.base + "/api/control", timeout=3) as response:
            self.assertEqual(json.load(response)["validation"]["deep"], "catalog_incomplete")

    def test_optional_save_requires_live_capability_and_clear_needs_no_catalog(self):
        self.assertEqual(self.request(SELECTION, profile="design"), 409)
        self.assertFalse(self.store.path.exists())
        with patch.object(server, "read_capabilities", return_value=True):
            self.assertEqual(self.request(SELECTION, profile="design"), 200)
        server.read_catalog = lambda *args, **kwargs: None
        self.assertEqual(self.request(None, revision=1, profile="design"), 200)
        self.assertEqual(self.store.read()["schemaVersion"], 2)

    def test_http_format_conflict_and_failed_publication_are_distinct(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.replace", side_effect=OSError("publication failed")):
            self.assertEqual(self.request(SELECTION, revision=1), 503)
        self.assertEqual(self.store.path.read_bytes(), original)
        invalid = original.replace(b'"schemaVersion":1', b'"schemaVersion":9')
        self.store.path.write_bytes(invalid)
        self.assertEqual(self.request(SELECTION, revision=1), 409)
        self.assertEqual(self.store.path.read_bytes(), invalid)
        with self.assertRaises(HTTPError) as error: urlopen(self.base + "/api/control", timeout=3)
        self.assertEqual(json.load(error.exception)["code"], "POLICY_FORMAT_UNSUPPORTED")

    def test_private_peer_boundary(self):
        self.assertTrue(server.private_peer("192.168.3.4"))
        self.assertTrue(server.private_peer("100.90.1.2"))
        self.assertFalse(server.private_peer("8.8.8.8"))
        self.assertFalse(server.private_peer("192.0.2.1"))

    def fallback_request(self, fallback, revision=0, origin=True):
        body = json.dumps({"revision": revision, "fallback": fallback}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + "/api/control/fallback", data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, None

    def test_final_fallback_route_is_additive_gated_and_cas_protected(self):
        self.assertEqual(self.fallback_request(None, revision=0, origin=False)[0], 403)
        status, body = self.fallback_request(None, revision=0)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 1)
        for bad in [{"mode": "sideways", "selection": SELECTION}, {"mode": "total", "selection": None}, SELECTION]:
            self.assertEqual(self.fallback_request(bad, revision=1)[0], 400)
        # Schema-1 upgrade requires the live capability confirmation (before catalog checks).
        self.assertEqual(self.fallback_request({"mode": "total", "selection": SELECTION}, revision=1)[0], 409)
        with patch.object(server, "read_capabilities", return_value=True):
            status, body = self.fallback_request({"selection": SELECTION}, revision=1)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 3)
        self.assertEqual(body["policy"]["finalFallback"], {"mode": "total", "selection": SELECTION})
        self.assertTrue((self.store.directory / "agent-control.schema1-rev1.backup.json").is_file())
        self.assertEqual(self.fallback_request({"mode": "degrading", "selection": SELECTION}, revision=1)[0], 409)
        # Catalog availability still gates the selection once no upgrade is pending.
        self.assertEqual(self.fallback_request({"mode": "total", "selection": {**SELECTION, "variant": "missing"}}, revision=1)[0], 422)
        status, body = self.fallback_request({"mode": "degrading", "selection": SELECTION}, revision=2)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["finalFallback"]["mode"], "degrading")
        # Profile writes keep working on schema 3 and preserve the slot.
        self.assertEqual(self.request(SELECTION, revision=3), 200)
        self.assertEqual(self.store.read()["finalFallback"]["mode"], "degrading")
        status, body = self.fallback_request(None, revision=4)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 3)
        self.assertIsNone(body["policy"]["finalFallback"])
        with urlopen(self.base + "/api/control", timeout=3) as response:
            self.assertIn("finalFallback", json.load(response)["policy"])


    def own_fallback_request(self, fallback, revision=0, origin=True, profile="deep"):
        body = json.dumps({"revision": revision, "fallback": fallback}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + f"/api/control/profiles/{profile}/fallback", data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, None

    def strategies_request(self, strategies, revision=0, origin=True):
        body = json.dumps({"revision": revision, "strategies": strategies}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + "/api/control/fallback-strategies", data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, None

    def raw_put(self, path, payload, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + path, data=json.dumps(payload).encode(), headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def test_profile_fallback_route_is_additive_gated_and_cas_protected(self):
        own_path = "/api/control/profiles/deep/fallback"
        self.assertEqual(self.own_fallback_request(None, revision=0, origin=False)[0], 403)
        for bad in [{"revision": 0}, {"revision": 0, "fallback": SELECTION, "extra": 1},
                    {"revision": 0, "fallback": {**SELECTION, "extra": "x"}},
                    {"revision": 0, "fallback": {**SELECTION, "provider_id": "sk-abcdefghijklmnopqrstuv"}},
                    {"revision": 0, "fallback": {**SELECTION, "model_id": "/etc/passwd"}}]:
            self.assertEqual(self.raw_put(own_path, bad), 400, bad)
        self.assertEqual(self.raw_put(own_path, {"revision": -1, "fallback": None}), 400)
        self.assertEqual(self.request(SELECTION), 200, "a schema-1 policy exists before the upgrade")
        # A schema-4 upgrade needs the live capability confirmation before any catalog check.
        self.assertEqual(self.own_fallback_request(SELECTION, revision=1)[0], 409)
        self.assertNotIn("profileFallbacks", self.store.path.read_text())
        with patch.object(server, "read_capabilities", return_value=True), \
             patch.object(server, "read_schema4_capabilities", return_value=True):
            status, body = self.own_fallback_request(SELECTION, revision=1)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 4)
        self.assertEqual(body["policy"]["profileFallbacks"]["deep"], SELECTION)
        self.assertEqual(body["policy"]["profiles"]["deep"], SELECTION, "the main mapping is preserved")
        self.assertEqual(body["routing"]["regime"], "per_profile")
        self.assertFalse(body["routing"]["legacyFinalStageApplies"])
        self.assertEqual(body["strategies"], {"degrading": None, "providerSkip": None})
        self.assertTrue((self.store.directory / "agent-control.schema1-rev1.backup.json").is_file())
        self.assertEqual(json.loads((self.store.directory / "agent-control.schema1-rev1.backup.json")
                                    .read_text())["schemaVersion"], 1)
        self.assertEqual(self.own_fallback_request(SELECTION, revision=1)[0], 409)
        self.assertEqual(self.own_fallback_request({**SELECTION, "variant": "missing"}, revision=2)[0], 422)
        server.read_catalog = lambda *args, **kwargs: {**CATALOG, "truncated": True}
        self.assertEqual(self.own_fallback_request({**SELECTION, "variant": "default"}, revision=2)[0], 503)
        server.read_catalog = lambda *args, **kwargs: None
        self.assertEqual(self.own_fallback_request({**SELECTION, "variant": "default"}, revision=2)[0], 503)
        server.read_catalog = lambda *args, **kwargs: CATALOG
        # Clearing needs no catalog and never downgrades the schema.
        status, body = self.own_fallback_request(None, revision=2)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 4)
        self.assertIsNone(body["policy"]["profileFallbacks"]["deep"])
        self.assertEqual(body["routing"]["regime"], "legacy_final_fallback",
                         "with everything unset the legacy behaviour is preserved")
        with patch("hub.policy.os.replace", side_effect=OSError("publication failed")):
            self.assertEqual(self.own_fallback_request(SELECTION, revision=3)[0], 503)
        self.assertEqual(self.store.read()["revision"], 3, "a failed publication changes nothing")
        with urlopen(self.base + "/api/control", timeout=3) as response:
            snapshot = json.load(response)
        for key in ("profileFallbackValidation", "strategies", "routing"):
            self.assertIn(key, snapshot)
        self.assertEqual(snapshot["profileFallbackValidation"]["deep"], "unconfigured")
        self.assertIn("profileFallbacks", snapshot["capabilities"])
        self.assertEqual(snapshot["routing"]["regime"], "legacy_final_fallback")

    def test_strategies_route_writes_both_switches_explicitly_and_reports_the_regime(self):
        self.assertEqual(self.strategies_request(None, revision=0, origin=False)[0], 403)
        for bad in [{"degrading": True}, {"degrading": True, "providerSkip": False, "extra": True},
                    {"degrading": 1, "providerSkip": None}, {"degrading": "true", "providerSkip": None},
                    {"degrading": True, "providerSkip": "no"}, "degrading", None]:
            self.assertEqual(self.strategies_request(bad, revision=0)[0], 400, bad)
        self.assertEqual(self.raw_put("/api/control/fallback-strategies", {"revision": 0}), 400)
        self.assertEqual(self.strategies_request({"degrading": True, "providerSkip": False}, revision=0)[0], 409)
        with patch.object(server, "read_capabilities", return_value=True), \
             patch.object(server, "read_schema4_capabilities", return_value=True):
            status, body = self.strategies_request({"degrading": True, "providerSkip": False}, revision=0)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 4)
        self.assertEqual(body["policy"]["strategies"], {"degrading": True, "providerSkip": False})
        self.assertEqual(body["routing"]["regime"], "per_profile")
        self.assertEqual(body["routing"]["strategiesEffective"], {"degrading": True, "providerSkip": False})
        self.assertEqual(sorted(json.loads(self.store.path.read_text())["profiles"]), sorted(PROFILES))
        self.assertEqual(list(self.store.directory.glob("agent-control.*.backup.json")), [],
                         "a missing original has no bytes to back up")
        self.assertEqual(self.strategies_request({"degrading": False, "providerSkip": True}, revision=0)[0], 409,
                         "a stale expected revision never writes")
        # No selection means no catalog dependency: an unavailable catalog still writes.
        server.read_catalog = lambda *args, **kwargs: None
        status, body = self.strategies_request({"degrading": False, "providerSkip": True}, revision=1)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["strategies"], {"degrading": False, "providerSkip": True})
        # Resetting to "not set" keeps schema 4 and returns to the legacy regime.
        status, body = self.strategies_request({"degrading": None, "providerSkip": None}, revision=2)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 4)
        self.assertEqual(body["policy"]["strategies"], {"degrading": None, "providerSkip": None})
        self.assertEqual(body["routing"]["regime"], "legacy_final_fallback")
        with patch("hub.policy.os.replace", side_effect=OSError("publication failed")):
            self.assertEqual(self.strategies_request({"degrading": True, "providerSkip": True}, revision=3)[0], 503)
        self.assertEqual(self.store.read()["revision"], 3, "a failed publication changes nothing")
        with urlopen(self.base + "/api/control", timeout=3) as response:
            snapshot = json.load(response)
        self.assertEqual(snapshot["strategies"], {"degrading": None, "providerSkip": None})
        self.assertEqual(snapshot["routing"]["strategiesEffective"], {"degrading": False, "providerSkip": False})


    def disabled_request(self, kind, profile=None, disabled=True, revision=0, origin=True):
        path = {"primary": f"/api/control/profiles/{profile}/disabled",
                "own": f"/api/control/profiles/{profile}/fallback/disabled",
                "final": "/api/control/fallback/disabled"}[kind]
        body = json.dumps({"revision": revision, "disabled": disabled}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + path, data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, None

    def test_slot_disabled_store_write_upgrades_backs_up_and_preserves(self):
        self.store.update("deep", SELECTION, 0)
        self.store.update_fallback({"mode": "degrading", "selection": SELECTION}, 1, optional_capable=True)
        self.store.update_profile_fallback("deep", SELECTION, 2, schema4_capable=True)
        with self.assertRaises(PolicyCapabilityError):
            self.store.update_slot_disabled(("profile", "deep"), True, 3)
        saved = self.store.update_slot_disabled(("profile", "deep"), True, 3,
                                                schema4_capable=True, schema5_capable=True)
        self.assertEqual(saved["schemaVersion"], 5)
        self.assertTrue(saved["disabled"]["profiles"]["deep"])
        self.assertFalse(saved["disabled"]["profileFallbacks"]["deep"])
        self.assertFalse(saved["disabled"]["finalFallback"])
        # The stored selections survive byte-exact beside the disable state.
        self.assertEqual(saved["profiles"]["deep"], SELECTION)
        self.assertEqual(saved["profileFallbacks"]["deep"], SELECTION)
        self.assertEqual(saved["finalFallback"], {"mode": "degrading", "selection": SELECTION})
        self.assertEqual(list(json.loads(self.store.path.read_text())),
                         ["schemaVersion", "revision", "updatedAt", "profiles", "finalFallback",
                          "profileFallbacks", "strategies", "disabled"],
                         "canonical key order matches the adapter writer")
        backup = self.store.directory / "agent-control.schema4-rev3.backup.json"
        self.assertTrue(backup.is_file())
        self.assertEqual(json.loads(backup.read_text())["schemaVersion"], 4)
        # The other two slots are independent; clearing never downgrades.
        own = self.store.update_slot_disabled(("profileFallback", "deep"), True, 4, schema5_capable=True)
        self.assertTrue(own["disabled"]["profileFallbacks"]["deep"])
        self.assertTrue(own["disabled"]["profiles"]["deep"])
        final = self.store.update_slot_disabled(("finalFallback", None), True, 5, schema5_capable=True)
        self.assertTrue(final["disabled"]["finalFallback"])
        reenabled = self.store.update_slot_disabled(("profile", "deep"), False, 6, schema5_capable=True)
        self.assertEqual(reenabled["schemaVersion"], 5, "clearing never downgrades")
        self.assertFalse(reenabled["disabled"]["profiles"]["deep"])
        self.assertTrue(reenabled["disabled"]["profileFallbacks"]["deep"])
        self.assertEqual(reenabled["profiles"]["deep"], SELECTION)
        with self.assertRaises(PolicyConflict):
            self.store.update_slot_disabled(("profile", "deep"), True, 3)
        for bad_slot in [("profile", "nope"), ("finalFallback", "deep"), ("bogus", None)]:
            with self.assertRaises(PolicyError):
                self.store.update_slot_disabled(bad_slot, True, 7, schema5_capable=True)
        with self.assertRaises(PolicyError):
            self.store.update_slot_disabled(("profile", "deep"), "yes", 7, schema5_capable=True)
        # A schema-5 document stays valid for the strict reader and regime rules.
        policy = self.store.read()
        self.assertEqual(policy["schemaVersion"], 5)
        self.assertEqual(routing_regime(policy)["regime"], "per_profile")
        # Every other writer preserves the schema-5 disable state and never drops it.
        self.assertEqual(self.store.update("standard", SELECTION, 7)["schemaVersion"], 5)
        self.assertIn("disabled", json.loads(self.store.path.read_text()))
        self.assertEqual(self.store.read()["disabled"]["profileFallbacks"]["deep"], True)

    def test_slot_disabled_routes_are_capability_gated_cas_protected_and_parity_with_mcp(self):
        self.assertEqual(self.disabled_request("primary", "deep", origin=False)[0], 403)
        for bad in [{"revision": 0}, {"revision": 0, "disabled": True, "extra": 1},
                    {"revision": 0, "disabled": "yes"}, {"revision": -1, "disabled": False}]:
            self.assertEqual(self.raw_put("/api/control/profiles/deep/disabled", bad), 400, bad)
        self.assertEqual(self.request(SELECTION), 200, "a schema-1 policy exists before the upgrade")
        # Schema-5 upgrade needs the live capability confirmation (and schema 2 from schema 1).
        self.assertEqual(self.disabled_request("primary", "deep", True, revision=1)[0], 409)
        self.assertNotIn("disabled", self.store.path.read_text())
        with patch.object(server, "read_capabilities", return_value=True), \
             patch.object(server, "read_schema4_capabilities", return_value=True), \
             patch.object(server, "read_slot_disabled_capabilities", return_value=True):
            status, body = self.disabled_request("primary", "deep", True, revision=1)
        self.assertEqual(status, 200)
        self.assertEqual(body["policy"]["schemaVersion"], 5)
        self.assertTrue(body["policy"]["disabled"]["profiles"]["deep"])
        self.assertEqual(body["policy"]["profiles"]["deep"], SELECTION, "the stored tuple is preserved")
        self.assertIn("routing", body)
        self.assertIn("strategies", body)
        self.assertIn("disabled", body)
        # Stale revision conflicts, never writes.
        self.assertEqual(self.disabled_request("primary", "deep", False, revision=1)[0], 409)
        self.assertTrue(json.loads(self.store.path.read_text())["disabled"]["profiles"]["deep"])
        # Own-fallback and final-fallback slot routes hit their own slots.
        with patch.object(server, "read_capabilities", return_value=True), \
             patch.object(server, "read_schema4_capabilities", return_value=True), \
             patch.object(server, "read_slot_disabled_capabilities", return_value=True):
            self.store.update_fallback({"mode": "total", "selection": SELECTION}, 2, optional_capable=True)
            own_status, own_body = self.disabled_request("own", "deep", True, revision=3)
            self.assertEqual(own_status, 200)
            self.assertTrue(own_body["policy"]["disabled"]["profileFallbacks"]["deep"])
            self.assertTrue(own_body["policy"]["disabled"]["profiles"]["deep"],
                            "the primary slot keeps its independent pause")
            final_status, final_body = self.disabled_request("final", disabled=True, revision=4)
            self.assertEqual(final_status, 200)
            self.assertTrue(final_body["policy"]["disabled"]["finalFallback"])
        # The disabled slot disappears from the effective resolution but stays readable.
        policy = self.store.read()
        resolved = resolve_profile(policy, "deep", CATALOG)
        self.assertEqual(resolved["status"], "hold_disabled")
        self.assertEqual(resolved["resolution_path"], ["deep"])
        self.assertEqual([c["label"] for c in resolved["candidates"] if c["disabled"]], ["deep.main"])
        with urlopen(self.base + "/api/control", timeout=3) as response:
            snapshot = json.load(response)
        self.assertTrue(snapshot["disabled"]["profiles"]["deep"])
        # Without any live MCP connection the capability discovery is honestly False.
        self.assertFalse(snapshot["capabilities"]["slotDisabled"])
        self.assertEqual(snapshot["resolutions"]["deep"]["status"], "hold_disabled")
        # A live schema-5 adapter passes its flag through the snapshot unchanged.
        with patch.object(server, "read_policy_capabilities",
                          return_value={"optionalProfiles": True, "profileFallbacks": True, "slotDisabled": True}), \
             urlopen(self.base + "/api/control", timeout=3) as response:
            snapshot = json.load(response)
        self.assertTrue(snapshot["capabilities"]["slotDisabled"])


class CatalogTest(PolicyTest):
    def test_authenticated_mcp_read_checks_project_and_generation(self):
        root = Path(self.temp.name) / "share"
        root.mkdir(mode=0o700)
        credential = root / "mcp/credential"
        credential.parent.mkdir(parents=True, mode=0o700)
        credential.parent.chmod(0o700)
        credential.write_text("fixture-token\n")
        credential.chmod(0o600)

        class McpFixture(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond({"healthy": True, "project": {"id": "project-hash"}, "generation": "generation"})
            def do_POST(self):
                assert self.headers["X-OCVM-MCP-Token"] == "fixture-token"
                self.respond({"result": {"structuredContent": CATALOG}})
            def respond(self, value):
                data = json.dumps(value).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            def log_message(self, *args): pass

        http = ThreadingHTTPServer(("127.0.0.1", 0), McpFixture)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            runtime = {"enabled": True, "port": http.server_port, "generation": "generation"}
            self.assertEqual(read_catalog(runtime, root, "project-hash"), CATALOG)
            self.assertIsNone(read_catalog(runtime, root, "foreign-project"))
            self.assertEqual(mcp_connection(runtime, root, "foreign-project")["state"], "not_ready")
            self.assertFalse(read_capabilities(mcp_connection(runtime, root, "project-hash")))
        finally:
            http.shutdown(); http.server_close(); thread.join()

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / "adapters/mcp/dist/http.js").is_file(),
                         "MCP adapter has not been built in this checkout")
    def test_real_stateless_mcp_transport_returns_catalog(self):
        root = Path(self.temp.name) / "share"
        root.mkdir(mode=0o700)
        credential = root / "mcp/credential"
        credential.parent.mkdir(parents=True, mode=0o700)
        credential.parent.chmod(0o700)
        credential.write_text("fixture-token\n"); credential.chmod(0o600)
        js = '''import { McpHttpServer } from "./adapters/mcp/dist/http.js";
const runtime = {schema:1,project:process.argv[1],projectHash:"project-hash",projectName:"fixture",
  backendUrl:"http://127.0.0.1:4095",generation:"generation",opencodeVersion:"test",
  listenHost:"127.0.0.1",listenPort:0,credentialFile:"/fixture"};
const gateway = {getSessionRuntimeOptions:async()=>({agents:["build"],...JSON.parse(process.argv[2])})};
const server = new McpHttpServer(runtime,"fixture-token",gateway);
console.log(await server.start());
process.on("SIGTERM",()=>{void server.close().then(()=>process.exit(0));});'''
        process = subprocess.Popen(["node", "--input-type=module", "-e", js, str(self.project), json.dumps(CATALOG)],
                                   cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            port = int(process.stdout.readline().strip())
            runtime = {"enabled": True, "port": port, "generation": "generation"}
            self.assertEqual(read_catalog(runtime, root, "project-hash"), CATALOG)
            self.assertTrue(read_capabilities(mcp_connection(runtime, root, "project-hash")))
        finally:
            process.terminate(); process.communicate(timeout=5)


class SlotCapabilityDetectionTest(unittest.TestCase):
    """task_68085480: real-schema detection regression.

    The greyed-out slot checkboxes were caused by `_supports_slot_disabled`
    reading the wrong schema level (`set(deep_entry)` instead of the entry's
    `properties`). This test runs the detection against the schema SHAPE the MCP
    SDK actually serializes (nested `properties`, `anyOf` schema_version, `oneOf`
    slot selector) and would have failed before the fix. Fixtures that patch
    `read_policy_capabilities` never exercised this path — that was the gap.
    """

    def _tools(self):
        return {
            "get_project_model_policy": {"outputSchema": {"properties": {
                "schema_version": {"anyOf": [{"type": "number", "const": n} for n in (1, 2, 3, 4, 5)]},
                "resolution": {"type": "object", "properties": {}},
                "profiles": {"type": "object", "properties": {
                    "deep": {"type": "object", "properties": {
                        "selection": {}, "status": {}, "disabled": {"type": "boolean"}}},
                }},
            }}},
            "set_project_model_policy_slot_disabled": {"inputSchema": {"properties": {
                "revision": {"type": "number"},
                "slot": {"oneOf": [
                    {"type": "object", "properties": {"kind": {"const": "profile"}}},
                    {"type": "object", "properties": {"kind": {"const": "profile_fallback"}}},
                    {"type": "object", "properties": {"kind": {"const": "final_fallback"}}},
                ]},
                "disabled": {"type": "boolean"},
            }}},
        }

    def test_nested_schema_shape_is_detected(self):
        self.assertTrue(_supports_slot_disabled(self._tools()),
                        "the SDK-serialized (nested) schema must be detected")

    def test_inline_property_shape_is_also_tolerated(self):
        tools = self._tools()
        # Some serializers place field names directly on the entry object.
        tools["get_project_model_policy"]["outputSchema"]["properties"]["profiles"]["properties"]["deep"] = \
            {"selection": {}, "status": {}, "disabled": {"type": "boolean"}}
        self.assertTrue(_supports_slot_disabled(tools))

    def test_missing_tool_or_field_is_false(self):
        tools = self._tools()
        del tools["set_project_model_policy_slot_disabled"]
        self.assertFalse(_supports_slot_disabled(tools), "without the write tool the capability is honestly false")
        tools = self._tools()
        del tools["get_project_model_policy"]["outputSchema"]["properties"]["profiles"]["properties"]["deep"]["properties"]["disabled"]
        self.assertFalse(_supports_slot_disabled(tools), "without the readback disabled flag the capability is false")
        tools = self._tools()
        tools["set_project_model_policy_slot_disabled"]["inputSchema"]["properties"]["disabled"] = {"type": "string"}
        self.assertFalse(_supports_slot_disabled(tools), "a non-boolean disabled field is rejected")


if __name__ == "__main__":
    unittest.main()
