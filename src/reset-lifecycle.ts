import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset } from "./history.js";

type BudgetOwner = {
	automaticResetEnabled: (ctx: ExtensionContext) => boolean;
	resetDue: (ctx: ExtensionContext) => boolean;
	consumeTurnEnd: (ctx: ExtensionContext) => SessionBoundaryDraft[];
	clear: () => void;
};

type ResetOptions = {
	isEnabled: () => boolean;
	budget: BudgetOwner;
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
	const resetBoundaryResult = (entries: SessionBoundaryDraft[], ctx: ExtensionContext) => {
		try {
			return { entries: [...entries, ...options.buildReset(ctx)], continue: true as const };
		} catch (error) {
			ctx.ui.notify(`pi-context: could not build reset (${String(error)}).`, "warning");
			// The incoming drafts and budget drafts are already valid work from this
			// boundary. Preserve them, but do not claim a continuation when reset
			// construction failed.
			return entries.length > 0 ? { entries } : undefined;
		}
	};

	pi.on("turn_end", (event, ctx) => {
		if (!active) return undefined;
		const requested = explicitRequested;
		explicitRequested = false;
		const aborted = isAbort(event.message, event.outcome, ctx);
		const stagedBudgetEntries = options.budget.consumeTurnEnd(ctx);
		// Lifecycle owns whether drafts are acceptable for this turn. Budget only
		// drains its instance-local staging, so aborts and disabled mode cannot commit it.
		const budgetEntries = options.isEnabled() && !aborted ? stagedBudgetEntries : [];
		const entries = [...(event.entries ?? []), ...budgetEntries];
		if (aborted) {
			overflowPending = false;
			overflowRecoveryUsed = false;
			return entries.length > 0 ? { entries } : undefined;
		}
		// Native overflow/length recovery is handled after turn_end through the bounded
		// settle path; do not turn that failed response into a threshold reset. If Pi has
		// already queued the next user message, the successful queued turn owns settlement
		// and must supersede this stale failure.
		if (isOverflowLike(event.message, ctx)) {
			const queued = event.context.pendingMessages.length > 0 || ctx.hasPendingMessages();
			overflowPending = !queued && options.isEnabled() && options.budget.automaticResetEnabled(ctx);
			return entries.length > 0 ? { entries } : undefined;
		}
		// A successful turn, including one drained from Pi's queue, supersedes any
		// older overflow failure before the settle boundary gets a chance to recover it.
		if (event.outcome !== "error") {
			overflowPending = false;
			overflowRecoveryUsed = false;
		}
		if (!options.isEnabled() || event.outcome === "error") return entries.length > 0 ? { entries } : undefined;
		// The completed response may be the first event whose persisted usage crosses the
		// reserve, so a final assistant response does not defer the reset until another prompt.
		const autoThreshold = options.budget.resetDue(ctx);
		if (!requested && !autoThreshold) return entries.length > 0 ? { entries } : undefined;
		return resetBoundaryResult(entries, ctx);
	});

	pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx) => {
		if (!active || !overflowPending) return undefined;
		// Pi invokes this boundary before settlement even when an agent_end handler has
		// queued user input. Let that turn run first; its successful turn_end clears the
		// stale failure, while another failure leaves the bounded recovery armed.
		if (event.context.pendingMessages.length > 0 || ctx.hasPendingMessages()) return undefined;
		overflowPending = false;
		if (!options.isEnabled() || !options.budget.automaticResetEnabled(ctx) || event.outcome === "aborted" || ctx.signal?.aborted) return undefined;
		if (overflowRecoveryUsed) return undefined;
		overflowRecoveryUsed = true;
		return resetBoundaryResult(event.entries, ctx);
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
	pi.on("session_shutdown", () => { clear(); options.budget.clear(); active = false; });

	return {
		request() {
			if (explicitRequested) return "rollover_already_pending";
			explicitRequested = true;
			return "rollover_requested";
		},
		clear,
	};
}
