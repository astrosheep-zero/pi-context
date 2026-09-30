import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../tools/notes.js";
import { loadNotesSnapshot } from "../boot/snapshot.js";
import { renderBootBlock } from "../boot/render.js";
import { projectKey } from "../notes/paths.js";
import { snapshotNotesIdentity, type NotesIdentity } from "../notes/identity.js";
import type { BootToolNames } from "../boot/text.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOOL_NAMES = ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"] as const;
const HANDLERS = { notes_write: notesWrite, notes_update: notesUpdate, notes_read: notesRead, notes_list: notesList, notes_search: notesSearch } as const;
export type ClaudeIdentityInput = Readonly<{ home: string; sessionId: string; cwd: string; agent: string; model: string }>;

function identity(input: ClaudeIdentityInput): NotesIdentity {
 if (!input || typeof input !== "object" || typeof input.cwd !== "string") throw new Error("invalid identity");
 return snapshotNotesIdentity({ home: input.home, sessionId: input.sessionId, projectKey: projectKey(input.cwd), agent: input.agent, model: input.model });
}
function jsonValue(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }

export async function dispatch(request: unknown): Promise<unknown> {
 if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("malformed request");
 const value = request as Record<string, unknown>;
 if (value.op === "schemas") return TOOL_NAMES.map((name) => ({ name, description: HANDLERS[name].description, inputSchema: jsonValue(HANDLERS[name].parameters) }));
 if (value.op === "tool") {
  if (typeof value.tool !== "string" || !(TOOL_NAMES as readonly string[]).includes(value.tool)) throw new Error("unknown tool");
  const id = identity(value.identity as ClaudeIdentityInput);
  const handler = HANDLERS[value.tool as typeof TOOL_NAMES[number]];
  if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new Error("invalid tool parameters");
  const execute = handler.execute as any;
  return value.tool === "notes_update" ? execute(value.params, id, (change: { kind: string }) => change.kind === "none" ? "" : `note ${change.kind}`) : execute(value.params, id);
 }
 if (value.op === "boot") {
  const id = identity(value.identity as ClaudeIdentityInput);
  if (!value.tools || typeof value.tools !== "object") throw new Error("invalid boot tools");
  const snapshot = await loadNotesSnapshot(id, typeof value.openedAt === "number" ? value.openedAt : Date.now());
  return renderBootBlock({ agentName: id.agent, modelName: id.model, firstWindowId: `claude:${id.sessionId}`, currentWindowId: `claude:${id.sessionId}`, notes: snapshot, tools: value.tools as BootToolNames });
 }
 throw new Error("unknown operation");
}
function safeError(error: unknown): string { return error instanceof Error && error.message ? error.message.replace(/[\r\n].*$/s, "") : "helper request failed"; }
export async function handleLine(line: string): Promise<string> {
 if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) return JSON.stringify({ ok: false, error: "request too large" });
 try { const result = await dispatch(JSON.parse(line)); const response = JSON.stringify({ ok: true, result }); return Buffer.byteLength(response, "utf8") <= MAX_RESPONSE_BYTES ? response : JSON.stringify({ ok: false, error: "response too large" }); }
 catch (error) { return JSON.stringify({ ok: false, error: safeError(error) }); }
}
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
 process.stdin.setEncoding("utf8"); let input = "";
 process.stdin.on("data", (chunk) => { input += chunk; });
 process.stdin.on("end", async () => { process.stdout.write(`${await handleLine(input.trim())}\n`); });
}
