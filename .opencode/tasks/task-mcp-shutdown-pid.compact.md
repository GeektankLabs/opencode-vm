# Compact context - MCP adapter shutdown PID ownership fix

Task: `task/mcp-shutdown-pid` (follow-up of task_68085480 adapter-log rotation)
Branch/worktree: `task/mcp-shutdown-pid` at
`.opencode-vm/worktrees/task-mcp-shutdown-pid` (base `39dab8f`, OCVM 0.7.48).

## Auftrag
Nach Nutzerlog (13Oct2026) blieb beim normalen Shutdown ein MCP-Listener
(Gastport 40960) bestehen:
`[mcp] Listener on port 40960 remains after adapter shutdown.` und
`[mcp] ERROR: adapter shutdown could not be verified.`; beim naechsten
`attach` `[attach] Could not stop the previous web/OpenLive runtime safely.`
Freigabe: enger Fix + isolierte Regressionstests + lokaler Commitkandidat.
Kein Push/Publish/Install/Live-Restart, keine BI-MC-Aktion, keine neue V2.

## Kausalitaet (Source + neue OCVM-Prozessbeobachtung; NICHT am alten BI-MC-Socket)
Commit `d085541` (task_68085480 part6, ausgeliefert als OCVM 0.7.44) aenderte
`start_mcp_adapter` von
    aa-exec ... node ... "$4" >>"$log" 2>&1 &        # $! = node PID
zu
    ( aa-exec ... node ... | python3 -u -c writer ) &  # $! = Pipeline-Subshell
`/tmp/ocvm-mcp.run.pid` nannte danach die Subshell, deren vererbte
`/proc/cmdline` den Supervisor-Marker traegt (der Child-Marker steht nur als
Argument darin). `stop_mcp_adapter` (`:15670`) killte so nur die Huelle; das
`node`-Enkelkind hielt den LISTEN-Socket -> `ss`-Restpruefung (`:15697`).
Live-Beleg (read-only, aktuelle OCVM-Session): `sup.pid=13589` (Session-Leader),
`run.pid=14022` = Subshell, `node pid=14023` LISTEN 127.0.0.1:40961.

## Fix (eng, 1 Stelle)
`opencode-vm.sh:15870` (start_mcp_adapter): Listener wird INNERHALB der
Brace-Group (linke Pipe-Seite) gebackgroundet, sodass `$!` die echte node-PID
ist und mit dem Child-Marker in run.pid landet:
    { aa-exec ... node "$adapter/dist/main.js" "$child_marker" 2>&1 &
      echo $! > /tmp/ocvm-mcp.run.pid
      wait $! || true
    } | python3 -u -c "$writer" "$log"
`stop_mcp_adapter` bleibt unveraendert: Supervisor->Child-Einzel-PID-Kills mit
Generation-Marker (kein PGID-Kill, keine fremden Prozesse), Writer endet per
EOF, harte Rest-LIstenerpruefung erhalten (fremder Listener -> fail-closed).

## Tests
`tests/mcp_shutdown_test.sh` (neu, Linux, isoliert):
- treibt echtes start/stop_mcp_adapter aus der eingebetteten web-Library mit
  gefaktem aa-exec/node, das einen Port bindet;
- 20 Checks: run.pid = echter Listener-PID mit Child-Marker/Port gebunden;
  stop: Port frei, pidfiles weg, kein node/writer-Waise; wiederholter Stop;
  Stop->Restart; fremder Listener wird NICHT getoetet und nicht als Erfolg
  gewertet; markerloser PID wird nicht signalisiert.
- Isolation: eigener tmpfs-/tmp + PID-Namespace (`sudo unshare --mount --pid
  --fork --mount-proc`), Guard verweigert bei fremden /tmp/ocvm-mcp*.pid.
- Negativkontrolle gegen `39dab8f`: FAIL (6), reproduziert
  `[mcp] Listener on port ... remains after adapter shutdown.`

## Pins / Version
Base HEAD `39dab8f35f0a785c7a01e790d26bbf20a9134e6b` (Main 39dab8f / OCVM
0.7.48 / MCP 0.1.52). Kandidat: OCVM_VERSION 0.7.49; OPENLIVE_ADAPTER_TAG,
MCP_ADAPTER_TAG, HUB_ASSET_TAG -> v0.7.49; Adapterversionen/-SHA256 unveraendert
(keine Adapter-Bytes geaendert).

## Grenzen
Kein Live-Repro am alten BI-MC-Socket; Kausalitaet aus Source + neuer
OCVM-Prozessbeobachtung. Host-seitige Shutdown-Ursache (VM absichtlich running
fuer ReAttach) bleibt Host-Verhalten. Unabhaengige QC am fertigen Pin offen.
