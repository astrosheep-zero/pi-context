import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piContext from "../src/index.js";
import { GUIDANCE_OPEN_TAG, WARNING_TYPE, GUIDANCE_TYPE } from "../src/protocol.js";

for (const mode of ["golden", "write-error", "ignored-warning", "explicit", "uncompactable", "followup", "steering", "repeat", "nested", "immediate-dispose", "abort"] as const) {
	test(`real Pi loop: ${mode} reset preserves history and handles completion`, { timeout: 15000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-loop-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const previousNotesRoot = process.env.PI_NOTES_HOME;
		process.env.PI_CODING_AGENT_DIR = dir;
		const notesRoot = mkdtempSync(join(tmpdir(), "pi-context-loop-notes-"));
		process.env.PI_NOTES_HOME = notesRoot;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let disposed = false;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
			await runtime.setRuntimeApiKey("openai", "scripted-test-key");
			const base = runtime.getModels("openai")[0];
			assert.ok(base);
			const model = { ...base, contextWindow: 100000, maxTokens: 4096 };
			const usageMode = mode === "golden" || mode === "write-error" || mode === "ignored-warning";
			const expectedResets = mode === "abort" || mode === "uncompactable" ? 0 : mode === "nested" ? 2 : 1;
			// 0.86 split-turn cut can still summarize a turn prefix, so keepRecentTokens: 1 no longer
			// makes a reset uncompactable; a keep larger than the whole session keeps everything and does.
const settings = { compaction: { enabled: usageMode, reserveTokens: 32768, keepRecentTokens: mode === "uncompactable" ? 1_000_000 : 200 }, retry: { enabled: false } };
			writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
			const settingsManager = SettingsManager.create(dir, dir);
			let resets = 0;
			let settled = 0;
			let targetResets = expectedResets;
			let activeSentinel = "OLD_CONTEXT_SENTINEL";
			let finish!: () => void;
			let failFinish!: (error: Error) => void;
			const finished = new Promise<void>((resolve, reject) => { finish = resolve; failFinish = reject; });
			const finishTimeout = setTimeout(() => failFinish(new Error(`timed out waiting for ${mode} agent settlement (resets=${resets}, settled=${settled}, requests=${requests.length})`)), 5000);
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
				systemPromptOverride: () => "Use the tools as requested.", agentsFilesOverride: () => ({ agentsFiles: [] }),
				extensionFactories: [piContext, (pi) => {
					pi.on("session_compact", () => { resets++; });
					pi.on("agent_settled", () => {
						settled++;
						if (mode === "abort") { if (settled === 1) finish(); return; }
						if (resets >= targetResets && requests.length > 0 && !requests.at(-1)!.includes(activeSentinel)) finish();
					});
					pi.on("tool_result", () => {
						if (mode === "abort") void session!.abort();
					});
					pi.on("tool_call", async () => {
						if (mode === "followup") await session!.followUp("QUEUED_INPUT_SENTINEL");
						if (mode === "steering") await session!.steer("QUEUED_INPUT_SENTINEL");
					});
				}],
			});
			await loader.reload();
			const sm = SessionManager.inMemory(dir);
			sm.appendMessage({ role: "user", content: "Earlier work to retain in durable history.", timestamp: Date.now() });
			sm.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "Earlier result. ".repeat(100) }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
			({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, sessionManager: sm, resourceLoader: loader, tools: ["wipe_memory", "notes_write", "get_context_remaining"] }));
			const requests: string[] = [];
			let checkpointed = false;
			let freshTurns = 0;
			session.agent.streamFunction = (_model, context) => {
				requests.push(JSON.stringify(context.messages));
				const n = requests.length;
				const request = requests[n - 1]!;
				const fresh = !request.includes("OLD_CONTEXT_SENTINEL");
				if (fresh) freshTurns++;
				// The early reminder and the final warning steer share one structural envelope:
				// <context_window_guidance>. The reminder is the first in the window, the
				// warning the second, so the envelope count identifies which arrived.
				// The early reminder and the final warning steer share one structural envelope,
				// <context_window_guidance>. The reminder is deferred to the end of the turn while
				// streaming, so in this scripted tool-calling loop only the warning reaches the
				// provider context: the envelope's presence marks the warning.
				const budgetMarkers = request.split(GUIDANCE_OPEN_TAG).length - 1;
				const sawWarning = budgetMarkers >= 1;
				const sawGuidance = budgetMarkers >= 1;
				const explicitReset = (n === 1 && !usageMode && mode !== "uncompactable") || (mode === "repeat" && (n === 1 || n === 3)) || (mode === "nested" && n === 3);
				const nestedCheckpoint = mode === "nested" && n === 2;
				const checkpoint = usageMode && sawWarning && !checkpointed && mode !== "ignored-warning";
				if (checkpoint) checkpointed = true;
				// The warning is chosen from the previous turn's usage, so a scripted run has to
				// keep taking turns until it sees the warning (first window) or the next
				// window's reminder. "ignored-warning" keeps working instead of checkpointing.
				const probe = usageMode && !checkpoint && (
					(!fresh && !sawWarning) || (mode === "ignored-warning" && sawWarning) || (fresh && freshTurns === 2 && !sawGuidance)
				);
				const tokens = usageMode ? (fresh ? (freshTurns === 1 ? 100 : 50000) : sawWarning ? 70000 : n === 1 ? 50000 : 60000) : 100;
				const tool = explicitReset || nestedCheckpoint || (mode === "uncompactable" && n === 1);
				const call = probe ? "get_context_remaining" : checkpoint || nestedCheckpoint ? "notes_write" : tool ? "wipe_memory" : undefined;
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: probe ? [{ type: "toolCall", id: "probe-call", name: "get_context_remaining", arguments: {} }]
						: checkpoint || nestedCheckpoint ? [{ type: "toolCall", id: "checkpoint-call", name: "notes_write", arguments: { address: mode === "write-error" ? "../invalid.md" : "checkpoint.md", content: nestedCheckpoint ? "NESTED_RESET_PADDING ".repeat(300) : "CHECKPOINT_SENTINEL" } }]
						: tool ? [{ type: "toolCall", id: "reset-call", name: "wipe_memory", arguments: {} }]
						: [{ type: "text", text: fresh ? "Resumed." : "Working." }],
					stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				stream.end();
				return stream;
			};
			await session.bindExtensions({});
			let failure: string | undefined;
			session.subscribe((event) => {
				if (mode === "uncompactable" && event.type === "compaction_end" && event.errorMessage) {
					failure = event.errorMessage;
					finish();
				}
			});
			await session.prompt("OLD_CONTEXT_SENTINEL: save progress and continue the task.");
			if (mode === "immediate-dispose") {
				// prompt() must not resolve after compaction merely because sendMessage is
				// detached: by this point the continuation has settled and answered.
				session.dispose();
				disposed = true;
				assert.ok(settled >= 2, "the continuation settles before the originating prompt resolves");
				assert.ok(requests.length >= 2 && !requests.at(-1)!.includes("OLD_CONTEXT_SENTINEL"), "the resumed answer exists before immediate disposal");
			}
			await finished;
			clearTimeout(finishTimeout);
			if (!disposed) await session.waitForIdle();
			if (mode === "abort") {
				assert.equal(resets, 0, "user cancellation clears pending rollover");
				assert.equal(requests.length, 1, "no continuation resurrects the cancelled run");
				await session.prompt("Resume explicitly after cancellation.");
				assert.equal(requests.length, 2);
				assert.ok(requests[1].includes("Resume explicitly after cancellation."));
				assert.ok(requests[1].includes("OLD_CONTEXT_SENTINEL"), "no reset happened: history is intact");
				return;
			}
			if (mode === "uncompactable") {
				assert.match(failure ?? "", /Nothing to compact/);
				assert.equal(resets, 0);
				assert.equal(requests.length, 1, "failed reset does not loop or resume automatically");
				await session.prompt("Continue after the failed reset.");
				assert.equal(requests.length, 2);
				assert.ok(requests[1].includes("OLD_CONTEXT_SENTINEL"));
				return;
			}
			assert.equal(resets, expectedResets);
			if (mode === "golden" || mode === "write-error" || mode === "ignored-warning") {
				const branch = sm.getBranch();
				const guidanceIndices = branch.flatMap((entry, i) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE ? [i] : []);
				const warningIndices = branch.flatMap((entry, i) => entry.type === "custom_message" && entry.customType === WARNING_TYPE ? [i] : []);
				const noteFile = join(notesRoot, "pi", "session", sm.getSessionId(), "checkpoint.md");
				const resetIndex = branch.findIndex((entry) => entry.type === "compaction");
				assert.equal(guidanceIndices.length, 1, "one early reminder");
				assert.equal(warningIndices.length, 1, "one final warning steer");
				assert.ok(warningIndices[0]! > guidanceIndices[0]!, "the reminder precedes the warning");
				if (mode === "ignored-warning") {
					assert.equal(existsSync(noteFile), false, "an ignored warning leaves no checkpoint");
				} else if (mode === "write-error") {
					assert.equal(existsSync(noteFile), false, "failed write creates no checkpoint");
					assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes_write" && entry.message.isError));
					assert.ok(!requests.at(-1)!.includes("checkpoint.md"), "fresh context must not invent a saved note");
				} else {
					assert.ok(existsSync(noteFile), "the checkpoint is a real file on disk");
					assert.ok(resetIndex > warningIndices[0]!, "the warning precedes the wipe");
					assert.ok(requests.at(-1)!.includes("checkpoint.md"), "fresh boot carries the saved checkpoint as a metadata line");
				}

				assert.ok(!requests.at(-1)!.includes(GUIDANCE_OPEN_TAG), "new window excludes old guidance");
			}
			if (mode === "followup" || mode === "steering") {
				assert.ok(requests[1].includes("QUEUED_INPUT_SENTINEL"), "queued user work is delivered before rollover");
				assert.ok(requests[1].includes("OLD_CONTEXT_SENTINEL"), "queue drains in the existing window");
				assert.ok(!requests[2].includes("QUEUED_INPUT_SENTINEL"), "queue is not replayed after rollover");
				const queuedEntries = sm.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("QUEUED_INPUT_SENTINEL"));
				assert.equal(queuedEntries.length, 1, "one durable user input");
			}
			if (mode === "nested") {
				assert.equal(resets, 2, "a continuation-requested reset forms a second completed handoff");
				assert.equal(new Set(sm.getBranch().filter((entry) => entry.type === "compaction").map((entry) => JSON.stringify(entry.details))).size, 2);
			}
			if (mode === "repeat") {
				const nextFinished = new Promise<void>((resolve) => { finish = resolve; });
				targetResets = 2;
				activeSentinel = "SECOND_WINDOW_SENTINEL";
				await session.prompt("SECOND_WINDOW_SENTINEL: " + "Additional work. ".repeat(100));
				await nextFinished;
				await session.waitForIdle();
				assert.equal(resets, 2);
				assert.ok(!requests.at(-1)!.includes("SECOND_WINDOW_SENTINEL"));
				const boundaries = sm.getBranch().filter((entry) => entry.type === "compaction");
				assert.equal(new Set(boundaries.map((entry) => JSON.stringify(entry.details))).size, 2);
			}
			assert.ok(requests[0].includes("OLD_CONTEXT_SENTINEL"));
			assert.ok(!requests.at(-1)!.includes("OLD_CONTEXT_SENTINEL"));
			assert.ok(requests.at(-1)!.includes("context_window"));
			assert.ok(JSON.stringify(session.sessionManager.getBranch()).includes("OLD_CONTEXT_SENTINEL"));
			if (mode === "golden") {
				await session.prompt("Keep working in the new window until its reminder threshold.");
				assert.equal(resets, 1);
				const branch = sm.getBranch();
				const boundary = branch.findIndex((entry) => entry.type === "compaction");
				const reminders = branch.flatMap((entry, i) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE ? [i] : []);
				assert.equal(reminders.length, 2, "the next window gets its own reminder");
				assert.ok(reminders[1]! > boundary, "old messages cannot suppress a new window's reminder");
				const warnings = branch.flatMap((entry, i) => entry.type === "custom_message" && entry.customType === WARNING_TYPE ? [i] : []);
				assert.equal(warnings.length, 1, "the next window has no warning yet");
			}
		} finally {
			if (!disposed) session?.dispose();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			if (previousNotesRoot === undefined) delete process.env.PI_NOTES_HOME;
			else process.env.PI_NOTES_HOME = previousNotesRoot;
			rmSync(dir, { recursive: true, force: true });
			rmSync(notesRoot, { recursive: true, force: true });
		}
	});
}
