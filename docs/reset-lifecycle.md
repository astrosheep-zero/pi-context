# Reset lifecycle

`src/reset-lifecycle.ts` owns reset requests, compaction attempts, and continuation. `src/index.ts` composes the features and constructs reset boundaries; projections, tools, budget policy, and prompt rendering have separate modules described in [Architecture](architecture.md).

| Event | Transition / owner |
| --- | --- |
| `wipe_memory` | Mark explicit request; repeated calls report already pending. Tool returns terminal output. |
| Manual, threshold or overflow `session_before_compact`, idle or streaming | Build the reset boundary immediately and return it. Never cancel and never take a model turn; an aborted signal returns `{ cancel: true }`. |
| `agent_end` | No-op for an instant reset. |
| `agent_settled` | If idle and an explicit request is pending, create one identified attempt and request `ctx.compact`. The originating handler owns and awaits that attempt through its continuation's settlement. |
| Matching `session_compact` | Confirm boundary, persist window state. Native compaction retains its own scheduling. |
| Attempt `onComplete` | Consume attempt; for a confirmed boundary when idle with no queued messages, register continuation ownership before sending it. Its nested `agent_settled` settles that owner; a reset requested by the continuation completes its own handoff before releasing its predecessor. |
| Attempt `onError` or synchronous throw | Clear attempt/request, warn, retain history. No automatic retry loop. |
| Shutdown / start / tree / toggle off | Invalidate outstanding attempt. Identity checks reject callbacks from older attempts. |

The final checkpoint warning is steered earlier from the context hook (`warning.ts`) once per window at reserve+12288 tokens remaining. After it, the model either ends the window itself with `wipe_memory` or rides into Pi's automatic compaction, which resets on the spot with no turn.

The completion callback is the scheduling boundary: `session_compact` fires before Pi clears manual compaction state. Sending a prompt inside that hook is too early. An explicit reset uses the manual `ctx.compact` route and therefore needs this completion logic; an automatic compaction is already the reset and resumes through Pi's own caller.

`sendMessage(..., { triggerTurn: true })` starts its run detached from the extension API. The explicit attempt therefore retains an attempt-owned waiter before sending it, and its originating `agent_settled` handler awaits that waiter. The continuation's `agent_settled` releases the waiter without awaiting itself. If that continuation calls `wipe_memory`, its settled handler starts and awaits the next attempt before it releases the prior waiter, forming a bounded reset chain. Failure, cancellation, shutdown, tree navigation, and toggling off release the relevant waiter exactly once.

Public APIs cannot guarantee immediate reset inside mixed tool batches or before queued steering/follow-up messages finish. `terminate` ends the tool-followup path; `agent_settled` remains the safe point to request compaction. The scheduler does not manipulate user queues. Pi also determines compaction eligibility before the extension hook; an uncompactable session produces a warning and waits for a new prompt.

Validation is split into persisted-data integration tests, isolated lifecycle event tests, and scripted SDK tests running Pi's actual agent loop. The SDK tests cover explicit success, instant automatic reset, and core compaction rejection followed by a user prompt. Lifecycle tests cover callback races and queue guards without pretending to exercise provider/network behavior.
