export const NOTESOUP_SETTINGS_KEY = "notesoup";
/** Nested under "notesoup": the default dreamer model pattern, overridden by CLI --dreamer. */
export const NOTESOUP_DREAMER_KEY = "dreamer";

export type NotesoupSettings = { reminderMarginTokens?: unknown; dreamer?: unknown };

function isSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the raw "notesoup" object from one parsed settings scope. */
function notesoupSettings(settings: unknown): Record<string, unknown> {
	if (!isSettingsObject(settings)) return {};
	const value = settings[NOTESOUP_SETTINGS_KEY];
	return isSettingsObject(value) ? value : {};
}

/** Merge the global and project "notesoup" objects per key; project wins, mirroring Pi's deep merge. */
export function mergeNotesoupSettings(globalSettings: unknown, projectSettings: unknown): NotesoupSettings {
	const merged = { ...notesoupSettings(globalSettings), ...notesoupSettings(projectSettings) };
	return { reminderMarginTokens: merged.reminderMarginTokens, dreamer: merged.dreamer };
}
