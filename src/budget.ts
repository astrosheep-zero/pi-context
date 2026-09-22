import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_TYPE, WARNING_TYPE } from "./protocol.js";
import { thresholdsFor, resetThresholds } from "./thresholds.js";
import { currentWindowId, hasWindowMessage } from "./history.js";
import { tokenBudgetGuidance } from "./prompts.js";
import { output } from "./tool-output.js";
import { windowUsage } from "./context-window.js";

/** Remaining tokens in the provider's active window, or null without a usable estimate. */
export function remainingTokens(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model">): number | null {
	const usage = windowUsage(ctx);
	return !usage || usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
}

export function registerBudget(pi: ExtensionAPI, isEnabled: () => boolean) {
	let guidancePersistedInWindow: string | undefined;
	let pending: { windowId: string; content: string } | undefined;

	pi.on("session_start", (_event, ctx) => { guidancePersistedInWindow = undefined; pending = undefined; resetThresholds(); thresholdsFor(ctx); });
	pi.on("session_tree", () => { guidancePersistedInWindow = undefined; pending = undefined; resetThresholds(); });
	pi.on("model_select", resetThresholds);
	pi.on("agent_end", () => { pending = undefined; });
	pi.on("turn_end", (event, ctx) => {
		const reminder = pending;
		pending = undefined;
		if (!isEnabled() || !reminder || reminder.windowId !== currentWindowId(ctx)) return;
		return { entries: [...(event.entries ?? []), { type: "custom_message", customType: GUIDANCE_TYPE, content: reminder.content, display: false }] };
	});
	pi.on("context", (_event, ctx) => {
		if (!isEnabled() || hasWindowMessage(ctx, GUIDANCE_TYPE)) return undefined;
		// The early reminder persists once per window the first time remaining crosses
		// reserve+margin. It never edits the outgoing request.
		const remaining = remainingTokens(ctx);
		if (remaining === null) return undefined;
		const windowId = currentWindowId(ctx);
		const { reminder, reserve, warning } = thresholdsFor(ctx);
		// The final warning owns the deep band: when it has fired (or is due now),
		// the shallow reminder would only repeat the same instruction closer to
		// the wipe, at a worse position. See warning.ts.
		if (remaining <= warning || hasWindowMessage(ctx, WARNING_TYPE)) return undefined;
		if (remaining <= reminder && guidancePersistedInWindow !== windowId) {
			guidancePersistedInWindow = windowId;
			// Persist at turn_end, before any reset drafts. A queued sendMessage could
			// otherwise cross the marker and leak the old window's reminder forward.
			const left = Math.max(0, remaining - warning);
			pending = { windowId, content: tokenBudgetGuidance(left) };
			ctx.ui.notify("pi-context: context budget low — checkpoint reminder recorded for the model, kept out of the chat view.", "warning");
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

}
