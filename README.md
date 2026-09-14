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
- **`<context_window>` hint** — persisted as a visible custom message at session start and after each window reset (Codex-style: written once into history instead of re-injected per request). It carries the agent name, first/current/previous window IDs, and the 5 most recently updated notes. Within a window the note list goes stale, exactly like Codex's steady-state world-state diffing.
- **Low-budget guidance** — when remaining context first drops to 16,000 tokens or below, a `<context_window_guidance>` reminder is **persisted once per window** into history (TUI-visible, no extra turn; `sendMessage` safely defers to end of turn mid-stream). The in-flight request additionally gets one transient tail copy so the model sees it immediately. Text is static and appended, so the provider prefix cache survives. The exact remaining figure is one `get_context_remaining` call away. Note: Pi's built-in auto-compaction fires when remaining context falls below `reserveTokens` (default 16,384), so raise the reminder threshold above your `reserveTokens` or the reminder never precedes compaction.
- **Auto-compact fallback** — Codex `auto_compact_fallback_prompt` parity, adapted to Pi's trigger points. On the first proactive `threshold` compaction in a window (post-run, agent still streaming), the extension cancels compaction once and steers in a note-taking turn ("write durable state with `notes_write_file` now"); the next threshold trigger performs the real reset and auto-continues, like Codex's mid-turn rollover. The pre-prompt threshold path (idle — cancelling would race the user prompt) and `overflow` recovery (cancelling would abandon Pi's one-shot retry) reset immediately without a fallback turn.
- **Runtime toggle** — `/pi-context off` disables hint injection, guidance, fallback turns, and reset-style compaction (Pi's default compaction, including `keepRecentTokens`, applies again). `/pi-context on` re-enables; a bare `/pi-context` reports the current state.
- **History tools** — the model searches pre-reset conversation with case-sensitive literal substring search, exactly like Codex's `history.*` namespace.
- **Notes tools** — persistent, session-scoped virtual files that survive window resets.

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

On `session_before_compact`, the extension appends a persistent custom reset marker through public `pi.appendEntry`, reads that real marker ID from the readonly session manager, and returns it as `firstKeptEntryId`. Pi's `buildContextEntries()` then keeps the compaction envelope plus that custom marker; custom markers are excluded from LLM context. Thus the subsequent provider context contains the short reset result and hidden continuation, not old conversation messages. The old entries remain only in the session tree for `history_*`.

The same handler is used for native automatic compaction. When Pi marks an overflow compaction `willRetry`, Pi core performs its single retry itself and this extension deliberately sends no second continuation. While the extension is enabled, its custom reset keeps nothing after the boundary marker, so Pi's `keepRecentTokens` setting has no effect; with `/pi-context off`, Pi's default compaction (and `keepRecentTokens`) applies again.

This is a composition of public `session_before_compact`, `session_compact`, `pi.appendEntry`, `ctx.compact`, and `pi.sendMessage`; it is not a Pi-core `newSession` call. A manual Pi compaction is only eligible when Pi's own `prepareCompaction()` accepts the session. Therefore a `new_context` request in a too-small/uncompactable session fails cleanly without default-summary fallback or continuation. A core change would be needed only to guarantee a force-reset at arbitrary small context sizes or to atomically interrupt a mixed parallel tool batch.

## Verification

```sh
npm run typecheck
npm test
```

The integration harness uses the installed Pi `SessionManager`, including an on-disk JSONL reload. It verifies note persistence/Unicode/path rules, provider context exclusion after the real `firstKeptEntryId` boundary while history remains searchable, completed tool-result boundary placement, one continuation only, and cancellation/failure/no-double-retry behavior. It uses no model or network call.
