# Changelog

One section per local release candidate. Entries are written at candidate
preparation and describe user/operator-visible contract changes; internal
receipts live in `planning/task-concepts/` documents.

## 0.7.69 (local candidate, unreleased)

- **Delivery path reduced to build, package, publish:** the automated test
  collection was removed from the repository — `tests/**` (python/shell/node
  suites, `tests/fixtures/`, `tests/helpers/`, `tests/agent-managed-v1-spike/`),
  the adapter `src/*.test.ts` sources and `adapters/*/tests/` runners/fixtures,
  the test scripts in `adapters/*/package.json`, and the `chatgpt-skill` /
  `managed-sessions` test workflows. The release workflow now resolves release
  metadata/pins, installs build dependencies, compiles, builds the three
  archives reproducibly, verifies digests and packaged file completeness, writes
  `SHA256SUMS` and publishes the GitHub release. Real build/packaging/upload
  errors still fail; no incomplete or inconsistent release is published.
  OpenLive (0.1.8) and MCP (0.1.59) adapter versions and filenames are
  unchanged; their archive SHA-256 pins were refreshed because the shipped
  `package.json` (test scripts removed) is part of the archives. The Hub pin is
  unchanged.

## 0.7.35 / MCP adapter 0.1.44 / skill 2026-10-12-r52 (local candidate, unreleased)

- **Adaptive monitor progress/investigation strategy** (task_a234c341 V2, package task_e67c39cf): the monitor engine keeps per-worker progress clocks (`worker_key` + `dispatch_receipt` episodes, anchored at the worker's captured dispatch time) with configurable starting values (first check 1 h, cooldown 1 h, long-work ladder 2 h/4 h/8 h cap) settable via the existing `create_monitor`/`update_monitor` tools (`investigation` config with budgets — per-call timeout, byte/call/duration admission control and an optional rolling 24 h `daily_budget` with transparent deferral — plus the task contract: `task_type` with `milestoned` deadline handling and optional `expected_milestone`; degenerate values fail closed). After the configured first check without receipt-correlated progress, the engine runs one budgeted, strictly read-only investigation per wake — scheduled before the no-op and busy gates so a due check is never absorbed. Positive long-work evidence (attributable tool-progress delta on the worker's own receipt, a receipt-correlated management-journal checkpoint — bounded scan, evaluated not claimed — or a re-dispatch) advances the ladder; an investigation result is never progress. Errors, process loss and generation changes override the clock without a false progress reset.
- **Wake-claim recovery** (§13.8): monitor wake claims now carry owner fencing (`owner_pid`/`owner_generation`); a boot sweep releases an orphaned claim only with heartbeat evidence of the owner generation gone stale, reconciling an uncertain dispatch through the existing WAL path first (unresolved → `dispatch-uncertain` park, never a silent release). Fresh heartbeats of the owner generation and identity-less legacy claims are never released.
- **Two-phase cheap observer** (§13.7): phase 1 is registry-only (due evaluation, `wake_request` handover, stuck-claim visibility); phase 2 adds tightly bounded receipt-correlated status probes while a wake is in flight (≤ 3 per batch, 30 s throttle, per-call timeout) so fresh evidence persists even when the previous wake blocks on its own await — the observer never sends, recovers, aborts or releases a living owner.
- **Orchestrator skill r52** (task_4ae1d182 remainder): shared three-state communication vocabulary (`CURRENT_TURN_WAIT`/`ON_DEMAND_STATUS`/`PROACTIVE_MONITORING`, new `references/communication-states.md`) with verified-hops-only notification rules — engine decisions are readable on demand, never pushed; dedicated monitoring regression rows; monitor reporting learns the new investigation states with honest non-progress wording.
- Hub remains unchanged (additive registry fields are preserved byte-stably across Hub mutations, verified by `tests/hub_crosswriter_test.py`); OpenLive unchanged; no new fallback, push, or scheduling infrastructure.
