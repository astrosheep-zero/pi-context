import { PI_CONTEXT_SETTINGS_KEY } from "./protocol.js";

export type PiContextSettings = { reminderMarginTokens?: unknown; dreamer?: unknown };

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
