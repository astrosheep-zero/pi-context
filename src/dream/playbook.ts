import { readFileSync } from "node:fs";

export function loadPlaybook(path: string): string { return readFileSync(path, "utf8"); }
