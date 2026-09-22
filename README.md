# pi-context

Codex-style context windows for [Pi](https://github.com/earendil-works/pi-mono): durable reset windows, session-history tools, and persistent notes — implemented entirely with public extension APIs. No Pi core modification required.

## Install

```sh
pi install npm:@astrosheep/pi-context
```

Or load it for a single invocation without installing:

```sh
pi -e npm:@astrosheep/pi-context
```

## What you get

- **`wipe_memory`** — the model can request a fresh context window. The request commits after the complete tool batch; the old conversation stays in the session and remains readable through history_*, but is excluded from the next provider context.
- **A boot block at every window head** — static once-per-window content (cache-stable) carrying the window identity, the recent-notes index, and a short protocol that teaches the model how to recover: notes for its own bookkeeping, history tools for everything before the reset. The five note homes are read once into that boot's snapshot; a home that is unavailable is omitted without blocking the window, and the boot says that `notes_list` can retry after recovery.
- **Low-budget guidance** — one persisted early warning per window when the estimated remaining budget crosses the reminder line, so the model checkpoints before the lights go out.
- **`get_context_remaining`** — the live, reserve-adjusted estimate of the context budget left before Pi's compaction reserve.
- **Nine history/notes tools** — Codex's History/Notes actions flattened into Pi's single tool namespace; notes are real markdown files under `~/.agents/notes` (`human/`, `project/`, `agents/`, `models/`, `pi/session/`):

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

The tool descriptions the model sees are the behavioral documentation: note results use `address` as the sole home identity; search is case-sensitive literal substring; both `notes_read` and `history_read` are character windows prefixed with the same `READ WINDOW` block, whose cursors reconstruct the source exactly when only the content after each block is concatenated; anything a response does not deliver is named by an explicit field.

- **Runtime toggle** — `/pi-context off` disables new automatic resets; `/pi-context on` re-enables them; bare `/pi-context` reports the current state. A durable reset marker remains in force when off, so disabling the extension does not resurrect history from an already-reset window.

## Context-window protocol

Each reset appends one `pi-context/reset-marker` custom entry with `{ "windowId": "..." }`, followed by one hidden `pi-context/boot` custom message whose details carry the same `windowId`. The marker is the window boundary and the UUID-like window identity is independent of Pi entry IDs. Native compaction and branch-summary entries are history items inside the current window; they do not create windows.

`/wipe-memory` is the manual reset command. It waits for idle, appends the marker and boot through Pi's public session APIs, and does not call a model. While pi-context is enabled, `/compact` is cancelled with an actionable `/wipe-memory` notice. Automatic resets use the active provider-window usage; mixed tool batches finish before the boundary, and queued steering/follow-up messages are delivered exactly once in the new window. An aborted turn does not manufacture a continuation.

History remains available after reset, including earlier windows and raw JSONL. Branch navigation also remains available. If either the source or destination branch contains a reset marker, generated `/tree` summaries are suppressed with a notice because Pi's raw summary generator bypasses the context projection and could reintroduce erased history. Navigation itself is not suppressed; branches without markers retain native summaries.

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

## SDK integration

SDK hosts that create a session directly can bind pi-context to the exact same public `SettingsManager` authority as the session:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
// The package currently publishes source/dist files without a package main/exports entry.
import { createPiContext } from "@astrosheep/pi-context/dist/src/index.js";

const cwd = process.cwd();
const agentDir = "/tmp/my-pi-agent";
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: 16_384 },
});
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  extensionFactories: [createPiContext({ settingsManager })],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
});
```

The manager must be shared by the resource loader's factory and `createAgentSession`. If the host replaces its settings authority, it must create and bind a new `createPiContext({ settingsManager })` factory together with the replacement manager; an existing factory remains bound to the manager it was created with.

The default extension export is file-backed: it reads Pi's standard global settings directory plus the trusted project's `.pi/settings.json`, with project values winning per key. It cannot discover an arbitrary SDK session manager from `cwd`, environment variables, session IDs, or private SDK fields. For an injected manager, compaction settings come from the manager's public `getCompactionSettings(model)` getter, including the active model's `modelOverrides`; pi-context margins are read from the public `getGlobalSettings()` and `getProjectSettings()` scopes. Opaque runtime overrides that those public scope getters do not expose are intentionally not treated as pi-context configuration. Live public manager changes apply on the next policy query/turn, and the extension does not drain the manager's settings I/O diagnostics.

## Check the notes store

Run `dream doctor` (or `dream doctor --notes-home <dir>`) to check home layout, note frontmatter, concrete backtick-quoted note addresses, MAP entries, and lock presence/format. It is read-only: no model, git commits, directory creation, or repairs. Exit status is 0 when clean and 1 when issues are found. References needing an unavailable project context are reported as unresolved; prose and example/glob addresses are not validated. A present lock is reported without inferring process liveness.

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
