import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createAgentSession, createEditToolDefinition, createWriteToolDefinition, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { contentText } from "../history/history.js";
import { parseNote } from "../notes/frontmatter.js";

export type DreamWrite = { tool: "write" | "edit" | "delete"; path: string };
export type DreamResult = { report: string; writes: DreamWrite[]; error?: string };
export type DreamerSession = Pick<AgentSession, "prompt" | "subscribe" | "dispose">;
export type DreamerSessionFactory = (options: { cwd: string; modelPattern?: string; tools: string[] }) => Promise<DreamerSession>;
export const DREAMER_TOOLS = ["read", "grep", "find", "ls", "write", "edit"];

function isOutside(notesHome: string, target: string): boolean {
	const fromHome = relative(notesHome, target);
	return fromHome === ".." || fromHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromHome);
}

async function jailWritePath(notesHome: string, path: string, options: { createParent?: boolean } = {}): Promise<string> {
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
	// delete passes createParent:false: the parent must already exist for there to be anything to remove.
	if (options.createParent !== false) await mkdir(targetParent, { recursive: true });
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
	return target;
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

/** The dream session's custom definitions: jailed versions of the two write built-ins, plus the jailed delete below. */
export function dreamerWriteToolDefinitions(notesHome: string): ToolDefinition<any, any, any>[] {
	return [
		jailToolDefinition(createWriteToolDefinition(notesHome), notesHome),
		jailToolDefinition(createEditToolDefinition(notesHome), notesHome),
	];
}

const DELETE_PARAMETERS = Type.Object({ path: Type.String({ description: "Path of the crumpled note file, relative to the notes home." }) }, { additionalProperties: false });

/**
 * The dreamer's physical delete, jailed like the writes and restricted to crumpled notes: the
 * playbook's wastebasket rule is the only legitimate target, so a live note refuses here even
 * before policy is consulted. The time window itself stays playbook policy, not tool law.
 */
export function dreamerDeleteToolDefinition(notesHome: string): ToolDefinition<any, any, any> {
	return {
		name: "delete",
		label: "delete",
		description: "Physically delete one crumpled note file inside the notes home. Reserved for the playbook's wastebasket rule: a crumpled note whose full retention window has passed. Live notes refuse. Deletion is permanent beyond the Git audit.",
		parameters: DELETE_PARAMETERS,
		async execute(_toolCallId: string, params: { path: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
			const target = await jailWritePath(notesHome, params.path, { createParent: false });
			let raw: string;
			try {
				raw = await readFile(target, "utf8");
			} catch (error: any) {
				throw new Error(`delete: cannot read ${params.path} in notes home: ${error.message}`);
			}
			if (parseNote(raw).meta.crumpledAt === undefined) throw new Error(`delete: ${params.path} is not a crumpled note; only the wastebasket rule permits deletion`);
			await unlink(target);
			return { content: [{ type: "text", text: `deleted ${params.path}` }], details: undefined };
		},
	};
}

export const defaultDreamerSessionFactory: DreamerSessionFactory = async ({ cwd, modelPattern, tools }) => {
	let model: Model<Api> | undefined;
	if (modelPattern) {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
		const result = await resolveModelScopeWithDiagnostics([modelPattern], runtime);
		model = result.scopedModels[0]?.model;
		if (!model) throw new Error(`dreamer model pattern "${modelPattern}" did not resolve to an available model`);
	}
	const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), tools, customTools: [...dreamerWriteToolDefinitions(cwd), dreamerDeleteToolDefinition(cwd)], noTools: "all", model, thinkingLevel: "off" });
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
		if ((tool === "write" || tool === "edit" || tool === "delete") && args && typeof args === "object" && typeof args.path === "string") writes.push({ tool, path: args.path });
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
