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

The existing VM web runtime remains the only trust boundary and the existing incoming OpenCode MCP adapter remains the only MCP server. A pinned `taskboard` release binary runs as an owned transient `ocvm-taskboard` service on guest loopback. Its database is under the persistent per-project state mount (`~/.opencode-vm/project-state/<hash>/taskboard/taskboard.db`), so VM recreation and service restarts do not remove board data.

The MCP adapter contains a board-neutral `ProjectBoardService` backed by a `TaskboardAdapter`. It talks to the taskboard HTTP API over guest loopback and stores only integration metadata in an atomic JSON sidecar: stable `task_id` mappings, project mappings, comments, session links and future source/artifact references. A stable ID is generated independently from the backend ULID; tasks created in the UI are assigned one lazily on first API read. Public MCP tools use task terminology and never expose tcarac-specific tool names or IDs as their identity.

The first phase has one `project-local` scope. `transfer_project_task` is present as an explicit, fail-closed capability boundary and reports that multi-scope transfer is not enabled yet. The metadata shape already records scope and backend mapping so a later DoltLite/global adapter can replace the storage implementation without changing MCP tools.

The web launcher is the existing root launcher/seed page, extended with OpenCode, Editor and Taskboard cards. Taskboard gets the next contiguous web port (`P+5`) and is opened in a new tab. The service is started and stopped with the same web/tui-mcp runtime lifecycle; no second tunnel or taskboard MCP process is introduced.

## PLAN Import Boundary

No `PLAN-*.md` file is modified and no automatic synchronization is performed. The integration metadata reserves `source` fields (`file`, `section`, `entry`) for a later explicit import command. An importer can create tasks through the same service and retain the exact Markdown origin without making Markdown and the board competing authorities.
