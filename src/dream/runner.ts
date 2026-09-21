import { readFileSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createAgentSession, createEditToolDefinition, createWriteToolDefinition, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { contentText } from "../history.js";

export type DreamWrite = { tool: "write" | "edit"; path: string };
export type DreamResult = { report: string; writes: DreamWrite[]; error?: string };
export type DreamerSession = Pick<AgentSession, "prompt" | "subscribe" | "dispose">;
export type DreamerSessionFactory = (options: { cwd: string; modelPattern?: string; tools: string[] }) => Promise<DreamerSession>;
export const DREAMER_TOOLS = ["read", "grep", "find", "ls", "write", "edit"];

function isOutside(notesHome: string, target: string): boolean {
	const fromHome = relative(notesHome, target);
	return fromHome === ".." || fromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromHome);
}

async function jailWritePath(notesHome: string, path: string): Promise<void> {
	let realNotesHome: string;
	try {
		realNotesHome = await realpath(notesHome);
	} catch {
		throw new Error(`write jail: cannot resolve notes home ${notesHome}`);
	}
	const target = resolve(realNotesHome, path);
	const targetParent = dirname(target);
	if (isOutside(realNotesHome, targetParent)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	// write creates parent directories itself. Create only after the lexical check, then
	// canonicalize the parent so a symlink cannot lead the underlying tool out of home.
	await mkdir(targetParent, { recursive: true });
	let realTargetParent: string;
	try {
		realTargetParent = await realpath(targetParent);
	} catch {
		throw new Error(`write jail: cannot resolve target parent in notes home ${notesHome}`);
	}
	if (isOutside(realNotesHome, realTargetParent)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	let targetStats;
	try {
		targetStats = await lstat(target);
	} catch (error: any) {
		if (error.code !== "ENOENT") throw new Error(`write jail: cannot inspect target in notes home ${notesHome}`);
	}
	if (targetStats?.isSymbolicLink()) {
		let realTarget: string;
		try {
			realTarget = await realpath(target);
		} catch {
			throw new Error(`write jail: cannot resolve target in notes home ${notesHome}`);
		}
		if (isOutside(realNotesHome, realTarget)) throw new Error(`write jail: ${path} is outside notes home ${notesHome}`);
	}
	if (targetStats && targetStats.nlink > 1) throw new Error(`write jail: ${path} has hard links and is not allowed in notes home ${notesHome}`);
}

function jailToolDefinition<T extends ToolDefinition<any, any, any>>(definition: T, notesHome: string): T {
	const execute = definition.execute;
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			await jailWritePath(notesHome, (params as { path: string }).path);
			return execute(toolCallId, params, signal, onUpdate, ctx);
		},
	} as T;
}

/** The only custom definitions in the dream session replace the two built-ins with jailed versions. */
export function dreamerWriteToolDefinitions(notesHome: string): ToolDefinition<any, any, any>[] {
	return [
		jailToolDefinition(createWriteToolDefinition(notesHome), notesHome),
		jailToolDefinition(createEditToolDefinition(notesHome), notesHome),
	];
}

export const defaultDreamerSessionFactory: DreamerSessionFactory = async ({ cwd, modelPattern, tools }) => {
	let model: Model<Api> | undefined;
	if (modelPattern) {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
		const result = await resolveModelScopeWithDiagnostics([modelPattern], runtime);
		model = result.scopedModels[0]?.model;
		if (!model) throw new Error(`dreamer model pattern "${modelPattern}" did not resolve to an available model`);
	}
	const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), tools, customTools: dreamerWriteToolDefinitions(cwd), noTools: "all", model, thinkingLevel: "off" });
	return session;
};

/**
 * Run one dream turn. A dreamer failure is returned as `error` together with the partial
 * writes observed so far, so the caller can record partial state instead of losing it;
 * only a failure to even start the session throws.
 */
export async function runDreamer(playbook: string, cwd: string, options: { modelPattern?: string; sessionFactory?: DreamerSessionFactory } = {}): Promise<DreamResult> {
	const session = await (options.sessionFactory ?? defaultDreamerSessionFactory)({ cwd, modelPattern: options.modelPattern, tools: DREAMER_TOOLS });
	let answer = "";
	let providerError: string | undefined;
	const writes: DreamWrite[] = [];
	const unsubscribe = session.subscribe((event: any) => {
		const tool = event.toolName ?? event.tool?.name;
		const args = event.args ?? event.arguments ?? event.tool?.arguments;
		if ((tool === "write" || tool === "edit") && args && typeof args === "object" && typeof args.path === "string") writes.push({ tool, path: args.path });
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		if (event.message.stopReason === "error") { providerError = event.message.errorMessage ?? "unknown provider error"; return; }
		answer = contentText(event.message.content);
	});
	try {
		try {
			await session.prompt(playbook);
		} catch (error) {
			return { report: answer, writes, error: error instanceof Error ? error.message : String(error) };
		}
		if (providerError) return { report: answer, writes, error: `dreamer failed: ${providerError}` };
		return { report: answer, writes };
	} finally {
		unsubscribe?.();
		session.dispose();
	}
}

export function loadPlaybook(path: string): string { return readFileSync(path, "utf8"); }
