import type { McpResult } from "./tools.js";

/** Subset of QueryContext needed by the MCP tool bridge. */
export interface McpToolBridgeState {
	turnToolCallIds: string[];
	nextHandlerIdx: number;
	pendingToolCalls: Map<string, { toolName: string; resolve: (result: McpResult) => void }>;
	pendingResults: Map<string, McpResult>;
}
