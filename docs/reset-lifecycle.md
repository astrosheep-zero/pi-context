# Reset lifecycle

`src/context/reset-lifecycle.ts` owns the close-out request phases, turn-end batching, bounded overflow recovery, and reset scheduling. `src/context/budget.ts` owns budget policy and stages the early reminder/final warning; `src/context/reset-artifacts.ts` builds the checkpoint, marker, boot, and continuation drafts; `src/context/context-window.ts` validates and projects the active window. `src/context/runtime.ts` wires these parts to Pi's public lifecycle hooks and `/wipe-memory` command.

## Lifecycle at a glance

| Trigger | Behavior |
| --- | --- |
| `wipe_memory` tool | Mark the current window tool-requested. At `turn_end`, after the complete tool batch and any accepted budget drafts, append the reset boundary and ask Pi to continue. Repeated requests for that window deduplicate. |
| `/wipe-memory` | Capture the current window, wait for idle, and stop if another invocation has already moved the branch to a new window. Arm a manual close-out, persist the shared hidden warning, and trigger an ordinary model turn. The agent can write notes/use tools over several turns. A `wipe_memory` call commits at `turn_end`; otherwise a successful normal stop commits at `agent_before_settle` after queued messages drain. |
| Budget warning | When automatic compaction is enabled and remaining active-window budget reaches reserve plus the warning runway, put the same hidden warning in the request and arm an automatic close-out. An explicit `wipe_memory` commits the boundary; a successful normal stop is the fallback. |
| Hard reserve | Independent safety path: if automatic resets are enabled and completed-turn usage reaches Pi's reserve, commit a boundary at `turn_end`. |
| Abort or error | Never count as successful close-out. Abort clears lifecycle state. An ordinary close-out error is dropped without reset; provider-overflow recovery remains separately bounded. |
| `/compact` while active | Cancel native compaction, which could otherwise summarize pre-reset history back into the active window. A manual attempt receives an actionable `/wipe-memory` notice. |

A new boundary is ordered as:

1. A native `compaction` entry with `summary: ""` and `firstKeptEntryId` set to its own ID. This is Pi's retain-none canonical checkpoint; it is not a generated summary request.
2. A `pi-context/reset-marker` custom entry with `{ windowId }`.
3. A hidden `pi-context/boot` custom message with matching `details.windowId`.
4. A hidden continuation message.

The raw session branch is preserved for history. New checkpoint-backed branches use Pi's canonical retain-none projection, which preserves the empty summary wrapper and system/tool state while excluding earlier conversational context. Older marker-only sessions use marker slicing as a narrow compatibility fallback. A marker is trusted as checkpoint-backed only when it directly follows an empty native compaction whose `firstKeptEntryId` is the compaction's own ID; a generic preceding compaction is not enough.

`turn_end` is the sole composer for completed turns. It preserves incoming entries, consumes current-window budget drafts, and appends the ordered reset boundary only when the reducer requests one. `agent_before_settle` handles successful close-out fallback after Pi has drained queued work. Pi owns the ensuing continuation and request scheduling. Reset construction awaits the asynchronous notes snapshot; the handler captures its session/window generation before awaiting, then rechecks generation, session, window, enabled state, and abort status before returning drafts. A stale completion is discarded while incoming/budget entries survive, and success notices are staged only after that guard. Construction failures notify only while the initiating lifecycle is still current and preserve already-collected entries without claiming a continuation.

## Reducer state

`reduceResetControl` is pure: the adapter supplies all lifecycle facts, and the reducer returns the next state plus a named effect. Its state combines a request phase with a bounded overflow phase:

| State | Meaning |
| --- | --- |
| `{ phase: "none" }` | No close-out/tool request is pending. |
| `{ phase: "close-out", windowId, source }` | Manual or automatic warning close-out remains armed across ordinary note/tool turns. |
| `{ phase: "tool-requested", windowId }` | A direct `wipe_memory` request will commit after its complete turn batch. |
| `overflow: "idle"` | No overflow recovery is pending. |
| `overflow: "pending"` | An overflow failure may recover once at pre-settlement. |
| `overflow: "pending-spent"` | Recovery was already spent in this failure chain. |
| `overflow: "spent"` | The one recovery has been used until the chain settles. |

### Transition rules

- `close_out(windowId, source)` arms a close-out for that window. Repeating an already-pending request deduplicates; a manual request can upgrade an automatic request for the same window.
- `tool_request(windowId)` marks that window for a turn-end reset. A matching duplicate is reported as already pending.
- `turn_end` first clears everything on abort. Overflow-like errors disarm the reset request and arm overflow recovery only when there is no queued work, the extension is enabled, and automatic reset is enabled. Other failures drop the request but preserve the overflow chain. A successful, enabled turn commits for a tool request or hard-reserve condition; a close-out alone remains armed.
- `agent_before_settle` clears state on actual abort. Pending overflow recovery gets its one bounded attempt when enabled and unqueued. Otherwise a close-out commits only if the outcome is successful, the request belongs to the current window, the extension is enabled, and no queued work remains. Automatic close-outs also require automatic resets to remain enabled.
- `agent_settled`, session start/tree navigation/shutdown, `/pi-context off`, and abort clear transient request state. Durable checkpoint/marker history remains authoritative after transient state is gone.

This separation is intentional: a note write or ordinary tool turn during a close-out must not consume it. Direct `wipe_memory` is not armed by the shared warning and remains valid without one. A user abort, an assistant message with a synthetic `stopReason: "aborted"`, and a generic provider error are distinct cases; none commits an ordinary close-out, while only Pi's actual operation cancellation is a user abort.

## Budget staging and notifications

The early reminder is staged once per window when remaining budget reaches `reserve + reminderMarginTokens`. The final close-out warning is staged/attached at `reserve + WARNING_RUNWAY_TOKENS`, only when automatic compaction is enabled. The hard reserve itself remains a separate safety cutoff. The warning text is shared with `/wipe-memory`; after it is durable, the extension does not repeat it in that window. Warning persistence deduplicates only injection: each eligible low-budget request re-arms transient automatic close-out before checking for the durable warning, so an abort/error can clear its attempt and the next request can retry without another warning.

Budget drafts are instance-local and are consumed at turn end. They are discarded on abort, failed turn, transition, or window mismatch. UI reminder notices are emitted only after the matching hidden entry is durable, so failed requests do not report an uncommitted warning. Active-window usage and the exact `SettingsManager` authority drive threshold checks; default file-backed policy is cached per extension instance, while injected managers are read through their public API.

## Projection, repair, and history

`context_with_system` selects the active boot by durable `details.windowId`. For a verified native checkpoint, Pi's canonical projection is used directly; for a legacy marker-only reset, the compatibility projection slices at the matching boot. The projection preserves system/tool state and later prompt patches. If the boot is absent, the runtime aborts safely instead of sending raw history. Usage estimation uses the same checkpoint-aware projection decision.

Startup/tree repair is narrow: it may complete a repairable marker tail when later conversation does not make the missing metadata ambiguous. It awaits the notes snapshot and rechecks lifecycle/window identity before sending a repaired boot or continuation. Legacy marker-only tails remain supported; repair never moves a boundary or promotes an arbitrary compaction to a retain-none checkpoint. `/tree` summary generation is suppressed with an empty summary when either branch crosses a reset, because the raw summary generator bypasses the provider projection.

## Validation and known limits

The test suite combines isolated reducer tests with scripted SDK tests executing Pi's real agent loop without model/network calls. The agent-loop coverage includes manual warning plus multi-turn note writes and explicit wipe, direct wipe without warning, normal-stop fallback, same-window concurrent command deduplication, actual and synthetic abort/error cleanup, queued steering/follow-up delivery, hard-reserve and bounded-overflow recovery, successive resets, and real SessionManager file reopen after two retain-none checkpoints. It also checks raw-history preservation, canonical projection, empty-summary retention, system/tool state, warning/marker order, and fresh-window continuation.

The broader coherence and pagination property suites were removed during test reduction; retained cases are representative rather than exhaustive. Tree-summary suppression has no dedicated retained test, and external-provider behavior, every malformed persisted shape, and every filesystem failure mode are not established by this suite.
