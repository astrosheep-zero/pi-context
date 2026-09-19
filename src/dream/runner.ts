import { readFileSync } from "node:fs";
import { createAgentSession, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerMemoryTools } from "../memory/tools.js";

export type DreamWrite = { tool: "notes_write" | "notes_edit"; path?: string; scope?: string; stale?: boolean };
export type DreamResult = { report: string; writes: DreamWrite[] };
export type DreamerSession = Pick<AgentSession, "prompt" | "subscribe" | "dispose">;
export type DreamerSessionFactory = (options: { cwd: string; modelPattern?: string; tools: string[]; customTools?: ToolDefinition[] }) => Promise<DreamerSession>;
export const DREAMER_TOOLS = ["read", "grep", "find", "ls", "notes_read", "notes_list", "notes_search", "notes_write", "notes_edit"];

export function memoryToolDefinitions(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	registerMemoryTools({ registerTool(tool: ToolDefinition) { tools.push(tool); } } as any);
	return tools;
}

export const defaultDreamerSessionFactory: DreamerSessionFactory = async ({ cwd, modelPattern, tools, customTools = memoryToolDefinitions() }) => {
	let model: Model<Api> | undefined;
	if (modelPattern) {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
		const result = await resolveModelScopeWithDiagnostics([modelPattern], runtime);
		model = result.scopedModels[0]?.model;
		if (!model) throw new Error(`dreamer model pattern "${modelPattern}" did not resolve to an available model`);
	}
	const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), tools, customTools, noTools: "all", model, thinkingLevel: "off" });
	return session;
};

function textContent(content: unknown): string {
	return typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
}

export async function runDreamer(playbook: string, cwd: string, options: { modelPattern?: string; sessionFactory?: DreamerSessionFactory } = {}): Promise<DreamResult> {
	const session = await (options.sessionFactory ?? defaultDreamerSessionFactory)({ cwd, modelPattern: options.modelPattern, tools: DREAMER_TOOLS });
	let answer = "";
	let providerError: string | undefined;
	const writes: DreamWrite[] = [];
	const unsubscribe = session.subscribe((event: any) => {
		const tool = event.toolName ?? event.tool?.name;
		const args = event.args ?? event.arguments ?? event.tool?.arguments;
		if ((tool === "notes_write" || tool === "notes_edit") && args && typeof args === "object") writes.push({ tool, path: args.path, scope: args.scope, stale: args.stale });
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		if (event.message.stopReason === "error") { providerError = event.message.errorMessage ?? "unknown provider error"; return; }
		answer = textContent(event.message.content);
	});
	try {
		await session.prompt(playbook);
		if (providerError) throw new Error(`dreamer failed: ${providerError}`);
		return { report: answer, writes };
	} finally {
		unsubscribe?.();
		session.dispose();
	}
}

export function loadPlaybook(path: string): string { return readFileSync(path, "utf8"); }
