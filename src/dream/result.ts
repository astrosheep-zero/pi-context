export type DreamWrite = { tool: "write" | "edit" | "delete"; path: string };
export type DreamResult = { report: string; writes: DreamWrite[]; error?: string };
