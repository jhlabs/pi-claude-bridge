import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Tool } from "@mariozechner/pi-ai";
import type { McpToolBridgeState } from "./types.js";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// --- Tool name mapping ---

// SDK → pi direction (used when CC emits tool_use blocks)
const SDK_TO_PI: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

export function mapToolNameToPI(sdkName: string, customMap?: Map<string, string>): string {
	const normalized = sdkName.toLowerCase();

	// Check custom MCP tool mappings first
	if (customMap) {
		const mapped = customMap.get(sdkName) ?? customMap.get(normalized);
		if (mapped) return mapped;
	}

	// Built-in SDK tool names
	const builtin = SDK_TO_PI[normalized];
	if (builtin) return builtin;

	// Strip MCP prefix if present
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return sdkName.slice(MCP_TOOL_PREFIX.length);

	return sdkName;
}

// pi → SDK direction (used when importing history)
const PI_TO_SDK: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function mapToolNameToSDK(piName: string, customMap?: Map<string, string>): string {
	if (!piName) return "";
	const normalized = piName.toLowerCase();

	if (customMap) {
		const mapped = customMap.get(piName) ?? customMap.get(normalized);
		if (mapped) return mapped;
	}

	if (PI_TO_SDK[normalized]) return PI_TO_SDK[normalized];
	return piName;
}

// --- Tool arg mapping ---

// SDK arg key → pi arg key renames per tool
const ARG_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

export function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const input = args ?? {};
	const renames = ARG_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value;
	}
	// Pi bash has no default timeout; add safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Disallowed CC built-in tools ---

export const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"Skill", "TaskOutput", "TaskStop", "ToolSearch",
	"AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
];

// --- TypeBox → Zod schema conversion ---

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) {
		base = z.enum(prop.enum as [string, ...string[]]);
	} else {
		switch (prop.type) {
			case "string": base = z.string(); break;
			case "number": case "integer": base = z.number(); break;
			case "boolean": base = z.boolean(); break;
			case "array": base = prop.items
				? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
				: z.array(z.unknown()); break;
			case "object": base = z.record(z.string(), z.unknown()); break;
			default: base = z.unknown();
		}
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}

// --- MCP tool resolution ---

export function resolveMcpTools(context: { tools?: Tool[] }): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// --- MCP server builder ---

export type McpContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
export interface McpResult { content: McpContent; isError?: boolean; toolCallId?: string; [key: string]: unknown }
export interface PendingToolCall { toolName: string; resolve: (result: McpResult) => void; }

export function buildMcpServer(
	tools: Tool[],
	queryCtx: McpToolBridgeState,
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;

	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: async () => {
			const toolCallId = queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
			if (toolCallId) {
				const ready = queryCtx.pendingResults.get(toolCallId);
				if (ready) {
					queryCtx.pendingResults.delete(toolCallId);
					return ready;
				}
			}
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));

	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}
