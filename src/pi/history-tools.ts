import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historyWindows, historyList, historyRead, historySearch } from "../tools/history.js";
import { historyFromSession } from "./history.js";

export function registerHistoryTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		...historyWindows,
		async execute(_id, params, _signal, _update, ctx) {
			return historyWindows.execute(params, historyFromSession(ctx), ctx.sessionManager.getSessionId());
		},
	}));
	pi.registerTool(defineTool({
		...historyList,
		async execute(_id, params, _signal, _update, ctx) {
			return historyList.execute(params, historyFromSession(ctx));
		},
	}));
	pi.registerTool(defineTool({
		...historyRead,
		async execute(_id, params, _signal, _update, ctx) {
			return historyRead.execute(params, historyFromSession(ctx));
		},
	}));
	pi.registerTool(defineTool({
		...historySearch,
		async execute(_id, params, _signal, _update, ctx) {
			return historySearch.execute(params, historyFromSession(ctx));
		},
	}));
}
