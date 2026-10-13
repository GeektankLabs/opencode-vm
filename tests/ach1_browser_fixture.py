"""Disposable Hub with deterministic catalog; real HTTP and policy persistence."""
import json
from pathlib import Path
import tempfile

import hub.server as server
import hub.catalog as catalog

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

# Static tools/list schema in the shape the MCP SDK actually serializes (nested
# `properties`, `anyOf` schema_version, `oneOf` slot selector). The Hub's REAL
# capability detection (`hub.catalog._supports_*`) runs against this instead of
# patched capability functions, so the browser flow exercises detection and UI
# together (task_68085480).
def _profile_entry():
    return {"type": "object", "properties": {"selection": {"type": "object"}, "status": {"type": "string"}, "disabled": {"type": "boolean"}}}


STATIC_TOOLS = {
    "get_recommended_runtime": {
        "inputSchema": {"properties": {"profile": {"enum": ["deep", "standard", "execution", "design", "review"]}}},
        "outputSchema": {"properties": {"resolution_path": {"type": "array"}, "resolved_profile": {"type": "string"}, "resolved_label": {"type": "string"}}},
    },
    "get_project_model_policy": {"outputSchema": {"properties": {
        "schema_version": {"anyOf": [{"type": "number", "const": n} for n in (1, 2, 3, 4, 5)]},
        "resolution": {"type": "object", "properties": {}},
        "profiles": {"type": "object", "properties": {name: _profile_entry() for name in ("deep", "standard", "execution", "design", "review")}},
        "profile_fallbacks": {"type": "object", "properties": {}},
        "strategies": {"type": "object", "properties": {"degrading": {"type": "boolean"}, "provider_skip": {"type": "boolean"}}},
        "routing": {"type": "object", "properties": {"regime": {"type": "string"}, "legacy_final_stage_applies": {"type": "boolean"},
                                                     "strategies_effective": {"type": "object"}, "candidate_order": {"type": "object"}}},
    }}},
    "set_project_model_policy_profile_fallback": {"inputSchema": {"properties": {"revision": {"type": "number"}, "profile": {"type": "string"}, "fallback": {"type": "object"}}}},
    "set_project_model_policy_strategies": {"inputSchema": {"properties": {"revision": {"type": "number"},
        "strategies": {"type": "object", "properties": {"degrading": {"type": "boolean"}, "provider_skip": {"type": "boolean"}}}}}},
    "set_project_model_policy_slot_disabled": {"inputSchema": {"properties": {"revision": {"type": "number"},
        "slot": {"oneOf": [{"type": "object", "properties": {"kind": {"const": "profile"}}},
                           {"type": "object", "properties": {"kind": {"const": "profile_fallback"}}},
                           {"type": "object", "properties": {"kind": {"const": "final_fallback"}}}]},
        "disabled": {"type": "boolean"}}}},
}


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
        # Capability discovery runs for real against ONE static tools/list schema
        # (see STATIC_TOOLS) instead of patching the capability functions.
        catalog._tools_list = lambda connection: STATIC_TOOLS
        http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        print(json.dumps({"port": http.server_port, "project": str(server.PROJECT)}), flush=True)
        try:
            http.serve_forever()
        finally:
            http.server_close()
