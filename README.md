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
- **`<context_window>` boot block** — the head of every fresh window. For a reset it IS the summary returned from `session_before_compact` (position 0, persisted, no extra message); for the root window `session_start` persists it once as a visible custom message. It carries the agent name and first/current/previous window IDs, the recent-notes index, and a `<context_window_protocol>` teaching block. The notes index is a window-open snapshot with the same frozen-at-write semantics as the reminder count. Nothing is injected transiently per request: the boot block is static once-per-window content, so the head of the window stays cache-stable. Codex diverges here — its `<context_window>` block carries only the agent path and window IDs, while the notes index is our own addition.
- **Low-budget guidance** — when estimated remaining context first drops to the reminder threshold (by default **40,960 tokens**: Pi's default 16,384 `reserveTokens` plus a 24,576 reminder margin; see [Reminder timing](#reminder-timing)), a `<context_window_guidance>` reminder is **persisted once per window** into history (TUI-visible, no extra turn; `sendMessage` safely defers mid-stream). There is deliberately no transient copy: a bridge would make the model meet the same text twice at shifted positions, because history records the persisted copy after the crossing request's assistant reply. The reminder is an early warning, so arriving from the next request on costs nothing and keeps the model's view identical to recorded history. The measured remaining count is frozen into the text at the threshold crossing, so the persisted reminder is a snapshot true at write time; `get_context_remaining` remains the live source for the current figure. The text is appended rather than prepended; existing history is not rewritten.
- **Direct automatic reset** — every automatic compaction immediately uses the same reset handler. No cancellation to obtain a fallback turn, no input interception or replay, and no special idle/streaming scheduling. The reminder asks the model to write notes early; if it misses that opportunity, old history remains searchable. Pi owns automatic continuation, queued inputs, and overflow retry.
- **Graceful fallback** — when estimated remaining context reaches the fallback threshold (by default **24,576 tokens**: Pi's default 16,384 `reserveTokens` plus an 8,192 fallback margin; see [Reminder timing](#reminder-timing)), the extension inserts one final note-taking instruction once per window. Before a fresh user turn, it is persisted through `before_agent_start`; after a running tool turn (only while the agent is still streaming), it is sent at the ordinary `turn_end` boundary with `triggerTurn: true`, which Pi routes to `agent.steer()`: the message is drained after the turn end and injected before the next LLM call, extending the current run by one note-taking turn while a queued user prompt (follow-up) waits until the agent would stop. It never copies, handles, or replays user input and never cancels Pi's compaction. Pi's automatic compaction still performs the reset afterward.
- **Runtime toggle** — `/pi-context off` disables the boot block, guidance, and reset-style compaction (Pi's default compaction, including `keepRecentTokens`, applies again). `/pi-context on` re-enables; a bare `/pi-context` reports the current state.
- **History tools** — the model searches pre-reset conversation with case-sensitive literal substring search, exactly like Codex's `history.*` namespace.
- **Notes tools** — persistent, session-scoped virtual files that survive window resets.

## Reminder timing

Reminder and fallback thresholds derive from Pi's compaction reserve plus margins configured in `settings.json` under the top-level `pi-context` key:

```json
{
  "compaction": { "reserveTokens": 16384 },
  "pi-context": {
    "reminderMarginTokens": 24576,
    "fallbackMarginTokens": 8192
  }
}
```

Both margins are measured in **remaining context tokens** added on top of Pi's `compaction.reserveTokens`:

- `fallback = reserveTokens + fallbackMarginTokens` (default margin `8192`)
- `reminder = reserveTokens + reminderMarginTokens` (default margin `24576`)

Put the key in the global settings (`~/.pi/agent/settings.json`) or the project settings (`<cwd>/.pi/settings.json`); project values win per key, mirroring Pi's own settings merge. With Pi's default `reserveTokens: 16384` the defaults give reminder `40960` and fallback `24576`: the fallback sits one note-taking turn above Pi's reset line, and the reminder leaves another 16,384 tokens of working room above the fallback, no matter how you set `reserveTokens`.

Pi's `reserveTokens` and the `pi-context` margins are re-read from disk at every `session_start` and cached for that session. Invalid values — a margin that is not a positive integer, or a `reminderMarginTokens` that does not clear `fallbackMarginTokens` — are ignored per offending key with one TUI warning naming the key and the default used instead; session handling never throws. If `fallbackMarginTokens` still leaves the reminder below the fallback after the reminder's default is applied, that key degrades too, with its own warning.

This is a file-backed read through Pi's public `SettingsManager`. It sees committed `settings.json` only: SDK-level ephemeral `applyOverrides()` calls and the unreleased `compaction.modelOverrides` are not seen by this extension.

The extension does not change Pi settings or reserve additional context. Large tool outputs or user inputs can jump over one or both reminders; overflow recovery still resets immediately rather than forcing a doomed extra turn. For small context windows, tune the margins (or Pi's reserve) to fit the model.

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

`history_*` reads the current branch's actual Pi session entries, including entries hidden by earlier compaction. Window IDs are extension-owned: the root window is `pcw:<session-id>:root`, and each reset mints an 8-hex id baked into the compaction entry's `details.windowId` as `pcw:<session-id>:<minted>`. Pi-native compactions (extension toggled off) fall back to `pcw:<session-id>:<compaction-entry-id>`. Item IDs are the persisted Pi entry IDs. No transcript copy or volatile archive is maintained.

`notes_*` stores operation entries in the same append-only Pi session under `pi-context/note`. They are session-scoped, survive JSONL reload, never enter provider context, and use safe relative virtual paths only (no absolute paths, `..`, `.`, empty components, or backslashes). Searches are literal and case-sensitive. `notes_read_file` accepts inclusive 1-based line ranges; negative line numbers count from the last line. Writes are capped at 1,000,000 UTF-8 bytes.

Unlike Codex, the history tools do not advertise `agent_name`: Pi has no cross-agent session routing, so the parameter is omitted from the schemas entirely (strict `additionalProperties: false` still rejects it) instead of costing schema tokens on every request.

Two extra controls compose Pi public APIs:

- `get_context_remaining` returns `{ "remaining_tokens": number | null }`. `null` means Pi itself cannot make a reliable estimate (notably immediately after compaction). The low-budget guidance uses the same source and stays silent when the estimate is unknown.
- `new_context` returns terminal tool output, then waits for Pi's `agent_end`, triggers public `ctx.compact()`, installs a short deterministic reset compaction, and sends exactly one hidden continuation turn after compaction succeeds. Call it by itself in a tool batch. Pi only ends a tool turn when every parallel tool result is terminal, so Pi 0.85.1 cannot force an atomic rollover from the middle of a mixed parallel tool batch.

## Reset behavior and limits

On `session_before_compact`, the extension appends a persistent custom reset marker through public `pi.appendEntry`, reads that real marker ID from the readonly session manager, and returns it as `firstKeptEntryId`. Pi's `buildContextEntries()` then keeps the compaction envelope plus that custom marker; custom markers are excluded from LLM context. Thus the subsequent provider context contains the boot block summary and the marker, not old conversation messages. The boot summary also carries the extension-minted window id in its `details.windowId`, so the fresh window names itself with an id Pi could not have supplied at bake time. Only an explicit `new_context` adds a hidden continuation; automatic resets and user `/compact` keep Pi's native scheduling. The old entries remain only in the session tree for `history_*`.

Pi's built-in “compacted into the following summary” envelope is left intact. Its content explicitly says: “Context window reset. No summary was generated. Retrieve prior details through history_* and notes_*.” No context filtering or TUI override is used to hide that envelope.

The same handler is used for native automatic compaction. When Pi marks an overflow compaction `willRetry`, Pi core performs its single retry itself and this extension deliberately sends no second continuation. While the extension is enabled, its custom reset keeps nothing after the boundary marker, so Pi's `keepRecentTokens` setting has no effect; with `/pi-context off`, Pi's default compaction (and `keepRecentTokens`) applies again.

This is a composition of public `session_before_compact`, `session_compact`, `pi.appendEntry`, `ctx.compact`, and `pi.sendMessage`; it is not a Pi-core `newSession` call. A manual Pi compaction is only eligible when Pi's own `prepareCompaction()` accepts the session. Therefore a `new_context` request in a too-small/uncompactable session fails cleanly without default-summary fallback or continuation. A core change would be needed only to guarantee a force-reset at arbitrary small context sizes or to atomically interrupt a mixed parallel tool batch.

## Verification

```sh
npm run typecheck
npm test
```

The integration harness uses the installed Pi `SessionManager` and `SettingsManager` (global and project settings fixtures in temp directories, so the real `~/.pi` is never touched), including an on-disk JSONL reload. It verifies note persistence/Unicode/path rules, the boot block contents and extension-minted window ids on reset and root paths, that the `context` hook never injects, provider context exclusion after the real `firstKeptEntryId` boundary while history remains searchable, completed tool-result boundary placement, settings-derived threshold resolution and margin validation, one early reminder and one final fallback per window, one continuation only, and cancellation/failure/no-double-retry behavior. It uses no model or network call.
