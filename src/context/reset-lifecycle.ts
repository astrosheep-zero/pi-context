import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset } from "./context-window.js";

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
 * Reset-control state. The concern is split into two independent, explicitly typed axes so
 * that no combination of independently combinable lifecycle booleans is legal by accident:
 *
 * - `request` is the single pending explicit wipe request ("none" or "explicit"). Repeated
 *   requests deduplicate while one is pending.
 * - `overflow` is the bounded provider-overflow recovery chain:
 *   - "idle"          no overflow failure is pending; recovery is available for a later chain.
 *   - "pending"       an overflow failure is pending; recovery is still available.
 *   - "pending-spent" an overflow failure is pending, but recovery was already spent this chain.
 *   - "spent"         recovery was spent and the failure is no longer pending.
 *
 * All eight combinations of the two axes are reachable (a request may arrive while an overflow
 * chain is pending, spent, or settled), and each has a defined transition. There is no state
 * whose fields silently contradict one another.
 */
export type ResetRequestPhase = "none" | "explicit";
export type ResetOverflowPhase = "idle" | "pending" | "pending-spent" | "spent";

export interface ResetControlState {
	readonly request: ResetRequestPhase;
	readonly overflow: ResetOverflowPhase;
}

export function initialResetControl(): ResetControlState {
	return { request: "none", overflow: "idle" };
}

/**
 * Facts for a completed turn. The three `get`-supplied fields are guards the adapter resolves
 * lazily: the reducer reads each one only in the branch where the previous adapter consulted it,
 * so policy resolution and pending-message probes keep their original call ordering.
 */
export interface ResetTurnEndFacts {
	readonly aborted: boolean;
	readonly overflow: boolean;
	readonly failed: boolean;
	readonly enabled: boolean;
	readonly queued: boolean;
	readonly automaticResetEnabled: boolean;
	readonly thresholdDue: boolean;
}

/** Facts for the pre-settlement boundary; policy guards stay lazy for the same reason. */
export interface ResetBeforeSettleFacts {
	readonly queued: boolean;
	readonly enabled: boolean;
	readonly automaticResetEnabled: boolean;
	readonly aborted: boolean;
}

export type ResetControlEvent =
	| { readonly type: "request" }
	| { readonly type: "turn_end"; readonly facts: ResetTurnEndFacts }
	| { readonly type: "before_settle"; readonly facts: ResetBeforeSettleFacts }
	| { readonly type: "settled" }
	| { readonly type: "abort" }
	| { readonly type: "clear" };

/**
 * The requested effect of a transition. Effects are named, not performed: marker/boot/
 * continuation writes, continuation requests, and UI notices stay in the adapter.
 *
 * - "none"              keep any return value to the drafts already collected for this event.
 * - "requested"         a new explicit reset request was recorded.
 * - "already-requested" a request was already pending and was deduplicated.
 * - "commit-boundary"   build and commit the reset boundary now (turn_end).
 * - "recover-overflow"  build and commit the one bounded overflow recovery now (settle).
 */
export type ResetControlEffect =
	| "none"
	| "requested"
	| "already-requested"
	| "commit-boundary"
	| "recover-overflow";

export interface ResetControlResult {
	readonly state: ResetControlState;
	readonly effect: ResetControlEffect;
}

/**
 * Pure reset-control transition. It performs no writes, no policy resolution of its own, and
 * no UI work; every fact it reads is supplied by the caller. Callers can therefore drive the
 * full transition table without a live Pi session.
 */
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult {
	switch (event.type) {
		case "request": {
			if (state.request === "explicit") return { state, effect: "already-requested" };
			return { state: { ...state, request: "explicit" }, effect: "requested" };
		}
		case "turn_end": {
			const facts = event.facts;
			const requested = state.request === "explicit";
			// The explicit request is consumed by the turn boundary whether or not it commits.
			const request: ResetRequestPhase = "none";
			if (facts.aborted) {
				// An aborted turn drops the whole boundary: no explicit request, no overflow chain.
				return { state: { request, overflow: "idle" }, effect: "none" };
			}
			if (facts.overflow) {
				// A failure that Pi may recover natively: arm (or re-arm) the bounded settle path.
				// A queued message, disabled mode, or disabled automatic reset leaves it disarmed.
				const pending = !facts.queued && facts.enabled && facts.automaticResetEnabled;
				const spent = state.overflow === "pending-spent" || state.overflow === "spent";
				const overflow: ResetOverflowPhase = pending
					? (spent ? "pending-spent" : "pending")
					: (spent ? "spent" : "idle");
				return { state: { request, overflow }, effect: "none" };
			}
			// Any non-overflow completed turn supersedes an older overflow failure. A non-overflow
			// error leaves the armed overflow chain untouched for the settle boundary.
			const overflow: ResetOverflowPhase = facts.failed ? state.overflow : "idle";
			if (!facts.enabled || facts.failed) return { state: { request, overflow }, effect: "none" };
			// Explicit and threshold resets both commit at turn_end, after incoming and budget drafts.
			const commit = requested || facts.thresholdDue;
			return { state: { request, overflow }, effect: commit ? "commit-boundary" : "none" };
		}
		case "before_settle": {
			const facts = event.facts;
			if (state.overflow !== "pending" && state.overflow !== "pending-spent") return { state, effect: "none" };
			// Let a queued turn run first; its own turn_end settles or clears this chain.
			if (facts.queued) return { state, effect: "none" };
			const spent = state.overflow === "pending-spent";
			if (!facts.enabled || !facts.automaticResetEnabled || facts.aborted) {
				return { state: { ...state, overflow: spent ? "spent" : "idle" }, effect: "none" };
			}
			// The recovery is one-use per failure chain. Committing it spends the attempt.
			return { state: { ...state, overflow: "spent" }, effect: spent ? "none" : "recover-overflow" };
		}
		case "settled":
			// Settlement ends the failure chain but leaves a pending explicit request armed.
			return { state: { ...state, overflow: "idle" }, effect: "none" };
		case "abort":
		case "clear":
			return { state: initialResetControl(), effect: "none" };
	}
}

/**
 * Own reset requests at Pi 0.87 boundaries. Persisted windows are custom entries, not
 * compaction summaries: turn_end commits explicit/threshold resets after a complete tool
 * batch, while agent_before_settle commits the one bounded overflow recovery after Pi's
 * native recovery attempt has been cancelled.
 *
 * This function is the effect adapter: it captures Pi events, translates them into pure
 * reset-control transitions, and performs the resulting marker/boot/continuation writes and
 * notifications. The decision of what to do lives entirely in `reduceResetControl`.
 */
export function registerResetLifecycle(pi: ExtensionAPI, options: ResetOptions) {
	let sessionActive = true;
	let control = initialResetControl();

	const clear = () => { control = reduceResetControl(control, { type: "clear" }).state; };
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
		if (!sessionActive) return undefined;
		const aborted = isAbort(event.message, event.outcome, ctx);
		const stagedBudgetEntries = options.budget.consumeTurnEnd(ctx);
		// Lifecycle owns whether drafts are acceptable for this turn. Budget only
		// drains its instance-local staging, so aborts and disabled mode cannot commit it.
		const budgetEntries = options.isEnabled() && !aborted ? stagedBudgetEntries : [];
		const entries = [...(event.entries ?? []), ...budgetEntries];
		const decision = reduceResetControl(control, {
			type: "turn_end",
			facts: {
				aborted,
				overflow: aborted ? false : isOverflowLike(event.message, ctx),
				failed: event.outcome === "error",
				enabled: options.isEnabled(),
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				get thresholdDue() { return options.budget.resetDue(ctx); },
			},
		});
		control = decision.state;
		if (decision.effect === "commit-boundary") return resetBoundaryResult(entries, ctx);
		return entries.length > 0 ? { entries } : undefined;
	});

	pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx) => {
		if (!sessionActive) return undefined;
		const decision = reduceResetControl(control, {
			type: "before_settle",
			facts: {
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get enabled() { return options.isEnabled(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				get aborted() { return event.outcome === "aborted" || ctx.signal?.aborted === true; },
			},
		});
		control = decision.state;
		if (decision.effect !== "recover-overflow") return undefined;
		return resetBoundaryResult(event.entries, ctx);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!sessionActive) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const markerExists = currentReset(ctx) !== undefined;
		if (options.isEnabled() || markerExists) {
			if (event.reason === "manual") {
				ctx.ui.notify("pi-context: /compact is disabled while context windows are active; use /wipe-memory to start a fresh window.", "warning");
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
		control = reduceResetControl(control, { type: "settled" }).state;
	});
	pi.on("session_start", () => { clear(); sessionActive = true; });
	pi.on("session_tree", clear);
	pi.on("session_shutdown", () => { clear(); options.budget.clear(); sessionActive = false; });

	return {
		request() {
			const decision = reduceResetControl(control, { type: "request" });
			control = decision.state;
			return decision.effect === "already-requested" ? "rollover_already_pending" : "rollover_requested";
		},
		clear,
	};
}
