import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

type ResetResult = { cancel: true } | {
	compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
};

/** A reset request is session-local. Only this module schedules compaction/continuation. */
export function registerResetLifecycle(pi: ExtensionAPI, options: {
	isEnabled: () => boolean;
	fallback: Parameters<ExtensionAPI["sendMessage"]>[0];
	continuation: Parameters<ExtensionAPI["sendMessage"]>[0];
	buildReset: (event: SessionBeforeCompactEvent, ctx: ExtensionContext, explicit: boolean) => ResetResult;
	isCurrentReset: (entryId: string, ctx: ExtensionContext) => boolean;
	onReset: (entryId: string) => void;
}) {
	type Fallback = "available" | "borrowed" | "ready" | "spent";
	type Attempt = { completed: boolean; sessionId: string; explicit: boolean };
	type Request =
		| { phase: "idle" }
		| { phase: "requested" }
		| { phase: "compacting"; attempt: Attempt };
	let state: Request = { phase: "idle" };
	let fallback: Fallback = "available";
	let handledEntry: string | undefined;
	let active = true;

	const clear = () => {
		state = { phase: "idle" };
		fallback = "available";
		handledEntry = undefined;
	};
	const valid = (request: Attempt, ctx: ExtensionContext) =>
		active && options.isEnabled() && state.phase === "compacting" && state.attempt === request && ctx.sessionManager.getSessionId() === request.sessionId;

	// State is intentionally not resumed from a pending request: a loaded session must
	// not execute work from a tool that belonged to a previous runtime or tree branch.
	pi.on("session_start", () => { clear(); active = true; });
	pi.on("session_shutdown", () => { clear(); active = false; });
	pi.on("session_tree", clear);

	pi.on("agent_end", (_event, ctx) => {
		if (!active || !options.isEnabled()) return;
		if (ctx.signal?.aborted) {
			// Esc cancels the user's run. Do not reset or resurrect it at settled.
			state = { phase: "idle" };
			if (fallback !== "available") fallback = "spent";
			return;
		}
		if (fallback === "borrowed") fallback = "ready";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!active || !options.isEnabled() || state.phase === "compacting" || !ctx.isIdle()) return;
		if (state.phase !== "requested" && fallback !== "ready") return;
		// One owner for explicit and fallback resets. Consume the request before any
		// external call; repeated settled events and reentrant callbacks are harmless.
		const request: Attempt = { completed: false, sessionId: ctx.sessionManager.getSessionId(), explicit: state.phase === "requested" };
		state = { phase: "compacting", attempt: request };
		if (fallback !== "available") fallback = "spent";
		const onError = (error: Error) => {
			if (!valid(request, ctx)) return;
			state = { phase: "idle" };
			// Do not retry from settled in a tight loop. A later prompt may trigger a
			// native reset or explicitly request one; the borrowed allowance stays spent.
			ctx.ui.notify(`pi-context: reset did not complete (${error.message}). The conversation is retained; resume with another prompt.`, "warning");
		};
		try {
			ctx.compact({
				onComplete: () => {
					if (!valid(request, ctx)) return;
					state = { phase: "idle" };
					// session_compact only confirms the boundary. onComplete runs after
					// Pi clears compaction state; sending inside the hook starts too early.
					// A queued user prompt may already have started at compaction_end.
					if (request.completed && ctx.isIdle() && !ctx.hasPendingMessages()) {
						pi.sendMessage(options.continuation, { triggerTurn: true });
					}
				},
				onError,
			});
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!active || !options.isEnabled()) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const automatic = event.reason === "threshold" || event.reason === "overflow";
		if (automatic && state.phase === "idle" && fallback === "available" && !ctx.isIdle()) {
			// Pi routes triggerTurn to steer during a run. Idle calls would start a
			// nested prompt, so pre-prompt automatic compactions always reset directly.
			fallback = "borrowed";
			pi.sendMessage(options.fallback, { triggerTurn: true });
			return { cancel: true };
		}
		try {
			return options.buildReset(event, ctx, state.phase === "requested" || (state.phase === "compacting" && state.attempt.explicit));
		} catch (error) {
			ctx.ui.notify(`pi-context: could not build reset (${String(error)}).`, "warning");
			return { cancel: true }; // Never fall through to a generated default summary.
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!active || !options.isEnabled() || handledEntry === event.compactionEntry.id) return;
		if (!options.isCurrentReset(event.compactionEntry.id, ctx)) return;
		handledEntry = event.compactionEntry.id;
		fallback = "available";
		if (state.phase === "compacting") state.attempt.completed = !event.willRetry;
		else state = { phase: "idle" };
		// A native compaction (including overflow retry) owns its own scheduling.
		// Only a reset we requested gets a continuation from our onComplete callback.
		options.onReset(event.compactionEntry.id);
	});

	return {
		request() {
			const pending = state.phase !== "idle";
			if (!pending) state = { phase: "requested" };
			return pending ? "rollover_already_pending" : "rollover_requested";
		},
		clear,
	};
}
