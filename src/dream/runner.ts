import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createAgentSession, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseManifest, type Manifest } from "./manifest.js";

export type DreamerSession = Pick<AgentSession, "prompt" | "subscribe" | "dispose">;
export type DreamerSessionFactory = (options: { cwd: string; modelPattern?: string; tools: string[] }) => Promise<DreamerSession>;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "notes_read", "notes_list", "notes_search"];

export const defaultDreamerSessionFactory: DreamerSessionFactory = async ({ cwd, modelPattern, tools }) => {
	let model: Model<Api> | undefined;
	if (modelPattern) {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
		const result = await resolveModelScopeWithDiagnostics([modelPattern], runtime);
		model = result.scopedModels[0]?.model;
		if (!model) throw new Error(`dreamer model pattern "${modelPattern}" did not resolve to an available model`);
	}
	const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), tools, noTools: "all", model });
	return session;
};

export function runExternalDreamer(command: string, playbook: string, cwd: string): Manifest {
	const result = spawnSync(command, { shell: true, cwd, input: playbook, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(`dreamer failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
	return parseManifest(result.stdout);
}

export async function runDreamer(playbook: string, cwd: string, options: { command?: string; modelPattern?: string; sessionFactory?: DreamerSessionFactory } = {}): Promise<Manifest> {
	if (options.command) return runExternalDreamer(options.command, playbook, cwd);
	const session = await (options.sessionFactory ?? defaultDreamerSessionFactory)({ cwd, modelPattern: options.modelPattern, tools: READ_ONLY_TOOLS });
	let answer = "";
	let providerError: string | undefined;
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		if (event.message.stopReason === "error") { providerError = event.message.errorMessage ?? "unknown provider error"; return; }
		const content = event.message.content;
		answer = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
	});
	try {
		await session.prompt(`${playbook}\n\nReturn exactly one JSON manifest matching this schema: { merge?, promote?, trash?, pending?, skillCandidates?, report }.`);
		try {
			return parseManifest(answer);
		} catch (error) {
			if (providerError) throw new Error(`dreamer failed: ${providerError}`);
			throw error;
		}
	} finally {
		unsubscribe?.();
		session.dispose();
	}
}
export function loadPlaybook(path: string): string { return readFileSync(path, "utf8"); }
