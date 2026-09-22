import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_CONTEXT_SETTINGS_KEY, PI_CONTEXT_DREAMER_KEY, DEFAULT_RESERVE_TOKENS, DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "./protocol.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };
type PiContextSettings = { reminderMarginTokens?: unknown; dreamer?: unknown };

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
export function mergePiContextSettings(globalSettings: unknown, projectSettings: unknown): PiContextSettings {
	const merged = { ...piContextSettings(globalSettings), ...piContextSettings(projectSettings) };
	return { reminderMarginTokens: merged.reminderMarginTokens, dreamer: merged.dreamer };
}

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
			warnings.push(`pi-context: ${reminderKey} must be a positive integer; using default ${DEFAULT_REMINDER_MARGIN_TOKENS}.`);
			reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		} else reminderMargin = parsed;
	}
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens, warning: reserveTokens + WARNING_RUNWAY_TOKENS }, warnings };
}

export type DreamerSetting = { pattern?: string; warnings: string[] };

/**
 * `pi-context.dreamer` is a non-empty model pattern. Anything else present is ignored
 * with one warning; absent means no configured pattern, so the automatic model applies.
 */
export function deriveDreamer(settings: PiContextSettings): DreamerSetting {
	const raw = settings.dreamer;
	if (raw === undefined) return { warnings: [] };
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { warnings: [`pi-context: ${PI_CONTEXT_SETTINGS_KEY}.${PI_CONTEXT_DREAMER_KEY} must be a non-empty string; ignoring it.`] };
	}
	return { pattern: raw.trim(), warnings: [] };
}

/**
 * Resolve the configurable dreamer model from Pi settings for a CLI invocation: global
 * `~/.pi/agent/settings.json` merged with the project's `.pi/settings.json`, project
 * values winning per key. A settings read failure degrades to no pattern with one warning.
 */
export function readDreamerSettings(cwd = process.cwd()): DreamerSetting {
	try {
		const settingsManager = SettingsManager.create(cwd, undefined, { projectTrusted: true });
		return deriveDreamer(mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()));
	} catch (error) {
		return { warnings: [`pi-context: could not read settings; using the automatic dreamer model (${String(error)}).`] };
	}
}

let cached: ResolvedThresholds | undefined;
let automatic = true;

export function automaticResetEnabled(ctx: ExtensionContext): boolean {
	thresholdsFor(ctx);
	return automatic;
}

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
		// Resolve the active provider/model override from the public settings API.
		const model = ctx.model;
		const compaction = settingsManager.getCompactionSettings(model ? { provider: model.provider, id: model.id } : undefined);
		automatic = compaction.enabled;
		const derived = deriveThresholds(
			compaction.reserveTokens,
			mergePiContextSettings(settingsManager.getGlobalSettings(), settingsManager.getProjectSettings()),
		);
		for (const warning of derived.warnings) ctx.ui.notify(warning, "warning");
		cached = derived.thresholds;
	} catch (error) {
		ctx.ui.notify(`pi-context: could not read settings; using defaults (${String(error)}).`, "warning");
		cached = { reminder: DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS, reserve: DEFAULT_RESERVE_TOKENS, warning: DEFAULT_RESERVE_TOKENS + WARNING_RUNWAY_TOKENS };
	}
	return cached;
}

export function resetThresholds(): void {
	cached = undefined;
	automatic = true;
}
