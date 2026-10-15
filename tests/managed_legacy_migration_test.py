"""Maintained legacy-adoption migration regression; disposable fixtures only.

Covers the 0.7.42 scopeDirs-field migration in runtime/managed-policy.mjs:
sessions adopted by pre-0.1.45 writers persisted otherwise-valid revision-1
entries without the scopeDirs field and failed every later adoption with
MANAGED_STATE_REVISION_UNSUPPORTED (adapter surfaces it as
BACKEND_INCOMPATIBLE before any prompt). Legacy entries are produced the
realistic way — adopted by the current writer, then the scopeDirs field is
stripped from the store between server restarts, exactly matching the
pre-0.1.45 writer shape. No origin, credentials or real publishing.
"""
import hashlib
import json
from pathlib import Path
from helpers.managed_runtime import Runtime

ADOPTED_AT = "2026-08-01T00:00:00.000Z"
RICH_ADOPTED_AT = "2026-08-02T00:00:00.000Z"


def store_path(fixture):
    digest = hashlib.sha256(str(fixture.project).encode()).hexdigest()
    return Path(fixture.env["XDG_DATA_HOME"]) / "opencode" / "managed-sessions" / f"{digest}.json"


def adopt_raw(fixture, sid, scope_dirs=None):
    import http.client
    import socket as socket_mod
    connection = http.client.HTTPConnection("localhost", timeout=10)
    connection.sock = socket_mod.socket(socket_mod.AF_UNIX, socket_mod.SOCK_STREAM)
    connection.sock.connect(fixture.socket)
    payload = {"session_id": sid, "ingress": "mcp"}
    if scope_dirs is not None:
        payload["scope_dirs"] = scope_dirs
    connection.request("POST", "/adopt", json.dumps(payload), {"Content-Type": "application/json"})
    response = connection.getresponse()
    data = json.loads(response.read())
    connection.close()
    return response.status, data


def legacy_shape(entry, adopted_at):
    """Strip the scopeDirs field, pre-0.1.45 writer shape (4db0ace era)."""
    legacy = {key: entry[key] for key in entry if key not in ("scopeDirs", "scopeReadFiles")}
    assert "scopeDirs" not in legacy and set(legacy) >= {"revision", "adoptedAt", "base", "disabled", "lastNative"}
    legacy["adoptedAt"] = adopted_at
    return legacy


def read_store(fixture):
    return json.loads(store_path(fixture).read_text())["sessions"]


def check():
    fixture = Runtime()
    try:
        fixture.start()
        plain = fixture.session()
        rich = fixture.session(permission=[{"permission": "edit", "pattern": "*", "action": "deny"}])
        nullbad = fixture.session()
        typebad = fixture.session()
        # First, ordinary adoption by the current writer: realistic baseline
        # entries (native rules + managed tail) to strip the field from.
        fixture.adopt(plain)
        fixture.adopt(rich)
        plain_entry = read_store(fixture)[plain]
        rich_entry = read_store(fixture)[rich]
        assert plain_entry["scopeDirs"] == [] and rich_entry["scopeDirs"] == []
        plain_rules = fixture.api("GET", f"/session/{plain}")["permission"]
        fixture.stop()

        # Rewrite the adopted entries to the pre-0.1.45 legacy shape; the two
        # malformed entries are seeded directly in the same otherwise-valid
        # shape (unprepared sessions have an empty native list). All four live
        # in one store, as on real upgraded projects.
        store = store_path(fixture)
        sessions = read_store(fixture)
        sessions[plain] = legacy_shape(plain_entry, ADOPTED_AT)
        sessions[rich] = legacy_shape(rich_entry, RICH_ADOPTED_AT)
        # A pre-0.1.45 entry can also carry an explicit tool disable from its
        # message.tools handling; inject one to prove it survives migration
        # and stays effective through the delta path.
        sessions[rich]["disabled"] = {"question": True}
        for sid in (nullbad, typebad):
            sessions[sid] = {"revision": 1, "adoptedAt": ADOPTED_AT, "base": [], "disabled": {}, "lastNative": []}
        sessions[nullbad]["scopeDirs"] = None
        sessions[typebad]["scopeDirs"] = "/srv/data"
        store.write_text(json.dumps({"schema": 1, "project": str(fixture.project), "sessions": sessions}))

        fixture.start()
        # LegacyAdopt: the reported failure path (re-adopt of a scopeDirs-less
        # entry) now succeeds and is lazily normalized to an empty scope.
        status, data = adopt_raw(fixture, plain)
        assert status == 200 and data["agent_managed"] is True, (status, data)
        saved = read_store(fixture)
        # noDeltaPersist: the managed tail is already in place, so this
        # re-prepare had an empty policy delta — the persisted migration
        # proves the explicit migrated-flag persistence.
        assert saved[plain] == {**sessions[plain], "scopeDirs": [], "scopeReadFiles": []}, saved[plain]
        assert saved[plain]["base"] == plain_entry["base"] and saved[plain]["lastNative"] == plain_entry["lastNative"] and saved[plain]["disabled"] == plain_entry["disabled"], "stored rules stay verbatim"
        # Lazy migration touches only the queried session.
        assert saved[nullbad] == sessions[nullbad] and saved[typebad] == sessions[typebad], "unqueried entries must not be rewritten"
        assert saved[rich]["adoptedAt"] == RICH_ADOPTED_AT, "unqueried rich entry must not be rewritten yet"
        # keinexternalAllow: normalization grants no external rule.
        assert fixture.api("GET", f"/session/{plain}")["permission"] == plain_rules
        print("PASS legacy re-adopt, empty-delta persist, lazy per-session migration", flush=True)

        # Rich legacy entry: stored deny + disabled map survive verbatim and
        # stay effective through the delta path.
        status, _ = adopt_raw(fixture, rich)
        assert status == 200, status
        saved = read_store(fixture)
        assert saved[rich]["adoptedAt"] == RICH_ADOPTED_AT, "adoptedAt must be preserved through migration"
        assert saved[rich]["disabled"] == sessions[rich]["disabled"], "disabled map must be preserved"
        assert saved[rich]["scopeDirs"] == [] and saved[rich]["base"] == sessions[rich]["base"], saved[rich]
        rules = fixture.api("GET", f"/session/{rich}")["permission"]
        assert any(r["permission"] == "edit" and r["action"] == "deny" for r in rules), rules
        assert any(r["permission"] == "question" and r["action"] == "deny" for r in rules), rules
        print("PASS legacy adopt preserves deny/disabled/adoptedAt/base rules", flush=True)

        # repeat/idempotent: a second adoption neither changes the session
        # rules nor rewrites the persisted entry.
        status, _ = adopt_raw(fixture, plain)
        assert status == 200
        assert fixture.api("GET", f"/session/{plain}")["permission"] == plain_rules
        assert read_store(fixture)[plain] == saved[plain], "idempotent repeat must not rewrite the store"
        print("PASS repeat adoption stays idempotent", flush=True)

        # malformed/null still fail closed and never migrate the store.
        for sid in (nullbad, typebad):
            status, data = adopt_raw(fixture, sid)
            assert status == 409 and "MANAGED_STATE_REVISION_UNSUPPORTED" in data["error"], (status, data)
        assert read_store(fixture)[nullbad] == sessions[nullbad]
        assert read_store(fixture)[typebad] == sessions[typebad]
        print("PASS null/wrong-type scopeDirs still fail closed", flush=True)

        # restart: the persisted migration feeds a freshly loaded plugin; a
        # normal message (the send_message path) works without re-adopting and
        # leaves the migrated entry untouched.
        fixture.start()
        future = fixture.prompt(plain, "migrated-answer", ["Migrated session answered after restart"])
        fixture.finish(future, plain)
        assert read_store(fixture)[plain] == saved[plain], "restart prompt must not rewrite the migrated entry"
        print("PASS restart uses the persisted migration for ordinary messages", flush=True)

        # foreignChangeReject: divergence between the stored native-rules
        # snapshot and the actual native rules (the observable condition the
        # ownership prefix check protects; the plugin reads the store only at
        # startup, so the divergence is injected into the fixture store and
        # activated by a restart — never into product code) still refuses
        # adoption and leaves the store unchanged.
        tampered = dict(read_store(fixture)[plain])
        tampered["lastNative"] = [{"permission": "edit", "pattern": "*", "action": "deny"}]
        tampered["base"] = list(tampered["lastNative"])
        store.write_text(json.dumps({"schema": 1, "project": str(fixture.project), "sessions": {**read_store(fixture), plain: tampered}}))
        fixture.start()
        status, data = adopt_raw(fixture, plain)
        assert status == 409 and "MANAGED_POLICY_REPLACED_EXTERNALLY" in data["error"], (status, data)
        assert read_store(fixture)[plain] == tampered
        print("PASS foreign rule divergence still rejected without store writes", flush=True)

        # New-state behavior unchanged: normal adoption with an explicit scope
        # works, and a migrated entry can still gain an authorized scope
        # (the migrated snapshot is restored first so the ownership prefix
        # check passes again).
        store.write_text(json.dumps({"schema": 1, "project": str(fixture.project), "sessions": {**read_store(fixture), plain: saved[plain]}}))
        fixture.start()
        fresh = fixture.session()
        fixture.adopt(fresh, scope_dirs=[str(fixture.root)])
        assert read_store(fixture)[fresh]["scopeDirs"] == [str(fixture.root)]
        status, _ = adopt_raw(fixture, plain, scope_dirs=[str(fixture.root)])
        assert status == 200
        assert read_store(fixture)[plain]["scopeDirs"] == [str(fixture.root)]
        print("PASS new-state scope adoption and migrated-entry scope gain unchanged", flush=True)
    finally:
        fixture.close()


if __name__ == "__main__":
    check()
