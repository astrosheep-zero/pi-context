import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, GUIDANCE_TYPE, WARNING_PROMPT, WARNING_TYPE } from "../protocol.js";
import { readThresholdSettings, type ResolvedThresholds, type ThresholdSettingsResolution } from "./thresholds.js";
import { currentWindowId, hasWindowMessage, windowUsage } from "./context-window.js";
import { tokenBudgetGuidance } from "./prompts.js";
import { output } from "../tool-output.js";

/** Remaining tokens in the provider's active window, or null without a usable estimate. */
export function remainingTokens(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">): number | null {
	const usage = windowUsage(ctx);
	return !usage || usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
}

export function registerBudget(pi: ExtensionAPI, isEnabled: () => boolean, settingsManager?: SettingsManager) {
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
	const resetDue = (ctx: ExtensionContext): boolean => {
		if (!automaticResetEnabled(ctx)) return false;
		const usage = windowUsage(ctx);
		return usage !== undefined && usage.tokens !== null && usage.contextWindow - usage.tokens <= thresholdsFor(ctx).reserve;
	};
	const invalidateThresholds = () => { cachedPolicy = undefined; };
	let pendingGuidance: { windowId: string; content: string } | undefined;
	let pendingWarning: { windowId: string; content: string } | undefined;
	let pendingNotices: Array<{ windowId: string; customType: string }> = [];
	const notifyCommittedReminders = (ctx: ExtensionContext) => {
		const windowId = currentWindowId(ctx);
		for (const notice of pendingNotices) {
			if (notice.windowId !== windowId || !hasWindowMessage(ctx, notice.customType)) continue;
			ctx.ui.notify(notice.customType === WARNING_TYPE
				? "pi-context: context budget critical — final checkpoint warning recorded for the model."
				: "pi-context: context budget low — checkpoint reminder recorded for the model, kept out of the chat view.", "warning");
		}
		pendingNotices = [];
	};

	const clearStaged = () => {
		pendingGuidance = undefined;
		pendingWarning = undefined;
	};
	const resetForTransition = () => {
		clearStaged();
		pendingNotices = [];
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
		pendingNotices = drafts.map(({ windowId, customType }) => ({ windowId, customType }));
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
	// A request can fail before Pi emits turn_end. agent_settled is the public
	// lifecycle point that must discard an uncommitted draft before the next prompt.
	// UI notices follow committed reminders. Aborted requests can retry their drafts
	// without showing the same low-budget notification twice.
	pi.on("turn_start", (_event, ctx) => notifyCommittedReminders(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		notifyCommittedReminders(ctx);
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
		if (hasWindowMessage(ctx, WARNING_TYPE) || pendingWarning?.windowId === windowId) return undefined;
		if (remaining <= warning) {
			// A not-yet-committed shallow reminder is superseded by the final warning.
			pendingGuidance = undefined;
			const content = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
			pendingWarning = { windowId, content };
			const warningMessage = {
				role: "custom" as const,
				customType: WARNING_TYPE,
				content,
				display: false,
				timestamp: Date.now(),
			};
			return { messages: [..._event.messages, warningMessage] };
		}
		if (hasWindowMessage(ctx, GUIDANCE_TYPE) || pendingGuidance?.windowId === windowId) return undefined;
		if (remaining <= reminder) {
			// Persist at turn_end, before any reset drafts. A queued sendMessage could
			// otherwise cross the marker and leak the old window's reminder forward.
			const left = Math.max(0, remaining - warning);
			pendingGuidance = { windowId, content: tokenBudgetGuidance(left) };
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
		resetDue,
		consumeTurnEnd,
		clear: () => { clearStaged(); pendingNotices = []; },
	};
}
