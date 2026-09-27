# Stored-result reading protocol

Use discovered schemas as the contract. Names and fields here describe capabilities; do not assume every OpenCode MCP exposes all of them.

## Choose the shortest path

| Known input | Preferred read |
|---|---|
| Submitted user message ID | `get_task_result(session_id, submitted_message_id, ...)` |
| Assistant report ID | `get_message(session_id, message_id)` |
| Only session identity | Small `get_session_history` page to find message/parent IDs |
| Content reference and continuation | `read_message_content(content_ref, cursor, max_bytes)` |

Retain all result references from the same task-search attempt. `search_complete=true` means the search completed, not that the text was read. Do not declare absence while the search is incomplete. Use exact parent/task bindings, not similar titles. In the opencode-vm contract, search pages are newest-first; reverse the accumulated results if chronological presentation is needed.

## Keep pagination streams separate

- History `next_before`: older messages, not the rest of the current message.
- Task-result `next_cursor`: another page of the result search.
- Content `next_cursor`: the next byte range of one visible-text revision.
- Journal `next_cursor`: a separate stream with its own filters; see [progress and activity](progress-activity.md).

Treat every cursor as opaque and scoped to its original connection/project/query. Use it only in the matching tool and with matching IDs/reference/filters.

## Verify page continuity

For each content read retain the message ID, reference, revision, unit, total bytes, start/end ranges, continuation and declared hash. Preserve availability/omissions from the message descriptor when not repeated on pages. Do not assume those fields appear at the same nesting level across connectors.

For a full visible-text read:

1. Begin at the start of the reference, not a guessed offset.
2. Require the expected message/revision and a first range starting at zero.
3. Require each next range to begin at the previous end. Follow the actual inclusive/exclusive convention.
4. Allow a page smaller than the requested byte maximum at a UTF-8 boundary or due to serialized-response budgeting.
5. Require progress. A repeated cursor/range or a zero-length page with `has_more=true` is an anomaly, not permission to loop forever.
6. Continue until `has_more=false`; when total length is known, require the final end to equal it.
7. Read all relevant terminal report constituents before claiming the entire task result was reviewed.

For an end-exclusive interface, `[0,256)` followed by `[256,512)` is contiguous. A total of 6267 bytes makes that only a 512-byte sample, not a full read or checksum verification.

If programmatic reconstruction is available, hash the exact concatenated visible UTF-8 bytes and verify the declared length and SHA-256. Do not normalize line endings, whitespace or Unicode, insert separators, or claim a computed hash after merely comparing server-supplied strings.

## Interpret completeness precisely

| Signal | Interpretation |
|---|---|
| `text_truncated=true`, reason `preview_limit` or `response_budget` | Preview is shortened; fetch its stored content reference. Not an outage. |
| `history_has_more=true` | More older messages exist. |
| `search_complete=false` | Continue the task-result search. |
| Content-page `has_more=true` | More text remains in this revision. |
| Final range reaches total and `has_more=false` | The visible stream ended; assess omissions separately. |
| `content_complete=false` on a final partial page | May be normal: in opencode-vm this flag means THIS response alone contains the whole visible text. It does not summarize the client's accumulated read. |
| `availability=not_exposed`, zero visible bytes | Unexposed source parts may exist; this is not necessarily an empty original. |
| `finish=length` or `content-filter` | Stored text may be fully readable, but generation did not end regularly. |

For example, reading `[0,256)` and `[256,512)` of a 512-byte stream completes the visible read. The second response can still report `content_complete=false` because its own start is not zero. Follow the discovered contract for other servers; never use that flag to invent an extra page after `has_more=false`.

An empty terminal entry with unavailable content is not a successful report. Keep execution state, report availability, read coverage and substantive outcome separate.

## Changed or expired data

On reference expiry, reacquire with known session/message IDs. On `CONTENT_CHANGED`, get a new reference and restart content reading from zero; never append to the old revision.

On `SEARCH_CHANGED`, **discard the old search-page accumulation and restart without the old cursor**. Dedupe only within the new attempt using message ID/revision. Old observations may be retained as explicitly historical context, never merged into the new complete result set. Bound repeated attempts and report instability rather than hiding it.

Read only exposed user/assistant content. Do not reconstruct hidden reasoning or bypass omitted tool-output permissions. Explain genuine source gaps. A new expert analysis needs authorization as a distinct task; it is not a read retry.

## Compact read receipt

For an MCP read test, report tools actually called, relevant IDs, revision, byte ranges, `has_more`, continuity, task state and search completeness. State exactly how much was read. Do not infer an MCP version from tool names or content revisions.
