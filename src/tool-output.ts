function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function output(value: unknown, details: unknown = value, terminate = false) {
	return { content: [{ type: "text" as const, text: json(value) }], details, terminate };
}

