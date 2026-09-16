# Reset lifecycle

`src/reset-lifecycle.ts` owns requests, fallback allowance, compaction attempts, and continuation. `src/index.ts` composes the features and constructs reset boundaries; projections, tools, budget policy, and prompt rendering have separate modules described in [Architecture](architecture.md).

| Event | Transition / owner |
| --- | --- |
| `new_context` | Mark explicit request; repeated calls report already pending. Tool returns terminal output. |
| Streaming automatic `session_before_compact` | Available → borrowed; send one note-taking steer and cancel this compaction. |
| Idle automatic or manual compaction | Build reset directly; no borrowed turn. |
| `agent_end` | Borrowed → ready. Aborted run clears explicit request and spends borrowed allowance. |
| `agent_settled` | If idle and explicit/ready, create one identified attempt and request `ctx.compact`. |
| Matching `session_compact` | Confirm boundary, persist window state, re-arm allowance. Native compaction retains its own scheduling. |
| Attempt `onComplete` | Consume attempt; send continuation only for a confirmed boundary when idle with no queued messages. |
| Attempt `onError` or synchronous throw | Clear attempt/request, warn, retain history. No automatic retry loop. |
| Shutdown / start / tree / toggle off | Invalidate outstanding attempt. Identity checks reject callbacks from older attempts. |

The completion callback is the scheduling boundary: `session_compact` fires before Pi clears manual compaction state. Sending a prompt inside that hook is too early. Both explicit and borrowed-fallback resets use the manual `ctx.compact` route and therefore need the same completion logic. Native compaction/retry already has a caller responsible for subsequent work.

Public APIs cannot guarantee immediate reset inside mixed tool batches or before queued steering/follow-up messages finish. `terminate` ends the tool-followup path; `agent_settled` remains the safe point to request compaction. The scheduler does not manipulate user queues. Pi also determines compaction eligibility before the extension hook; an uncompactable session produces a warning and waits for a new prompt.

Validation is split into persisted-data integration tests, isolated lifecycle event tests, and scripted SDK tests running Pi's actual agent loop. The SDK tests cover explicit success, fallback success, and core compaction rejection followed by a user prompt. Lifecycle tests cover callback races and queue guards without pretending to exercise provider/network behavior.
