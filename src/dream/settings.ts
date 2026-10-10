import { NOTESOUP_DREAMER_KEY, NOTESOUP_SETTINGS_KEY, type NotesoupSettings } from "../settings.js";

export type DreamerSetting = { pattern?: string; warnings: string[] };

/**
 * `notesoup.dreamer` is a non-empty model pattern. Anything else present is ignored
 * with one warning; absent means no configured pattern, so the automatic model applies.
 */
export function deriveDreamer(settings: NotesoupSettings): DreamerSetting {
	const raw = settings.dreamer;
	if (raw === undefined) return { warnings: [] };
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { warnings: [`notesoup: ${NOTESOUP_SETTINGS_KEY}.${NOTESOUP_DREAMER_KEY} must be a non-empty string; ignoring it.`] };
	}
	return { pattern: raw.trim(), warnings: [] };
}
