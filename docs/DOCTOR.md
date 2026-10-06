# VM-local `doctor` — compact focused diagnostics without MCP access

Every opencode-vm session VM ships a bare `doctor` command on PATH
(`~/.local/bin/doctor`). It produces one compact, copy-pastable, strictly
read-only report about **this VM, this project and this session generation**.
It complements — never replaces — the host-side `opencode-vm doctor`, which
inspects host sync/auth/model/db state and needs `limactl`.

There is exactly **one canonical diagnosis path**: the library staged at
`<session-share>/lib/doctor.sh` (materialized by `install_doctor_lib` on every
session start/attach, so older sessions heal on their next start). The PATH
entry is a thin wrapper that only discovers the session share from real mount
metadata (`/proc/mounts` virtiofs entries), sources the library and dispatches
one area. All report logic lives in the library. The wrapper hands its
resolved share to `doctor_main`, and the library re-verifies it against its
own mount discovery; divergent views fail closed (exit 3) instead of
diagnosing a different share than the one that was sourced.

## Usage

```bash
# From ANY directory inside a fresh session VM shell — no cd, no env needed:
doctor              # full report (same as: doctor show)
doctor tunnel       # MCP tunnel focus (reuses the canonical guest tunnel status)
doctor mcp          # OpenCode backend + incoming MCP adapter focus
doctor services     # guest services/units/PIDs/listeners focus
doctor help         # usage text
```

The host-side CLI stays as it is:

```bash
opencode-vm doctor [show]   # host state: sync/auth/model/db, skills, MCPs, connector
```

## What the report covers

- **Identity first:** VM hostname, session share, project path, project hash
  and generation — resolved from real runtime metadata (`/proc/mounts`,
  `mcp/runtime.json`, `mcp/ready.json`, systemd unit descriptions) and
  cross-checked (`md5(project) == share id`, generation consistency).
  Multiple mounted session shares are reported **AMBIGUOUS** with all
  candidates listed — the doctor never picks one arbitrarily. Stale or
  mixed-generation descriptors are flagged explicitly.
- **Versions and provenance (guest-provable only):** `opencode --version`
  cross-checked against descriptor and live health values; script version as
  staged (`lib/doctor.env`) and, when the OpenLive gateway runs, live from
  `/openlive/info`; staged MCP adapter version + managed-staging marker;
  tunnel-client, taskboard, editor and hub-asset directories. Installation
  vs. checkout is a host-side fact and is reported `UNVERIFIED` honestly —
  never invented.
- **Services with separated dimensions:** each service line keeps
  `config | process | readiness | last-success` apart (opencode-server,
  web-front, mcp-adapter, mcp-tunnel, hub, dashboard, editor, taskboard, a2a,
  openlive-gateway, session-runtime). Missing files or rights degrade that
  section to `UNVERIFIED(reason)`; the run never aborts globally.
- **Last proven tool roundtrip:** only a *completed* adapter tool trace
  (`[mcp] call=…` `"state":"completed"` lines in `mcp/adapter.log`) counts as
  proof. Activity-journal `message.completed` events are shown separately and
  explicitly labeled as worker events — not tool proof, not E2E.
- **Bounded, redacted excerpts:** last lines of adapter/tunnel/backend/hub/
  dashboard logs, each byte- and line-bounded and passed through the
  redaction filter. Error codes, failure reasons and support IDs
  (request/session/message identifiers) are reported; secrets are not.

Every report ends with `PASS/FAIL/UNVERIFIED` counts, the used time/line
budget and the standing notice that these are **local checks only — not a
ChatGPT/E2E acceptance**.

## Guarantees and limits

- **Read-only, no repair:** no writes, no temp files, no unit or process
  mutation, no signals to foreign processes, no restarts. Only loopback
  health GETs and the tunnel health Unix socket are probed; every probe is
  time-bounded (2 s default, 15 s total wall budget, 150 report lines).
- **No MCP access:** the doctor never calls MCP tools, boards, sessions or
  LLMs, and dispatches no work. Adapter checks use the same authenticated
  `/healthz` readiness contract as the existing host doctor.
- **Secrets:** tokens, tunnel keys, passwords, JWTs, `sk-…`/`ghp_…`-style
  keys, `Authorization`/`Basic` headers are never printed — the single output
  chokepoint redacts every foreign line (including error paths), known
  credential values are additionally scrubbed from the buffered report before
  it is printed, and the adapter token reaches `curl` only through stdin
  (`--config -`), never through argv. Credential files are read only as far as
  an internal health probe requires and are never echoed. Whole `auth.json`,
  tunnel keys or environment dumps are never read.
- **Exit codes:** `0` report without FAIL (UNVERIFIED allowed) · `1` at least
  one FAIL dimension · `2` usage error · `3` identity ambiguous/unresolved
  (candidates are still printed) · `4` canonical library not staged (older
  session — re-start/attach heals it).
- Foreign-owned systemd units (description does not reference this session
  share) are reported and **left untouched**.

## Headless testing

`tests/vm_doctor_test.sh` exercises the wrapper and the materialized library
without Lima, VMs or network: identity selection (single/zero/multiple/stale/
foreign), cwd independence, redaction (planted secrets, stdin-vs-argv proof,
corrupt-JSON error paths), absence and permission degradation, stopped
adapter, absent OpenCode, global wall budget, line budget, worker-event vs.
tool-trace labeling, no-mutation byte/mode preservation, `bash -n` and
`shellcheck --severity=error` on the materialized payloads, plus wrapper
install idempotence/drift and staging regressions. Native fresh-Mac/Lima
shell acceptance and real end-to-end runs remain separate NOT_RUN/UNVERIFIED
gates.
