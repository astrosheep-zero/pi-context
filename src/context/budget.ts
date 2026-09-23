import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_TYPE, WARNING_CONTENT, WARNING_TYPE } from "../protocol.js";
import { readThresholdSettings, type ResolvedThresholds, type ThresholdSettingsResolution } from "./thresholds.js";
import { currentWindowId, hasWindowMessage, isWindowMarker, rootWindowId, windowUsage } from "./context-window.js";
import { tokenBudgetGuidance } from "./prompts.js";
import { output } from "../tool-output.js";

/** Remaining tokens in the provider's active window, or null without a usable estimate. */
export function remainingTokens(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">): number | null {
	const usage = windowUsage(ctx);
	return !usage || usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
}

export function registerBudget(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	settingsManager?: SettingsManager,
	onCloseOut: (windowId: string) => void = () => {},
) {
	let cachedPolicy: { thresholds: ResolvedThresholds; automatic: boolean } | undefined;
	const notifiedWarnings = new Set<string>();
	const resolvePolicy = (ctx: ExtensionContext): ThresholdSettingsResolution => {
		if (!settingsManager && cachedPolicy) return { ...cachedPolicy, warnings: [] };
		const resolution = readThresholdSettings(ctx, settingsManager);
		for (const warning of resolution.warnings) {
			if (notifiedWarnings.has(warning)) continue;
			notifiedWarnings.add(warning);
			ctx.ui.notify(warning, "warning");
		}
		if (!settingsManager) cachedPolicy = { thresholds: resolution.thresholds, automatic: resolution.automatic };
		return resolution;
	};
	const thresholdsFor = (ctx: ExtensionContext): ResolvedThresholds => {
		return resolvePolicy(ctx).thresholds;
	};
	const automaticResetEnabled = (ctx: ExtensionContext): boolean => {
		return resolvePolicy(ctx).automatic;
	};
	const hardReserveDue = (ctx: ExtensionContext): boolean => {
		if (!automaticResetEnabled(ctx)) return false;
		const usage = windowUsage(ctx);
		return usage !== undefined && usage.tokens !== null && usage.contextWindow - usage.tokens <= thresholdsFor(ctx).reserve;
	};
	const invalidateThresholds = () => { cachedPolicy = undefined; };
	let pendingGuidance: { windowId: string; content: string; remaining: number } | undefined;
	let pendingWarning: { windowId: string; content: string; remaining: number } | undefined;
	let pendingNotices = new Map<string, { sessionId: string; windowId: string }>();
	const noticeKey = (sessionId: string, windowId: string) => `${sessionId}:${windowId}`;
	const warningCommittedInWindow = (ctx: ExtensionContext, notice: { sessionId: string; windowId: string }): boolean => {
		if (ctx.sessionManager.getSessionId() !== notice.sessionId) return false;
		let windowId = rootWindowId(notice.sessionId);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (isWindowMarker(entry)) {
				windowId = entry.data.windowId;
				continue;
			}
			if (windowId === notice.windowId && entry.type === "custom_message" && entry.customType === WARNING_TYPE) return true;
		}
		return false;
	};
	const notifyCommittedWarnings = (ctx: ExtensionContext, settled = false) => {
		for (const [key, notice] of pendingNotices) {
			if (warningCommittedInWindow(ctx, notice)) {
				pendingNotices.delete(key);
				ctx.ui.notify("pi-context: Context almost full; close out the current memory window.", "warning");
			} else if (settled) {
				// An uncommitted draft must not be matched to a later manual warning.
				pendingNotices.delete(key);
			}
		}
	};

	const clearStaged = () => {
		pendingGuidance = undefined;
		pendingWarning = undefined;
	};
	const resetForTransition = () => {
		clearStaged();
		pendingNotices.clear();
		invalidateThresholds();
		notifiedWarnings.clear();
	};

	const consumeTurnEnd = (ctx: ExtensionContext): SessionBoundaryDraft[] => {
		const staged = [
			pendingGuidance ? { ...pendingGuidance, customType: GUIDANCE_TYPE } : undefined,
			pendingWarning ? { ...pendingWarning, customType: WARNING_TYPE } : undefined,
		];
		clearStaged();
		const windowId = currentWindowId(ctx);
		const drafts = staged.filter((draft): draft is NonNullable<typeof draft> => draft !== undefined && draft.windowId === windowId);
		if (drafts.some((draft) => draft.customType === WARNING_TYPE)) {
			const sessionId = ctx.sessionManager.getSessionId();
			pendingNotices.set(noticeKey(sessionId, windowId), { sessionId, windowId });
		}
		return drafts.map((draft) => ({
			type: "custom_message" as const,
			customType: draft.customType,
			content: draft.content,
			display: false,
		}));
	};

	pi.on("session_start", (_event, ctx) => { resetForTransition(); thresholdsFor(ctx); });
	pi.on("session_tree", resetForTransition);
	pi.on("model_select", resetForTransition);
	pi.on("session_shutdown", resetForTransition);
	// A warning can be committed at turn_end, before a tool turn or a reset changes the
	// active window. Observe the active branch at public lifecycle boundaries and match
	// the candidate against its originating window segment, not only the current window.
	pi.on("turn_start", (_event, ctx) => notifyCommittedWarnings(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		notifyCommittedWarnings(ctx, true);
		clearStaged();
	});
	pi.on("context", (_event, ctx) => {
		if (!isEnabled()) return undefined;
		// The early reminder persists once per window the first time remaining crosses
		// reserve+margin. It never edits the outgoing request.
		const remaining = remainingTokens(ctx);
		if (remaining === null) return undefined;
		const windowId = currentWindowId(ctx);
		const { reminder, warning } = thresholdsFor(ctx);
		if (remaining <= warning && automaticResetEnabled(ctx)) {
			// Re-arm close-out on each eligible request. A prior request may have aborted
			// after persisting the warning, so warning deduplication must not own this state.
			onCloseOut(windowId);
			if (hasWindowMessage(ctx, WARNING_TYPE) || pendingWarning?.windowId === windowId) return undefined;
			// The critical close-out starts at reserve + runway, not at the hard reserve.
			pendingGuidance = undefined;
			const content = WARNING_CONTENT;
			pendingWarning = { windowId, content, remaining };
			const warningMessage = {
				role: "custom" as const,
				customType: WARNING_TYPE,
				content,
				display: false,
				timestamp: Date.now(),
			};
			return { messages: [..._event.messages, warningMessage] };
		}
		if (hasWindowMessage(ctx, WARNING_TYPE) || pendingWarning?.windowId === windowId) return undefined;
		if (hasWindowMessage(ctx, GUIDANCE_TYPE) || pendingGuidance?.windowId === windowId) return undefined;
		if (remaining <= reminder) {
			// Persist at turn_end, before any reset drafts. A queued sendMessage could
			// otherwise cross the marker and leak the old window's reminder forward.
			const left = Math.max(0, remaining - warning);
			pendingGuidance = { windowId, content: tokenBudgetGuidance(left), remaining };
		}
		return undefined;
	});

	pi.registerTool(defineTool({
		name: "get_context_remaining",
		label: "Get context remaining",
		description: "Return estimated context tokens left before your memory is wiped; null when Pi cannot estimate usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			// The countdown the model sees ends at the warning line (reserve + runway);
			// the runway below it is overdraft the model never sees. See protocol.ts.
			const remaining = remainingTokens(ctx);
			return output({ remaining_tokens: remaining === null ? null : Math.max(0, remaining - thresholdsFor(ctx as ExtensionContext).warning) });
		},
	}));

	return {
		automaticResetEnabled,
		hardReserveDue,
		consumeTurnEnd,
		clear: () => { clearStaged(); pendingNotices.clear(); },
	};
}
