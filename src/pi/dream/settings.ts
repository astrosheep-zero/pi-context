import { deriveDreamer, type DreamerSetting } from "../../dream/settings.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mergePiContextSettings } from "../../settings.js";

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
