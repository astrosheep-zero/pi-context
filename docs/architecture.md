# Architecture

pi-context uses Pi's session branch as the durable source of truth. It does not maintain a second transcript or a hidden prompt overlay. Runtime state exists only to schedule work and reserve a reminder until Pi persists it.

## Ownership

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `index.ts` | Compose features, expose toggle/reset tools, construct marker/boot boundaries | Pi extension API |
| `history.ts` | Project branch entries into windows/items; identify active window | `SessionReader`, read-only branch and session ID |
| `context-window.ts` | Select the active boot, project provider context, and account for active-window usage | Pi context/system projection APIs |
| `notes/model.ts` | Replay persisted note operations and validate virtual paths/timestamps | Filesystem-backed notes homes; no session-branch selection |
| `history-tools.ts` | Public history schemas and tool results over branch projections | Pi tool API plus read projections |
| `notes/tools.ts` | Filesystem note tool adapters; append validated note operations | Pi tool API plus notes filesystem |
| `budget.ts` | Resolve settings, report usable budget, persist guidance once | Pi settings/context hooks |
| `thresholds.ts` | Derive the reminder/reserve/warning lines from Pi's reserve plus the pi-context margins | Pi `SettingsManager`, read-only; session-scoped cache |
| `warning.ts` | Steer the final checkpoint warning once per window | Pi context hook |
| `prompts.ts` | Render static boot block, note index, reminder and warning | Read projections and protocol text |
| `reset-lifecycle.ts` | Own reset requests, turn-end batching, recovery and continuation | Pi lifecycle hooks and injected boundary builder |
| `protocol.ts` | Persisted entry tags, protocol text and defaults | No imports or effects |
| `tool-schema.ts`, `tool-output.ts` | Shared wire-schema primitives and JSON result encoding | No session state |

Dependencies flow from the composition root and tool adapters to projections and protocol constants. Projections cannot send messages, compact, notify, or mutate the session. A runtime framework or generic event bus would add indirection without strengthening these boundaries.

## State and persistence

Reset requests are committed at `turn_end` after the complete tool batch: the boundary drafts are appended after that batch with `continue: true`, so Pi owns queue scheduling. Repeated `wipe_memory` requests in one batch deduplicate; a later window may still request another reset. Aborts do not manufacture a continuation. See [reset lifecycle](reset-lifecycle.md).

The durable boundary is one `pi-context/reset-marker` custom entry with `{ windowId: string }`, followed by one hidden `pi-context/boot` custom message with `details.windowId` equal to the marker identity. The marker is the only window boundary. `history.ts` scans `getBranch()` for the latest well-formed marker; it never uses a global entry tail. Native compaction and branch-summary entries remain history items in the current window, so the old compaction-entry identity is not a window identity.

The final context projection selects the active boot by `details.windowId` and folds only the dropped system prefix through Pi's `getCurrentSystemMessage`. Later prompt patches and new messages stay in order. A missing boot aborts the hook with a safe head and notice rather than silently sending raw history. Startup/tree handling may repair a marker whose boot was lost during a partial append; it does not parse or migrate the legacy reset-v2 protocol.

Boot and reminder deduplication inspect the current branch-local window. Reloading JSONL therefore does not duplicate messages, while navigation to a sibling branch cannot inherit another branch's window state. A fork/clone receives a new session ID while copying its selected path, so startup must also verify that a root boot's `details.windowId` matches the new `rootWindowId(sessionId)` before treating it as present.

History reads reconstruct the selected session branch on demand without a cache, so branch navigation cannot expose history from a sibling.

Note replay accepts only supported operations, safe virtual paths, representable timestamps and results within the UTF-8 size limit. Invalid operations are ignored; they cannot replace a valid note. Notes remain in their filesystem-backed homes, unchanged by session branch navigation.

The `/clear-context` command waits for idle, appends the marker and boot with Pi's public `appendEntry`/`sendMessage` APIs, and never calls a model. While enabled, `/compact` is cancelled with an actionable `/clear-context` notice. Disabling pi-context stops new automatic resets, but an existing marker still excludes earlier history and native compaction is still cancelled on that marked branch; a fresh root may use native Pi semantics. Threshold and warning accounting use active-window provider usage rather than pre-reset global usage.

## Evidence and limits

The integration suite uses real SessionManager and SettingsManager instances, including JSONL restoration, marker-based branch navigation, Unicode content, malformed note operations and settings precedence. History/coherence tests cover active-branch selection, pre-marker retention, native summaries as items, and cursor reconstruction.

Scripted SDK tests execute the real Pi agent loop with no model network request. They cover explicit reset, consecutive marker windows, mixed-tool completion before the boundary, steering and follow-up delivery exactly once in the new window without replay, complete system/tool projections, and cancellation followed by a new user prompt. They inspect actual provider contexts and durable entries. Independent probes for partial marker/boot repair and tree-summary suppression are not counted as permanent suite coverage. They do not establish reliability of an external provider or every possible interleaving between unrelated extensions.

Mixed tool batches finish before the marker/boot boundary. Queued steering/follow-up messages are delivered exactly once in the new window; they are neither dropped nor replayed. Runtime overflow recovery is bounded to one reset/retry per failure chain, while ordinary retryable provider errors remain Pi-owned. When either the source or destination branch has a reset marker, `/tree` navigation still succeeds but its generated summary is replaced by an empty summary plus a notice; raw history and branch selection remain available. If neither branch has a marker, Pi's native tree summary is retained.
