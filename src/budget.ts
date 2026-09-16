import { Type } from "@earendil-works/pi-ai";
import { defineTool, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, GUIDANCE_TYPE, FALLBACK_TYPE } from "./protocol.js";
import { currentWindowId, hasWindowMessage } from "./history.js";
import { tokenBudgetGuidance } from "./prompts.js";
import { output } from "./tool-output.js";

type ResolvedThresholds = { reminder: number; reserve: number };
type PiContextMargins = { reminderMarginTokens: unknown };

function isSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the raw "pi-context" object from one parsed settings scope. */
function piContextSettings(settings: unknown): Record<string, unknown> {
	if (!isSettingsObject(settings)) return {};
	const value = settings[PI_CONTEXT_SETTINGS_KEY];
	return isSettingsObject(value) ? value : {};
}

/** Merge the global and project "pi-context" objects per key; project wins, mirroring Pi's deep merge. */
export function mergePiContextSettings(globalSettings: unknown, projectSettings: unknown): PiContextMargins {
	const merged = { ...piContextSettings(globalSettings), ...piContextSettings(projectSettings) };
	return { reminderMarginTokens: merged.reminderMarginTokens };
}

/** A margin is usable only as a positive integer; anything else is ignored. */
function validMargin(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
	return raw;
}

/**
 * Pure derivation of the reminder threshold from Pi's reserve plus the pi-context
 * reminder margin. An invalid margin degrades to the default and reports one warning.
 * The borrowed fallback turn has no token threshold of its own: it is driven by Pi's
 * automatic threshold/overflow compaction request (see session_before_compact).
 */
export function deriveThresholds(reserveTokens: number, margins: PiContextMargins): { thresholds: ResolvedThresholds; warnings: string[] } {
	const warnings: string[] = [];
	const reminderKey = `${PI_CONTEXT_SETTINGS_KEY}.reminderMarginTokens`;
	let reminderMargin: number;
	if (margins.reminderMarginTokens === undefined) reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
	else {
		const parsed = validMargin(margins.reminderMarginTokens);
		if (parsed === undefined) {
			warnings.push(`pi-context: ${reminderKey} must be a positive integer; using default ${DEFAULT_REMINDER_MARGIN_TOKENS}.`);
			reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		} else reminderMargin = parsed;
	}
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens }, warnings };
}

export function registerBudget(pi: ExtensionAPI, isEnabled: () => boolean) {
	let guidancePersistedInWindow: string | undefined;
	let thresholds: ResolvedThresholds | undefined;

	/**
	 * Resolve the thresholds for this session from Pi's compaction reserve plus the
	 * settings.json "pi-context" margins. The file-backed read is cached until the next
	 * session_start; invalid configuration degrades per offending key with one warning
	 * and never throws during session operation.
	 */
	const resolveThresholds = (ctx: ExtensionContext): ResolvedThresholds => {
		if (thresholds) return thresholds;
		try {
			const settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const derived = deriveThresholds(
				settingsManager.getCompactionSettings().reserveTokens,
				mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
			);
			for (const warning of derived.warnings) ctx.ui.notify(warning, "warning");
			thresholds = derived.thresholds;
		} catch (error) {
			ctx.ui.notify(`pi-context: could not read settings; using defaults (${String(error)}).`, "warning");
			thresholds = { reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS, reserve: DEFAULT_RESERVE_TOKENS };
		}
		return thresholds;
	};

	pi.on("session_start", (_event, ctx) => { thresholds = undefined; guidancePersistedInWindow = undefined; resolveThresholds(ctx); });
	pi.on("session_tree", () => { guidancePersistedInWindow = undefined; });
	pi.on("context", (_event, ctx) => {
		if (!isEnabled() || hasWindowMessage(ctx, FALLBACK_TYPE)) return undefined;
		// This hook does exactly one thing: persist the once-per-window low-budget
		// reminder the first time remaining context crosses the reminder threshold.
		// It never injects messages into the request.
		const usage = ctx.getContextUsage();
		if (usage && usage.tokens !== null) {
			const remaining = Math.max(0, usage.contextWindow - usage.tokens);
			const windowId = currentWindowId(ctx);
			const { reminder, reserve } = resolveThresholds(ctx);
			if (remaining <= reminder && guidancePersistedInWindow !== windowId && !hasWindowMessage(ctx, GUIDANCE_TYPE)) {
				guidancePersistedInWindow = windowId;
				// Persist once per window — no transient copy. A transient bridge would
				// cover the crossing request, but history would record the reminder after
				// that request's assistant reply, so across the boundary the model would
				// meet the same text twice at shifted positions. The reminder is an early
				// warning, not a per-request instruction: arriving from the next request
				// on (sendMessage defers safely to end of turn while streaming, queueing
				// instead of splitting a tool call/result pair) costs nothing, and the
				// model's view stays identical to recorded history, Codex-style.
				pi.sendMessage({ customType: GUIDANCE_TYPE, content: tokenBudgetGuidance(Math.max(0, remaining - reserve)), display: true }, { triggerTurn: false });
			}
		}
		return undefined;
	});

	pi.registerTool(defineTool({
		name: "get_context_remaining",
		label: "Get context remaining",
		description: "Return estimated context tokens available before the compaction reserve, clamped to zero; null when Pi cannot estimate usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const usage = ctx.getContextUsage();
			const remaining = usage?.tokens === null || usage === undefined ? null : Math.max(0, usage.contextWindow - usage.tokens - resolveThresholds(ctx).reserve);
			return output({ remaining_tokens: remaining });
		},
	}));

}
