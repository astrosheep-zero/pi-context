# Reset lifecycle

`src/reset-lifecycle.ts` owns reset requests, turn-end batching, recovery, and continuation. `src/index.ts` composes the features and constructs marker/boot boundaries; projections, tools, budget policy, and prompt rendering have separate modules described in [Architecture](architecture.md).

| Event | Transition / owner |
| --- | --- |
| `wipe_memory` | Record an explicit reset request. Repeated calls in one tool batch deduplicate; the tool returns terminal output. |
| `turn_end` | After the entire tool batch, append the event entries followed by the reset drafts: one `pi-context/reset-marker` with `{ windowId }`, then one hidden boot message with matching `details.windowId`; continue the turn through Pi's public queue. |
| Abort before the boundary | Drop the pending boundary. Never manufacture a continuation for an aborted turn. |
| Threshold / provider overflow | Request the same marker/boot boundary for the active provider window. Actual overflow/length recovery retries at most once per failure chain; ordinary retryable provider errors stay Pi-owned. |
| `/clear-context` | Wait for idle, append marker and boot through public session APIs, and do not call a model. |
| `/compact` while enabled | Cancel with an actionable `/clear-context` notice so native compaction cannot summarize erased canonical history back into the active window. |
| Startup / tree / partial append | Inspect the active branch. Repair a marker whose boot was not persisted; do not interpret legacy reset-v2 details. |
| `/pi-context off` | Stop new automatic resets, but retain the boundary of an existing marker. Marked branches still cancel native compaction; a fresh root may use Pi's native semantics. |

The final checkpoint warning is steered earlier from the context hook (`warning.ts`) once per active provider window at reserve+12288 tokens remaining. After it, the model either writes its note and calls `wipe_memory`, or runtime recovery requests the same marker/boot boundary. The warning and guidance drafts precede reset drafts so stale reminders cannot be queued into the new window.

The turn-end commit is the scheduling boundary: Pi receives the finished tool batch and then the marker/boot drafts as one append operation. Pi owns queue scheduling and deduplication of the next request; the extension does not run a parallel compaction state machine or use a compaction completion callback.

The hidden boot is selected by its durable `details.windowId`, not by timestamp or content equality. The context hook folds only the dropped system prefix before that boot and preserves later prompt patches and messages in order. If the boot is missing, the hook aborts with a safe head and notice rather than sending raw history. A fork/clone creates a new session ID while copying branch entries, so startup must treat a copied root boot with the old session's root ID as missing and repair it.

Public APIs let a mixed tool batch finish before the marker/boot boundary. Queued steering/follow-up messages are delivered exactly once in the new window, neither dropped nor replayed. `/tree` navigation remains available, but when either source or destination branch contains a reset marker, Pi's raw summary generator is bypassed: the summary is empty and a notice explains why, preventing erased history from re-entering through a path outside the context hook. With no marker on either branch, native summaries remain unchanged.

Validation is split into persisted-data integration tests, isolated lifecycle event tests, and scripted SDK tests running Pi's actual agent loop. History/coherence coverage checks marker-selected branch history, durable reload, repeated windows, and exact read cursors. Scripted SDK coverage checks explicit and automatic marker resets, mixed-tool completion before the boundary, steering/follow-up delivery exactly once in the new window, complete system/tool projections, manual clear without a model call, bounded overflow recovery, and ordinary errors that must not wipe memory. Partial marker/boot repair and tree-summary suppression remain independent probes until promoted into permanent tests.
