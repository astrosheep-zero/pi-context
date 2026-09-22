import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredCommand,
	SessionManager,
	SettingsManager,
	type SessionBoundaryDraft,
	type SessionBeforeCompactEvent,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import piContext, { createPiContext } from "../../src/index.js";
import { loadNotesSnapshot } from "../../src/notes/notes-snapshot.js";
import { renderBootBlock } from "../../src/context/prompts.js";
import { agentSlug, modelSlug } from "../../src/notes/paths.js";
import { rootWindowId } from "../../src/context/context-window.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../../src/tool-output.js";

let defaultCwd = "/private/tmp/pi-context-test-cwd";
let registerTempPath: ((path: string) => void) | undefined;

export type ExtensionTestEnvironment = {
	readonly cwd: string;
	readonly agentDir: string;
	beforeEach(): void;
	afterEach(): void;
	newNotesRoot(): string;
	dispose(): void;
};

/**
 * Install the process-level settings and notes roots needed by one test file.
 * The caller owns the lifecycle hooks; this helper never registers tests or hooks.
 */
export function installExtensionTestEnvironment(prefix = "pi-context-test"): ExtensionTestEnvironment {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousNotesHome = process.env.PI_NOTES_HOME;
	const defaultAgentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`));
	const cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
	defaultCwd = cwd;
	const notesRoots = new Set<string>();
	const tempPaths = new Set<string>();
	registerTempPath = (path: string): void => { tempPaths.add(path); };

	const newNotesRoot = (): string => {
		const root = mkdtempSync(join(tmpdir(), `${prefix}-notes-`));
		notesRoots.add(root);
		process.env.PI_NOTES_HOME = root;
		return root;
	};
	const beforeEach = (): void => {
		process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
		newNotesRoot();
	};
	const afterEach = (): void => {
		process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
		for (const root of notesRoots) rmSync(root, { recursive: true, force: true });
		notesRoots.clear();
		for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
		tempPaths.clear();
		if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesHome;
	};
	const dispose = (): void => {
		afterEach();
		for (const root of notesRoots) rmSync(root, { recursive: true, force: true });
		rmSync(defaultAgentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		registerTempPath = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesHome;
	};
	return { cwd, agentDir: defaultAgentDir, beforeEach, afterEach, newNotesRoot, dispose };
}

export type Notice = { message: string; type?: "info" | "warning" | "error" };

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

export type SettingsFixture = { cwd: string; agentDir: string };

/**
 * Materialize global (agentDir/settings.json) and project (cwd/.pi/settings.json)
 * settings in temp directories, then read them back through the same public
 * SettingsManager.create the extension uses. Never touches the real ~/.pi.
 */
export function settingsFixture(options: {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	reserveTokens?: number;
} = {}): SettingsFixture {
	const cwd = mkdtempSync(join(tmpdir(), "pi-context-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-agent-"));
	const global = { ...(options.global ?? {}) };
	if (options.reserveTokens !== undefined) global.compaction = { reserveTokens: options.reserveTokens };
	writeJson(join(agentDir, "settings.json"), global);
	if (options.project) writeJson(join(cwd, ".pi", "settings.json"), options.project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	registerTempPath?.(cwd);
	registerTempPath?.(agentDir);
	const fixtureManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const projectReserve = (options.project?.compaction as { reserveTokens?: number } | undefined)?.reserveTokens;
	assert.equal(fixtureManager.getCompactionSettings().reserveTokens, projectReserve ?? options.reserveTokens ?? 16_384, "fixture reserve reads back");
	return { cwd, agentDir };
}

export type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

type SendMessageArg = Parameters<ExtensionAPI["sendMessage"]>[0];

export type SentMessage = {
	message: SendMessageArg;
	options: { triggerTurn?: boolean } | undefined;
};

export type Captured = {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, EventHandler[]>;
	commands: Map<string, CommandOptions>;
	sent: SentMessage[];
	contextMessages: unknown[];
	flags: string[];
};

export type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export type CompactionHookResult =
	| { cancel: true }
	| { compaction: { summary: string; firstKeptEntryId: string | null; tokensBefore: number; details?: unknown } }
	| undefined;

/** TypeBox's TSchema does not expose `type`/`required` statically; read them structurally. */
export function objectSchema(tool: ToolDefinition | undefined): { type?: string; required?: string[] } | undefined {
	return tool?.parameters as { type?: string; required?: string[] } | undefined;
}

export function manager(persisted = false): SessionManager {
	if (!persisted) return SessionManager.inMemory("/private/tmp/pi-context-test");
	const dir = mkdtempSync(join(tmpdir(), "pi-context-session-"));
	return SessionManager.create("/private/tmp/pi-context-test", dir);
}

export function makeExtension(sessionManager: SessionManager, settingsManager?: SettingsManager): Captured {
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [], contextMessages: [], flags: [] };
	const api = {
		registerFlag(name: string) {
			captured.flags.push(name);
		},
		registerTool(tool: ToolDefinition) {
			captured.tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: CommandOptions) {
			captured.commands.set(name, options);
		},
		on(name: string, handler: EventHandler) {
			const handlers = captured.handlers.get(name) ?? [];
			handlers.push(handler);
			captured.handlers.set(name, handlers);
		},
		appendEntry(customType: string, data?: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage(message: SendMessageArg, options?: { triggerTurn?: boolean }) {
			captured.sent.push({ message, options });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	// The harness implements only the ExtensionAPI members this extension uses.
	(settingsManager ? createPiContext({ settingsManager }) : piContext)(api as unknown as ExtensionAPI);
	return captured;
}

export function explicitBoot(ctx: ExtensionContext, currentWindowId: string, previousWindowId: string | undefined): string {
	return renderBootBlock({
		agentName: agentSlug(ctx),
		modelName: modelSlug(ctx),
		firstWindowId: rootWindowId(ctx.sessionManager.getSessionId()),
		currentWindowId,
		previousWindowId,
		notes: loadNotesSnapshot(ctx),
	});
}

export function context(
	sessionManager: SessionManager,
	compact?: ExtensionContext["compact"],
	usage?: ContextUsage,
	idle = true,
	cwd = defaultCwd,
	projectTrusted = true,
	model?: string | { provider: string; id: string },
): ExtensionContext {
	const notices: Notice[] = [];
	const compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle" | "hasPendingMessages" | "cwd" | "isProjectTrusted" | "ui" | "model"> = {
		sessionManager,
		model: typeof model === "string" ? ({ id: model } as unknown as ExtensionContext["model"]) : model as ExtensionContext["model"] | undefined,
		getContextUsage: () => usage,
		compact: (options) => { compactionRequests.push(options); compact?.(options); },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) } as unknown as ExtensionContext["ui"],
	};
	// Only the members the extension reads; the rest of the ExtensionContext surface is unused.
	return Object.assign(fake as unknown as ExtensionContext, { notices, compactionRequests });
}

export function noticesOf(ctx: ExtensionContext): Notice[] {
	return (ctx as ExtensionContext & { notices: Notice[] }).notices;
}

export function sentOf(captured: Captured, customType: string): SentMessage[] {
	return captured.sent.filter((sent) => sent.message.customType === customType);
}

export async function call(
	captured: Captured,
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	// Most pre-redesign coverage names session notes by their bare address. Keep these old
	// fixture call sites readable while routing the direct tool invocation through its new
	// address-shaped input; contract-specific tests below pass address themselves.
	const noteCall = name === "notes_write" || name === "notes_edit" || name === "notes_read";
	if (noteCall && "path" in params && !("address" in params)) {
		const { path, scope, ...rest } = params;
		assert.equal(typeof path, "string", "legacy note fixture path is a string");
		const address = scope === "project" ? `@project/${path}` : scope === "human" ? `@human/${path}` : path;
		return tool.execute("call-1", { ...rest, address }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	if ((name === "notes_list" || name === "notes_search") && params.scope === "human") {
		const { scope: _scope, pattern, ...rest } = params;
		return tool.execute("call-1", { ...rest, pattern: `@human/${typeof pattern === "string" ? pattern : "**"}` }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	if ((name === "notes_list" || name === "notes_search") && params.scope === "session") {
		const { scope: _scope, pattern, ...rest } = params;
		return tool.execute("call-1", { ...rest, pattern: typeof pattern === "string" ? pattern : "*.md" }, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
	}
	return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx) as Promise<AgentToolResult<unknown>>;
}

export function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "tool result carries text");
	const value = JSON.parse(text.text) as Record<string, unknown>;
	const suffix = (address: string) => address.startsWith("@project/") ? address.slice("@project/".length) : address.startsWith("@human/") ? address.slice("@human/".length) : address;
	const legacyPath = (row: Record<string, unknown>) => {
		if (typeof row.address === "string" && row.path === undefined) Object.defineProperty(row, "path", { value: suffix(row.address), enumerable: false });
	};
	legacyPath(value);
	if (Array.isArray(value.files)) for (const file of value.files) if (file && typeof file === "object") legacyPath(file as Record<string, unknown>);
	return value as T;
}

/** Assert the delivered wire text fits the tool-output budget, header included for raw reads. */
export function assertWithinBudget(result: AgentToolResult<unknown>, message: string): void {
	const text = result.content[0];
	const bytes = text && text.type === "text" ? Buffer.byteLength(text.text, "utf8") : 0;
	assert.ok(bytes <= TOOL_OUTPUT_MAX_BYTES, `${message}: ${bytes} bytes over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
}

/** Decoded raw read response using the shared READ WINDOW grammar. */
export type ReadWindow = {
	header: string;
	content: string;
	offset_chars: number;
	total_chars: number;
	next_offset_chars: number | null;
	details: Record<string, unknown>;
};

/** Decode either raw read without including its shared metadata block in the payload. */
export function resultRead(result: AgentToolResult<unknown>): ReadWindow {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "read result carries text");
	const block = /^(--- READ WINDOW ---\n(?:[a-z_]+: [^\n]*\n)+chars: \[(\d+),(\d+)\) of (\d+)\nnext_offset_chars: (null|\d+)\n)\n/.exec(text.text);
	assert.ok(block, "raw read carries one READ WINDOW block followed by exactly one blank line");
	const header = block[1]!;
	const content = text.text.slice(block[0].length);
	const offset_chars = Number(block[2]);
	const end = Number(block[3]);
	const total_chars = Number(block[4]);
	const next_offset_chars = block[5] === "null" ? null : Number(block[5]);
	assert.equal(Array.from(content).length, end - offset_chars, "READ WINDOW range matches the delivered payload");
	return { header, content, offset_chars, total_chars, next_offset_chars, details: (result.details ?? {}) as Record<string, unknown> };
}

/**
 * Assert a value is a local-time ISO 8601 string with an explicit numeric offset (never "Z")
 * and that Date.parse restores the stored epoch milliseconds. No time zone is assumed.
 */
export function assertLocalIso(value: unknown, epochMs: number, message: string): void {
	assert.equal(typeof value, "string", message);
	assert.match(value as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, message);
	assert.equal(Date.parse(value as string), epochMs, `${message}: Date.parse restores the stored epoch ms`);
}

/** Assert the text contains a well-formed local ISO timestamp and return it, without pinning surrounding wording. */
export function assertIsoTimestamp(text: string, message: string): string {
	const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
	assert.ok(match, message);
	assert.equal(Number.isNaN(Date.parse(match[0])), false, `${message}: timestamp parses`);
	return match[0];
}

/** Assert `actual` is a middle-truncation of `original`: same head, same tail, strictly fewer characters. */
export function assertTruncationOf(original: string, actual: string): void {
	const match = actual.match(/^([\s\S]*)…\[truncated \d+ chars\]…([\s\S]*)$/);
	assert.ok(match, "truncated value carries the middle-truncation marker");
	const head = match[1] as string;
	const tail = match[2] as string;
	assert.ok(original.startsWith(head), "truncation keeps the original head");
	assert.ok(original.endsWith(tail), "truncation keeps the original tail");
	assert.ok(head.length + tail.length < original.length, "truncation actually removes characters");
}

export async function runManualCompact(captured: Captured, ctx: ExtensionContext): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler, "session_before_compact handler registered");
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: ctx.sessionManager.getBranch(),
		preparation: {
			firstKeptEntryId: "",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 0,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
		},
	};
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

export function runHandlers(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): void {
	const isIdle = ctx.isIdle;
	if (name === "agent_settled") ctx.isIdle = () => true;
	try {
		for (const handler of captured.handlers.get(name) ?? []) handler(event as never, ctx);
	} finally { ctx.isIdle = isIdle; }
}

export async function runHandlersAsync(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of captured.handlers.get(name) ?? []) results.push(await handler(event as never, ctx));
	return results;
}

export function completeRequestedCompaction(ctx: ExtensionContext): void {
	const requests = (ctx as ExtensionContext & { compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> }).compactionRequests;
	const options = requests.shift();
	assert.ok(options?.onComplete, "a reset request has a completion callback");
	const isIdle = ctx.isIdle;
	ctx.isIdle = () => true;
	try { options.onComplete({} as Parameters<NonNullable<typeof options.onComplete>>[0]); }
	finally { ctx.isIdle = isIdle; }
}

export async function runCommand(captured: Captured, name: string, args: string, ctx: ExtensionContext): Promise<Notice[]> {
	const command = captured.commands.get(name);
	assert.ok(command, `${name} command registered`);
	const notices: Notice[] = [];
	const cmdCtx = Object.assign({}, ctx, {
		waitForIdle: async () => {},
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) },
	}) as unknown as ExtensionCommandContext;
	await command.handler(args, cmdCtx);
	return notices;
}

export type ContextHookResult = { messages: unknown[] } | undefined;

export async function runContextHook(captured: Captured, ctx: ExtensionContext, eventOverride: Record<string, unknown> = {}): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context") ?? [];
	assert.ok(handlers.length > 0, "context handler registered");
	// Pi invokes every registered context handler in order; budget and warning each own one.
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context", messages: [], ...eventOverride } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

export async function runContextWithSystemHook(
	captured: Captured,
	ctx: ExtensionContext,
	messages: unknown[],
): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context_with_system") ?? [];
	assert.ok(handlers.length > 0, "context_with_system handler registered");
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context_with_system", messages } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

export async function commitTurnEndBoundary(captured: Captured, sessionManager: SessionManager, ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean }> {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	const event: TurnEndEvent = {
		type: "turn_end",
		entries,
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		turnIndex: 0,
		message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as unknown as AgentMessage,
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
	};
	for (const handler of captured.handlers.get("turn_end") ?? []) {
		event.entries = entries;
		const result = (await handler(event as never, ctx)) as { entries?: SessionBoundaryDraft[]; continue?: boolean } | undefined;
		if (result?.entries !== undefined) entries = result.entries;
		if (result?.continue !== undefined) shouldContinue = result.continue;
	}
	for (const entry of entries) {
		switch (entry.type) {
			case "custom":
				sessionManager.appendCustomEntry(entry.customType, entry.data);
				break;
			case "custom_message":
				sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
				break;
			case "compaction":
				sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage);
				break;
			case "context_edit":
				sessionManager.appendContextEdit(entry.targetId, entry.replacement);
				break;
		}
	}
	return { entries, continue: shouldContinue };
}

export function appendText(sessionManager: SessionManager, role: "user" | "assistant" | "toolResult", text: string, toolName = "bash"): string {
	const base = {
		role,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		...(role === "assistant" ? { stopReason: "stop" } : {}),
		...(role === "toolResult" ? { toolCallId: "call-1", toolName, isError: false } : {}),
	};
	// Assistant/toolResult messages carry provider metadata (usage, stopReason, ids)
	// that SessionManager persists opaquely and the extension never reads, so the
	// harness stores the minimal shape.
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage(base as unknown as AppendableMessage);
}
