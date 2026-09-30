import { PI_CONTEXT_DREAMER_KEY, PI_CONTEXT_SETTINGS_KEY, type PiContextSettings } from "../settings.js";

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
