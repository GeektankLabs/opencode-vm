# Taskboard Integration

## Technical Check

The reviewed `tcarac/taskboard` snapshot is commit `c3db6eba367edce32c9942362f707dd7f91ea689` (the current `v0.6.0` release is available as a pinned Linux binary). It is a single Go binary with an embedded React UI and a SQLite store using `modernc.org/sqlite`.

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

The MCP adapter contains a board-neutral `ProjectBoardService` backed by a `TaskboardAdapter`. It talks to the taskboard HTTP API over guest loopback and stores only integration metadata in an atomic JSON sidecar: stable `task_id` mappings, project mappings, comments, session links and future source/artifact references. A stable ID is generated independently from the backend ULID; tasks created in the UI are assigned one lazily on first API read. Public MCP tools use task terminology and never expose tcarac-specific tool names or IDs as their identity.

The first phase has one `project-local` scope. `transfer_project_task` is present as an explicit, fail-closed capability boundary and reports that multi-scope transfer is not enabled yet. The metadata shape already records scope and backend mapping so a later DoltLite/global adapter can replace the storage implementation without changing MCP tools.

The web launcher is the existing root launcher/seed page, extended with OpenCode, Editor and Taskboard cards. Taskboard gets the next contiguous web port (`P+5`) and is opened in a new tab. The service is started and stopped with the same web/tui-mcp runtime lifecycle; no second tunnel or taskboard MCP process is introduced.

## PLAN Import Boundary

No `PLAN-*.md` file is modified and no automatic synchronization is performed. The integration metadata reserves `source` fields (`file`, `section`, `entry`) for a later explicit import command. An importer can create tasks through the same service and retain the exact Markdown origin without making Markdown and the board competing authorities.
