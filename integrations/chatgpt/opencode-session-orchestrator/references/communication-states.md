# Communication states: CURRENT_TURN_WAIT, ON_DEMAND_STATUS, PROACTIVE_MONITORING

One shared vocabulary for every "follow-up / I'll keep you posted / I'll notify you"
claim. Use exactly these three state names in reasoning and pick user wording that
cannot be mistaken for another state. This file consolidates the scattered rules;
`SKILL.md`, `references/progress-activity.md` and `references/regression-scenarios.md`
point here.

## The three states

| State | Meaning | You may promise continuation? |
|---|---|---|
| `CURRENT_TURN_WAIT` | A bounded wait/recheck **inside the active conversation turn** (roughly 2–5 s per recheck, a few rounds at most). | No later push may be derived from it. When the turn ends without a result, the state becomes `ON_DEMAND_STATUS`. |
| `ON_DEMAND_STATUS` | The default after any submission. The user asks, you do one fresh read (`get_session`, `get_session_progress`, `get_monitor`/`get_monitor_history`, `get_project_task`) and report. | You never continue in the background. Say so explicitly once, then stop. |
| `PROACTIVE_MONITORING` | A separately available, authorized scheduling mechanism **outside this skill** delivers the update. | Only claimable when that exact mechanism is named, configured and verified for the concrete host/surface — never because the skill "monitors". |

## Where updates can really come from (verified hops only)

These are the only evidence-backed channels in the current opencode-vm contract.
Engine-side monitor decisions are **not** pushed anywhere:

1. **On-demand reads.** `get_monitor`/`get_monitor_history` expose the engine's
   bounded investigation outcomes (`investigation-inconclusive`,
   `investigation-longwork`, `investigation-no_progress_evidenced`,
   `investigation-anchor-unknown`, park reasons, `wait_reason`) as registry
   history — readable any time, pushed never.
2. **Manager-session escalation.** The monitor's manager session is woken by the
   engine and escalates itself through the existing attention/journal tools; the
   prepared attention queue (`get_project_attention`) is derived from backend
   **activity events** (failed/aborted turns, input-required, ready results) —
   not from engine decisions.
3. **Events/webhook subscriptions** (0.1.23+ contract): only with a confirmed,
   signed subscription and a verified callback/wake-up path on the concrete
   host/surface. Callback 2xx proves transport only.

A `PROACTIVE_MONITORING` promise requires hop 3 **by name**. Hops 1–2 support
`ON_DEMAND_STATUS` answers and never justify an unprompted later message.

## Wording rules

- Never: "ich melde mich automatisch", "I'll keep you posted", "ich gebe dir
  Bescheid, sobald …", "ich beobachte das im Hintergrund" — unless the named,
  verified hop-3 mechanism exists for this exact surface.
- `CURRENT_TURN_WAIT` wording must contain the bounded scope: *"Ich prüfe kurz in
  diesem Zug …"* / *"Let me recheck briefly within this turn."*
- `ON_DEMAND_STATUS` wording must hand the next step to the user: *"Frag einfach
  wieder — ich lese dann den aktuellen Stand."* / *"Ask me anytime; I'll do a
  fresh read."*
- If the user asks for automatic updates and no verified mechanism exists, refuse
  explicitly and offer the on-demand pattern: *"Einen Automatismus habe ich hier
  nicht —frag mich einfach zwischendurch."*
- An engine-side investigation outcome is never phrased as progress. Inconclusive
  means unverifiable: *"Der Lauf ist aktiv, aber ich kann keinen belegten
  Fortschritt sehen — ich meld das, wenn sich das ändert"* is only allowed with
  hop 3; otherwise add: *"bis dahin frag mich einfach."*

## Voice and text examples

| Situation | Text (DE) | Voice (DE, kurz) |
|---|---|---|
| Submission accepted, long run | "Angenommen. Ich beobachte das nicht im Hintergrund — frag einfach, ich lese dann den Live-Stand." | "Angenommen — frag einfach, ich lese dann den Stand." |
| Bounded current-turn wait ending without result | "Kurzer Recheck war ergebnislos. Ab jetzt: frag mich einfach, ich lese frisch." | "Jetzt noch nichts —frag mich einfach." |
| User asks "melde dich, wenn's fertig ist" (no mechanism) | "Eine automatische Benachrichtigung kann ich hier nicht zusagen. Ich lese auf Anfrage den exakten Stand — Monitor-Historie eingeschlossen." | "Automatisch melde ich mich nicht — frag mich einfach." |
| Confirmed subscription exists (named surface) | "Der Monitor auf <surface> ist bestätigt und meldet sich bei Ergebnis; Details lese ich bei Rückfrage." | "Der bestätigte Monitor meldet sich bei Ergebnis." |
| Investigation inconclusive (on-demand answer) | "Der Worker läuft, aber ein belegter Fortschritt ist nicht erkennbar; die nächste begrenzte Prüfung ist um <Zeit>." | "Läuft, belegter Fortschritt nicht erkennbar — nächste Prüfung um <Zeit>." |
| Worker result pending synthesis | "Das Arbeitsergebnis liegt vor und wartet auf die Manager-Aufbereitung." | "Ergebnis liegt vor, Aufbereitung läuft." |

## Regression anchors

The six mandatory scenarios and their expected behavior live in
`references/regression-scenarios.md` (rows: long run, current-turn wait, manual
status check, input/permission pending, missing monitoring, confirmed external
monitoring). Each row must keep passing with this file as the single vocabulary
source.
