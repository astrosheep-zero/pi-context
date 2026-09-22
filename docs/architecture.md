# Architecture

pi-context uses Pi's session branch as the durable source of truth. It does not maintain a second transcript or a hidden prompt overlay. Runtime state exists only to schedule work and reserve a reminder until Pi persists it.

## Ownership

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `index.ts` | Compose features, expose toggle/reset tools, construct marker/boot boundaries | Pi extension API |
| `history.ts` | Project branch entries into windows/items using the shared window identity | `SessionReader`, read-only branch and session ID |
| `context-window.ts` | Own durable window identity, select the active boot, project provider context, and account for active-window usage | `SessionReader` plus Pi context/system projection APIs |
| `notes/model.ts` | Replay persisted note operations and validate virtual paths/timestamps | Filesystem-backed notes homes; no session-branch selection |
| `history-tools.ts` | Public history schemas and tool results over branch projections | Pi tool API plus read projections |
| `notes/tools.ts` | Filesystem note tool adapters; append validated note operations | Pi tool API plus notes filesystem |
| `budget.ts` | Own the per-extension-instance settings cache, report usable budget, stage guidance/warning drafts, and resolve automatic reset decisions | Pi settings/context hooks |
| `thresholds.ts` | Purely read settings and derive the reminder/reserve/warning lines from Pi's reserve plus the pi-context margins | Pi `SettingsManager`, read-only; no mutable cache |
| `prompts.ts` | Render static boot block, note index, reminder and warning | Read projections and protocol text |
| `reset-lifecycle.ts` | Own reset requests, turn-end batching, recovery and continuation | Pi lifecycle hooks and injected boundary builder |
| `protocol.ts` | Persisted entry tags, protocol text and defaults | No imports or effects |
| `tool-schema.ts`, `tool-output.ts` | Shared wire-schema primitives and JSON result encoding | No session state |

Dependencies flow from the composition root and tool adapters to projections and protocol constants. Projections cannot send messages, compact, notify, or mutate the session. A runtime framework or generic event bus would add indirection without strengthening these boundaries.

## State and persistence

`turn_end` has one composer in `reset-lifecycle.ts`: it accepts the incoming drafts, drains the budget instance's staged guidance/warning drafts, and only then appends reset drafts. Reset requests are committed after the complete tool batch with `continue: true`, so Pi owns queue scheduling. Repeated `wipe_memory` requests in one batch deduplicate; a later window may still request another reset. Aborts and reset-construction failures preserve already-built drafts without manufacturing a continuation. See [reset lifecycle](reset-lifecycle.md).

The durable boundary is one `pi-context/reset-marker` custom entry with `{ windowId: string }`, followed by one hidden `pi-context/boot` custom message with `details.windowId` equal to the marker identity. The marker is the only window boundary. `context-window.ts` owns the marker predicate, active-branch scan, root/current IDs, and per-window message lookup; `history.ts` consumes those identity primitives while projecting entries. The scan never uses a global entry tail. Native compaction and branch-summary entries remain history items in the current window, so the old compaction-entry identity is not a window identity.

The final context projection selects the active boot by `details.windowId` and folds only the dropped system prefix through Pi's `getCurrentSystemMessage`. Later prompt patches and new messages stay in order. A missing boot aborts the hook with a safe head and notice rather than silently sending raw history. Startup/tree handling repairs only a genuinely incomplete marker tail: a missing boot with no later raw message, custom message, compaction, branch summary, or authoritative raw boot. If later work exists, boot creation is refused and `/clear-context` is the explicit recovery path; it does not parse or migrate the legacy reset-v2 protocol.

Boot and reminder deduplication inspect the current branch-local window. Reloading JSONL therefore does not duplicate messages, while navigation to a sibling branch cannot inherit another branch's window state. A fork/clone receives a new session ID while copying its selected path, so startup must also verify that a root boot's `details.windowId` matches the new `rootWindowId(sessionId)` before treating it as present.

History reads reconstruct the selected session branch on demand without a cache, so branch navigation cannot expose history from a sibling.

Note replay accepts only supported operations, safe virtual paths, representable timestamps and results within the UTF-8 size limit. Invalid operations are ignored; they cannot replace a valid note. Notes remain in their filesystem-backed homes, unchanged by session branch navigation.

The `/clear-context` command waits for idle, appends the marker and boot with Pi's public `appendEntry`/`sendMessage` APIs, and never calls a model. While enabled, `/compact` is cancelled with an actionable `/clear-context` notice. Disabling pi-context stops new automatic resets, but an existing marker still excludes earlier history and native compaction is still cancelled on that marked branch; a fresh root may use native Pi semantics. Threshold and warning accounting use active-window provider usage rather than pre-reset global usage. Budget policy and staged prompts are instance-owned, so concurrent sessions cannot share reserve/enablement or uncommitted drafts; model/session transitions invalidate that instance cache.

## Evidence and limits

The integration suite uses real SessionManager and SettingsManager instances, including JSONL restoration, marker-based branch navigation, Unicode content, malformed note operations and settings precedence. History/coherence tests cover active-branch selection, pre-marker retention, native summaries as items, and cursor reconstruction.

Scripted SDK tests execute the real Pi agent loop with no model network request. They cover explicit reset, consecutive marker windows, mixed-tool completion before the boundary, steering and follow-up delivery exactly once in the new window without replay, complete system/tool projections, hidden/absent-boot safety, queued overflow recovery, concurrent policy isolation, and cancellation followed by a new user prompt. They inspect actual provider contexts and durable entries. Persisted-data tests also cover metadata-only marker-tail repair and root-fork boot refresh while preserving copied root messages. They do not establish reliability of an external provider or every possible interleaving between unrelated extensions.

Mixed tool batches finish before the marker/boot boundary. Queued steering/follow-up messages are delivered exactly once in the new window; they are neither dropped nor replayed. Runtime overflow recovery is bounded to one reset/retry per failure chain, while ordinary retryable provider errors remain Pi-owned. When either the source or destination branch has a reset marker, `/tree` navigation still succeeds but its generated summary is replaced by an empty summary plus a notice; raw history and branch selection remain available. If neither branch has a marker, Pi's native tree summary is retained.
