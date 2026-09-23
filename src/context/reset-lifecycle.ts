import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { currentReset, currentWindowId } from "./context-window.js";

type BudgetOwner = {
	automaticResetEnabled: (ctx: ExtensionContext) => boolean;
	hardReserveDue: (ctx: ExtensionContext) => boolean;
	consumeTurnEnd: (ctx: ExtensionContext) => SessionBoundaryDraft[];
	clear: () => void;
};

type ResetOptions = {
	isEnabled: () => boolean;
	budget: BudgetOwner;
	buildReset: (ctx: ExtensionContext, isCurrent: () => boolean) => SessionBoundaryDraft[] | Promise<SessionBoundaryDraft[]>;
	getLifecycleGeneration?: () => number;
	onResetReady?: (ctx: ExtensionContext, drafts: readonly SessionBoundaryDraft[]) => void;
};

function isAbort(message: AgentMessage, outcome: string | undefined, ctx: ExtensionContext): boolean {
	return outcome === "aborted" || (message.role === "assistant" && message.stopReason === "aborted") || ctx.signal?.aborted === true;
}

function isOverflowLike(message: AgentMessage, ctx: ExtensionContext): boolean {
	if (message.role !== "assistant") return false;
	return isContextOverflow(message, ctx.model?.contextWindow) ||
		(ctx.model !== undefined && isRecoverableLength(message, ctx.model.maxTokens));
}

export type ResetRequestSource = "manual" | "automatic";
type ToolResetRequestSource = ResetRequestSource | "tool";
export type ResetRequest =
	| { readonly phase: "none" }
	| { readonly phase: "close-out"; readonly windowId: string; readonly source: ResetRequestSource }
	| { readonly phase: "tool-requested"; readonly windowId: string; readonly source: ToolResetRequestSource };
export type ResetOverflowPhase = "idle" | "pending" | "pending-spent" | "spent";

export interface ResetControlState {
	readonly request: ResetRequest;
	readonly overflow: ResetOverflowPhase;
}

const NO_REQUEST: ResetRequest = { phase: "none" };

export function initialResetControl(): ResetControlState {
	return { request: NO_REQUEST, overflow: "idle" };
}

/** Facts for a completed turn. Guard values stay lazy to preserve policy resolution order. */
export interface ResetTurnEndFacts {
	readonly windowId: string;
	readonly aborted: boolean;
	readonly overflow: boolean;
	readonly failed: boolean;
	readonly enabled: boolean;
	readonly queued: boolean;
	readonly automaticResetEnabled: boolean;
	readonly hardReserveDue: boolean;
}

/** Facts for the pre-settlement boundary; policy guards stay lazy for the same reason. */
export interface ResetBeforeSettleFacts {
	readonly windowId: string;
	readonly queued: boolean;
	readonly enabled: boolean;
	readonly automaticResetEnabled: boolean;
	readonly aborted: boolean;
	readonly failed: boolean;
}

export type ResetControlEvent =
	| { readonly type: "close_out"; readonly windowId: string; readonly source: ResetRequestSource }
	| { readonly type: "tool_request"; readonly windowId: string }
	| { readonly type: "turn_end"; readonly facts: ResetTurnEndFacts }
	| { readonly type: "before_settle"; readonly facts: ResetBeforeSettleFacts }
	| { readonly type: "settled" }
	| { readonly type: "abort" }
	| { readonly type: "clear" };

export type ResetControlEffect =
	| "none"
	| "close-out-armed"
	| "already-pending"
	| "commit-boundary"
	| "commit-boundary-stop"
	| "recover-overflow";

export interface ResetControlResult {
	readonly state: ResetControlState;
	readonly effect: ResetControlEffect;
}

function requestForWindow(request: ResetRequest, windowId: string): ResetRequest {
	return request.phase !== "none" && request.windowId === windowId ? request : NO_REQUEST;
}

/** Pure reset-control transitions: request phases own close-out, tool commit, and fallback. */
export function reduceResetControl(state: ResetControlState, event: ResetControlEvent): ResetControlResult {
	switch (event.type) {
		case "close_out": {
			const request = state.request;
			if (request.phase === "tool-requested" && request.windowId === event.windowId) {
				return { state, effect: "already-pending" };
			}
			if (request.phase === "close-out" && request.windowId === event.windowId) {
				if (request.source === "manual" || event.source === "automatic") return { state, effect: "already-pending" };
				return { state: { ...state, request: { ...request, source: "manual" } }, effect: "close-out-armed" };
			}
			return { state: { ...state, request: { phase: "close-out", windowId: event.windowId, source: event.source } }, effect: "close-out-armed" };
		}
		case "tool_request": {
			const request = state.request;
			if (request.phase === "tool-requested" && request.windowId === event.windowId) return { state, effect: "already-pending" };
			const source: ToolResetRequestSource = request.phase === "close-out" ? request.source : "tool";
			return { state: { ...state, request: { phase: "tool-requested", windowId: event.windowId, source } }, effect: "close-out-armed" };
		}
		case "turn_end": {
			const facts = event.facts;
			const request = requestForWindow(state.request, facts.windowId);
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			if (facts.overflow) {
				const pending = !facts.queued && facts.enabled && facts.automaticResetEnabled;
				const spent = state.overflow === "pending-spent" || state.overflow === "spent";
				const overflow: ResetOverflowPhase = pending
					? (spent ? "pending-spent" : "pending")
					: (spent ? "spent" : "idle");
				return { state: { request: NO_REQUEST, overflow }, effect: "none" };
			}
			if (facts.failed) return { state: { request: NO_REQUEST, overflow: state.overflow }, effect: "none" };
			if (!facts.enabled) {
				return { state: { request: NO_REQUEST, overflow: "idle" }, effect: "none" };
			}
			// A direct tool request commits after the whole tool batch. The budget cutoff is
			// a separate hard-reserve safety path; ordinary close-out waits for settlement.
			if (request.phase === "tool-requested" || facts.hardReserveDue) {
				const stopAfterReset = request.phase === "tool-requested" && request.source === "manual";
				return { state: { request: NO_REQUEST, overflow: "idle" }, effect: stopAfterReset ? "commit-boundary-stop" : "commit-boundary" };
			}
			return { state: { request, overflow: "idle" }, effect: "none" };
		}
		case "before_settle": {
			const facts = event.facts;
			if (facts.aborted) return { state: initialResetControl(), effect: "none" };
			const request = requestForWindow(state.request, facts.windowId);
			if (state.overflow === "pending" || state.overflow === "pending-spent") {
				if (facts.queued) {
					return { state: { ...state, request: facts.failed ? NO_REQUEST : request }, effect: "none" };
				}
				const spent = state.overflow === "pending-spent";
				if (!facts.enabled || !facts.automaticResetEnabled) {
					return { state: { request: facts.failed ? NO_REQUEST : request, overflow: spent ? "spent" : "idle" }, effect: "none" };
				}
				return { state: { request: NO_REQUEST, overflow: "spent" }, effect: spent ? "none" : "recover-overflow" };
			}
			if (facts.failed || !facts.enabled || request.phase !== "close-out") {
				return { state: { ...state, request: NO_REQUEST }, effect: "none" };
			}
			if (facts.queued) return { state: { ...state, request }, effect: "none" };
			if (request.source === "automatic" && !facts.automaticResetEnabled) {
				return { state: { ...state, request: NO_REQUEST }, effect: "none" };
			}
			return { state: { request: NO_REQUEST, overflow: "idle" }, effect: request.source === "manual" ? "commit-boundary-stop" : "commit-boundary" };
		}
		case "settled":
			return { state: initialResetControl(), effect: "none" };
		case "abort":
		case "clear":
			return { state: initialResetControl(), effect: "none" };
	}
}

/**
 * Own close-out requests at Pi's public turn and pre-settlement boundaries. Tool-requested
 * resets commit at turn_end; manual and budget close-outs remain armed across note/tool turns
 * and fall back at a successful agent_before_settle. Overflow recovery remains bounded.
 */
export function registerResetLifecycle(pi: ExtensionAPI, options: ResetOptions) {
	let sessionActive = true;
	let lifecycleGeneration = 0;
	let control = initialResetControl();

	const clear = () => { control = reduceResetControl(control, { type: "clear" }).state; };
	const resetBoundaryResult = async (entries: SessionBoundaryDraft[], ctx: ExtensionContext, continueAfterReset: boolean) => {
		const generation = lifecycleGeneration;
		const outerGeneration = options.getLifecycleGeneration?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const windowId = currentWindowId(ctx);
		const isCurrent = () => sessionActive && lifecycleGeneration === generation &&
			(outerGeneration === undefined || options.getLifecycleGeneration?.() === outerGeneration) && options.isEnabled() &&
			ctx.signal?.aborted !== true && ctx.sessionManager.getSessionId() === sessionId && currentWindowId(ctx) === windowId;
		let resetDrafts: SessionBoundaryDraft[];
		try {
			resetDrafts = await options.buildReset(ctx, isCurrent);
		} catch (error) {
			if (isCurrent()) ctx.ui.notify(`pi-context: could not build reset (${String(error)}).`, "warning");
			return entries.length > 0 ? { entries } : undefined;
		}
		if (!isCurrent()) return entries.length > 0 ? { entries } : undefined;
		options.onResetReady?.(ctx, resetDrafts);
		return { entries: [...entries, ...resetDrafts], continue: continueAfterReset };
	};

	pi.on("turn_end", async (event, ctx) => {
		if (!sessionActive) return undefined;
		const aborted = isAbort(event.message, event.outcome, ctx);
		const stagedBudgetEntries = options.budget.consumeTurnEnd(ctx);
		const budgetEntries = options.isEnabled() && !aborted && event.outcome !== "error" ? stagedBudgetEntries : [];
		const entries = [...(event.entries ?? []), ...budgetEntries];
		const decision = reduceResetControl(control, {
			type: "turn_end",
			facts: {
				windowId: currentWindowId(ctx),
				aborted,
				overflow: aborted ? false : isOverflowLike(event.message, ctx),
				failed: event.outcome === "error",
				enabled: options.isEnabled(),
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				get hardReserveDue() { return options.budget.hardReserveDue(ctx); },
			},
		});
		control = decision.state;
		if (decision.effect === "commit-boundary" || decision.effect === "commit-boundary-stop") return await resetBoundaryResult(entries, ctx, decision.effect === "commit-boundary");
		return entries.length > 0 ? { entries } : undefined;
	});

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx) => {
		if (!sessionActive) return undefined;
		const decision = reduceResetControl(control, {
			type: "before_settle",
			facts: {
				windowId: currentWindowId(ctx),
				get queued() { return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages(); },
				get enabled() { return options.isEnabled(); },
				get automaticResetEnabled() { return options.budget.automaticResetEnabled(ctx); },
				aborted: event.outcome === "aborted" || ctx.signal?.aborted === true,
				failed: event.outcome === "error",
			},
		});
		control = decision.state;
		if (decision.effect !== "commit-boundary" && decision.effect !== "commit-boundary-stop" && decision.effect !== "recover-overflow") return undefined;
		return await resetBoundaryResult(event.entries, ctx, decision.effect !== "commit-boundary-stop");
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!sessionActive) return undefined;
		if (event.signal.aborted) return { cancel: true };
		const markerExists = currentReset(ctx) !== undefined;
		if (options.isEnabled() || markerExists) {
			if (event.reason === "manual") {
				ctx.ui.notify("pi-context: /compact is disabled while context windows are active; use /wipe-memory to start a fresh window.", "warning");
			}
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.signal?.aborted) control = reduceResetControl(control, { type: "abort" }).state;
	});
	pi.on("agent_settled", () => {
		control = reduceResetControl(control, { type: "settled" }).state;
	});
	pi.on("session_start", () => { lifecycleGeneration++; clear(); sessionActive = true; });
	pi.on("session_tree", () => { lifecycleGeneration++; clear(); });
	pi.on("session_shutdown", () => { lifecycleGeneration++; clear(); options.budget.clear(); sessionActive = false; });

	return {
		closeOut(windowId: string, source: ResetRequestSource) {
			const decision = reduceResetControl(control, { type: "close_out", windowId, source });
			control = decision.state;
			return decision.effect;
		},
		request(windowId: string) {
			const decision = reduceResetControl(control, { type: "tool_request", windowId });
			control = decision.state;
			return decision.effect === "already-pending" ? "rollover_already_pending" : "rollover_requested";
		},
		clear,
	};
}
