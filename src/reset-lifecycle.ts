import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

type ResetResult = { cancel: true } | {
	compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
};

/** A reset request is session-local. Only this module schedules compaction/continuation. */
export function registerResetLifecycle(pi: ExtensionAPI, options: {
	isEnabled: () => boolean;
	continuation: Parameters<ExtensionAPI["sendMessage"]>[0];
	buildReset: (event: SessionBeforeCompactEvent, ctx: ExtensionContext, explicit: boolean) => ResetResult;
	isCurrentReset: (entryId: string, ctx: ExtensionContext) => boolean;
	onReset: (entryId: string) => void;
}) {
	type Attempt = {
		completed: boolean;
		explicit: boolean;
		nextRequested: boolean;
		continuationStarted: boolean;
		sessionId: string;
		settled: boolean;
		wait: Promise<void>;
		release: () => void;
	};
	type Request =
		| { phase: "idle" }
		| { phase: "requested" }
		| { phase: "compacting"; attempt: Attempt };
	let state: Request = { phase: "idle" };
	let handledEntry: string | undefined;
	let active = true;

	const release = (attempt: Attempt) => {
		if (attempt.settled) return;
		attempt.settled = true;
		if (state.phase === "compacting" && state.attempt === attempt) {
			state = { phase: "idle" };
			handledEntry = undefined;
		}
		attempt.release();
	};
	const clear = () => {
		if (state.phase === "compacting") release(state.attempt);
		state = { phase: "idle" };
		handledEntry = undefined;
	};
	const valid = (request: Attempt, ctx: ExtensionContext) =>
		active && options.isEnabled() && state.phase === "compacting" && state.attempt === request && ctx.sessionManager.getSessionId() === request.sessionId;

	const begin = (ctx: ExtensionContext) => {
		let releaseWait!: () => void;
		const request: Attempt = {
			completed: false,
			explicit: true,
			nextRequested: false,
			continuationStarted: false,
			sessionId: ctx.sessionManager.getSessionId(),
			settled: false,
			wait: new Promise<void>((resolve) => { releaseWait = resolve; }),
			release: () => releaseWait(),
		};
		state = { phase: "compacting", attempt: request };
		const onError = (error: Error) => {
			if (!valid(request, ctx)) return;
			release(request);
			// Do not retry from settled in a tight loop. A later prompt may trigger a
			// native reset or explicitly request one.
			ctx.ui.notify(`pi-context: reset did not complete (${error.message}). The conversation is retained; resume with another prompt.`, "warning");
		};
		try {
			ctx.compact({
				onComplete: () => {
					if (!valid(request, ctx)) return;
					// session_compact only confirms the boundary. onComplete runs after
					// Pi clears compaction state; sending inside the hook starts too early.
					// A queued user prompt may already have started at compaction_end.
					if (request.completed && ctx.isIdle() && !ctx.hasPendingMessages()) {
						// The SDK detaches sendMessage, so own the next settled event before
						// starting it. The originating agent_settled handler awaits wait.
						if (request.continuationStarted) return;
						request.continuationStarted = true;
						try {
							pi.sendMessage(options.continuation, { triggerTurn: true });
						} catch (error) {
							onError(error instanceof Error ? error : new Error(String(error)));
						}
						return;
					}
					release(request);
				},
				onError,
			});
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
		return request;
	};

	// State is intentionally not resumed from a pending request: a loaded session must
	// not execute work from a tool that belonged to a previous runtime or tree branch.
	pi.on("session_start", () => { clear(); active = true; });
	pi.on("session_shutdown", () => { clear(); active = false; });
	pi.on("session_tree", clear);

	pi.on("agent_end", (_event, ctx) => {
		if (!active || !options.isEnabled()) return;
		if (ctx.signal?.aborted) {
			// Esc cancels the user's run. Do not reset or resurrect it at settled.
			clear();
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!active || !options.isEnabled() || !ctx.isIdle()) return;
		if (state.phase === "compacting" && state.attempt.continuationStarted) {
			const preceding = state.attempt;
			if (!preceding.nextRequested) {
				release(preceding);
				return;
			}
			// This settled event belongs to the continuation started by preceding.
			// If it requested another reset, retain preceding until that reset's own
			// continuation settles. Its eventual nested handler only releases its own
			// waiter, so it never awaits itself.
			const next = begin(ctx);
			return next.wait.then(() => release(preceding));
		}
		if (state.phase !== "requested") return;
		// One owner for requested resets. Consume the request before any external call;
		// repeated settled events and reentrant callbacks are harmless.
		return begin(ctx).wait;
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!active || !options.isEnabled()) return undefined;
		if (event.signal.aborted) return { cancel: true };
		// Automatic threshold/overflow compactions reset on the spot — no model turn.
		// The warning steer fired earlier (see warning.ts); what crosses the reserve
		// line now is the wipe itself.
		try {
			return options.buildReset(event, ctx, state.phase === "requested");
		} catch (error) {
			ctx.ui.notify(`pi-context: could not build reset (${String(error)}).`, "warning");
			return { cancel: true }; // Never fall through to a generated default summary.
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!active || !options.isEnabled() || handledEntry === event.compactionEntry.id) return;
		if (!options.isCurrentReset(event.compactionEntry.id, ctx)) return;
		handledEntry = event.compactionEntry.id;
		if (state.phase === "compacting") state.attempt.completed = !event.willRetry;
		else state = { phase: "idle" };
		// A native compaction (including overflow retry) owns its own scheduling.
		// Only a reset we requested gets a continuation from our onComplete callback.
		options.onReset(event.compactionEntry.id);
	});

	return {
		request() {
			if (state.phase === "idle") {
				state = { phase: "requested" };
				return "rollover_requested";
			}
			if (state.phase === "compacting" && state.attempt.continuationStarted && !state.attempt.nextRequested) {
				state.attempt.nextRequested = true;
				return "rollover_requested";
			}
			return "rollover_already_pending";
		},
		clear,
	};
}
