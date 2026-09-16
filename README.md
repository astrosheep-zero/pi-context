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

- **`new_context` tool** — the model requests a fresh context window. The extension waits for the current run to settle, compacts with a short deterministic reset message (old conversation is excluded from the new provider context but stays in the session), then sends one hidden continuation turn once compaction has fully completed, unless another prompt is already queued or running.
- **`<context_window>` boot block** — the head of every fresh window. For a reset it IS the summary returned from `session_before_compact` (position 0, persisted, no extra message); for the root window `session_start` persists it once as a visible custom message. It carries the agent name and first/current/previous window IDs, the recent-notes index, and a `<context_window_protocol>` teaching block. The notes index lists up to three most-recent notes, each with its `X lines, Y UTF-8 bytes` metadata plus a local-time ISO 8601 `updated` timestamp (explicit UTC offset, never `Z`) and an inline preview. A note of 200 Unicode characters or fewer is shown whole; a longer one shows its first 120 and last 80 Unicode characters joined by an ellipsis, so the two ends never overlap and no text is repeated. The notes index is a window-open snapshot with the same frozen-at-write semantics as the reminder count. Nothing is injected transiently per request: the boot block is static once-per-window content, so the head of the window stays cache-stable. Codex diverges here — its `<context_window>` block carries only the agent path and window IDs, while the notes index is our own addition.
- **Low-budget guidance** — when estimated remaining context first drops to the reminder threshold (by default **40,960 tokens**: Pi's default 16,384 `reserveTokens` plus a 24,576 reminder margin; see [Reminder timing](#reminder-timing)), a `<context_window_guidance>` reminder is **persisted once per window** into history (TUI-visible, no extra turn; `sendMessage` safely defers mid-stream). There is deliberately no transient copy: a bridge would make the model meet the same text twice at shifted positions, because history records the persisted copy after the crossing request's assistant reply. The reminder is an early warning, so arriving from the next request on costs nothing and keeps the model's view identical to recorded history. The measured remaining budget excludes `reserveTokens` and is frozen into the text at the threshold crossing, so the persisted reminder is a snapshot true at write time; `get_context_remaining` remains the live source for the current figure. The text is appended rather than prepended; existing history is not rewritten.
- **Two-phase automatic fallback** — while Pi is streaming, the first automatic `threshold`/`overflow` crossing of the reserve line does not reset immediately. `session_before_compact` queues the final note-taking instruction with `pi.sendMessage(..., { triggerTurn: true })` — which Pi routes to `agent.steer()` while streaming, so the message is queued synchronously and reaches the model before any pending user input — and returns `{ cancel: true }`. Pi records that as an aborted compaction, spends no summary, and continues the same run with the borrowed turn; no user text or images are copied, intercepted, or replayed, and no `input` handler is registered. Once the borrowed run has finished, `agent_end` arms the real reset and `agent_settled` requests it through `ctx.compact()` for both `threshold` and `overflow`, unless another compaction has already completed. Pi can perform another automatic check after a run, and overflow recovery has a one-shot guard. The settled scheduler ensures the borrowed turn has one reset owner even when no native check resets it. Requesting the reset after the run settles avoids issuing it from `agent_end` while Pi is still finishing the run. A phase flag makes the cancel happen at most once per window — it re-arms only after a completed reset starts a fresh window. A failed reset clears the pending request, warns the user, and leaves history intact; another prompt can retry without borrowing another turn. Extension-requested fallback resets send a continuation after the compaction completion callback. The borrow is skipped when the crossing arrives while Pi is idle (the pre-prompt check in `AgentSession.prompt()`, where `triggerTurn` would start a nested run and make the pending `Agent.prompt()` reject); that crossing resets directly. `manual` `/compact` and `new_context` never take the borrowed-turn path. The reminder asks the model to write notes early; if it misses that opportunity, old history remains searchable.
- **Runtime toggle** — `/pi-context off` disables the boot block, guidance, and reset-style compaction (Pi's default compaction, including `keepRecentTokens`, applies again). `/pi-context on` re-enables; a bare `/pi-context` reports the current state.
- **History tools** — the model searches pre-reset conversation with case-sensitive literal substring search, exactly like Codex's `history.*` namespace.
- **Notes tools** — persistent, session-scoped virtual files that survive window resets.

## Reminder timing

The reminder threshold derives from Pi's compaction reserve plus a margin configured in `settings.json` under the top-level `pi-context` key:

```json
{
  "compaction": { "reserveTokens": 16384 },
  "pi-context": {
    "reminderMarginTokens": 24576
  }
}
```

The margin is measured in **remaining context tokens** added on top of Pi's `compaction.reserveTokens`:

- `reminder = reserveTokens + reminderMarginTokens` (default margin `24576`)

Put the key in the global settings (`~/.pi/agent/settings.json`) or the project settings (`<cwd>/.pi/settings.json`); project values win per key, mirroring Pi's own settings merge. With Pi's default `reserveTokens: 16384` the default gives reminder `40960`, leaving 24,576 tokens of working room above Pi's reset line no matter how you set `reserveTokens`. The reminder is an early warning; once fallback guidance has been persisted in the current window, no later early reminder is appended. This also applies after session reload. The borrowed fallback turn needs no threshold of its own: it is driven by Pi's automatic `threshold`/`overflow` compaction request, so `before_agent_start`/`turn_end` send nothing and no `fallbackMarginTokens` setting exists.

Pi's `reserveTokens` and the `pi-context` reminder margin are re-read from disk at every `session_start` and cached for that session. An invalid margin — not a positive integer — is ignored with one TUI warning naming the key and the default used instead; session handling never throws.

This is a file-backed read through Pi's public `SettingsManager`. It sees committed `settings.json` only: SDK-level ephemeral `applyOverrides()` calls and the unreleased `compaction.modelOverrides` are not seen by this extension.

The extension does not change Pi settings or reserve additional context. Large tool outputs or user inputs can jump over the reminder. For small context windows, tune the reminder margin (or Pi's reserve) to fit the model.

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

`history_*` reads the current branch's actual Pi session entries, including entries hidden by earlier compaction. Window IDs are extension-owned: the root window is `pcw:<session-id>:root`, and each reset mints an 8-hex id baked into the compaction entry's `details.windowId` as `pcw:<session-id>:<minted>`. Pi-native compactions (extension toggled off) fall back to `pcw:<session-id>:<compaction-entry-id>`. Item IDs are the persisted Pi entry IDs. No transcript copy or volatile archive is maintained. Ordering is newest-first by default: `recent_first` omitted or `true` returns newest-first, and only an explicit `false` returns oldest-first; `history_list_windows`, `history_list_items`, and `history_search_contents` share that switch.

`notes_*` stores operation entries in the same append-only Pi session under `pi-context/note`. They are session-scoped, survive JSONL reload, never enter provider context, and use safe relative virtual paths only (no absolute paths, `..`, `.`, empty components, or backslashes). Searches are literal and case-sensitive. `notes_read_file` accepts inclusive 1-based line ranges; negative line numbers count from the last line. `notes_read_file` success results and every matched file object from `notes_search_contents` also carry `created_at` and `updated_at`, the same fields `notes_list_files_by_prefix` returns. All note timestamps are local-time ISO 8601 strings with an explicit UTC offset (for example `2026-09-15T17:31:45.392+08:00`; a UTC host renders `+00:00`, never `Z`), while the persisted `NoteFile`/`NoteOperation` metadata keeps plain epoch milliseconds. Error results carry no timestamps. Writes are capped at 1,000,000 UTF-8 bytes.

Unlike Codex, the history tools do not advertise `agent_name`: Pi has no cross-agent session routing, so the parameter is omitted from the schemas entirely (strict `additionalProperties: false` still rejects it) instead of costing schema tokens on every request.

Two extra controls compose Pi public APIs:

- `get_context_remaining` returns `{ "remaining_tokens": number | null }`, computed as `max(0, contextWindow - usedTokens - reserveTokens)`: the estimated budget available before Pi's compaction reserve. `null` means Pi itself cannot make a reliable estimate (notably immediately after compaction). The low-budget guidance reports this same reserve-adjusted budget and stays silent when the estimate is unknown. Its trigger still compares physical remaining capacity against `reserveTokens + reminderMarginTokens`, so subtracting reserve from the reported number does not change reminder timing.
- `new_context` returns terminal tool output, then waits for Pi's `agent_settled`, triggers public `ctx.compact()`, installs a short deterministic reset compaction, and sends exactly one hidden continuation turn after compaction succeeds. Call it by itself in a tool batch. Pi only ends a tool turn when every parallel tool result is terminal, so Pi 0.85.1 cannot force an atomic rollover from the middle of a mixed parallel tool batch.

## Reset behavior and limits

On `session_before_compact`, the extension appends a persistent custom reset marker through public `pi.appendEntry`, reads that real marker ID from the readonly session manager, and returns it as `firstKeptEntryId`. Pi's `buildContextEntries()` then keeps the compaction envelope plus that custom marker; custom markers are excluded from LLM context. Thus the subsequent provider context contains the boot block summary and the marker, not old conversation messages. The boot summary also carries the extension-minted window id in its `details.windowId`, so the fresh window names itself with an id Pi could not have supplied at bake time. Both explicit `new_context` and the reset requested after a borrowed fallback run add a hidden continuation from `ctx.compact`'s `onComplete` callback. Native automatic resets and user `/compact` keep Pi's native scheduling. Explicit and fallback reset requests share the `agent_settled` scheduler: if the model calls `new_context` in a borrowed fallback run, the explicit request consumes that fallback allowance, producing one reset and at most one continuation. Continuation is suppressed if another prompt is queued or already running. The old entries remain only in the session tree for `history_*`.

The scheduler lives in [`src/reset-lifecycle.ts`](src/reset-lifecycle.ts); `src/index.ts` composes the features and builds reset boundaries. History and notes projections, tool adapters, budget policy, and prompt rendering have separate ownership described in [Architecture](docs/architecture.md). See the [lifecycle event table](docs/reset-lifecycle.md) for ownership and cancellation rules. Shutdown, tree navigation, and toggling off invalidate outstanding callbacks. An aborted run clears pending rollover work. Queued steering/follow-up messages may continue before the run settles; the extension does not clear or replay that queue.

Pi's built-in “compacted into the following summary” envelope is left intact. Its content explicitly says: “Context window reset: this is a fresh window. The previous conversation is not included and no summary was generated. Notes and durable session history persist across windows.” No context filtering or TUI override is used to hide that envelope.

The same handler is used for native automatic compaction. When Pi marks an overflow compaction `willRetry`, Pi core performs its single retry itself and this extension deliberately sends no second continuation. While the extension is enabled, its custom reset keeps nothing after the boundary marker, so Pi's `keepRecentTokens` setting has no effect; with `/pi-context off`, Pi's default compaction (and `keepRecentTokens`) applies again.

This is a composition of public `session_before_compact`, `session_compact`, `pi.appendEntry`, `ctx.compact`, and `pi.sendMessage`; it is not a Pi-core `newSession` call. A manual Pi compaction is only eligible when Pi's own `prepareCompaction()` accepts the session. Therefore a `new_context` request in a too-small/uncompactable session fails cleanly without default-summary fallback or continuation. A core change would be needed only to guarantee a force-reset at arbitrary small context sizes or to atomically interrupt a mixed parallel tool batch.

## Verification

```sh
npm run typecheck
npm test
```

The integration harness uses the installed Pi `SessionManager` and `SettingsManager` (global and project settings fixtures in temp directories, so the real `~/.pi` is never touched), including an on-disk JSONL reload. It verifies note persistence/Unicode/path rules, the boot block contents and extension-minted window ids on reset and root paths, that the `context` hook never injects, provider context exclusion after the real `firstKeptEntryId` boundary while history remains searchable, completed tool-result boundary placement, settings-derived reminder threshold resolution and margin validation, that the removed `before_agent_start`/`turn_end` fallback is gone, one early reminder per window, one continuation only, the two-phase automatic ordering (one cancel, one steer, one real reset, re-armed per window, `ctx.compact()` for both threshold and overflow, idle crossings and manual/`new_context` resets bypassing the borrow), and cancellation/failure/no-double-retry behavior. Additional lifecycle tests cover duplicate callbacks, stale callback identity, shutdown/tree/toggle changes, user abort, synchronous errors, native retry ownership, and queued prompts. SDK tests run the real Pi agent loop, extension hooks, manual compaction, and continuation with scripted provider responses: explicit and fallback resets each produce one boundary, exclude old provider context, and preserve durable history. A real uncompactable-session case verifies no automatic retry and recovery on the next user prompt. Further SDK cases verify fallback note-writing while usage remains above the reserve line, with no obsolete early reminder before reset; steering/follow-up delivery before reset without replay; consecutive distinct windows; and user cancellation without automatic continuation. Persisted-data tests verify boot/reminder deduplication after JSONL reload and branch navigation, and reject malformed note timestamps without overwriting valid notes. These tests use temporary settings and fake credentials and make no model or network call.
