import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { PI_CONTEXT_DREAMER_KEY, PI_CONTEXT_SETTINGS_KEY } from "../protocol.js";
import { mergePiContextSettings, type PiContextSettings } from "../settings.js";

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
