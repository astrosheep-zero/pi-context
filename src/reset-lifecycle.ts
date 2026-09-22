import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset } from "./history.js";
import { thresholdsFor } from "./thresholds.js";
import { windowUsage } from "./context-window.js";

type ResetOptions = {
	isEnabled: () => boolean;
	automaticResetEnabled: (ctx: ExtensionContext) => boolean;
	buildReset: (ctx: ExtensionContext) => SessionBoundaryDraft[];
};

function isAbort(message: AgentMessage, outcome: string | undefined, ctx: ExtensionContext): boolean {
	return outcome === "aborted" || (message.role === "assistant" && message.stopReason === "aborted") || ctx.signal?.aborted === true;
}

function isOverflowLike(message: AgentMessage, ctx: ExtensionContext): boolean {
	if (message.role !== "assistant") return false;
	return isContextOverflow(message, ctx.model?.contextWindow) ||
		(ctx.model !== undefined && isRecoverableLength(message, ctx.model.maxTokens));
}

/**
 * Own reset requests at Pi 0.87 boundaries. Persisted windows are custom entries, not
 * compaction summaries: turn_end commits explicit/threshold resets after a complete tool
 * batch, while agent_before_settle commits the one bounded overflow recovery after Pi's
 * native recovery attempt has been cancelled.
 */
export function registerResetLifecycle(pi: ExtensionAPI, options: ResetOptions) {
	let explicitRequested = false;
	let overflowPending = false;
	let overflowRecoveryUsed = false;
	let active = true;

	const clear = () => {
		explicitRequested = false;
		overflowPending = false;
		overflowRecoveryUsed = false;
	};

	const safeBuildReset = (ctx: ExtensionContext): SessionBoundaryDraft[] | undefined => {
		try {
			return options.buildReset(ctx);
		} catch (error) {
			ctx.ui.notify(`pi-context: could not build reset (${String(error)}).`, "warning");
			return undefined;
		}
	};
	const thresholdDue = (ctx: ExtensionContext): boolean => {
		const usage = windowUsage(ctx);
		if (!usage || usage.tokens === null) return false;
		return usage.contextWindow - usage.tokens <= thresholdsFor(ctx).reserve;
	};

	pi.on("turn_end", (event, ctx) => {
		if (!active) return undefined;
		if (isAbort(event.message, event.outcome, ctx)) {
			explicitRequested = false;
			return undefined;
		}
		// Native overflow/length recovery is handled after turn_end through the bounded
		// settle path; do not turn that failed response into a threshold reset.
		if (isOverflowLike(event.message, ctx)) {
			explicitRequested = false;
			if (options.isEnabled() && options.automaticResetEnabled(ctx)) overflowPending = true;
			return undefined;
		}
		if (event.outcome === "error") {
			explicitRequested = false;
			return undefined;
		}
		if (!options.isEnabled()) {
			explicitRequested = false;
			return undefined;
		}
		overflowRecoveryUsed = false;
		// The completed response may be the first event whose persisted usage crosses the
		// reserve, so a final assistant response does not defer the reset until another prompt.
		const autoThreshold = options.automaticResetEnabled(ctx) && thresholdDue(ctx);
		if (!explicitRequested && !autoThreshold) {
			return undefined;
		}
		explicitRequested = false;
		overflowPending = false;
		const drafts = safeBuildReset(ctx);
		if (!drafts) return undefined;
		return { entries: [...(event.entries ?? []), ...drafts], continue: true };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!active || !overflowPending) return undefined;
		overflowPending = false;
		if (!options.isEnabled() || !options.automaticResetEnabled(ctx) || event.outcome === "aborted" || ctx.signal?.aborted) return undefined;
		if (overflowRecoveryUsed) return undefined;
		overflowRecoveryUsed = true;
		const drafts = safeBuildReset(ctx);
		if (!drafts) return undefined;
		return { entries: [...(event.entries ?? []), ...drafts], continue: true };
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!active) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const markerExists = currentReset(ctx) !== undefined;
		if (options.isEnabled() || markerExists) {
			if (event.reason === "manual") {
				ctx.ui.notify("pi-context: /compact is disabled while context windows are active; use /clear-context to start a fresh window.", "warning");
			}
			// Native compaction is cancelled here. Threshold resets are decided solely from
			// completed-turn usage at turn_end, never from canonical pre-request history.
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.signal?.aborted) clear();
	});
	pi.on("agent_settled", () => {
		// A failed recovery chain is bounded to one reset/retry. Once Pi settles, a later
		// user prompt starts a new chain; successful continuations clear this earlier.
		overflowPending = false;
		overflowRecoveryUsed = false;
	});
	pi.on("session_start", () => { clear(); active = true; });
	pi.on("session_tree", clear);
	pi.on("session_shutdown", () => { clear(); active = false; });

	return {
		request() {
			if (explicitRequested) return "rollover_already_pending";
			explicitRequested = true;
			return "rollover_requested";
		},
		clear,
	};
}
