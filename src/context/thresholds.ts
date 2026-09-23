import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "../protocol.js";
import { mergePiContextSettings, type PiContextSettings } from "../settings.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };
/** A margin is usable only as a positive integer; anything else is ignored. */
function validMargin(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
	return raw;
}

/**
 * Pure derivation of the thresholds from Pi's reserve: the reminder fires at reserve
 * plus the pi-context margin, the warning steer at reserve plus WARNING_RUNWAY_TOKENS.
 * An invalid margin degrades to the default and reports one warning. Automatic
 * threshold/overflow handling is represented by reset lifecycle boundary drafts;
 * no compaction summary is generated.
 */
export function deriveThresholds(reserveTokens: number, margins: PiContextSettings): { thresholds: ResolvedThresholds; warnings: string[] } {
	const warnings: string[] = [];
	const reminderKey = `${PI_CONTEXT_SETTINGS_KEY}.reminderMarginTokens`;
	let reminderMargin: number;
	if (margins.reminderMarginTokens === undefined) reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
	else {
		const parsed = validMargin(margins.reminderMarginTokens);
		if (parsed === undefined) {
			warnings.push(`pi-context: ${reminderKey} must be a positive integer; using the default reminder margin.`);
			reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		} else reminderMargin = parsed;
	}
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens, warning: reserveTokens + WARNING_RUNWAY_TOKENS }, warnings };
}

/**
 * Read the active compaction reserve, enablement, and pi-context margin settings. This
 * function deliberately has no cache: the budget owner supplies the invocation-scoped
 * cache so two live piContext instances cannot share mutable policy state.
 */
export type ThresholdSettingsResolution = {
	thresholds: ResolvedThresholds;
	automatic: boolean;
	warnings: string[];
};

function readThresholdSettingsFromManager(ctx: ExtensionContext, settingsManager: SettingsManager): ThresholdSettingsResolution {
	// Resolve the active provider/model override from the public settings API.
	const model = ctx.model;
	const compaction = settingsManager.getCompactionSettings(model ? { provider: model.provider, id: model.id } : undefined);
	const derived = deriveThresholds(
		compaction.reserveTokens,
		mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
	);
	return { thresholds: derived.thresholds, automatic: compaction.enabled, warnings: derived.warnings };
}

/**
 * Resolve policy from either the explicitly supplied SDK authority or Pi's default
 * file-backed settings. The caller owns diagnostics and any lifecycle caching.
 */
export function readThresholdSettings(ctx: ExtensionContext, settingsManager?: SettingsManager): ThresholdSettingsResolution {
	try {
		if (settingsManager) return readThresholdSettingsFromManager(ctx, settingsManager);
		return readThresholdSettingsFromManager(
			ctx,
			SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }),
		);
	} catch (error) {
		return {
			thresholds: {
				reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS,
				reserve: DEFAULT_RESERVE_TOKENS,
				warning: DEFAULT_RESERVE_TOKENS + WARNING_RUNWAY_TOKENS,
			},
			automatic: true,
			warnings: [`pi-context: could not read settings; using defaults (${String(error)}).`],
		};
	}
}
