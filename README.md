# pi-context

Your agent's memory gets wiped when the context fills. pi-context makes that survivable: the agent keeps durable notes, checkpoints before a wipe, and reads its own history afterward. For you it's mostly invisible — an occasional notification, `/wipe-memory` to force a fresh window, `/pi-context` to toggle.

Codex-style context windows for [Pi](https://github.com/earendil-works/pi): durable reset windows, session-history tools, and persistent notes — implemented entirely with public extension APIs. No Pi core modification required.

## Install

```sh
pi install npm:@astrosheep/pi-context
```

Or load it for a single invocation without installing:

```sh
pi -e npm:@astrosheep/pi-context
```

## What you get

- **`wipe_memory`** — the model can request a fresh context window after completing a tool batch. Manual `/wipe-memory` arms a close-out that always ends in a stop: the hidden warning starts one turn when idle or steers a running turn, the agent closes out its notes, and the reset commits when the run settles. Abort and ordinary errors never count as completion; a manual overflow clears the window and stops without a recovery request. Raw conversation remains in the session and history_* tools, but is excluded from the next provider context.
- **A boot block at every window head** — static once-per-window content (cache-stable) carrying the window identity, the recent-notes index, and a short protocol that teaches the model how to recover: notes for its own bookkeeping, history tools for everything before the reset. The five note homes are read once into that boot's snapshot; a home that is unavailable is omitted without blocking the window, and the boot says that `notes_list` can retry after recovery.
- **Budget close-out** — one early reminder at the configured margin, followed (when automatic compaction is enabled) by a hidden warning above Pi's hard reserve. That warning allows a multi-turn close-out and, unlike manual `/wipe-memory` (which stops), continues in the fresh window. The hard reserve remains a separate safety reset.
- **`get_context_remaining`** — the live context-budget countdown to the warning line (`reserve + 16,384`); the warning runway below that line is hidden, and unknown usage returns null.
- **Nine history/notes tools** — Codex's History/Notes actions flattened into Pi tool names, grouped under the `notes` and `history` tool namespaces (both point to `/skill:memory`); notes are real markdown files under `~/.agents/notes` (`human/`, `project/`, `agents/`, `models/`, `pi/session/`):

| Codex action | Pi tool |
| --- | --- |
| `history.list_windows` | `history_windows` |
| `history.list_items` | `history_list` |
| `history.read_item` | `history_read` |
| `history.search_contents` | `history_search` |
| `notes.write` | `notes_write` |
| `notes.update` | `notes_update` |
| `notes.rename` | `notes_update` (`rename_to`) |
| `notes.read` | `notes_read` |
| `notes.list` | `notes_list` |
| `notes.search` | `notes_search` |

Notes/history tools return the success payload directly or `{ error: message, code, details? }` on failure. Codemode receives this object through Pi's structured results; ordinary model calls receive concise text rendered from the same bounded result. This replaces the old `ok/data` envelope. See [Tool results](docs/tool-results.md).

History is a seq-numbered stream of `user`, `assistant`, `tool` (call and result combined), and `context` (summaries and injected messages) events. `history_list` shows the newest conversation page by default, folding tool/context events; pass `roles` to expand selected types. `older_before`/`newer_after` are ready to pass back as `before`/`after` while retaining the filters and opposite anchor. `history_search` finds case-insensitive literal text in the event document, including recorded tool names, arguments, output and nested-call metadata. Its `seq` and `offset_chars` feed `history_read`. Only public event seqs are readable; a paired result does not introduce an alias address. Nested calls belong to their parent execution, have no independent seq, and never claim to contain unrecorded child outputs.

Notes listings are recent-first snapshots with a `more` count when the output budget or limit leaves rows out; use `pattern` to narrow the range. Both searches accept one literal or several literals combined by OR. Notes reads separate metadata from the body; note search/read positions count Unicode code points in the **body only**, never in serialized frontmatter. History search/read positions count code points in the same deterministic event document. Both read tools return `text`, `offset_chars`, `total_chars`, `next_offset_chars`, and `limited_by` at the result root; concatenate `text` and pass `next_offset_chars` as the next `offset_chars` until null. Tool history reads add a compact summary; full arguments and nested-call records appear only in the pageable text. Text rendering places an actionable continuation notice after the payload only when more remains. The notice is not part of `text` or its character positions.

- **Runtime toggle** — `/pi-context off` disables new automatic resets; `/pi-context on` re-enables them; bare `/pi-context` reports the current state. A durable reset marker remains in force when off, so disabling the extension does not resurrect history from an already-reset window.

## Context-window protocol

Each committed reset first appends a native empty-summary compaction checkpoint with `firstKeptEntryId` set to the checkpoint itself (retain none), then a `pi-context/reset-marker`, hidden `pi-context/boot`, and hidden continuation. The checkpoint lets Pi's persisted canonical projection discard earlier conversation while retaining the system/tool state and empty summary wrapper. The raw session branch and history tools still retain the full conversation. The marker's `windowId` is the durable window identity; legacy marker-only branches remain readable through a narrow compatibility projection.

`/wipe-memory` acknowledges the request immediately and arms a manual close-out. The hidden checkpoint warning always goes out: when idle it starts one ordinary model turn, while streaming it steers the running turn so the agent closes out promptly. The reset commits at a successful settlement after queued work drains, and the run stops instead of continuing in the fresh window. Abort and ordinary errors do not commit; a manual overflow clears and stops without retrying the model, even with automatic reset disabled. The budget warning asks the agent to save notes and call `wipe_memory`, which commits after its batch. A normal stop alone does not reset or continue the run; the existing warning remains in context for later requests. The hard reserve remains a separate safety boundary but preserves a pending manual stop across the reset. Pi's empty tool-batch follow-up is cancelled before provider work; real queued user input is answered before stopping, without a second wipe. Direct `wipe_memory` remains valid without a prior warning. While pi-context is enabled, `/compact` is cancelled with an actionable `/wipe-memory` notice. Close-outs wait for queued steering/follow-up work in the current window. An aborted turn does not manufacture a continuation.

History remains available after reset, including earlier windows and raw JSONL. Branch navigation also remains available. If either the source or destination branch contains a reset marker, generated `/tree` summaries are suppressed with a notice because Pi's raw summary generator bypasses the context projection and could reintroduce erased history. Navigation itself is not suppressed; branches without markers retain native summaries.

## Configuration

The reminder threshold is Pi's compaction reserve plus a margin, configured under the top-level `pi-context` key in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json` (project values win per key):

```json
{
  "compaction": { "reserveTokens": 16384 },
  "pi-context": { "reminderMarginTokens": 24576 }
}
```

`reminder = reserveTokens + reminderMarginTokens`; with the defaults the early guidance fires 24,576 tokens above Pi's hard reserve. When automatic compaction is enabled, the shared close-out warning starts at `reserveTokens + 16,384`; the hard reserve is the final safety boundary.

The dreamer model is configured under the same key. `--dreamer <model pattern>` on the `dream` CLI wins; otherwise a non-empty `pi-context.dreamer` string from settings applies; otherwise the automatic model is used. An invalid value (empty or not a string) is ignored with one warning.

```json
{
  "pi-context": { "reminderMarginTokens": 24576, "dreamer": "anthropic/claude-sonnet-4-5" }
}
```

## Claude Code Mod

The package also ships `mods/pi-context`, an early-access Claude Code Mod that registers the five notes tools as `mcp__pi-context__notes_*` tools and attaches one host-scoped notes boot block through Claude's conversation-scoped `prompt.context` event; Claude persists it across resume and reload. The sandboxed hooks module delegates filesystem and shared-domain work to the plugin-local `mods/pi-context/dist/claude/helper.js` through Claude's bounded `$.process.run` capability. It does not implement Claude reset, history, budget, or dream behavior.

The plugin also exposes the shared `skills/dream/SKILL.md` and its referenced `playbook.md`; the build synchronizes both projections from the canonical repository files. Validate it from a built checkout with `claude plugin validate mods/pi-context --strict`; the package build and `npm pack --dry-run` include the manifests, hooks module, helper, skill, and playbook.

## Standalone notes library

The same package provides a **Node.js TypeScript library independent of Pi**:

```sh
npm install @astrosheep/pi-context
```

```ts
import { createNotesStore, type NotesIdentity } from "@astrosheep/pi-context/notes";

const identity: NotesIdentity = {
  home: "/path/to/notes",          // explicit filesystem root
  sessionId: "my-session",        // safe single directory component
  projectKey: "my-project-a1b2c3d4",
  agent: "my-agent",              // canonical lowercase slug
  model: "my-model",              // canonical lowercase slug
};
const notes = createNotesStore(identity);
await notes.write("@project/decisions.md", "Use a shared notes library.", { origin: "user" });
await notes.update("@project/decisions.md", [
  { oldText: "shared", newText: "host-independent" },
]);
const note = await notes.read("@project/decisions.md"); // body and metadata, or undefined
const files = await notes.list({ pattern: "@project/**" });
const matches = await notes.search(["library"]);
```

`/notes` ships JavaScript and TypeScript declarations. It does not import Pi or read `PI_*` environment variables. Pi packages are optional peers: a notes-only installation does not install them. Using the plugin, root SDK entry, or `dream` CLI still requires Pi. This is a filesystem library for Node, not a browser storage API.

### API and identity

`createNotesStore(identity)` snapshots the five required identity fields; changing the supplied object afterward does not retarget the store. It resolves `home` once, validates identity components, and creates no files until an operation needs to write. Create a new store to change identity. Multiple stores can use independent roots and identities without changing process environment.

- `write(address, content, { origin? }?)` returns `Promise<{ meta, outcome }>` (`created`, `overwritten` or `uncrumpled`). Default origin is `self`; overwriting preserves creation time, existing project ownership, and unknown metadata, and always produces an uncrumpled note (it clears any `crumpledAt`).
- `read(address)` returns `Promise<{ meta, body, resolvedScope } | undefined>`. **Reads update** `lastAccessed` and `accessCount` on disk. The body is separate from metadata; the serialized frontmatter is not part of the read API.
- `update(address, edits?, { origin?, crumpled?, replaceAll? }?)` returns `Promise<{ meta, applied, resolvedScope, change }>`. Edits affect the body; metadata-only changes need no edits, but must supply `origin` or `crumpled`. `crumpled: true` records `crumpledAt` (keeping the original time if already set); `crumpled: false` removes it; omitted leaves it unchanged. Crumpling and smoothing never change `updatedAt`, which tracks body or origin changes only. Each replacement uses the evolving body in array order; the complete batch is written atomically only after every edit succeeds. `change` is a typed `{ kind, before, after }`: `kind` is `body`, `metadata`, or `file` to identify the diff inputs, or `none` with empty strings when neither body, origin, nor `crumpledAt` changed. It is not a rendered diff.
- `rename(fromAddress, toAddress)` returns `Promise<{ meta, replacedCrumpledTarget }>`. The note moves with every metadata key preserved (`updatedAt` is bumped); a live note at the target refuses with `already_exists`, a crumpled target is replaced, and renaming onto the same resolved path is `nothing_to_do`.
- `list({ pattern?, scope?, who?, wastebasket? }?)` returns `Promise<NoteRow[]>`, sorted by update time descending with address tie-breaking. Rows contain address, scope, virtual path, metadata, body, and body byte size. `scope` narrows the five-home view; `who` names a concrete agent/model home. By default crumpled notes are excluded; `wastebasket: true` returns only crumpled notes instead.
- `search(queries: string[], { pattern?, scope?, who?, wastebasket? }?)` returns `Promise<NoteSearchRow[]>`, sorted by address, with the same crumpled-note rule as `list`. Matching is case-insensitive literal OR over body lines; matches contain one-based `line`, `text`, and `offsetChars` into the body, excluding frontmatter. Neither listing nor search increments access metadata.

`list` and `search` share the `NotesQuery` type. A merged query uses `{ pattern?, wastebasket? }`; a single-home query adds `scope`. Only `scope: "agent" | "model"` accepts `who`. TypeScript rejects combinations such as `{ scope: "project", who: "root" }`, and JavaScript callers receive a runtime refusal.

The library returns full data, not tool envelopes or paginated/truncated output. `NoteError` exposes the existing named store refusals through `code`, with `lineNumbers` for ambiguous edits and `editIndex` for a failed edit. Runtime API fields and known persisted note metadata use camelCase; Pi tool wire fields such as `updated_at`, `offset_chars`, and `replace_all` retain their established names. Unrecognized frontmatter keys, including old snake_case metadata, are preserved as ordinary extras; they are not interpreted as current camelCase fields or migrated automatically. Invalid addresses/identities and filesystem failures reject; only a missing `read` returns `undefined`. Notes remain markdown files with the existing size limits and same-directory atomic rename. Same-file read/modify/write work is serialized by absolute physical filename across all store instances in this process (including `.md` address aliases); symlink/case aliases and cross-process locking are not guaranteed. `list` and `search` asynchronously traverse homes and serialize each discovered file read against pending mutations, but are not global snapshots and may not discover a file created after traversal. Foreign named homes can be read (including the access-metadata update), but their bodies cannot be written or edited through the store. These are cooperative address rules, not an OS security sandbox.

Addresses are a path with no `@` (a session note), `@project/`, `@human/`, `@self/`, `@model/`, or explicit `@agents/<slug>/` and `@models/<slug>/`. Relative self/model addresses resolve to the supplied identity. Results show the current agent's and model's notes as `@self/` and `@model/`; only other agents' or models' notes carry an explicit `@agents/<slug>/` or `@models/<slug>/`. Patterns accept either form. The disk layout remains `pi/session/<sessionId>/`, `project/<projectKey>/`, `human/`, `agents/<agent>/`, and `models/<model>/`. No data migration happens on library import or construction. Notes already using camelCase metadata retain their metadata; old snake_case keys are preserved as unrecognized extras, not interpreted or migrated. New session notes record the supplied project key.

### Library and plugin boundary

Ownership is explicit in the file tree:

```text
src/
  index.ts               # only the Pi extension and createPiContext factory
  notes/                 # filesystem semantics and explicit NotesIdentity
  boot/                  # five-home snapshot and pure rendering with tool bindings
  history/               # decoded query projection, pairing, paging and folding
  budget/                # pure thresholds, countdown policy and reminder text
  tools/                 # operation schemas, typed outcomes and bounded presentation
  dream/                 # jail, deletion policy, locks, gates, audit, reports, doctor
  settings.ts            # SDK-independent settings keys and per-key parsing
  pi/                    # native integration, not part of /notes
    extension.ts         # registration composition
    runtime.ts           # native lifecycle, commands, provider projection and UI
    window.ts            # native markers, checkpoints, branches and usage
    history.ts           # native decoding, seq allocation and branch selection
    notes/               # live identity extraction, registration and native diffs
    reset/               # reducer, boundary drafts, commit confirmation and repair
    dream/               # Pi session backend, settings reads and CLI
```

The public runtime exports are `createNotesStore`, `NoteError`, `projectKey(cwd)`, and `slugify(value)`, alongside the API's TypeScript types. The factory and `projectKey` remain synchronous; `projectKey` provides the existing repository/worktree identity algorithm, while `slugify` normalizes an agent/model name. The six primary store methods return promises and use asynchronous filesystem operations. Path/glob helpers, serialization, validation internals and constants are implementation details, not exported through `/notes`.

The Pi adapter supplies the root and live session/project/agent/model identity on each call. Tools and boot use the same storage implementation. Shared tool schemas use `typebox`, declared as a peer supplied by Pi and as a dev dependency for standalone development; their handlers accept explicit identities or decoded history projections. Pi owns registration, execution-context extraction and native edit diff rendering. Boot snapshot acquisition receives identity, a captured timestamp and an optional home loader; rendering receives explicit logical tool names. Native session traversal, stable seq allocation, branch selection and inference projection stay in Pi. Shared history is a query view, never a way to reconstruct inference messages. There are no compatibility shims or generic host runtime. Internal source paths are not the supported library API.

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

The root entry exports only the default Pi extension and `createPiContext`. This is a breaking source/API refactor: `NotesContext` is replaced by `NotesIdentity`; old internal export bags, root history helpers and the `./dist/src/index.js` export alias are removed. Import the root for Pi integration and `/notes` for the standalone library. The configured dream executable is now `dist/src/pi/dream/cli.js`. Stored notes, session paths, metadata and raw histories are unchanged; no migration runs.

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

## Memory skill

The package provides `/skill:memory`, a short self-contained guide to the notes and history tools: note addresses and homes, finding and paging notes, searching and paging history, saving recovery state, and what to do when a memory tool is unavailable. It is a fallback for sessions where the boot protocol is missing or unclear and a reference on demand; normal tool calls do not require reading it. It is written independently of the boot text rather than generated from it. The Claude Code Mod does not ship it, because that host has no history tools.

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
git diff --check
node scripts/check-notes-package.mjs  # optional built /notes CRUD smoke; no install
```

The harness runs against the real installed Pi `SessionManager`/`SettingsManager` in temporary directories with fake credentials — no model or network calls, and the real `~/.pi` is never touched. Resolved TypeScript AST dependency tests reject direct and transitive SDK, adapter and root-facade imports from all shared domains, including types, re-exports and literal dynamic/import-type references. See [CONTRIBUTING.md](CONTRIBUTING.md) for ownership and verification rules.

## License

MIT
