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

- **`wipe_memory`** — the model can request a fresh context window after completing a tool batch. Manual `/wipe-memory` and the budget warning instead start a close-out turn: the agent can write notes and use tools over multiple turns, then `wipe_memory` commits the reset or a successful normal stop falls back to one. Abort/error never counts as completion. Raw conversation remains in the session and history_* tools, but is excluded from the next provider context.
- **A boot block at every window head** — static once-per-window content (cache-stable) carrying the window identity, the recent-notes index, and a short protocol that teaches the model how to recover: notes for its own bookkeeping, history tools for everything before the reset. The five note homes are read once into that boot's snapshot; a home that is unavailable is omitted without blocking the window, and the boot says that `notes_list` can retry after recovery.
- **Budget close-out** — one early reminder at the configured margin, followed (when automatic compaction is enabled) by a shared hidden warning above Pi's hard reserve. That warning arms the same multi-turn close-out as `/wipe-memory`; the hard reserve remains a separate safety reset.
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

The tool descriptions the model sees are the behavioral documentation: history is a seq-numbered conversation; `history_list` shows the newest conversation page by default, and its `older_before`/`newer_after` response fields are ready to pass back as `before`/`after` while retaining the other filters and anchor; `history_search` finds case-insensitive literal text, previews from the earliest match, and returns `seq` plus `offset_chars` for `history_read`. Notes listings are recent-first snapshots with a `more` count when the wire budget or limit leaves rows out; use `pattern` to narrow the address range. Note results use `address` as the sole home identity; both searches use case-insensitive literal substrings with multiple queries combined by OR; pass a search result's address (`address` or `seq`) and `offset_chars` to the corresponding read tool; both `notes_read` and `history_read` are character windows prefixed with the same `READ WINDOW` block, whose cursors reconstruct the source exactly when only the content after each block is concatenated; anything a response does not deliver is named by an explicit field.

- **Runtime toggle** — `/pi-context off` disables new automatic resets; `/pi-context on` re-enables them; bare `/pi-context` reports the current state. A durable reset marker remains in force when off, so disabling the extension does not resurrect history from an already-reset window.

## Context-window protocol

Each committed reset first appends a native empty-summary compaction checkpoint with `firstKeptEntryId` set to the checkpoint itself (retain none), then a `pi-context/reset-marker`, hidden `pi-context/boot`, and hidden continuation. The checkpoint lets Pi's persisted canonical projection discard earlier conversation while retaining the system/tool state and empty summary wrapper. The raw session branch and history tools still retain the full conversation. The marker's `windowId` is the durable window identity; legacy marker-only branches remain readable through a narrow compatibility projection.

`/wipe-memory` waits for idle, records the shared hidden close-out warning, and triggers an ordinary model turn. The agent may write notes and use tools over multiple turns; an explicit `wipe_memory` commits after the complete batch, or a successful normal stop commits after queued messages drain. Abort/error does not commit. The budget warning arms this same close-out path; ordinary reminder guidance precedes it, and the hard reserve is a separate safety boundary. Direct `wipe_memory` remains valid without a prior warning. While pi-context is enabled, `/compact` is cancelled with an actionable `/wipe-memory` notice. Close-out requests wait for queued steering/follow-up work in the current window, while explicit tool resets commit after their batch and Pi delivers queued work exactly once. An aborted turn does not manufacture a continuation.

History remains available after reset, including earlier windows and raw JSONL. Branch navigation also remains available. If either the source or destination branch contains a reset marker, generated `/tree` summaries are suppressed with a notice because Pi's raw summary generator bypasses the context projection and could reintroduce erased history. Navigation itself is not suppressed; branches without markers retain native summaries.

## Configuration

The reminder threshold is Pi's compaction reserve plus a margin, configured under the top-level `pi-context` key in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json` (project values win per key):

```json
{
  "compaction": { "reserveTokens": 16384 },
  "pi-context": { "reminderMarginTokens": 24576 }
}
```

`reminder = reserveTokens + reminderMarginTokens`; with the defaults the early guidance fires 24,576 tokens above Pi's reset line. When automatic compaction is enabled, the shared close-out warning starts at `reserveTokens + 12,288`; the hard reserve is the final safety boundary.

The dreamer model is configured under the same key. `--dreamer <model pattern>` on the `dream` CLI wins; otherwise a non-empty `pi-context.dreamer` string from settings applies; otherwise the automatic model is used. An invalid value (empty or not a string) is ignored with one warning.

```json
{
  "pi-context": { "reminderMarginTokens": 24576, "dreamer": "anthropic/claude-sonnet-4-5" }
}
```

## Standalone notes library

The same package provides a **Node.js TypeScript library independent of Pi**:

```sh
npm install @astrosheep/pi-context
```

```ts
import { createNotesStore, type NotesContext } from "@astrosheep/pi-context/notes";

const context: NotesContext = {
  home: "/path/to/notes",          // explicit filesystem root
  sessionId: "my-session",        // safe single directory component
  projectKey: "my-project-a1b2c3d4",
  agent: "my-agent",              // canonical lowercase slug
  model: "my-model",              // canonical lowercase slug
};
const notes = createNotesStore(context);
await notes.write("@project/decisions.md", "Use a shared notes library.", { origin: "user" });
await notes.edit("@project/decisions.md", [
  { oldText: "shared", newText: "host-independent" },
]);
const note = await notes.read("@project/decisions.md"); // full text/body/metadata, or undefined
const files = await notes.list({ pattern: "@project/**" });
const matches = await notes.search(["library"]);
```

`/notes` ships JavaScript and TypeScript declarations. It does not import Pi or read `PI_*` environment variables. Pi packages are optional peers: a notes-only installation does not install them. Using the plugin, root SDK entry, or `dream` CLI still requires Pi. This is a filesystem library for Node, not a browser storage API.

### API and identity

`createNotesStore(context)` snapshots the five required identity fields; changing the supplied object afterward does not retarget the store. It resolves `home` once, validates identity components, and creates no files until an operation needs to write. Create a new store to change identity. Multiple stores can use independent roots and identities without changing process environment.

- `write(address, content, { origin?, stale? }?)` returns `Promise<{ meta }>`. Default origin is `self`; overwriting preserves creation time, existing project ownership, and unknown metadata, and revives stale notes unless `stale: true` is supplied.
- `read(address)` returns `Promise<{ meta, body, text, resolvedScope } | undefined>`. **Reads update** `lastAccessed` and `accessCount` on disk; `text` includes frontmatter.
- `edit(address, edits?, { origin?, stale?, replaceAll? }?)` returns `Promise<{ meta, applied, resolvedScope, change }>`. Edits affect the body; metadata-only changes need no edits. Each replacement uses the evolving body in array order; the complete batch is written atomically only after every edit succeeds. `change` is a typed `{ kind, before, after }`: `kind` is `body`, `metadata`, or `file` to identify the diff inputs, or `none` with empty strings when neither body nor origin/stale changed. It is not a rendered diff.
- `list({ pattern?, scope?, who? }?)` returns `Promise<NoteRow[]>`, sorted by update time descending with address tie-breaking. Rows contain address, scope, virtual path, metadata, body, and body byte size. `scope` narrows the five-home view; `who` names a concrete agent/model home.
- `search(queries: string[], { pattern?, scope?, who? }?)` returns `Promise<NoteSearchRow[]>`, sorted by address. Matching is case-insensitive literal OR over body lines; matches contain one-based `line`, `text`, and `offsetChars` into the serialized read text. Neither listing nor search increments access metadata.

`list` and `search` share the `NotesQuery` type. A merged query uses `{ pattern? }`; a single-home query adds `scope`. Only `scope: "agent" | "model"` accepts `who`. TypeScript rejects combinations such as `{ scope: "project", who: "root" }`, and JavaScript callers receive a runtime refusal.

The library returns full data, not tool envelopes or paginated/truncated output. `NoteError` exposes the existing named store refusals through `code`, with `lineNumbers` for ambiguous edits and `editIndex` for a failed edit. Runtime API fields and known persisted note metadata use camelCase; Pi tool wire fields such as `updated_at`, `offset_chars`, and `replace_all` retain their established names. Unrecognized frontmatter keys, including old snake_case metadata, are preserved as ordinary extras; they are not interpreted as current camelCase fields or migrated automatically. Invalid addresses/identities and filesystem failures reject; only a missing `read` returns `undefined`. Notes remain markdown files with the existing size limits and same-directory atomic rename. Same-file read/modify/write work is serialized by absolute physical filename across all store instances in this process (including `.md` address aliases); symlink/case aliases and cross-process locking are not guaranteed. `list` and `search` asynchronously traverse homes and serialize each discovered file read against pending mutations, but are not global snapshots and may not discover a file created after traversal. Foreign named homes can be read (including the access-metadata update), but their bodies cannot be written or edited through the store. These are cooperative address rules, not an OS security sandbox.

Addresses use bare paths, `@project/`, `@human/`, `@self/`, `@model/`, or explicit `@agents/<slug>/` and `@models/<slug>/`. Relative self/model addresses resolve to the supplied identity; listing renders their concrete names. The disk layout remains `pi/session/<sessionId>/`, `project/<projectKey>/`, `human/`, `agents/<agent>/`, and `models/<model>/`. No data migration happens on library import or construction. Notes already using camelCase metadata retain their metadata; old snake_case keys are preserved as unrecognized extras, not interpreted or migrated. New session notes record the supplied project key.

### Library and plugin boundary

Ownership is explicit in the file tree:

```text
src/
  notes/                 # host-independent library
    index.ts             # deliberate public exports
    context.ts           # explicit identity validation and snapshot
    store.ts             # five storage operations
    address.ts           # address parsing and matching
    paths.ts             # disk layout and project identity
    frontmatter.ts       # persisted metadata codec
    constants.ts         # storage limits
  pi/notes/              # Pi integration, not part of /notes
    adapter.ts           # live identity, root defaults, activation migration
    tools.ts             # schemas, diff rendering, output budgets
    snapshot.ts          # boot's five-home snapshot
    session-replay.ts    # historical Pi session operations
```

The public runtime exports are `createNotesStore`, `NoteError`, `projectKey(cwd)`, and `slugify(value)`, alongside the API's TypeScript types. The factory and `projectKey` remain synchronous; `projectKey` provides the existing repository/worktree identity algorithm, while `slugify` normalizes an agent/model name. The five store methods return promises and use asynchronous filesystem operations. Path/glob helpers, serialization, validation internals and constants are implementation details, not exported through `/notes`.

The Pi adapter supplies the root and live session/project/agent/model identity on each call. Tools and boot use the same storage implementation. Tool schemas, Pi-style edit diff rendering, wire budgets, pagination, boot selection, legacy activation migration, and session replay stay outside the library. There are no parallel legacy store/path adapters. Internal source paths are not the supported library API.

## SDK integration

SDK hosts that create a session directly can bind pi-context to the exact same public `SettingsManager` authority as the session:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiContext } from "@astrosheep/pi-context";

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

The previous `@astrosheep/pi-context/dist/src/index.js` SDK import remains supported. The root entry is Pi-dependent; notes-only consumers should import `/notes` instead.

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

## Dream skill

The package also provides `/skill:dream` for reviewing notes in the current agent session. The skill reads the same `playbook.md` used by the `dream` CLI; there is only one set of dream instructions.

Scope comes from the invocation directory: inside the notes store, dream may inspect across homes; in a project, it extracts from that project's material and all session notes with matching project metadata, and organizes only that project's notes. New session notes record their project key in the frontmatter `project` field. Standard linked Git worktrees resolve to the main checkout's repository root, sharing its project key and `@project/` home. Older metadata and homes remain untouched by the code: there is no automatic migration or backfill; existing data can be migrated manually. Notes without project metadata are skipped in project-only discovery. Changing directories later does not broaden the scope.

The skill stays in the current agent session. Its wrapper and shared playbook describe the dreamer's task, not runtime setup: the execution entry point is responsible for supplying readable/writable scope and establishing write permission, including locking and Git audit safeguards. The CLI supplies its own safeguards; the bare skill does not install them. Without an established scope and write permission, the dreamer asks rather than improvising runtime setup. Session records and unapproved homes stay untouched.

## Documentation

Implementation architecture and the reset lifecycle live in [docs/](docs/).

## Development

```sh
npm test            # build from a clean dist, then run the suite
npm run typecheck
npm run test:notes-package  # pack, install without Pi, typecheck and run a consumer
```

The harness runs against the real installed Pi `SessionManager`/`SettingsManager` in temporary directories with fake credentials — no model or network calls, and the real `~/.pi` is never touched.

## License

MIT
