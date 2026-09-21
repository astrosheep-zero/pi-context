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

## What you get

- **`new_context`** — the model can start a fresh context window. The old conversation leaves the provider context but stays in the session, so nothing is lost. Call it on its own, not inside a parallel tool batch.
- **A boot block at every window head** — static once-per-window content (cache-stable) carrying the window identity, the recent-notes index, and a short protocol that teaches the model how to recover: notes for its own bookkeeping, history tools for everything before the reset.
- **Low-budget guidance** — one persisted early warning per window when the estimated remaining budget crosses the reminder line, so the model checkpoints before the lights go out.
- **`get_context_remaining`** — the live, reserve-adjusted estimate of the context budget left before Pi's compaction reserve.
- **Nine history/notes tools** — Codex's History/Notes actions flattened into Pi's single tool namespace; notes are real markdown files under `~/.agents/notes` (`personal/`, `project/`, `pi/session/`):

| Codex action | Pi tool |
| --- | --- |
| `history.list_windows` | `history_windows` |
| `history.list_items` | `history_list` |
| `history.read_item` | `history_read` |
| `history.search_contents` | `history_search` |
| `notes.write` | `notes_write` |
| `notes.edit` | `notes_edit` |
| `notes.read` | `notes_read` |
| `notes.list` | `notes_list` |
| `notes.search` | `notes_search` |

The tool descriptions the model sees are the behavioral documentation: search is case-sensitive literal substring; reads are character windows whose cursors reconstruct the original exactly; anything a response does not deliver is named by an explicit field.

- **Runtime toggle** — `/pi-context off` restores Pi's default compaction (including `keepRecentTokens`); `/pi-context on` re-enables; bare `/pi-context` reports the current state.

## Configuration

The reminder threshold is Pi's compaction reserve plus a margin, configured under the top-level `pi-context` key in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json` (project values win per key):

```json
{
  "compaction": { "reserveTokens": 16384 },
  "pi-context": { "reminderMarginTokens": 24576 }
}
```

`reminder = reserveTokens + reminderMarginTokens`; with the defaults the early warning fires 24,576 tokens above Pi's reset line.

The dreamer model is configured under the same key. `--dreamer <model pattern>` on the `dream` CLI wins; otherwise a non-empty `pi-context.dreamer` string from settings applies; otherwise the automatic model is used. An invalid value (empty or not a string) is ignored with one warning.

```json
{
  "pi-context": { "reminderMarginTokens": 24576, "dreamer": "anthropic/claude-sonnet-4-5" }
}
```

## The dream lock

The `dream` CLI takes an exclusive `.dream.lock` in the notes home with a single O_CREAT|O_EXCL creation. The lock is Git-style existence locking: an existing lock refuses a new run regardless of its contents, PID, or age, and `--force` bypasses only the scheduling and material gates, never the lock. A lock is released only by the run that acquired it (and repeated cleanup is harmless), so a live dream is never displaced.

If a dream process crashed, its lock remains and later runs refuse to start. There is no automatic recovery and no force-unlock command: after you have confirmed that no dream process is running, remove the stale lock by hand.

```sh
# only when no dream is running
rm "${PI_NOTES_HOME:-$HOME/.agents/notes}/.dream.lock"
```

Removing a lock while a holder is running is outside the supported cooperative protocol and can let two dreams run at once.

## Documentation

Implementation architecture and the reset lifecycle live in [docs/](docs/).

## Development

```sh
npm test            # build from a clean dist, then run the suite
npm run typecheck
```

The harness runs against the real installed Pi `SessionManager`/`SettingsManager` in temporary directories with fake credentials — no model or network calls, and the real `~/.pi` is never touched.

## License

MIT
