# Reset lifecycle

`src/context/reset-lifecycle.ts` owns reset requests, turn-end batching, recovery, and continuation. It is the sole `turn_end` composer: incoming drafts, budget drafts, and reset drafts are ordered here. `src/context/budget.ts` owns the default-path instance-local policy cache, resolves injected policy live, stages guidance/warning drafts, and keeps the final warning text in the budget/protocol path; `src/context/thresholds.ts` only reads settings and derives values, using the shared merge in `src/settings.ts`. `src/index.ts` is the thin public entrypoint; `src/context/runtime.ts` composes the runtime hooks and constructs marker/boot boundaries. `src/notes/notes-snapshot.ts` acquires the notes snapshot, while `src/context/prompts.ts` only renders the explicit boot data and low-budget reminder. Projections and tools have separate modules described in [Architecture](architecture.md).

| Event | Transition / owner |
| --- | --- |
| `wipe_memory` | Record an explicit reset request. Repeated calls in one tool batch deduplicate; the tool returns terminal output. |
| `turn_end` | The sole composer drains current-window budget drafts after the event entries, then appends reset drafts: one `pi-context/reset-marker` with `{ windowId }`, one hidden boot message with matching `details.windowId`, and the continuation marker; continue the turn through Pi's public queue. |
| Abort before the boundary | Drop the pending boundary. Never manufacture a continuation for an aborted turn. |
| Threshold / provider overflow | Request the same marker/boot boundary for the active provider window. Actual overflow/length recovery retries at most once per failure chain; ordinary retryable provider errors stay Pi-owned. |
| `/wipe-memory` | Wait for idle, append marker and boot through public session APIs, and do not call a model. |
| `/compact` while enabled | Cancel with an actionable `/wipe-memory` notice so native compaction cannot summarize erased canonical history back into the active window. |
| Startup / tree / partial append | Repair only a marker followed by an otherwise empty metadata tail; refuse hidden/absent boots once later work exists, leaving `/wipe-memory` as the explicit recovery path. Do not interpret legacy reset-v2 details. |
| `/pi-context off` | Stop new automatic resets, but retain the boundary of an existing marker. Marked branches still cancel native compaction; a fresh root may use Pi's native semantics. |

## Reset-control state machine

`registerResetLifecycle` is the effect adapter. `reduceResetControl` in `src/context/reset-lifecycle.ts` is the pure transition surface: given the current state and one lifecycle event it returns the next state and one named effect, performing no writes, policy resolution, or UI work of its own. The adapter captures Pi's events, supplies the guards only in the branches that consult them, then performs the marker/boot/continuation writes, continuation requests, and notices.

State is a single value with two explicitly typed axes. There are no independently combinable lifecycle booleans.

| Axis | Value | Meaning |
| --- | --- | --- |
| `request` | `none` | no explicit wipe request pending |
| | `explicit` | one explicit request is pending and will commit at the next `turn_end` |
| `overflow` | `idle` | no overflow failure pending; a future recovery is available |
| | `pending` | active-provider overflow failure pending; recovery still available |
| | `pending-spent` | overflow failure pending, but its one recovery was already spent |
| | `spent` | recovery spent and the failure is no longer pending |

All eight combinations of the two axes are reachable and each has a defined transition.

| Event | Guard | Next state | Effect |
| --- | --- | --- | --- |
| `request` | `request=none` | `request=explicit`, overflow unchanged | `requested` |
| `request` | `request=explicit` | unchanged | `already-requested` |
| `turn_end` | turn aborted | `(request=none, overflow=idle)` | `none` |
| `turn_end` | overflow-like and `!queued && enabled && automaticResetEnabled` | `request=none`; overflow `pending`, or `pending-spent` if already spent | `none` |
| `turn_end` | overflow-like and (`queued \|\| !enabled \|\| !automaticResetEnabled`) | `request=none`; overflow `idle`, or `spent` if already spent | `none` |
| `turn_end` | completed, `enabled`, and (`explicit` requested or `thresholdDue`) | `(request=none, overflow=idle)` | `commit-boundary` |
| `turn_end` | completed, `enabled`, but neither trigger | `(request=none, overflow=idle)` | `none` |
| `turn_end` | non-overflow `failed` | `request=none`; overflow unchanged | `none` |
| `turn_end` | `!enabled` | `request=none`; completed clears overflow, error keeps it | `none` |
| `before_settle` | `overflow=pending`, not queued, `enabled`, `automaticResetEnabled`, not aborted | `overflow=spent` | `recover-overflow` |
| `before_settle` | `overflow=pending-spent` | `overflow=spent` | `none` |
| `before_settle` | `overflow` not pending, or queued | unchanged | `none` |
| `before_settle` | pending but `!enabled`, `!automaticResetEnabled`, or aborted | disarms to `idle` (`spent` if already spent) | `none` |
| `settled` | — | `overflow=idle`; `request` unchanged | `none` |
| `abort` / `clear` | — | `(request=none, overflow=idle)` | `none` |

### Invariants

1. At most one explicit request is pending at a time; duplicate requests in one tool batch dedupe and never queue a second boundary.
2. Every `turn_end` consumes a pending explicit request, whether or not that turn commits a reset.
3. A committed reset is exactly `marker -> boot -> continuation`, and ordinary and budget drafts are ordered before the marker. Budget staging is drained once per turn and discarded on abort or disabled mode.
4. Reset drafts are built once per commit. If construction throws, already-built incoming and budget drafts survive and no continuation is requested.
5. Overflow recovery is one attempt per failure chain: a failure arms `pending` only when nothing is queued, the extension is enabled, and automatic reset is enabled; a settle spends it to `spent`; a later failure becomes `pending-spent` and cannot recover again until settlement ends the chain.
6. Aborted turns never manufacture a continuation and clear both axes. Non-overflow errors keep the armed overflow chain for the settle boundary.
7. A successful non-overflow turn clears the overflow chain first, so a queued success supersedes a stale overflow failure before settle recovery can act.
8. `settled` ends the failure chain but preserves a pending explicit request; `clear` (session start, tree navigation, shutdown, `/pi-context off`, `/wipe-memory`) resets both axes.
9. Disabled mode never commits a reset and never arms or spends overflow recovery; an existing persisted marker stays authoritative for native-compaction cancellation.
10. Policy guards (`queued`, `automaticResetEnabled`, `thresholdDue`) are consulted only in the branch that needs them, preserving the adapter's original resolution order.

### Critical sequences

- **Normal reset.** A completed, enabled turn whose explicit request is pending or whose usage is due returns `commit-boundary`. The adapter drains budget drafts, keeps incoming drafts in order, appends `marker -> boot -> continuation`, and requests continuation. A second request in the same batch returns `already-requested`; the next turn commits it alone.
- **Overflow recovery.** An overflow-like `turn_end` with no queued message, enabled mode, and automatic reset arms `pending`; a `before_settle` with no queued message returns `recover-overflow` and spends the attempt to `spent`. A repeated settle is a no-op, and a later overflow failure re-arms only `pending-spent`.
- **Abort.** An aborted `turn_end` returns only the drafts already collected for that boundary, clears both axes, and never appends reset drafts.
- **Queued success.** A queued message defers `before_settle`; the queued turn's successful `turn_end` clears the stale overflow chain, so no recovery fires.
- **Process interruption.** If Pi stops between the marker and the later reset messages, the marker remains the authoritative boundary. On the next start, startup repair may append only the missing boot and continuation when the tail is otherwise repairable; it never moves or reinterprets the boundary.
- **Startup tail repair.** On `session_start` / `session_tree`, `ensureBoot` asks `repairResetTail` to inspect the marker tail and emit only the missing artifacts in the closed order: the boot, then the continuation. A boot/continuation sequence that is already complete, or a tail containing real conversation, a foreign message, a later marker, or a misordered/duplicate artifact, refuses repair and leaves `/wipe-memory` as the explicit recovery path.

The budget owner stages the early guidance and final checkpoint warning from active-window usage. The warning is visible in the current provider request, while both drafts are committed only by the lifecycle composer and are discarded on abort, settlement without a `turn_end`, transition, or window mismatch. After the warning, the model either writes its note and calls `wipe_memory`, or runtime recovery requests the same marker/boot boundary. Guidance and warning drafts precede reset drafts so stale reminders cannot be queued into the new window; durable entries remain the authority for redelivery. Their UI notices are emitted at the next turn start or settlement only after the matching reminder is committed in the active window, so aborted requests and retries cannot repeat an uncommitted reminder's notification.

The turn-end commit is the scheduling boundary: Pi receives the finished tool batch and then the marker/boot drafts as one append operation. Pi owns queue scheduling and deduplication of the next request; the extension does not run a parallel compaction state machine or use a compaction completion callback.

Boot construction reads the five note homes into one closed snapshot before rendering the hidden boot. An absent home is empty; a real read failure removes only that home's MAP/pocket rows. The boot retains its identity, reset line, notes-home instructions, and recovery protocol, and includes a concise `notes_list` retry notice. The human receives one incomplete-index notification per boot. This notes failure isolation does not bypass the marker/boot commit, alter raw history, or turn a partial boot into an empty fallback.

The hidden boot is selected by its durable `details.windowId`, not by timestamp or content equality. The context hook folds only the dropped system prefix before that boot and preserves later prompt patches and messages in order. If the boot is missing, the hook aborts with a safe head and notice rather than sending raw history. Startup/tree repair is deliberately narrow: it appends a boot only when the marker tail is otherwise incomplete metadata; later conversation or an authoritative raw boot causes safe refusal. `/wipe-memory` is the recovery path for that refused branch. A fork/clone creates a new session ID while copying branch entries, so startup refreshes the root boot identity while retaining copied root messages.

Public APIs let a mixed tool batch finish before the marker/boot boundary. Queued steering/follow-up messages are delivered exactly once in the new window, neither dropped nor replayed. `/tree` navigation remains available, but when either source or destination branch contains a reset marker, Pi's raw summary generator is bypassed: the summary is empty and a notice explains why, preventing erased history from re-entering through a path outside the context hook. With no marker on either branch, native summaries remain unchanged.

Validation uses a reduced set of persisted-data integration tests, isolated lifecycle event tests, and scripted SDK tests running Pi's actual agent loop. Representative cases check reset-window history retention, resumable reads, native-compaction cancellation, mixed-tool completion, steering/follow-up delivery, bounded overflow recovery, and settings authority. Tree-summary suppression no longer has a dedicated retained test. The separate coherence and pagination property suites have been removed; the retained cases do not cover the previous full matrix of branch, cancellation, malformed-input, and pagination edges.
