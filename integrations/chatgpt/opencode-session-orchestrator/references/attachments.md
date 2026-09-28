# File attachments for OpenCode sessions

Use this reference when the user asks to send an image, document or other file as context to an OpenCode session. It describes a conditional client workflow, not a promise that every MCP connection or ChatGPT surface supports uploads.

## Discover the transfer path first

1. Discover the selected connector's current tool list and schemas. Continue only if it actually exposes `upload_attachment` and `send_message` with an `attachments` parameter. The discovered schema is authoritative; never assume a tool/version from this reference.
2. Resolve the user's intended connector, project and exact exposed session using the normal orchestrator rules. Never choose an unrelated session or send files to several similar connections.
3. Confirm the file bytes are available through the current ChatGPT conversation/file context or another already available, authorized file capability. A filename, host path, URL, MCP resource URI or a file merely mentioned in chat is not the file's bytes. Do not invent a path, fetch arbitrary URLs or ask OpenCode to read the coordinating host's filesystem.
4. If the client cannot provide the actual bytes to the upload tool, do not claim the file was transferred. Ask the user to attach/provide it through an available supported surface, use an explicitly authorized existing conversion path, or explain the connector/client limitation.

An authorized task that explicitly asks to use an available file includes sending that file as task context; do not add a redundant approval question. Do not transfer unrelated files, secrets or unnecessary source material.

## Supported upload flow

The current opencode-vm connector supports only:

| MIME type | Maximum decoded size per file | Model treatment |
|---|---:|---|
| `image/png` | 5 MiB | OpenCode file part; actual image input, subject to model capability and provider limits |
| `image/jpeg` | 5 MiB | OpenCode file part; actual image input, subject to model capability and provider limits |
| `image/webp` | 5 MiB | OpenCode file part; actual image input, subject to model capability and provider limits |
| `text/plain` | 512 KiB | Decoded UTF-8 text in a labeled text part |
| `text/markdown` | 512 KiB | Decoded UTF-8 text in a labeled text part |

PDF, GIF, SVG, Office documents, audio, video and other types are not accepted as raw uploads by this tool. Check the actual connector schema and error response; a filename extension alone does not establish the MIME type.

For each supported file:

1. Use the exact target `session_id`, safe single-component `filename`, matching `mime_type`, and canonical Base64 encoding of the file's bytes in one `upload_attachment` call. Account for Base64 and JSON overhead against the discovered tool/client input limit. Never include a local path instead of bytes.
2. On confirmed success, retain the returned `attachment_id`, `filename`, `mime_type`, `size_bytes`, `sha256` and `expires_at`. The ID is bound to that session. Keep uploads and the following prompt together; it expires after about ten minutes and is one-use.
3. Submit one authorized `send_message` with the complete task text and an `attachments` array containing the returned IDs exactly once each. Keep file order and labels clear. Never construct, edit, reuse or pass a path/URL in place of an ID.
4. Treat the send as the existing write-capable, non-idempotent operation. Capture its receipt and follow the exact `message_id` through ordinary status/result recovery. An accepted receipt is not task completion.

Per message, the current adapter accepts at most **four** IDs and **10 MiB decoded total**. The adapter-wide temporary store holds at most **32 staged IDs / 20 MiB**. Because each text file is capped at 512 KiB, four text files total at most 2 MiB. Do not use multiple prompt sends to work around the four-file limit; that creates separate work and remains subject to admission/authorization rules.

### Errors, uncertainty and model capability

- `UNSUPPORTED_MEDIA_TYPE`: MIME is unsupported or the bytes do not match its declared media type. Convert/extract to an actually supported representation only when an existing capability can do so faithfully.
- `ATTACHMENT_TOO_LARGE`: per-file, per-message, staged-store or attachment-count limit exceeded. Do not silently compress, downsample, truncate or omit content; if a faithful, authorized conversion or focused extraction is available, disclose what it changes/covers.
- `INVALID_ATTACHMENT_REFERENCE`: malformed/duplicate ID, free path/URL, or unsafe filename. Never repair by guessing an ID or path.
- `ATTACHMENT_NOT_FOUND`: missing, expired or already-consumed ID. This is a confirmed pre-admission reference failure; upload again only if the task remains authorized and the file bytes are still available, then use the newly returned ID once.
- `ATTACHMENT_ACCESS_DENIED`: ID belongs to another session. Stop and resolve the correct target; do not move the file to a guessed session.
- `MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE`: the server could not confirm image input for the selected model. No prompt was sent and IDs remain staged until expiry. Do not bypass the rejection, silently convert the image to a description, switch connection/model, or change runtime settings without the user's authorization. Report the limitation or ask the user to choose an authorized image-capable runtime.
- `INVALID_ARGUMENT` for Base64/schema errors: correct the input only after the failure is definite; do not repeat an uncertain upload call.

An upload with no unambiguous result is non-idempotent staging: it may have consumed temporary capacity, and the response may have lost the only returned ID. Do not blindly upload again. A `SUBMISSION_UNCERTAIN` send may already have consumed the IDs and admitted the message: preserve the original invocation/message ID and use the normal receipt recovery workflow; never resend just to reuse attachments. If the uncertain response has no recoverable receipt, state that delivery is unknown and do not create a duplicate task.

The server checks `capabilities.input.image` before submitting image attachments. This is a guard, not a guarantee that every provider accepts the format, dimensions or size. Let the actual backend result determine what happened. Do not tell the user the model saw an image merely because the upload succeeded; the image was sent as model input only after an admitted `send_message` and successful OpenCode processing.

## PDF fallback: extract to text, never upload PDF bytes

When a PDF is requested as context, do **not** pass its bytes or `application/pdf` MIME to `upload_attachment`. Use only the current product's existing PDF/file-reading capability to extract the relevant content, then create a UTF-8 `.md` file (preferred) or `.txt` file for the supported upload flow.

- Prefer embedded/selectable PDF text. Do not invoke or require OCR when parseable text is available.
- For scanned pages, use OCR only if an appropriate existing PDF/OCR capability is already available and within the user's scope. If not, explain that limitation and request a text-based PDF/export or selected readable pages; do not invent extracted content.
- Preserve document structure where useful: source filename/title, headings, page or section boundaries, table rows/columns in readable Markdown, and page/section provenance. For example, label extracted sections `Source: report.pdf — pages 4–6` rather than merging unrelated pages into unmarked prose.
- Extract the portions relevant to the requested task; avoid forwarding unrelated pages, secrets or unnecessary content. State the page/section coverage in the task message when extraction is partial.
- Measure each generated text file as UTF-8 bytes. Keep every file at or below 512 KiB, split at useful page/section/table boundaries, and label parts with stable order and source ranges (for example, `report-part-01-of-03.md`). Preserve headings/context across boundaries as needed.
- Submit no more than four resulting files and no more than 10 MiB total. With the per-text-file limit, four files provide at most 2 MiB of extracted text. If the relevant extraction still does not fit, do not silently truncate or send repeated prompts to evade limits: narrow to the most relevant pages/sections or ask the user which scope to prioritize, and disclose omitted coverage.

## Other unsupported types

Do not automatically upload unsupported raw binaries. If an already available, authorized capability can faithfully extract text or render relevant pages as PNG/JPEG/WebP within limits, use that converted representation and state the conversion/coverage. Otherwise report the concrete unsupported type and ask for a supported export. Never use an arbitrary converter, URL fetch, host path or another session as a workaround.

## Retention and user-facing receipt

Before a prompt is admitted, staged bytes exist only in the adapter's process memory, expire after about ten minutes, and are removed on expiry or connector shutdown. After admission, OpenCode stores the resulting file part in normal session history; one-use upload consumption does **not** delete that history. Tell the user this when retention is relevant. Do not claim that temporary-upload expiry removes an attachment already submitted to the session.

After successful submission, report the target session, message ID/state and the attached filenames/types as useful. Keep Base64 and file contents out of status text and diagnostics. Preserve the existing rule that reads, uploads, acceptance receipts and completed task results are distinct events.
