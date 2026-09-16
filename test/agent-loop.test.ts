import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piContext from "../src/index.js";

for (const mode of ["explicit", "fallback", "uncompactable", "followup", "steering", "repeat", "abort"] as const) {
	test(`real Pi loop: ${mode} reset preserves history and handles completion`, { timeout: 15000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-loop-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
			await runtime.setRuntimeApiKey("openai", "scripted-test-key");
			const base = runtime.getModels("openai")[0];
			assert.ok(base);
			const model = { ...base, contextWindow: 100000, maxTokens: 4096 };
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: mode === "fallback", reserveTokens: 16384, keepRecentTokens: mode === "uncompactable" ? 1 : 200 }, retry: { enabled: false } });
			let resets = 0;
			let settled = 0;
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => { finish = resolve; });
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
				systemPromptOverride: () => "Use the tools as requested.", agentsFilesOverride: () => ({ agentsFiles: [] }),
				extensionFactories: [piContext, (pi) => {
					pi.on("session_compact", () => { resets++; });
					pi.on("agent_settled", () => { if (++settled % 2 === 0 || mode === "abort") finish(); });
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
			({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, sessionManager: sm, resourceLoader: loader, tools: ["new_context"] }));
			const requests: string[] = [];
			session.agent.streamFunction = (_model, context) => {
				requests.push(JSON.stringify(context.messages));
				const first = requests.length === 1;
				const tool = (first && mode !== "fallback") || (mode === "repeat" && requests.length === 3);
				const tokens = first && mode === "fallback" ? 90000 : 100;
				const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: tool ? [{ type: "toolCall", id: "reset-call", name: "new_context", arguments: {} }] : [{ type: "text", text: first ? "Checkpoint ready." : "Resumed." }],
					stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
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
			await finished;
			await session.waitForIdle();
			if (mode === "abort") {
				assert.equal(resets, 0, "user cancellation clears pending rollover");
				assert.equal(requests.length, 1, "no continuation resurrects the cancelled run");
				await session.prompt("Resume explicitly after cancellation.");
				assert.equal(requests.length, 2);
				assert.ok(requests[1].includes("OLD_CONTEXT_SENTINEL"));
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
			assert.equal(resets, 1);
			assert.equal(requests.length, ["fallback", "followup", "steering"].includes(mode) ? 3 : 2);
			if (mode === "followup" || mode === "steering") {
				assert.ok(requests[1].includes("QUEUED_INPUT_SENTINEL"), "queued user work is delivered before rollover");
				assert.ok(requests[1].includes("OLD_CONTEXT_SENTINEL"), "queue drains in the existing window");
				assert.ok(!requests[2].includes("QUEUED_INPUT_SENTINEL"), "queue is not replayed after rollover");
				const queuedEntries = sm.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("QUEUED_INPUT_SENTINEL"));
				assert.equal(queuedEntries.length, 1, "one durable user input");
			}
			if (mode === "repeat") {
				const nextFinished = new Promise<void>((resolve) => { finish = resolve; });
				await session.prompt("SECOND_WINDOW_SENTINEL: " + "Additional work. ".repeat(100));
				await nextFinished;
				await session.waitForIdle();
				assert.equal(resets, 2);
				assert.equal(requests.length, 4);
				assert.ok(!requests[3].includes("SECOND_WINDOW_SENTINEL"));
				const boundaries = sm.getBranch().filter((entry) => entry.type === "compaction");
				assert.equal(new Set(boundaries.map((entry) => JSON.stringify(entry.details))).size, 2);
			}
			assert.ok(requests[0].includes("OLD_CONTEXT_SENTINEL"));
			assert.ok(!requests.at(-1)!.includes("OLD_CONTEXT_SENTINEL"));
			assert.ok(requests.at(-1)!.includes("context_window"));
			assert.ok(JSON.stringify(session.sessionManager.getBranch()).includes("OLD_CONTEXT_SENTINEL"));
		} finally {
			session?.dispose();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
