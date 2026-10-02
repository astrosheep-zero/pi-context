/** Pi transport for host-neutral operations. */
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { Operation, Outcome, Renderer } from "../tools/result.js";

/** Operation data is schema-derived JSON; only the unresolved generic needs a JsonValue assertion. */
export function piOperationResult<TData>(render: Renderer<TData>, outcome: Outcome<TData>): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: render(outcome) }],
		structuredContent: outcome as unknown as JsonValue,
		isError: !outcome.ok,
		details: undefined,
	};
}

/** Register `operation` as a Pi tool; `run` supplies only the host context it needs. */
export function registerOperation<TParams extends TSchema, TData, TRest extends readonly unknown[]>(
	pi: ExtensionAPI,
	operation: Operation<TParams, TData, TRest>,
	run: (params: Static<TParams>, ctx: ExtensionToolContext) => Promise<Outcome<TData>>,
): void {
	pi.registerTool(defineTool<TParams, undefined>({
		name: operation.name,
		label: operation.label,
		description: operation.description,
		parameters: operation.parameters,
		outputSchema: operation.outputSchema,
		executionMode: operation.executionMode,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return piOperationResult(operation.render, await run(params, ctx));
		},
	}));
}
