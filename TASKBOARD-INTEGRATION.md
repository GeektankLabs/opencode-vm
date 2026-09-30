# Taskboard Integration

## Technical Check

The pinned `tcarac/taskboard` v0.6.0 Linux binaries report build commit `42247c51657ffae3c38be5755047ced847c863b2` (the formerly reviewed `c3db6eba367edce32c9942362f707dd7f91ea689` checkout has identical HTTP/DB/UI sources, but is not the release commit). The binary embeds a React UI and uses SQLite via `modernc.org/sqlite`.

The HTTP surface is:

- `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/{id}`
- `GET/POST /api/teams`, `GET/PUT/DELETE /api/teams/{id}`
- `GET/POST /api/tickets`, `GET/PUT/DELETE /api/tickets/{id}`
- `POST /api/tickets/{id}/move`, `POST /api/tickets/{id}/subtasks`
- `POST/DELETE /api/subtasks/{id}/toggle`, `GET/POST/PUT/DELETE /api/labels`
- `GET /api/board?projectId={id}` and the terminal WebSocket at `/api/terminal/ws`

The domain model is `Project -> Ticket -> Subtask`. Projects and tickets use ULIDs. A ticket has backend `id`, project ID, number/display key, title, description, status (`todo`, `in_progress`, `done`), priority, position, labels, subtasks, dependencies and timestamps. There is no comment model, no stable external task ID and no session/message/artifact relation. `MoveTicket` changes status and position. The existing `internal/mcp` exposes 22 backend-specific stdio tools; it is deliberately not started or exposed by this integration.

`internal/db.OpenAt(path)` already provides the small store seam needed for phase 1: migrations are embedded and the CLI accepts `--db`. The current `db.Store` is concrete and has no StoreManager or scope registry. Supporting multiple database paths later is therefore a small upstream-near change (a scope-to-`OpenAt` manager plus lifecycle/locking), not a reason to couple the public API to SQLite. This integration keeps that change out of the first phase.

## Architecture Decision

The existing incoming OpenCode MCP adapter remains the only external MCP server. A pinned `taskboard` release binary runs as an owned transient `ocvm-taskboard` service on guest port `P+5`; upstream binds all guest interfaces, the adapter calls guest loopback, and web mode forwards the port to the host/LAN. This development phase adds no Board HTTP/terminal auth. The persistent state is `<project>/.opencode-vm/taskboard/` on the mounted project: `taskboard.db`, `taskboard.metadata.json` (the MCP sidecar), a bounded `taskboard.log` plus `.1`, and the readiness `runtime.json`/failure `failure.json`. The entry `.opencode-vm/` is added to the project's root `.gitignore` on first start, without replacing existing rules. The editor and agent receive `OCVM_TASKBOARD_RUNTIME_DIR`; no DB, log or readiness descriptor depends on the host-mounted session share.

The pinned v0.6.0 upstream database stores its format in `schema_migrations`: `001_initial.sql` and `002_add_project_description.sql`. Preflight validates SQLite integrity and rejects unrecognized migration names before opening the binary. An existing `001` database receives an online SQLite backup at `taskboard.pre-v0.6.0.db`, then upstream performs its transactional forward migration to `002`; post-start verification requires both versions before publishing readiness. An unknown newer schema fails closed without an automatic downgrade. A one-time import from the old `~/.opencode-vm/project-state/<hash>/taskboard/` copies the DB with SQLite's online backup and copies the sidecar before publishing the new DB; the old files remain for recovery. A populated new DB always wins and is never overwritten by the old location. An incomplete import with missing sidecar fails closed. Regular startup and VM recreation reuse the project-local DB; final VM deletion removes the disposable binary but leaves the project state. **macOS/Lima virtiofs + SQLite WAL durability must still be accepted with a real VM-rebuild and write/readback test** before claiming production-grade crash recovery.

The MCP adapter's board-neutral `ProjectBoardService` talks directly to the taskboard HTTP API over guest loopback. Its schema-2 JSON sidecar stores project/task mappings on writes, integration comments, session/message/result/artifact links and a durable Inbox-to-workstream transfer journal; old schema-1 files are read compatibly. A public UUID-shaped `task_id` is derived deterministically from the project hash and backend ULID, including for UI-created tickets. Reads do **not** create backend projects or sidecar files. Confirmed `Inbox`/`INBOX` setup replaces implicit default creation on the first ticket; existing canonical projects retain their old ID, name and prefix. Additional Board Projects have repo-bound stable `board_project_id` values; cross-project reads and session reverse lookup cover the same repository DB. A confirmed transfer stages a marked technical copy in Done, preserves the public task ID and sidecar references, and reports success only after the source is absent and the target's original business status is read back. Unresolved requests fail closed and can be inspected by request UUID; native dependencies are not transferable. Sidecar writes use a process-shared `flock` and reload under that lock; corrupt/unsupported metadata fails closed. The sidecar is still separate from SQLite and is not a UI/MCP-wide CAS mechanism.

The first phase has one `project-local` scope. `transfer_project_task` is present as an explicit, fail-closed capability boundary and reports that multi-scope transfer is not enabled yet. The metadata shape already records scope and backend mapping so a later DoltLite/global adapter can replace the storage implementation without changing MCP tools.

The web launcher already registers project-ready Editor and Taskboard entries. Taskboard uses the contiguous web port `P+5` and opens in a new tab. The service shares the web/tui-mcp runtime lifecycle; no second taskboard MCP process is introduced. Taskboard HTTP/UI and its embedded terminal do not gain their own authentication from this phase-1 adapter work; development use without added Board auth is a deliberate separate decision, with central HTTPS/auth proxy design deferred.

## Phase 1 lookup boundary

`list_project_tasks` scans the complete upstream project/status list locally and filters title/description text, linked session, edit timestamp and terminal state. Upstream v0.6.0 has no search cursor or pagination. A scan exceeding 1 MiB/500 tickets, or a result exceeding 50 tickets/40,000 UTF-8 bytes, returns `TASK_SEARCH_INCOMPLETE`, never a partial list or a false absence claim. `get_project_task(task_id)` supports exact stable IDs and shows complete links where they fit the response budget; `list_project_tasks(session_id=...)` is reverse lookup. No new parent/child, resolution, cross-store CAS or task-synthesis write tool is added. The companion ChatGPT skill can produce a read-only remainder preview using these reads.

## Additive task writes (MCP adapter 0.1.18)

The optional catalog now has 18 Board tools. `add_task_document_bindings` validates one/both main-role files and all conflicts before one schema-3 sidecar commit; exact replay revalidates without publication. No replace, retarget, file write or Board-status mutation is allowed. Existing `register_task_document(expected_path)` remains available for deliberate replacements and detail roles.

`add_task_management_note` appends a visible native description block through one description-only PUT. Cooperating writers share the existing lock; UI/general edits do not, and upstream has no CAS. This accepted race boundary does not guarantee globally loss-free append. Character and full task-read UTF-8 budgets are checked before PUT; uncertain delivery requires readback, never a blind retry. The tools have honest additive write annotations, not approval guarantees. The r21 client keeps mandatory document readback and a separate Board move; fallback to register occurs only when the bundle tool is absent. See [MCP contract](docs/MCP-INTERFACE.md#optional-project-local-taskboard-tools-adapter-0118).

## PLAN Import Boundary

No `PLAN-*.md` file is automatically synchronized or imported. `source.file`, `source.section`, and `source.entry` are a documented idea for a later explicit importer, **not fields in the current sidecar**. A future importer could retain Markdown origins without making Markdown and the board competing authorities.
