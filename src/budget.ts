import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_TYPE, WARNING_TYPE } from "./protocol.js";
import { thresholdsFor, resetThresholds } from "./thresholds.js";
import { currentWindowId, hasWindowMessage } from "./history.js";
import { tokenBudgetGuidance } from "./prompts.js";
import { output } from "./tool-output.js";

/** Remaining tokens in the current context window, or null when Pi has no usage estimate. */
export function remainingTokens(ctx: Pick<ExtensionContext, "getContextUsage">): number | null {
	const usage = ctx.getContextUsage();
	return !usage || usage.tokens === null ? null : Math.max(0, usage.contextWindow - usage.tokens);
}

export function registerBudget(pi: ExtensionAPI, isEnabled: () => boolean) {
	let guidancePersistedInWindow: string | undefined;

	pi.on("session_start", (_event, ctx) => { guidancePersistedInWindow = undefined; resetThresholds(); thresholdsFor(ctx); });
	pi.on("session_tree", () => { guidancePersistedInWindow = undefined; resetThresholds(); });
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
			// Persist once per window — no transient copy. A transient bridge would
			// cover the crossing request, but history would record the reminder after
			// that request's assistant reply, so across the boundary the model would
			// meet the same text twice at shifted positions. The reminder is an early
			// warning, not a per-request instruction: arriving from the next request
			// on (sendMessage defers safely to end of turn while streaming, queueing
			// instead of splitting a tool call/result pair) costs nothing, and the
			// model's view stays identical to recorded history, Codex-style.
			// The persisted copy stays out of the TUI (display: false); one ephemeral
			// notify tells the user instead — visible to the human, invisible to the
			// model, and never recorded, so history and the model's view don't diverge.
			// The model-facing count ends at the warning line: what lies below is the
			// runway, invisible by design. The human's notify keeps the honest count.
			const left = Math.max(0, remaining - warning);
			pi.sendMessage({ customType: GUIDANCE_TYPE, content: tokenBudgetGuidance(left), display: false }, { triggerTurn: false });
			ctx.ui.notify(`pi-context: context budget low (${Math.max(0, remaining - reserve)} tokens before reserve) — checkpoint reminder recorded for the model, kept out of the chat view.`, "warning");
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
