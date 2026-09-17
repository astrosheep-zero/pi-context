# Architecture

pi-context uses Pi's session branch as the durable source of truth. It does not maintain a second transcript or a hidden prompt overlay. Runtime state exists only to schedule work and reserve a reminder until Pi persists it.

## Ownership

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `index.ts` | Compose features, expose toggle/reset tool, construct reset boundary | Pi extension API |
| `history.ts` | Project branch entries into windows/items; identify active window | `SessionReader`, read-only branch and session ID |
| `notes.ts` | Replay note operations, validate paths/timestamps | `SessionReader`; no scheduling or writes |
| `history-tools.ts`, `note-tools.ts` | Public schemas and tool results; append validated note operations | Pi tool API plus read projections |
| `budget.ts` | Resolve settings, report usable budget, persist guidance once | Pi settings/context hooks |
| `thresholds.ts` | Derive the reminder/reserve/warning lines from Pi's reserve plus the pi-context margins | Pi `SettingsManager`, read-only; session-scoped cache |
| `warning.ts` | Steer the final checkpoint warning once per window | Pi context hook |
| `prompts.ts` | Render static boot block, note index, reminder and warning | Read projections and protocol text |
| `reset-lifecycle.ts` | Own reset requests, completion and continuation | Pi lifecycle hooks and injected boundary builder |
| `protocol.ts` | Persisted entry tags, protocol text and defaults | No imports or effects |
| `tool-schema.ts`, `tool-output.ts` | Shared wire-schema primitives and JSON result encoding | No session state |

Dependencies flow from the composition root and tool adapters to projections and protocol constants. Projections cannot send messages, compact, notify, or mutate the session. A runtime framework or generic event bus would add indirection without strengthening these boundaries.

## State and persistence

Reset requests are a discriminated union: `idle`, `requested`, or `compacting` with an identified attempt. A request cannot simultaneously be pending and in flight. Each attempt records its originating session, whether it was explicit, and whether a matching boundary completed. Callback identity prevents an old attempt from consuming a newer one. See [reset lifecycle](reset-lifecycle.md).

Manual, threshold and overflow compactions all build the reset boundary on the spot, idle or streaming: `session_before_compact` returns the reset immediately, never cancels and never takes a model turn, and only an aborted signal cancels. The final checkpoint warning was already steered from the context hook (see [reset lifecycle](reset-lifecycle.md)), so the model had its chance to write a note; what crosses the line now is the wipe itself. `agent_settled` services only explicit `new_context` requests, whose `ctx.compact` route needs the completion callback.

Boot and reminder deduplication inspect messages in the current persisted window. Reloading the extension or the JSONL file therefore does not duplicate either message. Reminder reservation in memory covers Pi's deferred message write; navigation clears that reservation, while persisted branch-local messages remain authoritative. A sibling branch cannot suppress a reminder it never received.

Note replay accepts only supported operations, safe virtual paths, representable timestamps and results within the UTF-8 size limit. Invalid operations are ignored; they cannot replace a valid note. Reads reconstruct the current branch without a cache, so navigating a branch cannot expose notes from a sibling.

Reset IDs are opaque strings tagged with `reset-v2`; newly minted IDs use `pcw:<session>:<8 lowercase hex digits>`. Unsupported details fall back to Pi's compaction-entry identity for history lookup. Minting checks existing branch window IDs, which are independent of Pi entry IDs. A reset adds a marker via the public append API, then uses its real entry ID as `firstKeptEntryId`; old conversation remains searchable in the durable branch.

## Evidence and limits

The integration suite uses real SessionManager and SettingsManager instances, including JSONL restoration, branch navigation, Unicode content, malformed note operations and settings precedence. Lifecycle event tests cover duplicate/stale callbacks, native scheduling, disabled state, abort and failed compaction.

Scripted SDK tests execute the real Pi agent loop with no model network request. They cover explicit reset, instant automatic reset, rejected compaction, steering and follow-up delivery before reset without replay, consecutive distinct windows, and cancellation followed by a new user prompt. They inspect actual provider contexts and durable entries. They do not establish reliability of an external provider or every possible interleaving between unrelated extensions.

Pi decides compaction eligibility before the boundary hook. A short uncompactable session therefore cannot be force-reset with the public API. Mixed tool batches and queued messages may finish before `agent_settled`; the extension preserves their delivery rather than clearing the queue. Native compaction owns its subsequent scheduling, while extension-requested compaction resumes from `onComplete` after Pi clears compaction state.
