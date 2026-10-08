"""Disposable Hub with deterministic catalog; real HTTP and policy persistence."""
import json
from pathlib import Path
import tempfile

import hub.server as server

# Deliberately unsorted, mixed-case and with duplicate display names: every model
# picker must sort alphabetically by displayed name (case-insensitive, stable, with
# a deterministic model_id/provider_id tie-breaker) while provider separation and
# all IDs/variants stay exactly as delivered by the catalog.
CATALOG = {"providers": [{"provider_id": "fixture", "name": "Fixture Provider"},
                         {"provider_id": "other", "name": "Other Provider"}],
           "models": [{"provider_id": "fixture", "model_id": "family/model", "name": "Representative development model",
                       "variants": ["default", "high"]},
                      {"provider_id": "fixture", "model_id": "family/long-" + "model-name-" * 15,
                       "name": "Long model name · " + "representative " * 15, "variants": ["default", "high"]},
                      {"provider_id": "fixture", "model_id": "family/beta", "name": "beta reasoning model",
                       "variants": ["default", "high"]},
                      {"provider_id": "fixture", "model_id": "family/alpha", "name": "Alpha reasoning model",
                       "variants": ["default", "high"]},
                      {"provider_id": "fixture", "model_id": "family/dup-b", "name": "Duplicate display name",
                       "variants": ["default"]},
                      {"provider_id": "fixture", "model_id": "family/dup-a", "name": "duplicate display name",
                       "variants": ["default"]},
                      {"provider_id": "other", "model_id": "other/zeta", "name": "Zeta model",
                       "variants": ["default"]},
                      {"provider_id": "other", "model_id": "other/alpha", "name": "alpha model",
                       "variants": ["default"]}], "truncated": False}

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="ach1-fixture-") as temporary:
        root = Path(temporary)
        server.PROJECT = root / "project"; server.PROJECT.mkdir()
        server.SESSION_ROOT = root / "share"; server.SESSION_ROOT.mkdir(mode=0o700)
        server.RUNTIME = {
            "generation": "ach1-fixture",
            "mcp": {"enabled": False, "port": 0, "generation": "ach1-fixture"},
            "tunnelConfigured": False,
            "openliveConfigured": False,
            "a2aEnabled": False,
        }
        server.AUTH_CREDENTIALS = None
        server.REQUEST_SCHEME = "http"
        server.read_catalog = lambda *args, **kwargs: CATALOG
        server.read_capabilities = lambda *args: True
        server.read_policy_capabilities = lambda *args: {"optionalProfiles": True, "profileFallbacks": True}
        server.read_schema4_capabilities = lambda *args: True
        http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        print(json.dumps({"port": http.server_port, "project": str(server.PROJECT)}), flush=True)
        try:
            http.serve_forever()
        finally:
            http.server_close()
