#!/usr/bin/env bash
# ENFILE time protocol (resmon): bounded append (valid-schema guarantee), host
# sampler, scheduler read, ownership/idempotent start, cooperative stop, and an
# end-to-end real-sample -> append -> render path. Headless; no VM, no network.
# The Linux host sample runs against the real /proc; Darwin is exercised with
# mocked uname/sysctl/launchctl and a stub lsof. Fixtures are NOT a real
# Mac/Lima acceptance.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
# On any exit (incl. a failed assertion) stop this test's own sampler
# cooperatively and remove the temp tree — never leave an orphan loop behind.
trap '
  if command -v resmon_stop >/dev/null 2>&1; then
    resmon_stop "${PROJ:-}" >/dev/null 2>&1 || true
    resmon_stop "${PROJ2:-}" >/dev/null 2>&1 || true
  fi
  [ -n "${PROBE_DONE:-}" ] && : > "$PROBE_DONE" 2>/dev/null || true
  rm -rf "$TMP"
' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME" "$TMP/project"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
if [[ "$(uname -s)" == Linux ]]; then
  md5() { md5sum | cut -d' ' -f1; }
  export -f md5
fi
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
perms() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
PROJ="$TMP/project"
mkdir -p "$PROJ/.opencode-vm/monitor"

# --- F5: the script keeps its executable bit --------------------------------
[[ -x "$ROOT/opencode-vm.sh" ]] || fail "opencode-vm.sh is not executable"
pass "opencode-vm.sh retains the executable bit (mode fix)"

# --- payload hygiene: guest sampler is syntactically valid ------------------
[[ -n "${OCVM_RESMON_COLLECT_SH:-}" ]] || fail "OCVM_RESMON_COLLECT_SH missing"
printf '%s\n' "$OCVM_RESMON_COLLECT_SH" > "$TMP/collect.sh"
bash -n "$TMP/collect.sh" || fail "collect payload bash -n"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck --severity=error -s bash "$TMP/collect.sh" || fail "collect payload shellcheck"
fi
pass "guest sampler payload passes bash -n and shellcheck --severity=error"

# --- F1: bounded append never writes raw-truncated / invalid JSON ------------
f="$TMP/host.jsonl"
# valid sample round-trips with modes preserved
good='{"schema":1,"t":"2026-10-14T00:00:00Z","te":1,"side":"host","global":{"used":10,"max":100},"procs":[],"coverage":{"procs_scanned":1,"procs_total":1,"fd_unreadable":0,"top_scan":"full(/proc)","note":""}}'
resmon_host_append_bounded "$f" "$good"
[[ -f "$f" ]] || fail "valid sample was not written"
printf '%s' "$(tail -n1 "$f")" | jq -e 'type=="object"' >/dev/null || fail "written sample is not valid JSON"
[[ "$(perms "$f")" == "600" ]] || fail "history file not 0600"
[[ "$(perms "$(dirname "$f")")" == "700" ]] || fail "history dir not 0700"
# invalid JSON is dropped, never truncated into the file
before="$(wc -l < "$f")"
resmon_host_append_bounded "$f" 'this is not json {{{'
[[ "$(wc -l < "$f")" == "$before" ]] || fail "invalid JSON was written"
# oversize valid JSON is structurally shrunk (schema preserved), not cut
RESMON_MAX_SAMPLE_BYTES=600
big=$(jq -cn '{schema:1,t:"2026-10-14T00:00:00Z",te:1,side:"host",global:{used:1,max:2},procs:[range(0;8)|{pid:.,comm:"a-very-long-process-name-xxxxxxxxxxxxxxxx",fds:.,limit:1024}],coverage:{procs_scanned:1,procs_total:1,fd_unreadable:0,top_scan:"full(/proc)",note:""}}')
[[ "$(printf '%s' "$big" | wc -c)" -gt 600 ]] || fail "fixture not actually oversize"
nlines="$(wc -l < "$f")"
resmon_host_append_bounded "$f" "$big"
[[ "$(wc -l < "$f")" == "$((nlines + 1))" ]] || fail "shrink did not add exactly one line"
last="$(tail -n1 "$f")"
printf '%s' "$last" | jq -e 'type=="object" and (.procs|type=="array") and (.procs|length)<=3' >/dev/null || fail "shrunk sample invalid schema"
[[ "$(printf '%s' "$last" | wc -c)" -le 601 ]] || fail "shrunk sample still exceeds cap"
# a still-too-large object after shrink is dropped, not cut
RESMON_MAX_SAMPLE_BYTES=60
nlines="$(wc -l < "$f")"
huge=$(jq -cn '{schema:1,t:"2026-10-14T00:00:00Z",te:1,side:"host",global:{used:1,max:2},procs:[range(0;8)|{pid:.,comm:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}],coverage:{note:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}')
resmon_host_append_bounded "$f" "$huge"
[[ "$(wc -l < "$f")" == "$nlines" ]] || fail "unsrhrinkable oversize was written"
if tail -n1 "$f" | grep -q '\.\.\.'; then fail "raw truncation marker found"; fi
# rotation at file cap (one rotation, hard bound)
RESMON_MAX_SAMPLE_BYTES=4096 RESMON_FILE_CAP_BYTES=64
g="$TMP/rot.jsonl"
resmon_host_append_bounded "$g" "$good"
resmon_host_append_bounded "$g" "$good"
[[ -f "$g.1" ]] || fail "rotation at cap did not produce .1"
pass "bounded append: valid-schema guarantee, structural shrink, drop, rotation, modes"

# --- F1 end-to-end: real sampler -> append -> renderer ----------------------
eval "$OCVM_RESMON_COLLECT_SH"
eval "$OCVM_RESMON_RENDER_SH"
RESMON_MAX_SAMPLE_BYTES=4096 RESMON_FILE_CAP_BYTES=2097152
real="$(resmon_guest_sample)"
printf '%s' "$real" | jq -e 'type=="object"' >/dev/null || fail "real sample invalid"
rh="$TMP/e2e.jsonl"
resmon_append_bounded "$rh" "$real"
printf '%s' "$(tail -n1 "$rh")" | jq -e 'type=="object"' >/dev/null || fail "appended real sample invalid"
out="$(resmon_render_history "$rh" guest)"
printf '%s\n' "$out" | grep -q 'guest history: present samples=1' || fail "renderer did not find the real sample"
printf '%s\n' "$out" | grep -q 'global files: used=' || fail "renderer did not print the recorded global metric"
printf '%s\n' "$out" | grep -q 'process fd peak: pid=' || fail "renderer did not print the recorded process metric"
pass "end-to-end real sample -> append -> renderer records schema-valid required metrics"

# --- scheduler read: real registry shape monitors[].state.work ---------------
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"schema":1,"projectHash":"h","generation":"g","pid":1,"at":"%s"}\n' "$now" > "$PROJ/.opencode-vm/monitor/heartbeat.json"
printf '{"schema":1,"generation":5,"monitors":[{"id":"m1","state":{"work":"active"}},{"id":"m2","state":{"work":"parked_input_required"}}]}\n' > "$PROJ/.opencode-vm/monitor/registry.json"
s="$(resmon_sched_json "$PROJ")"
[[ "$(printf '%s' "$s" | jq -r .heartbeat_fresh)" == "true" ]] || fail "fresh heartbeat not detected"
[[ "$(printf '%s' "$s" | jq -r .work_state)" == "active,parked_input_required" ]] || fail "state.work not read from real schema"
# missing registry -> null, not a crash
rm -f "$PROJ/.opencode-vm/monitor/registry.json"
s="$(resmon_sched_json "$PROJ")"
[[ "$(printf '%s' "$s" | jq -r .work_state)" == "null" ]] || fail "missing registry not null"
# unreadable registry -> null
printf '{"monitors":[]}\n' > "$PROJ/.opencode-vm/monitor/registry.json"; chmod 000 "$PROJ/.opencode-vm/monitor/registry.json"
s="$(resmon_sched_json "$PROJ")"
[[ "$(printf '%s' "$s" | jq -r .work_state)" == "null" ]] || fail "unreadable registry not null"
chmod 600 "$PROJ/.opencode-vm/monitor/registry.json"; rm -f "$PROJ/.opencode-vm/monitor/registry.json" "$PROJ/.opencode-vm/monitor/heartbeat.json"
# stale heartbeat -> false
printf '{"schema":1,"generation":"g","at":"2000-01-01T00:00:00Z"}\n' > "$PROJ/.opencode-vm/monitor/heartbeat.json"
[[ "$(resmon_sched_json "$PROJ" | jq -r .heartbeat_fresh)" == "false" ]] || fail "stale heartbeat not detected"
rm -f "$PROJ/.opencode-vm/monitor/heartbeat.json"
pass "scheduler read: real monitors[].state.work, multiple/missing/unreadable, fresh vs stale"

# --- F2: Darwin lsof counts ONLY numeric fds --------------------------------
uname() { printf 'Darwin'; }
sysctl() { case "${2:-}" in kern.num_files) printf 122759;; kern.maxfiles) printf 491520;; kern.maxfilesperproc) printf 245760;; *) printf 0;; esac; }
launchctl() { printf '\tmaxfiles    256            unlimited\n'; }
mkdir -p "$TMP/bin"
cat > "$TMP/bin/lsof" <<'LSOF'
#!/usr/bin/env bash
# PID 999: 4 numeric fds plus cwd/txt/mem mapping entries (must be ignored).
# PID 1000: only mapping entries (0 numeric fds -> not reported).
printf 'p999\ncnode\nfcwd\nftxt\nfmem\nf0\nf1\nf2\nf3\np1000\ncbash\nfcwd\nftxt\n'
LSOF
chmod +x "$TMP/bin/lsof"
PATH="$TMP/bin:$PATH"
RESMON_HOST_TOP_PCT=0
d="$(resmon_host_sample "$PROJ" vm-x gen-x)"
[[ "$(printf '%s' "$d" | jq -r .os)" == "Darwin" ]] || fail "darwin os"
[[ "$(printf '%s' "$d" | jq -r '.procs|length')" == "1" ]] || fail "mapping-only pid must not be reported"
[[ "$(printf '%s' "$d" | jq -r '.procs[0].pid')" == "999" ]] || fail "darwin top pid"
[[ "$(printf '%s' "$d" | jq -r '.procs[0].fds')" == "4" ]] || fail "darwin must count 4 numeric fds, not mapping entries"
[[ "$(printf '%s' "$d" | jq -r '.procs[0].limit')" == "null" ]] || fail "darwin process limit must stay unknown, not a config value"
[[ "$(printf '%s' "$d" | jq -r '.limits.maxfilesperproc')" == "245760" ]] || fail "darwin maxfilesperproc config value"
[[ "$(printf '%s' "$d" | jq -r '.identity.host')" != "null" ]] || fail "host identity empty"
[[ "$(printf '%s' "$d" | jq -r '.identity.vm')" == "vm-x" ]] || fail "host identity vm"
# below threshold -> costly scan skipped, honest
RESMON_HOST_TOP_PCT=100
[[ "$(resmon_host_sample "$PROJ" vm-x gen-x | jq -r '.coverage.top_scan')" == skipped* ]] || fail "darwin skipped top_scan"
pass "Darwin host sample: numeric fd counting (mapping entries excluded), identity, cost gate"

# --- Linux host sample: real /proc, honest coverage -------------------------
uname() { printf 'Linux'; }
n="$(resmon_host_sample "$PROJ" vm-y gen-y)"
printf '%s' "$n" | jq -e . >/dev/null 2>&1 || fail "linux host sample is not JSON"
[[ "$(printf '%s' "$n" | jq -r .side)" == "host" ]] || fail "side must be host"
[[ "$(printf '%s' "$n" | jq -r '.coverage.top_scan')" == "full(/proc)" ]] || fail "linux top_scan"
[[ "$(printf '%s' "$n" | jq -r '.identity.host')" != "null" ]] || fail "linux host identity empty"
[[ "$(printf '%s' "$n" | jq -r '.limits.maxfilesperproc|type')" == "number" ]] || fail "nr_open limit numeric"
pass "Linux host sample: real /proc, JSON shape, identity, coverage reported"

# --- F4: ownership by vm+generation+start-marker; no orphan adoption --------
uname() { printf 'Linux'; }
RESMON_INTERVAL_SECONDS=1
is_vm_running() { return 1; }
SHARE="$TMP/share"
resmon_start "$PROJ" vm-A "$SHARE" gen-1 || fail "resmon_start A"
pidA="$(jq -r .pid "$(resmon_host_dir "$PROJ")/watch.pid")"
kill -0 "$pidA" 2>/dev/null || fail "sampler A not running"
[[ "$(jq -r .vm "$(resmon_host_dir "$PROJ")/watch.pid")" == "vm-A" ]] || fail "pidfile vm identity"
# idempotent for the same vm+generation
resmon_start "$PROJ" vm-A "$SHARE" gen-1
[[ "$(jq -r .pid "$(resmon_host_dir "$PROJ")/watch.pid")" == "$pidA" ]] || fail "same-identity start not idempotent"
# NEW vm name (orphan of an old VM must not be adopted) -> a fresh sampler starts
resmon_start "$PROJ" vm-B "$SHARE" gen-2
pidB="$(jq -r .pid "$(resmon_host_dir "$PROJ")/watch.pid")"
[[ "$pidB" != "$pidA" ]] || fail "stale orphan for another vm was adopted"
kill -0 "$pidB" 2>/dev/null || fail "new sampler B not running"
# the old sampler self-revokes (token superseded) instead of double-sampling
sleep 3
kill -0 "$pidA" 2>/dev/null && fail "superseded sampler A did not self-revoke"
# LATE old generation (previous session) must not adopt the current owner; the
# newer start self-revokes the older sampler (no double sampling).
resmon_start "$PROJ" vm-A "$SHARE" gen-1
pidC="$(jq -r .pid "$(resmon_host_dir "$PROJ")/watch.pid")"
[[ "$pidC" != "$pidB" ]] || fail "late old generation adopted the current owner"
sleep 3
kill -0 "$pidB" 2>/dev/null && fail "older generation did not self-revoke after a newer start"
# PID reuse: a live PID with a mismatching start marker is not own
cp "$(resmon_host_dir "$PROJ")/watch.pid" "$TMP/copy.pid"
jq -c '.marker="bogus-marker"' "$TMP/copy.pid" > "$TMP/copy.pid.x" && mv "$TMP/copy.pid.x" "$TMP/copy.pid"
if resmon_own_alive "$TMP/copy.pid" vm-A gen-1; then fail "PID-reuse/marker mismatch accepted as own"; fi
resmon_stop "$PROJ"
kill -0 "$pidC" 2>/dev/null && fail "current sampler alive after stop"
pass "ownership: vm+generation+marker, no orphan adoption, self-revocation, PID-reuse safe"

# --- F4: hung transport is contained; stop stays cooperative/bounded --------
SHARE2="$TMP/proj-share"; mkdir -p "$SHARE2/lib"; : > "$SHARE2/lib/resmon.sh"
is_vm_running() { return 0; }
vm_exec() { sleep 8; }
RESMON_INTERVAL_SECONDS=1
resmon_start "$PROJ" vm-H "$SHARE2" gen-H || fail "resmon_start H"
sleep 3
hlines="$(wc -l < "$(resmon_host_file "$PROJ")" 2>/dev/null || printf 0)"
[[ "$hlines" -ge 2 ]] || fail "host loop blocked by a hung guest transport (lines=$hlines)"
start_s="$(date +%s)"
resmon_stop "$PROJ"
stop_s=$(( $(date +%s) - start_s ))
[[ "$stop_s" -le 6 ]] || fail "stop not bounded while guest transport hangs (${stop_s}s)"
rm -rf "$SHARE2"
pass "hung guest transport: sampling continues, cooperative stop stays bounded (no kill)"

# --- R2: ONE project-wide guest probe; N cycles never accumulate orphans ----
# Cooperative, finite mock: the probe stays "in flight" until this test creates
# $PROBE_DONE (no real hang, no VM). Start/end receipts prove no orphan.
PROJ2="$TMP/project2"; mkdir -p "$PROJ2"
SHARE3="$TMP/proj-share3"; mkdir -p "$SHARE3/lib"; : > "$SHARE3/lib/resmon.sh"
SPAWNLOG="$TMP/r2-spawns"; : > "$SPAWNLOG"
PROBE_DONE="$TMP/r2-done"; rm -f "$PROBE_DONE"
is_vm_running() { return 0; }
vm_exec() {
  printf 'start\n' >> "$SPAWNLOG"
  while [[ ! -f "$PROBE_DONE" ]]; do sleep 0.1; done
  printf 'end\n' >> "$SPAWNLOG"
}
RESMON_INTERVAL_SECONDS=1
for i in 1 2 3; do
  resmon_start "$PROJ2" "vm-R$i" "$SHARE3" "gen-R$i"
  sleep 1
  resmon_stop "$PROJ2"
done
[[ "$(grep -c '^start$' "$SPAWNLOG")" == "1" ]] || fail "R2: N cycles spawned >1 probe project-wide ($(grep -c '^start$' "$SPAWNLOG"))"
[[ "$(resmon_probe_state "$PROJ2" | cut -f1)" == "in_flight" ]] || fail "R2: in-flight probe not reported"
# a NEW VM/generation while a probe is in flight must not start a second probe
resmon_start "$PROJ2" vm-Rnew "$SHARE3" gen-Rnew; sleep 1; resmon_stop "$PROJ2"
[[ "$(grep -c '^start$' "$SPAWNLOG")" == "1" ]] || fail "R2: new VM/generation started a second probe"
# coverage exposes the guest-probe state; missing/unknown guest is not healthy
hs="$(resmon_host_sample "$PROJ2" vm-Rnew gen-Rnew in_flight)"
[[ "$(printf '%s' "$hs" | jq -r '.coverage.guest_probe')" == "in_flight" ]] || fail "R2: coverage.guest_probe missing"
printf '%s\n' "$hs" > "$TMP/r2h.jsonl"
resmon_render_history "$TMP/r2h.jsonl" host | grep -q 'guest_probe=in_flight' || fail "R2: renderer does not surface guest_probe"
pass "R2a one project-wide probe across N cycles/new generation; coverage shows in_flight"

# PID reuse: a live PID with a mismatching marker is stale -> a new probe allowed
rec="$(resmon_probe_record "$PROJ2")"
jq -c --argjson p "$$" '.pid=$p | .marker="bogus"' "$rec" > "$rec.x" && mv "$rec.x" "$rec"
[[ "$(resmon_probe_state "$PROJ2" | cut -f1)" == "stale" ]] || fail "R2: PID-reuse/marker mismatch not stale"
resmon_probe_try_spawn "$PROJ2" vm-Rnew "$SHARE3" gen-Rnew || true
[[ "$(grep -c '^start$' "$SPAWNLOG")" == "2" ]] || fail "R2: PID reuse did not allow a new probe"
# a late OLD result must not delete or relabel the newer record
rec2="$(resmon_probe_record "$PROJ2")"
resmon_probe_release "$rec2" "definitely-old-token"
[[ -f "$rec2" ]] || fail "R2: late old result deleted the newer record"
[[ "$(jq -r .generation "$rec2")" == "gen-Rnew" ]] || fail "R2: late old result relabelled the record"
pass "R2b PID reuse -> new probe; late old result neither deletes nor relabels"

# parallel start attempts -> still exactly one NEW probe (atomic claim)
rm -f "$(resmon_probe_record "$PROJ2")"
before="$(grep -c '^start$' "$SPAWNLOG")"
resmon_probe_try_spawn "$PROJ2" vm-P1 "$SHARE3" g-1 || true & j1=$!
resmon_probe_try_spawn "$PROJ2" vm-P2 "$SHARE3" g-2 || true & j2=$!
wait "$j1" 2>/dev/null || true
wait "$j2" 2>/dev/null || true
after="$(grep -c '^start$' "$SPAWNLOG")"
[[ "$((after - before))" == "1" ]] || fail "R2: parallel starts spawned $(($after - $before)) probes"
# release every probe and prove they end + the record clears (no orphan)
touch "$PROBE_DONE"
for _ in $(seq 1 25); do
  [[ "$(resmon_probe_state "$PROJ2" | cut -f1)" == "none" ]] && break
  sleep 0.3
done
[[ "$(resmon_probe_state "$PROJ2" | cut -f1)" == "none" ]] || fail "R2: record not released after probe finished"
starts="$(grep -c '^start$' "$SPAWNLOG")"; ends="$(grep -c '^end$' "$SPAWNLOG")"
[[ "$starts" == "$ends" ]] || fail "R2: probe start/end receipts differ (start=$starts end=$ends)"
pass "R2c parallel starts -> one probe; start/end receipts equal (no orphan)"

printf 'ALL_PASS resmon_test (%s, Bash %s)\n' "$(uname -s)" "$BASH_VERSION"
