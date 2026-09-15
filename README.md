# pi-context

Codex-style context windows for [Pi](https://github.com/earendil-works/pi-mono): reset-style compaction, durable session-history tools, and persistent notes — implemented entirely with public extension APIs. No Pi core modification required.

## Install

```sh
pi install npm:@astrosheep/pi-context
```

Or load it for a single invocation without installing:

```sh
pi -e npm:@astrosheep/pi-context
```

## How it works

The extension composes Pi's public `session_before_compact` / `session_compact` hooks, custom session entries, and the `context` hook to approximate Codex's experimental context management:

- **`new_context` tool** — the model requests a fresh context window. The extension waits for the current tool turn to end, compacts with a short deterministic reset message (old conversation is excluded from the new provider context but stays in the session), then sends exactly one hidden continuation turn.
- **`<context_window>` hint** — persisted as a visible custom message at session start and after each window reset (Codex-style: written once into history instead of re-injected per request). Because that durable message can land after the fresh window's first provider request, the `context` hook appends one transient copy to that first request only; once the persisted hint is in history, its custom type suppresses the transient copy. It carries the agent name, first/current/previous window IDs, and the 5 most recently updated notes. Within a window the note list goes stale, exactly like Codex's steady-state world-state diffing.
- **Low-budget guidance** — when estimated remaining context first drops to **65,536 tokens** or below, a `<context_window_guidance>` reminder is **persisted once per window** into history (TUI-visible, no extra turn; `sendMessage` safely defers mid-stream). There is deliberately no transient copy: a bridge would make the model meet the same text twice at shifted positions, because history records the persisted copy after the crossing request's assistant reply. The reminder is an early warning, so arriving from the next request on costs nothing and keeps the model's view identical to recorded history. The measured remaining count is frozen into the text at the threshold crossing, so the persisted reminder is a snapshot true at write time; `get_context_remaining` remains the live source for the current figure. The text is appended rather than prepended; existing history is not rewritten.
- **Direct automatic reset** — every automatic compaction immediately uses the same reset handler. No cancellation to obtain a fallback turn, no input interception or replay, and no special idle/streaming scheduling. The reminder asks the model to write notes early; if it misses that opportunity, old history remains searchable. Pi owns automatic continuation, queued inputs, and overflow retry.
- **Graceful fallback** — when estimated remaining context reaches **40,960 tokens**, the extension inserts one final note-taking instruction once per window. Before a fresh user turn, it is persisted through `before_agent_start`; after a running tool turn (only while the agent is still streaming), it is sent at the ordinary `turn_end` boundary with `triggerTurn: true`, which Pi routes to `agent.steer()`: the message is drained after the turn end and injected before the next LLM call, extending the current run by one note-taking turn while a queued user prompt (follow-up) waits until the agent would stop. It never copies, handles, or replays user input and never cancels Pi's compaction. Pi's automatic compaction still performs the reset afterward.
- **Runtime toggle** — `/pi-context off` disables hint injection, guidance, and reset-style compaction (Pi's default compaction, including `keepRecentTokens`, applies again). `/pi-context on` re-enables; a bare `/pi-context` reports the current state.
- **History tools** — the model searches pre-reset conversation with case-sensitive literal substring search, exactly like Codex's `history.*` namespace.
- **Notes tools** — persistent, session-scoped virtual files that survive window resets.

## Reminder timing

```sh
pi --pi-context-reminder-tokens 65536 --pi-context-fallback-tokens 40960
```

Both flags accept positive integers measured in **remaining context tokens**, not tokens consumed. The reminder must be above the fallback, and both should be above your Pi `compaction.reserveTokens` with enough headroom for a turn. With Pi's default `reserveTokens: 16384`, the defaults leave roughly 24.5k tokens between early reminder and fallback, then another 24.5k between fallback and Pi's reset line. The extension does not change Pi settings or reserve additional context. Large tool outputs or user inputs can jump over one or both reminders; overflow recovery still resets immediately rather than forcing a doomed extra turn. For small context windows, tune all values to fit the model.

## Tools

The nine Codex History/Notes actions are flattened because Pi tools have one global name space:

| Codex action | Pi tool |
| --- | --- |
| `history.list_windows` | `history_list_windows` |
| `history.list_items` | `history_list_items` |
| `history.read_item` | `history_read_item` |
| `history.search_contents` | `history_search_contents` |
| `notes.list_files_by_prefix` | `notes_list_files_by_prefix` |
| `notes.read_file` | `notes_read_file` |
| `notes.search_contents` | `notes_search_contents` |
| `notes.append_to_file` | `notes_append_to_file` |
| `notes.write_file` | `notes_write_file` |

`history_*` reads the current branch's actual Pi session entries, including entries hidden by earlier compaction. Window IDs are stable `pcw:<session-id>:root` or `pcw:<session-id>:<compaction-entry-id>` identifiers; item IDs are the persisted Pi entry IDs. No transcript copy or volatile archive is maintained.

`notes_*` stores operation entries in the same append-only Pi session under `pi-context/note`. They are session-scoped, survive JSONL reload, never enter provider context, and use safe relative virtual paths only (no absolute paths, `..`, `.`, empty components, or backslashes). Searches are literal and case-sensitive. `notes_read_file` accepts inclusive 1-based line ranges; negative line numbers count from the last line. Writes are capped at 1,000,000 UTF-8 bytes.

Unlike Codex, the history tools do not advertise `agent_name`: Pi has no cross-agent session routing, so the parameter is omitted from the schemas entirely (strict `additionalProperties: false` still rejects it) instead of costing schema tokens on every request.

Two extra controls compose Pi public APIs:

- `get_context_remaining` returns `{ "remaining_tokens": number | null }`. `null` means Pi itself cannot make a reliable estimate (notably immediately after compaction). The low-budget guidance uses the same source and stays silent when the estimate is unknown.
- `new_context` returns terminal tool output, then waits for Pi's `agent_end`, triggers public `ctx.compact()`, installs a short deterministic reset compaction, and sends exactly one hidden continuation turn after compaction succeeds. Call it by itself in a tool batch. Pi only ends a tool turn when every parallel tool result is terminal, so Pi 0.85.1 cannot force an atomic rollover from the middle of a mixed parallel tool batch.

## Reset behavior and limits

On `session_before_compact`, the extension appends a persistent custom reset marker through public `pi.appendEntry`, reads that real marker ID from the readonly session manager, and returns it as `firstKeptEntryId`. Pi's `buildContextEntries()` then keeps the compaction envelope plus that custom marker; custom markers are excluded from LLM context. Thus the subsequent provider context contains the short reset result and a fresh window hint, not old conversation messages. Only an explicit `new_context` adds a hidden continuation; automatic resets and user `/compact` keep Pi's native scheduling. The old entries remain only in the session tree for `history_*`.

Pi's built-in “compacted into the following summary” envelope is left intact. Its content explicitly says: “Context window reset. No summary was generated. Retrieve prior details through history_* and notes_*.” No context filtering or TUI override is used to hide that envelope.

The same handler is used for native automatic compaction. When Pi marks an overflow compaction `willRetry`, Pi core performs its single retry itself and this extension deliberately sends no second continuation. While the extension is enabled, its custom reset keeps nothing after the boundary marker, so Pi's `keepRecentTokens` setting has no effect; with `/pi-context off`, Pi's default compaction (and `keepRecentTokens`) applies again.

This is a composition of public `session_before_compact`, `session_compact`, `pi.appendEntry`, `ctx.compact`, and `pi.sendMessage`; it is not a Pi-core `newSession` call. A manual Pi compaction is only eligible when Pi's own `prepareCompaction()` accepts the session. Therefore a `new_context` request in a too-small/uncompactable session fails cleanly without default-summary fallback or continuation. A core change would be needed only to guarantee a force-reset at arbitrary small context sizes or to atomically interrupt a mixed parallel tool batch.

## Verification

```sh
npm run typecheck
npm test
```

The integration harness uses the installed Pi `SessionManager`, including an on-disk JSONL reload. It verifies note persistence/Unicode/path rules, provider context exclusion after the real `firstKeptEntryId` boundary while history remains searchable, completed tool-result boundary placement, threshold ordering/config validation, one early reminder and one final fallback per window, one continuation only, and cancellation/failure/no-double-retry behavior. It uses no model or network call.
