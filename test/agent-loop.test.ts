import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentContext } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import piContext, { createPiContext } from "../src/index.js";
import { BOOT_TYPE, CONTEXT_WINDOW_OPEN_TAG, CONTINUATION, CONTINUATION_TYPE, GUIDANCE_OPEN_TAG, GUIDANCE_TYPE, RESET_MARKER_TYPE, WARNING_TYPE } from "../src/protocol.js";

type StreamScript = (request: number, context: AgentContext) => AssistantMessage;
type Hook = (pi: ExtensionAPI, getSession: () => AgentSession, requests: AgentContext[]) => void;

type Fixture = {
	dir: string;
	notesRoot: string;
	sessionManager: SessionManager;
	session: AgentSession;
	model: Awaited<ReturnType<ModelRuntime["getModels"]>>[number];
	requests: AgentContext[];
	streamContexts: AgentContext[];
	streamSignals: boolean[];
	events: Array<{ type: string; [key: string]: unknown }>;
	notices: string[];
	budgetNotices: () => number;
	close: () => void;
};

async function openFixture(options: {
	compactionEnabled?: boolean;
	keepRecentTokens?: number;
	contextWindow?: number;
	notesRootFile?: boolean;
	systemPrompt?: string;
	tools?: string[];
	cwd?: string;
	agentDir?: string;
	notesRoot?: string;
	writeSettings?: boolean;
	defaultCompactionEnabled?: boolean;
	defaultReserveTokens?: number;
	projectSettings?: Record<string, unknown>;
	settingsManager?: SettingsManager | ((model: Fixture["model"]) => SettingsManager);
	manageEnvironment?: boolean;
	projectTrusted?: boolean;
	seed?: (sessionManager: SessionManager) => void;
	script: StreamScript;
	hook?: Hook;
}): Promise<Fixture> {
	const dir = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-context-agent-loop-"));
	const ownsDir = options.cwd === undefined;
	const notesRoot = options.notesRoot ?? mkdtempSync(join(tmpdir(), "pi-context-agent-loop-notes-"));
	const ownsNotesRoot = options.notesRoot === undefined;
	const agentDir = options.agentDir ?? dir;
	const managesEnvironment = options.manageEnvironment ?? true;
	const previousDir = managesEnvironment ? process.env.PI_CODING_AGENT_DIR : undefined;
	const previousNotesRoot = managesEnvironment ? process.env.PI_NOTES_HOME : undefined;
	if (managesEnvironment) {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_NOTES_HOME = notesRoot;
	}
	if (options.notesRootFile) {
		rmSync(notesRoot, { recursive: true, force: true });
		writeFileSync(notesRoot, "blocked notes root");
	}
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models"),
		refreshOnCreate: false,
	});
	await runtime.setRuntimeApiKey("openai", "scripted-test-key");
	const base = runtime.getModels("openai")[0];
	assert.ok(base, "the installed SDK exposes a scripted model");
	const model = { ...base, contextWindow: options.contextWindow ?? 100_000, maxTokens: 4096 };
	runtime.stream = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.stream;
	runtime.complete = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.complete;
	runtime.streamSimple = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.streamSimple;
	runtime.completeSimple = (() => { throw new Error("unexpected native model request"); }) as typeof runtime.completeSimple;
	if (options.writeSettings !== false) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: {
			enabled: options.defaultCompactionEnabled ?? options.compactionEnabled ?? true,
			reserveTokens: options.defaultReserveTokens ?? 32_768,
			keepRecentTokens: options.keepRecentTokens ?? 200,
		},
		retry: { enabled: false },
	}));
	if (options.projectSettings !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
	}
	const settingsManager = typeof options.settingsManager === "function"
		? options.settingsManager(model)
		: options.settingsManager ?? SettingsManager.create(dir, agentDir, { projectTrusted: options.projectTrusted ?? true });
	const requests: AgentContext[] = [];
	const streamContexts: AgentContext[] = [];
	const streamSignals: boolean[] = [];
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const notices: string[] = [];
	let budgetNotices = 0;
	let session!: AgentSession;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		systemPromptOverride: () => options.systemPrompt ?? "Use the tools as requested.",
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [options.settingsManager ? createPiContext({ settingsManager }) : piContext, (pi) => {
		options.hook?.(pi, () => session, requests);
	}],
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(dir);
	options.seed?.(sessionManager);
	const created = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime: runtime,
		model,
		settingsManager,
		sessionManager,
		resourceLoader: loader,
		tools: options.tools ?? ["wipe_memory", "notes_write", "get_context_remaining"],
	});
	session = created.session;
	session.subscribe((event) => events.push(event as unknown as { type: string; [key: string]: unknown }));
	session.agent.streamFunction = (_model, context, streamOptions) => {
		const aborted = streamOptions?.signal?.aborted === true;
		streamContexts.push(context);
		streamSignals.push(aborted);
		if (aborted) {
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [],
				stopReason: "aborted",
				errorMessage: "scripted request aborted",
				timestamp: Date.now(),
				usage: usage(0, 0),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end();
			return stream;
		}
		requests.push(context);
		const request = requests.length;
		const message = options.script(request, context);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: (message.stopReason === "error" || message.stopReason === "aborted" ? "stop" : message.stopReason) as "stop" | "toolUse" | "length" | "deferred", message });
		stream.end();
		return stream;
	};
	await session.bindExtensions({
		uiContext: {
			notify(message: string, type?: "info" | "warning" | "error") {
				if (message.startsWith("pi-context: memory cleared · ")) {
					const windowId = message.split(" · ")[1];
					assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE && (entry.data as { windowId?: string })?.windowId === windowId), "notification follows the reset marker commit");
					assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && (entry.details as { windowId?: string })?.windowId === windowId), "notification follows the reset boot commit");
				}
				if (type === "warning" && sessionManager.getBranch().some((entry) => entry.type === "custom_message" && (entry.customType === GUIDANCE_TYPE || entry.customType === WARNING_TYPE))) budgetNotices++;
				notices.push(message);
			},
		} as ExtensionUIContext,
	});
	return {
		dir,
		notesRoot,
		sessionManager,
		session,
		model,
		requests,
		streamContexts,
		streamSignals,
		events,
		notices,
		budgetNotices: () => budgetNotices,
		close: () => {
			session.dispose();
			if (managesEnvironment) {
				if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousDir;
				if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
				else process.env.PI_NOTES_HOME = previousNotesRoot;
			}
			if (ownsDir) rmSync(dir, { recursive: true, force: true });
			if (ownsNotesRoot) rmSync(notesRoot, { recursive: true, force: true });
		},
	};
}

function usage(input: number, output = 1) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(fixture: Fixture, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: fixture.model.api,
		provider: fixture.model.provider,
		model: fixture.model.id,
		content,
		stopReason,
		timestamp: Date.now(),
		usage: usage(100),
		...extra,
	};
}

function text(message: AgentContext | undefined): string {
	return JSON.stringify(message?.messages ?? []);
}

function resetMarkers(fixture: Fixture) {
	return fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
}

function contextRemainingResults(fixture: Fixture): Array<number | null> {
	const results: Array<number | null> = [];
	for (const entry of fixture.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "get_context_remaining") continue;
		const content = (entry.message.content as Array<{ type?: string; text?: string }>).find((part) => part.type === "text")?.text;
		if (content === undefined) continue;
		const value = JSON.parse(content) as { remaining_tokens?: unknown };
		if (typeof value.remaining_tokens === "number" || value.remaining_tokens === null) results.push(value.remaining_tokens);
	}
	return results;
}

function assertFreshRequest(fixture: Fixture, requestIndex: number, oldSentinel: string): void {
	const body = text(fixture.requests[requestIndex]);
	assert.equal(body.includes(oldSentinel), false, "the new provider request excludes the old window transcript");
	assert.ok(body.includes(CONTEXT_WINDOW_OPEN_TAG), "the new provider request includes the fresh context-window boot");
	assert.equal(body.split(CONTINUATION).length - 1, 1, "the fresh window carries exactly one reset message");
}

test("real AgentSession: aborted low-budget requests notify only after a retry commits the reminder", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: (request) => assistant(fixture, [{ type: "text", text: `response ${request}` }], request === 2 ? "aborted" : "stop", { usage: usage(50_000) }),
	});
	try {
		const reminders = () => fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE);
		const notices = () => fixture.budgetNotices();
		await fixture.session.prompt("Establish usage below the reminder line.");
		await fixture.session.waitForIdle();
		assert.equal(reminders().length, 0);
		await fixture.session.prompt("Abort this low-budget request.");
		await fixture.session.waitForIdle();
		assert.equal(reminders().length, 0, "an aborted turn does not commit its reminder");
		assert.equal(notices(), 0, "an uncommitted reminder never notifies");
		await fixture.session.prompt("Retry successfully.");
		await fixture.session.waitForIdle();
		assert.equal(reminders().length, 1);
		assert.equal(notices(), 1, "the committed retry notifies once");
		await fixture.session.prompt("Continue in the same window.");
		await fixture.session.waitForIdle();
		assert.equal(reminders().length, 1);
		assert.equal(notices(), 1, "later turns cannot repeat the notice");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: explicit tiny-session wipe ignores keepRecentTokens and preserves raw history", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		keepRecentTokens: 1_000_000,
		script: (request, context) => request === 1
			? assistant(fixture, [{ type: "toolCall", id: "wipe-1", name: "wipe_memory", arguments: {} }], "toolUse")
			: assistant(fixture, [{ type: "text", text: "resumed in a new window" }]),
	});
	try {
		assert.equal(fixture.requests.length, 0, "startup boot does not trigger a model request");
		assert.equal(fixture.notices.length, 0, "startup boot is silent");
		await fixture.session.prompt("OLD_CONTEXT_SENTINEL: retain this only in durable history.");
		await fixture.session.waitForIdle();
		assert.equal(fixture.notices.filter((message) => message.includes("memory cleared")).length, 1, "the reset notifies once");
		assert.equal(fixture.requests.length, 2, "the tool starts exactly one continuation");
		assert.ok(text(fixture.requests[0]).includes("OLD_CONTEXT_SENTINEL"));
		assertFreshRequest(fixture, 1, "OLD_CONTEXT_SENTINEL");
		assert.equal(resetMarkers(fixture).length, 1, "explicit wipe does not depend on Pi's compaction keep window");
		const marker = resetMarkers(fixture)[0]!;
		assert.equal(marker.type, "custom");
		assert.deepEqual(Object.keys(marker.data as object), ["windowId"]);
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message", "the reset boot is persisted after the marker");
		assert.equal((boot.details as { windowId: string }).windowId, windowId);
		assert.equal(fixture.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0, "the explicit path does not manufacture a native compaction");
		assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes("OLD_CONTEXT_SENTINEL"), "raw history remains readable");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: a reset survives all notes-home read failures with an incomplete boot", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		notesRootFile: true,
		script: (request) => request === 1
			? assistant(fixture, [{ type: "toolCall", id: "wipe-notes-failure", name: "wipe_memory", arguments: {} }], "toolUse")
			: assistant(fixture, [{ type: "text", text: "resumed despite notes failure" }]),
	});
	try {
		await fixture.session.prompt("NOTES_FAILURE_RESET_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 2, "the failed notes index does not cancel the continuation");
		assertFreshRequest(fixture, 1, "NOTES_FAILURE_RESET_SENTINEL");
		assert.equal(resetMarkers(fixture).length, 1, "one reset marker is committed");
		const marker = resetMarkers(fixture)[0]!;
		assert.equal(marker.type, "custom");
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message");
		const bootText = typeof boot.content === "string" ? boot.content : JSON.stringify(boot.content);
		assert.ok(bootText.includes("Notes index incomplete"));
		assert.ok(bootText.includes("notes_list can retry after recovery"));
		assert.ok(bootText.includes("<context_window_protocol>"));
	} finally {
		fixture.close();
	}
});

test("real AgentSession: reset projection drops legacy message shapes but keeps raw history and equal/backwards new timestamps", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	const legacyTimestamp = Date.now();
	const legacyTexts = [
		"OLD_BASH_EXECUTION",
		"OLD_TOOL_RESULT",
		"OLD_COMPACTION_SUMMARY_WRAPPER",
		"OLD_BRANCH_SUMMARY",
	];
	fixture = await openFixture({
		compactionEnabled: false,
		seed: (sessionManager) => {
			type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "OLD_USER_BEFORE_LEGACY_ENTRIES" }], timestamp: legacyTimestamp } as unknown as AppendableMessage);
			sessionManager.appendMessage({ role: "bashExecution", command: legacyTexts[0], output: legacyTexts[0], exitCode: 0, cancelled: false, truncated: false, timestamp: legacyTimestamp } as unknown as AppendableMessage);
			sessionManager.appendMessage({ role: "toolResult", content: [{ type: "text", text: legacyTexts[1] }], toolCallId: "legacy-tool", toolName: "bash", isError: false, timestamp: legacyTimestamp } as unknown as AppendableMessage);
			const compactionParent = sessionManager.getLeafId();
			sessionManager.appendCompaction(legacyTexts[2], compactionParent, 123, { legacy: true }, true);
			sessionManager.branchWithSummary(sessionManager.getLeafId(), legacyTexts[3], { legacy: true }, true);
		},
		script: (request, context) => {
			if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "wipe-legacy", name: "wipe_memory", arguments: {} }], "toolUse");
			if (request === 2) {
				const body = text(context);
				for (const legacy of legacyTexts) assert.equal(body.includes(legacy), false, `${legacy} is cut from the reset projection`);
				return assistant(fixture, [{ type: "toolCall", id: "new-timestamp", name: "notes_write", arguments: { address: "equal-timestamp.md", content: "NEW_EQUAL_BACKWARDS_MESSAGE" } }], "toolUse", { timestamp: legacyTimestamp - 1 });
			}
			const body = text(context);
			for (const legacy of legacyTexts) assert.equal(body.includes(legacy), false, `${legacy} stays absent after another fresh-window turn`);
			assert.ok(body.includes("NEW_EQUAL_BACKWARDS_MESSAGE"), "a new message with an equal/backwards timestamp survives the projection");
			const newAssistant = context.messages.find((message) => message.role === "assistant" && JSON.stringify(message).includes("NEW_EQUAL_BACKWARDS_MESSAGE"));
			assert.equal(newAssistant?.timestamp, legacyTimestamp - 1, "projection preserves the new message timestamp");
			return assistant(fixture, [{ type: "text", text: "legacy projection clean" }]);
		},
	});
	try {
		await fixture.session.prompt("NEW_WINDOW_PROJECTION_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 3, "the fresh window accepts one additional new-window tool turn");
		assert.equal(resetMarkers(fixture).length, 1);
		const raw = JSON.stringify(fixture.sessionManager.getBranch());
		for (const legacy of legacyTexts) assert.ok(raw.includes(legacy), `${legacy} remains in durable raw history`);
	} finally {
		fixture.close();
	}
});

test("real AgentSession: successive resets and a mixed tool batch cut only after every tool result", async () => {
	for (const scenario of ["successive", "mixed"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: false,
			script: (request) => {
				if (scenario === "successive" && request < 3) return assistant(fixture, [{ type: "toolCall", id: `wipe-${request}`, name: "wipe_memory", arguments: {} }], "toolUse");
				if (scenario === "mixed" && request === 1) return assistant(fixture, [
					{ type: "toolCall", id: "wipe-1", name: "wipe_memory", arguments: {} },
					{ type: "toolCall", id: "note-1", name: "notes_write", arguments: { address: "batch.md", content: "MIXED_BATCH_NOTE" } },
				], "toolUse");
				return assistant(fixture, [{ type: "text", text: "fresh completion" }]);
			},
		});
		try {
			await fixture.session.prompt(`OLD_${scenario.toUpperCase()}_SENTINEL`);
			await fixture.session.waitForIdle();
			const expected = scenario === "successive" ? 2 : 1;
			assert.equal(resetMarkers(fixture).length, expected);
			assert.equal(fixture.requests.length, expected + 1);
			assertFreshRequest(fixture, fixture.requests.length - 1, `OLD_${scenario.toUpperCase()}_SENTINEL`);
			if (scenario === "mixed") {
				const branch = fixture.sessionManager.getBranch();
				const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === RESET_MARKER_TYPE);
				assert.ok(markerIndex > 0, "the marker follows the completed tool batch");
				assert.ok(branch.slice(0, markerIndex).some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write"), "notes_write completes before the cut");
				assert.ok(existsSync(join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "batch.md")));
			}
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: steering and follow-up are delivered exactly once in the fresh window", async () => {
	for (const deliverAs of ["steer", "followUp"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: false,
			hook: (pi, getSession) => {
				pi.on("tool_call", async (event) => {
					if ((event as { toolName?: string }).toolName !== "wipe_memory") return;
					if (deliverAs === "steer") await getSession().steer("QUEUED_ONCE");
					else await getSession().followUp("QUEUED_ONCE");
				});
			},
			script: (request) => request === 1
				? assistant(fixture, [{ type: "toolCall", id: "wipe-queue", name: "wipe_memory", arguments: {} }], "toolUse")
				: assistant(fixture, [{ type: "text", text: "queued message handled" }]),
		});
		try {
			await fixture.session.prompt(`OLD_${deliverAs}_SENTINEL`);
			await fixture.session.waitForIdle();
			assert.equal(fixture.requests.length, 2, `${deliverAs} does not duplicate the resumed request`);
			assertFreshRequest(fixture, 1, `OLD_${deliverAs}_SENTINEL`);
			assert.equal(text(fixture.requests[1]).split("QUEUED_ONCE").length - 1, 1, `${deliverAs} arrives once in the new window`);
			const queued = fixture.sessionManager.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("QUEUED_ONCE"));
			assert.equal(queued.length, 1, `${deliverAs} has one durable user message`);
		} finally {
			fixture.close();
		}
	}
});

test("real AgentSession: hidden or missing reset boots refuse to move the boundary", { timeout: 15000 }, async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		script: () => assistant(fixture, [{ type: "text", text: "scripted acknowledgement" }]),
	});
	try {
		await fixture.session.prompt("ROOT_BEFORE_HIDDEN_BOOT");
		await fixture.session.waitForIdle();
		await fixture.session.prompt("/wipe-memory");
		await fixture.session.waitForIdle();
		await fixture.session.prompt("VALID_POST_MARKER_WORK");
		await fixture.session.waitForIdle();

		const marker = resetMarkers(fixture)[0];
		assert.ok(marker && marker.type === "custom");
		const windowId = (marker.data as { windowId: string }).windowId;
		const boot = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId);
		assert.ok(boot && boot.type === "custom_message");
		fixture.sessionManager.appendContextEdit(boot.id, null);
		const bootCount = () => fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE && entry.details && typeof entry.details === "object" && (entry.details as { windowId?: unknown }).windowId === windowId).length;
		assert.equal(bootCount(), 1);

		await fixture.session.reload();
		assert.equal(bootCount(), 1, "a raw boot hidden by context_edit is not replaced at the tail");
		const requestsBeforeRefusal = fixture.requests.length;
		await fixture.session.prompt("MISSING_PROJECTED_BOOT_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(bootCount(), 1, "a refused active window never receives a replacement boot");
		assert.ok(fixture.requests.length <= requestsBeforeRefusal, "the normal provider request is not generated from a shortened window");
		const safeContext = fixture.streamContexts.at(-1);
		assert.ok(safeContext, "the SDK may still invoke the stream function with an aborted signal");
		assert.ok(safeContext.messages.every((message) => message.role === "system"), "a refused request receives system-only safe context");
		assert.equal(fixture.streamSignals.at(-1), true, "the refused request is aborted before provider work");
		assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes("VALID_POST_MARKER_WORK"), "raw post-marker work remains durable");
	} finally {
		fixture.close();
	}

	let missingRaw!: Fixture;
	missingRaw = await openFixture({
		compactionEnabled: false,
		seed: (sessionManager) => {
			sessionManager.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:missing:boot" });
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "RAW_POST_MARKER_WORK" }], timestamp: Date.now() });
		},
		script: () => assistant(missingRaw, [{ type: "text", text: "must not be called normally" }]),
	});
	try {
		assert.equal(missingRaw.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 0, "post-marker conversation blocks startup repair");
		await missingRaw.session.prompt("MISSING_RAW_BOOT_SENTINEL");
		await missingRaw.session.waitForIdle();
		assert.equal(missingRaw.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE).length, 0, "later conversation without a boot is refused, not repaired");
		assert.equal(missingRaw.streamSignals.at(-1), true);
		assert.ok(missingRaw.streamContexts.at(-1)?.messages.every((message) => message.role === "system"));
	} finally {
		missingRaw.close();
	}
});

test("real AgentSession: the complete system message and a changed tool loadout survive the reset projection", async () => {
	let fixture!: Fixture;
	fixture = await openFixture({
		compactionEnabled: false,
		systemPrompt: ["SYSTEM_SECTION_ALPHA", "SYSTEM_SECTION_BETA", "SYSTEM_TOOLS_SECTION", "SYSTEM_LOADOUT_SECTION"].join("\n"),
		tools: ["wipe_memory"],
		script: (request, context) => {
			const systemText = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			const currentSystem = getCurrentSystemMessage(context.messages);
			const effectiveToolNames = (currentSystem?.toolsAdded ?? []).map((tool) => tool.name).sort();
			assert.ok(systemText.includes("SYSTEM_SECTION_ALPHA"));
			assert.ok(systemText.includes("SYSTEM_SECTION_BETA"));
			assert.ok(systemText.includes("SYSTEM_TOOLS_SECTION"));
			assert.ok(systemText.includes("SYSTEM_LOADOUT_SECTION"));
			if (request === 1) {
				assert.deepEqual(effectiveToolNames, ["wipe_memory"]);
				fixture.session.setActiveToolsByName(["wipe_memory", "get_context_remaining"]);
				return assistant(fixture, [{ type: "toolCall", id: "wipe-system", name: "wipe_memory", arguments: {} }], "toolUse");
			}
			assert.deepEqual(effectiveToolNames, ["get_context_remaining", "wipe_memory"]);
			assert.ok(JSON.stringify(context.messages).includes(CONTEXT_WINDOW_OPEN_TAG));
			return assistant(fixture, [{ type: "text", text: "all system sections survived" }]);
		},
	});
	try {
		await fixture.session.prompt("SYSTEM_LOADOUT_SENTINEL");
		await fixture.session.waitForIdle();
		assert.equal(fixture.requests.length, 2);
		assertFreshRequest(fixture, 1, "SYSTEM_LOADOUT_SENTINEL");
	} finally {
		fixture.close();
	}
});

test("real AgentSession: overflow and recoverable length reset and retry once; repeated failure is bounded", { timeout: 15000 }, async () => {
	for (const failure of ["overflow", "length"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			script: (request) => {
				if (request === 1 && failure === "overflow") return assistant(fixture, [{ type: "text", text: "overflow response" }], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" });
				if (request === 1) return assistant(fixture, [{ type: "text", text: "truncated" }], "length", { usage: usage(99_000, 1) });
				return assistant(fixture, [{ type: "text", text: "recovered" }]);
			},
		});
		try {
			await fixture.session.prompt(`RECOVER_${failure}_SENTINEL`);
			await fixture.session.waitForIdle();
			assert.equal(resetMarkers(fixture).length, 1, `${failure} performs one reset`);
			assert.equal(fixture.requests.length, 2, `${failure} resumes once`);
			assertFreshRequest(fixture, 1, `RECOVER_${failure}_SENTINEL`);
		} finally {
			fixture.close();
		}
	}

	let repeated!: Fixture;
	repeated = await openFixture({
		script: (request) => assistant(repeated, [{ type: "text", text: `overflow-${request}` }], "error", { errorMessage: "Prompt too long: context exceeds maximum context length" }),
	});
	try {
		await repeated.session.prompt("REPEATED_OVERFLOW_SENTINEL");
		await repeated.session.waitForIdle();
		assert.equal(resetMarkers(repeated).length, 1, "repeated overflow does not create repeated windows");
		assert.equal(repeated.requests.length, 2, "repeated overflow stops after one recovery request");
		assert.ok(repeated.events.some((event) => event.type === "compaction_end" && typeof event.errorMessage === "string"));
	} finally {
		repeated.close();
	}
});

test("real AgentSession: concurrent trusted projects keep reserve and automatic policy isolated", { timeout: 20000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-shared-agent-"));
	const notesRoot = mkdtempSync(join(tmpdir(), "pi-context-shared-notes-"));
	const cwdAutomatic = mkdtempSync(join(tmpdir(), "pi-context-project-automatic-"));
	const cwdModel = mkdtempSync(join(tmpdir(), "pi-context-project-model-"));
	const cwdSession = mkdtempSync(join(tmpdir(), "pi-context-project-session-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: true, reserveTokens: 70_000, keepRecentTokens: 200 },
		retry: { enabled: false },
	}));
	let automatic!: Fixture;
	let modelInvalidated!: Fixture;
	let sessionInvalidated!: Fixture;
	const script = (fixture: () => Fixture, highUsage: { next: boolean }) => () => {
		const response = assistant(fixture(), [{ type: "text", text: "policy isolation response" }], "stop", { usage: usage(highUsage.next ? 85_000 : 100) });
		highUsage.next = false;
		return response;
	};
	const automaticUsage = { next: true };
	const modelUsage = { next: true };
	const sessionUsage = { next: true };
	try {
		// All three sessions share one stable global settings root. Only their trusted
		// project settings differ, so this cannot pass by rotating PI_CODING_AGENT_DIR.
		automatic = await openFixture({
			contextWindow: 100_000,
			cwd: cwdAutomatic,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: true, reserveTokens: 20_000 } },
			script: script(() => automatic, automaticUsage),
		});
		modelInvalidated = await openFixture({
			contextWindow: 100_000,
			cwd: cwdModel,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: false, reserveTokens: 80_000 } },
			script: script(() => modelInvalidated, modelUsage),
		});
		sessionInvalidated = await openFixture({
			contextWindow: 100_000,
			cwd: cwdSession,
			agentDir,
			notesRoot,
			writeSettings: false,
			projectSettings: { compaction: { enabled: false, reserveTokens: 80_000 } },
			script: script(() => sessionInvalidated, sessionUsage),
		});

		await Promise.all([
			automatic.session.prompt("AUTOMATIC_POLICY_PROJECT"),
			modelInvalidated.session.prompt("MODEL_POLICY_PROJECT"),
			sessionInvalidated.session.prompt("SESSION_POLICY_PROJECT"),
		]);
		await Promise.all([automatic.session.waitForIdle(), modelInvalidated.session.waitForIdle(), sessionInvalidated.session.waitForIdle()]);
		assert.equal(resetMarkers(automatic).length, 1, "the low reserve and enabled project resets automatically");
		assert.equal(automatic.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE).length, 1, "the automatic reset persists exactly one continuation");
		assert.equal(resetMarkers(modelInvalidated).length, 0, "the high reserve and disabled project does not reset");
		assert.equal(resetMarkers(sessionInvalidated).length, 0, "the second high reserve and disabled session does not reset");

		writeFileSync(join(cwdModel, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 20_000 } }));
		modelUsage.next = true;
		const changedModel = { ...modelInvalidated.model, id: `${modelInvalidated.model.id}-changed` };
		modelInvalidated.model = changedModel;
		await modelInvalidated.session.setModel(changedModel, { persist: false });
		await modelInvalidated.session.prompt("MODEL_POLICY_AFTER_INVALIDATION");
		await modelInvalidated.session.waitForIdle();
		assert.equal(resetMarkers(modelInvalidated).length, 1, "model_select invalidates the instance policy cache");

		writeFileSync(join(cwdSession, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 20_000 } }));
		sessionUsage.next = true;
		await sessionInvalidated.session.reload();
		await sessionInvalidated.session.prompt("SESSION_POLICY_AFTER_INVALIDATION");
		await sessionInvalidated.session.waitForIdle();
		assert.equal(resetMarkers(sessionInvalidated).length, 1, "session reload invalidates the instance policy cache");
	} finally {
		sessionInvalidated?.close();
		modelInvalidated?.close();
		automatic?.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(notesRoot, { recursive: true, force: true });
		rmSync(cwdAutomatic, { recursive: true, force: true });
		rmSync(cwdModel, { recursive: true, force: true });
		rmSync(cwdSession, { recursive: true, force: true });
	}
});

test("real AgentSession: injected settings managers own live policy and ignore conflicting default files", { timeout: 20000 }, async () => {
	const firstManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 80_000 } });
	const secondManager = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 20_000 } });
	const defaultAgentDir = mkdtempSync(join(tmpdir(), "pi-context-injected-default-agent-"));
	const notesRoot = mkdtempSync(join(tmpdir(), "pi-context-injected-notes-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousNotesRoot = process.env.PI_NOTES_HOME;
	writeFileSync(join(defaultAgentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 1_000 } }));
	process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
	process.env.PI_NOTES_HOME = notesRoot;
	let first!: Fixture;
	let second!: Fixture;
	const firstHighUsage = { next: false };
	const secondHighUsage = { next: false };
	const script = (getFixture: () => Fixture, highUsage: { next: boolean }) => (request: number) => {
		const fixture = getFixture();
		if (request === 1) {
			highUsage.next = false;
			return assistant(fixture, [{ type: "toolCall", id: "remaining", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(20_000) });
		}
		const input = highUsage.next ? 85_000 : 100;
		highUsage.next = false;
		return assistant(fixture, [{ type: "text", text: "scripted policy response" }], "stop", { usage: usage(input) });
	};
	try {
		first = await openFixture({
			contextWindow: 100_000,
			agentDir: defaultAgentDir,
			notesRoot,
			writeSettings: false,
			defaultCompactionEnabled: false,
			defaultReserveTokens: 1_000,
			settingsManager: firstManager,
			manageEnvironment: false,
			tools: ["get_context_remaining"],
			script: script(() => first, firstHighUsage),
		});
		second = await openFixture({
			contextWindow: 100_000,
			agentDir: defaultAgentDir,
			notesRoot,
			writeSettings: false,
			defaultCompactionEnabled: true,
			defaultReserveTokens: 95_000,
			settingsManager: secondManager,
			manageEnvironment: false,
			tools: ["get_context_remaining"],
			script: script(() => second, secondHighUsage),
		});

		await Promise.all([first.session.prompt("INJECTED_FIRST"), second.session.prompt("INJECTED_SECOND")]);
		await Promise.all([first.session.waitForIdle(), second.session.waitForIdle()]);
		assert.deepEqual(contextRemainingResults(first), [0], "the injected high reserve reaches the warning line in the real tool result");
		assert.ok((contextRemainingResults(second)[0] ?? 0) > 0, "the second injected reserve produces a distinct real tool result");
		assert.equal(resetMarkers(first).length, 1, "enabled injected policy resets at the first session's reserve");
		assert.equal(resetMarkers(second).length, 0, "disabled injected policy does not inherit the first session's reset decision");

		firstHighUsage.next = true;
		firstManager.setCompactionEnabled(false);
		firstManager.applyOverrides({ compaction: { reserveTokens: 90_000 } });
		await first.session.prompt("INJECTED_LIVE_DISABLE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 1, "a public setter disables the next turn without reload");
		assert.equal(resetMarkers(second).length, 0, "the second live manager remains unchanged");

		firstHighUsage.next = true;
		firstManager.setCompactionEnabled(true);
		firstManager.applyOverrides({ compaction: { reserveTokens: 1_000 } });
		await first.session.prompt("INJECTED_LIVE_ENABLE_LOW_RESERVE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 1, "live enablement and a lower reserve apply on the next turn");

		firstHighUsage.next = true;
		firstManager.applyOverrides({ compaction: { reserveTokens: 90_000 } });
		await first.session.prompt("INJECTED_LIVE_HIGH_RESERVE");
		await first.session.waitForIdle();
		assert.equal(resetMarkers(first).length, 2, "a live reserve increase drives the next reset decision");
	} finally {
		second?.close();
		first?.close();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesRoot;
		rmSync(defaultAgentDir, { recursive: true, force: true });
		rmSync(notesRoot, { recursive: true, force: true });
	}
});

test("real AgentSession: injected model overrides select the active model's reserve", { timeout: 20000 }, async () => {
	let settingsManager!: SettingsManager;
	let modelBId = "";
	const notesRoot = mkdtempSync(join(tmpdir(), "pi-context-model-override-notes-"));
	const previousNotesRoot = process.env.PI_NOTES_HOME;
	process.env.PI_NOTES_HOME = notesRoot;
	let fixture!: Fixture;
	fixture = await openFixture({
		contextWindow: 100_000,
		notesRoot,
		settingsManager: (model) => {
			modelBId = `${model.id}-changed`;
			settingsManager = SettingsManager.inMemory({
				compaction: {
					enabled: false,
					reserveTokens: 10_000,
					modelOverrides: {
						[`${model.provider}/${model.id}`]: { reserveTokens: 70_000 },
						[`${model.provider}/${modelBId}`]: { reserveTokens: 1_000 },
					},
				},
			});
			return settingsManager;
		},
		manageEnvironment: false,
		tools: ["get_context_remaining"],
		script: (request) => request === 1 || request === 3
			? assistant(fixture, [{ type: "toolCall", id: `remaining-${request}`, name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(30_000) })
			: assistant(fixture, [{ type: "text", text: "scripted model override response" }], "stop", { usage: usage(1_000) }),
	});
	try {
		await fixture.session.prompt("MODEL_OVERRIDE_A");
		await fixture.session.waitForIdle();
		assert.deepEqual(contextRemainingResults(fixture), [0], "model-a's high reserve reaches zero in the real tool result");

		const changedModel = { ...fixture.model, id: modelBId };
		fixture.model = changedModel;
		await fixture.session.setModel(changedModel, { persist: false });
		await fixture.session.prompt("MODEL_OVERRIDE_B");
		await fixture.session.waitForIdle();
		const results = contextRemainingResults(fixture);
		assert.equal(results.length, 2);
		assert.ok((results[1] ?? 0) > 0, "model-b's lower reserve is selected for the next real tool result");
	} finally {
		fixture.close();
		if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesRoot;
		rmSync(notesRoot, { recursive: true, force: true });
	}
});

test("real AgentSession: warning precedes a durable checkpoint, including failed writes and an ignored warning", { timeout: 20000 }, async () => {
	for (const scenario of ["checkpoint", "write-error", "ignored-warning"] as const) {
		let fixture!: Fixture;
		fixture = await openFixture({
			compactionEnabled: true,
			script: (request, context) => {
				if (request === 3) assert.ok(text(context).includes(GUIDANCE_OPEN_TAG), "the critical warning reaches the provider before checkpoint choice");
				if (request === 1) return assistant(fixture, [{ type: "toolCall", id: "budget-probe-1", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(50_000) });
				if (request === 2) return assistant(fixture, [{ type: "toolCall", id: "budget-probe-2", name: "get_context_remaining", arguments: {} }], "toolUse", { usage: usage(60_000) });
				if (request === 3 && scenario !== "ignored-warning") return assistant(fixture, [{ type: "toolCall", id: "checkpoint", name: "notes_write", arguments: {
					address: scenario === "write-error" ? "../invalid.md" : "checkpoint.md",
					content: "CHECKPOINT_SENTINEL",
				} }], "toolUse", { usage: usage(60_000) });
				if (request === 4 && scenario !== "ignored-warning") return assistant(fixture, [{ type: "toolCall", id: "wipe-after-checkpoint", name: "wipe_memory", arguments: {} }], "toolUse", { usage: usage(60_000) });
				return assistant(fixture, [{ type: "text", text: scenario === "ignored-warning" ? "warning intentionally ignored" : "checkpoint and wipe complete" }], "stop", { usage: usage(60_000) });
			},
		});
		try {
			await fixture.session.prompt(`WARNING_${scenario.toUpperCase()}_SENTINEL`);
			await fixture.session.waitForIdle();
			const branch = fixture.sessionManager.getBranch();
			assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, "one early reminder is durable");
			assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1, "one critical warning is durable");
			const noteFile = join(fixture.notesRoot, "pi", "session", fixture.sessionManager.getSessionId(), "checkpoint.md");
			if (scenario === "checkpoint") {
				assert.equal(resetMarkers(fixture).length, 1);
				assert.equal(existsSync(noteFile), true, "a successful checkpoint reaches the notes store before reset");
				assert.ok(text(fixture.requests.at(-1)).includes("checkpoint.md"), "the fresh boot indexes the successful checkpoint");
			} else if (scenario === "write-error") {
				assert.equal(resetMarkers(fixture).length, 1);
				assert.equal(existsSync(noteFile), false, "a failed checkpoint does not create a note");
				assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write" && entry.message.isError), "the failed write is a durable tool error");
			} else {
				assert.equal(resetMarkers(fixture).length, 0, "ignoring the warning does not reset automatically");
				assert.equal(existsSync(noteFile), false);
			}
		} finally {
			fixture.close();
		}
	}
});
