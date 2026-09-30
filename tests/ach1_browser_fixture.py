"""Disposable Hub with deterministic catalog; real HTTP and policy persistence."""
import json
from pathlib import Path
import tempfile

import hub.server as server

CATALOG = {"providers": [{"provider_id": "fixture", "name": "Fixture Provider"}],
           "models": [{"provider_id": "fixture", "model_id": "family/model", "name": "Representative development model",
                       "variants": ["default", "high"]},
                      {"provider_id": "fixture", "model_id": "family/long-" + "model-name-" * 15,
                       "name": "Long model name · " + "representative " * 15, "variants": ["default", "high"]}], "truncated": False}

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="ach1-fixture-") as temporary:
        root = Path(temporary)
        server.PROJECT = root / "project"; server.PROJECT.mkdir()
        server.SHARE_ROOT = root / "share"; server.SHARE_ROOT.mkdir()
        server.read_catalog = lambda *args, **kwargs: CATALOG
        server.read_capabilities = lambda *args: True
        server.vm_running = lambda *args: None
        http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        print(json.dumps({"port": http.server_port, "project": str(server.PROJECT)}), flush=True)
        try:
            http.serve_forever()
        finally:
            http.server_close()
