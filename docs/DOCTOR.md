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
doctor resources    # ENFILE time protocol: guest file-table/FD/watcher history
doctor help         # usage text
```

The host-side CLI stays as it is:

```bash
opencode-vm doctor [show]   # host state: sync/auth/model/db, skills, MCPs, connector
                            # plus a "Resources (ENFILE time protocol)" section
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

## ENFILE time protocol (`doctor resources`)

Because `ENFILE` incidents are short-lived, the doctor also reads a small,
bounded **resource history** instead of only the current instant:

- One lean host sampler runs for the session duration (started on start/attach,
  stopped cooperatively on cleanup via a sentinel — never a signal, no new
  service or monitoring framework). Each tick it records the *host* sample
  (global file table, host config limits, and — on Linux, or on macOS above a
  cost threshold — the top FD consumers) and asks the VM for one *guest*
  sample through the existing VM transport. Host and guest keep **separate
  histories and identities** on a **shared UTC time base**; there is no
  cross-side merge.
- At most **one guest probe is in flight for the whole project**, across all
  samplers and VM generations: a host-project-persistent probe record is bound
  to the actual transport PID through its start marker, so a hung transport
  (which is never signalled) cannot accumulate orphans over repeated
  start/stop cycles. While a probe record is live (or its ownership cannot be
  verified) no new probe starts; a dead/reused record is reclaimed. The host
  sample's `coverage.guest_probe` and the report expose the probe state
  (`none`/`in_flight`/`stale`/`unknown`/`invalid`) — **a missing or unknown
  guest is never reported as healthy**, while host measurement continues.
- Guest history is **VM-local** (`~/.local/state/ocvm/resmon/guest.jsonl`,
  ext4, outside the mount suspected of `ENFILE`); host history is host-local
  under the project state dir. Both are capped (per line and per file, one
  rotation) and mode `0600` in a `0700` dir. A sample is only ever written as a
  complete, schema-valid object: an oversize sample is structurally shrunk
  (excess processes dropped, schema preserved) or, if it still cannot fit,
  dropped entirely — **never raw-truncated**. On macOS only **numeric** file
  descriptors are counted; `lsof` mapping entries (`cwd`/`txt`/`mem`) are not
  FDs and are ignored.
- The report separates **global / process / watcher** limits and shows the
  current value, the **evidenced peak with its time and causer**, growth over
  the window, and proximity to the limit. A low current value **never** clears
  a historic peak. `max_user_watches` is reported as a **user** limit, not a
  process limit; shell/`launchctl` values are labelled as config values, never
  as a process's own limit. Missing / unreadable / stale / partial history is
  explicit, and the read window is stated (older peaks are not "excluded").
- The precise `ENFILE` **error site** is read from the existing
  `mcp/adapter.log` and `monitor/server.log`: the event time comes from the log
  line when present, otherwise the observation (log mtime) is labelled as such
  — no invented time.
- Read-only: the sampler reads `/proc`, `sysctl` and the existing logs; it never
  changes limits, signals or restarts anything, and it reads **no secrets, no
  environment and no full command lines**. Reading other-uid process FD counts
  would need root and is deliberately **not** enabled — that is reported as an
  honest coverage/permission gap, not silently escalated.

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
