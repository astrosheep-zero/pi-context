import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_CONTEXT_SETTINGS_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_TRIGGER_TOKENS } from "./protocol.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };
type PiContextMargins = { reminderMarginTokens?: unknown };

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
 * Pure derivation of the thresholds from Pi's reserve: the reminder fires at reserve
 * plus the pi-context margin, the warning steer at reserve plus WARNING_TRIGGER_TOKENS.
 * An invalid margin degrades to the default and reports one warning. Pi's automatic
 * threshold/overflow compaction itself resets immediately, with no model turn.
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
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens, warning: reserveTokens + WARNING_TRIGGER_TOKENS }, warnings };
}

let cached: ResolvedThresholds | undefined;

/**
 * Session-level threshold resolution: Pi's compaction reserve plus the settings.json
 * "pi-context" margins. The file-backed read is cached until resetThresholds (called
 * on session_start/session_tree); invalid configuration degrades per offending key
 * with one warning and never throws during session operation.
 */
export function thresholdsFor(ctx: ExtensionContext): ResolvedThresholds {
	if (cached) return cached;
	try {
		const settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		const derived = deriveThresholds(
			settingsManager.getCompactionSettings().reserveTokens,
			mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
		);
		for (const warning of derived.warnings) ctx.ui.notify(warning, "warning");
		cached = derived.thresholds;
	} catch (error) {
		ctx.ui.notify(`pi-context: could not read settings; using defaults (${String(error)}).`, "warning");
		cached = { reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS, reserve: DEFAULT_RESERVE_TOKENS, warning: DEFAULT_RESERVE_TOKENS + WARNING_TRIGGER_TOKENS };
	}
	return cached;
}

export function resetThresholds(): void {
	cached = undefined;
}
