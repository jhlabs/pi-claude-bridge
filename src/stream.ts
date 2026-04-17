import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage, EffortLevel, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import type { Base64ImageSource } from "@anthropic-ai/sdk/resources";
import { createAssistantMessageEventStream, calculateCost } from "@mariozechner/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Api } from "@mariozechner/pi-ai";
import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { debug } from "./debug.js";
import { syncSession, type SessionState } from "./session.js";
import {
	MCP_SERVER_NAME, MCP_TOOL_PREFIX, DISALLOWED_BUILTIN_TOOLS,
	mapToolNameToPI, mapToolArgs, resolveMcpTools, buildMcpServer,
	type McpResult,
} from "./tools.js";
import { toolResultToMcpContent, messageContentToText } from "./convert.js";

// --- Effort mapping ---

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

// --- Skills extraction ---

function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	const block = systemPrompt.slice(start, end + endMarker.length).trim();
	// Rewrite tool references to use MCP prefix
	return block.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}

// --- Stop reason mapping ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		default: return "stop";
	}
}

// --- Prompt extraction ---

function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user" || typeof last.content === "string" || !Array.isArray(last.content)) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && (block as any).data && (block as any).mimeType) {
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: (block as any).mimeType as Base64ImageSource["media_type"], data: (block as any).data },
			});
		}
	}
	return hasImage ? blocks : null;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } as MessageParam,
		parent_tool_use_id: null,
	};
}

// --- Tool result extraction from context ---

function extractAllToolResults(context: Context): McpResult[] {
	const results: McpResult[] = [];
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") {
			results.unshift({
				content: toolResultToMcpContent(msg.content as any),
				isError: msg.isError,
				toolCallId: msg.toolCallId,
			});
		} else if (msg.role === "assistant") {
			break;
		}
		// skip user messages (steer/followUp injected mid-tool-execution)
	}
	return results;
}

// --- Usage ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

// --- Per-query state ---

export class QueryContext {
	activeQuery: ReturnType<typeof query> | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, { toolName: string; resolve: (result: McpResult) => void }>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	deferredUserMessages: string[] = [];

	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): any[] {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content as any[];
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		} as AssistantMessage;
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
	}
}

// --- Context stack for reentrant queries ---

let _ctx = new QueryContext();
const contextStack: QueryContext[] = [];
function ctx(): QueryContext { return _ctx; }

function pushContext(): void {
	contextStack.push(_ctx);
	_ctx = new QueryContext();
}

function popContext(): void {
	const parent = contextStack[contextStack.length - 1];
	if (!parent) throw new Error("popContext with empty stack");
	parent.deferredUserMessages.push(..._ctx.deferredUserMessages);
	const popped = contextStack.pop();
	if (!popped) throw new Error("popContext: stack drained between peek and pop");
	_ctx = popped;
}

// --- Shared state ---

let sessionState: SessionState | null = null;
let piUI: ExtensionUIContext | null = null;

export function resetSessionState(): void { sessionState = null; }
export function setPiUI(ui: ExtensionUIContext): void { piUI = ui; }

// --- Stream event processing ---

function ensureTurnStarted(): void {
	const c = ctx();
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(stopReason?: string): void {
	const c = ctx();
	const stream = c.currentPiStream;
	const out = c.turnOutput;
	if (!stream || !out) return;
	if (!c.turnStarted) ensureTurnStarted();
	const reason = stopReason === "length" ? "length" : "stop";
	stream.push({ type: "done", reason, message: out });
	stream.end();
	c.currentPiStream = null;
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
): void {
	const c = ctx();
	const stream = c.currentPiStream;
	const out = c.turnOutput;
	if (!stream || !out) return;
	c.turnSawStreamEvent = true;
	const event = (message as any).event;

	if (event?.type === "message_start") {
		c.turnToolCallIds = [];
		c.nextHandlerIdx = 0;
		if (event.message?.usage) updateUsage(out, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted();
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			stream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: out });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			stream.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: out });
		} else if (event.content_block?.type === "tool_use") {
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mapToolNameToPI(event.content_block.name, customToolNameToPi),
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			stream.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: out });
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: out });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: out });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: out });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: out });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: out });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: out });
		}
		return;
	}

	if (event?.type === "message_delta") {
		out.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(out, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		out.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: out });
		stream.end();
		c.currentPiStream = null;
		return;
	}
}

function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>): void {
	const c = ctx();
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content || !c.turnOutput) return;

	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	const out = c.turnOutput;

	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted();
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: out });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: out });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: out });
		} else if (block.type === "thinking") {
			ensureTurnStarted();
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: out });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: out });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: out });
		} else if (block.type === "tool_use") {
			ensureTurnStarted();
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			const mappedArgs = mapToolArgs(mapToolNameToPI(block.name, customToolNameToPi), block.input);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mapToolNameToPI(block.name, customToolNameToPi),
				arguments: mappedArgs,
			});
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: out });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: c.turnBlocks[idx] as any, partial: out });
		}
	}

	if (assistantMsg.usage) updateUsage(out, assistantMsg.usage, model);

	if (c.turnSawToolCall && c.currentPiStream) {
		out.stopReason = "toolUse";
		c.currentPiStream.push({ type: "done", reason: "toolUse", message: out });
		c.currentPiStream.end();
		c.currentPiStream = null;
	}
}

// --- Background consumer ---

async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted()) break;
		if (!ctx().currentPiStream || !ctx().turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi);
				break;
			case "result": {
				const rc = ctx();
				if (!rc.turnSawStreamEvent && message.subtype === "success" && rc.turnOutput) {
					ensureTurnStarted();
					const text = (message as any).result || "";
					rc.turnBlocks.push({ type: "text", text });
					const idx = rc.turnBlocks.length - 1;
					rc.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: rc.turnOutput });
					rc.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: rc.turnOutput });
					rc.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: rc.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "rate_limit_event": {
				const info = (message as any).rate_limit_info;
				debug("rate_limit_event:", JSON.stringify(info).slice(0, 300));
				if (info?.status === "rejected") {
					const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
					piUI?.notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
				} else if (info?.status === "allowed_warning") {
					piUI?.notify(`Claude rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`, "warning");
				}
				break;
			}
		}
	}

	debug(`consumeQuery: loop exited, aborted=${wasAborted()}, sessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
	return { capturedSessionId };
}

// --- Main entry point ---

export function streamBridge(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;

	debug(`streamBridge: activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}`);

	// --- Tool result delivery ---
	if (ctx().activeQuery) {
		ctx().currentPiStream = stream;
		ctx().resetTurnState(model);

		const allResults = extractAllToolResults(context);
		debug(`tool results: ${allResults.length} results, ${ctx().pendingToolCalls.size} waiting handlers`);

		for (const result of allResults) {
			const id = result.toolCallId;
			if (!id) continue;
			const pending = ctx().pendingToolCalls.get(id);
			if (pending) {
				ctx().pendingToolCalls.delete(id);
				debug(`resolved ${pending.toolName} [${id}]`);
				pending.resolve(result);
			} else {
				ctx().pendingResults.set(id, result);
				debug(`queued result [${id}]`);
			}
		}

		// Capture deferred user messages (steer during tool execution)
		if (lastMsgRole === "user") {
			const userPrompt = extractUserPrompt(context.messages);
			if (userPrompt) {
				ctx().deferredUserMessages.push(userPrompt);
				debug(`deferred steer: ${userPrompt.slice(0, 60)}`);
			}
		}

		if (sessionState) sessionState.cursor = context.messages.length;
		ctx().latestCursor = Math.max(ctx().latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (after abort) ---
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug("orphaned tool result after abort, emitting end_turn");
		if (sessionState) sessionState.cursor = context.messages.length;
		const c = ctx();
		queueMicrotask(() => {
			c.resetTurnState(model);
			if (c.turnOutput) stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---
	const isReentrant = ctx().activeQuery !== null;
	if (isReentrant) pushContext();

	ctx().currentPiStream = stream;
	ctx().pendingToolCalls.clear();
	ctx().pendingResults.clear();
	ctx().deferredUserMessages = [];
	ctx().resetTurnState(model);
	ctx().latestCursor = 0;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	const cwd = (options as any)?.cwd ?? process.cwd();

	const { sessionId: resumeSessionId, state: newState } = syncSession(
		context.messages, cwd, sessionState, customToolNameToSdk, model.id,
	);
	sessionState = newState;

	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";
	if (!promptText && !promptBlocks) promptText = "[continue]";

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks) : promptText;

	const mcpServers = buildMcpServer(mcpTools, ctx());
	const skillsAppend = extractSkillsBlock(context.systemPrompt);
	const effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;

	const queryOptions: Parameters<typeof query>[0]["options"] = {
		cwd,
		disallowedTools: DISALLOWED_BUILTIN_TOOLS,
		allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
		permissionMode: "bypassPermissions" as const,
		includePartialMessages: true,
		systemPrompt: {
			type: "preset" as const, preset: "claude_code" as const,
			...(skillsAppend ? { append: skillsAppend } : {}),
		},
		extraArgs: { model: model.id },
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
	};

	debug(`fresh query: model=${model.id}, tools=${mcpTools.length}, resume=${resumeSessionId?.slice(0, 8) ?? "none"}, effort=${effort ?? "default"}`);

	let wasAborted = false;
	const sdkQuery = query({ prompt, options: queryOptions });
	ctx().activeQuery = sdkQuery;
	const abortCtx = ctx();

	const onAbort = () => {
		wasAborted = true;
		abortCtx.deferredUserMessages = [];
		for (const pending of abortCtx.pendingToolCalls.values()) {
			pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] });
		}
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		if (sessionState) sessionState = { ...sessionState, needsRebuild: true };
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};

	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted)
		.then(async ({ capturedSessionId }) => {
			debug(`consumeQuery done: stopReason=${ctx().turnOutput?.stopReason}, aborted=${wasAborted}`);

			if (wasAborted || options?.signal?.aborted) {
				if (sessionState) sessionState = { ...sessionState, needsRebuild: true };
				const ac = ctx();
				ac.deferredUserMessages = [];
				if (ac.turnOutput) {
					ac.turnOutput.stopReason = "aborted";
					ac.turnOutput.errorMessage = "Operation aborted";
					ac.currentPiStream?.push({ type: "error", reason: "aborted", error: ac.turnOutput });
				}
				ac.currentPiStream?.end();
				ac.currentPiStream = null;
				return;
			}

			// Capture session ID
			const sid = capturedSessionId ?? sessionState?.sessionId;
			if (sid) {
				const cursor = Math.max(context.messages.length, ctx().latestCursor, sessionState?.cursor ?? 0);
				sessionState = { sessionId: sid, cursor, cwd };
			}

			// Replay deferred user messages (steers during tool execution)
			try {
				while (ctx().deferredUserMessages.length > 0 && !isReentrant && !wasAborted) {
					const steerPrompt = ctx().deferredUserMessages.shift();
					if (!steerPrompt) break;
					debug(`replaying deferred steer: ${steerPrompt.slice(0, 60)}`);
					ctx().resetTurnState(model);

					const resumeId = sessionState?.sessionId;
					if (!resumeId) { debug("no session for deferred message, dropping"); break; }

					const contQuery = query({
						prompt: steerPrompt,
						options: { ...queryOptions, resume: resumeId },
					});
					ctx().activeQuery = contQuery;

					try {
						const { capturedSessionId: contSid } = await consumeQuery(contQuery, customToolNameToPi, model, () => wasAborted);
						const newSid = contSid ?? sessionState?.sessionId;
						if (newSid) sessionState = { sessionId: newSid, cursor: sessionState?.cursor ?? 0, cwd };
					} catch (contError) {
						debug("continuation query error:", contError);
						break;
					} finally {
						contQuery.close();
					}
				}
			} finally {
				ctx().activeQuery = sdkQuery;
			}

			finalizeCurrentStream(ctx().turnOutput?.stopReason);
		})
		.catch((error) => {
			debug("query error:", error);
			if (wasAborted || options?.signal?.aborted) {
				if (sessionState) sessionState = { ...sessionState, needsRebuild: true };
			} else {
				sessionState = null;
			}
			const ec = ctx();
			ec.deferredUserMessages = [];
			if (ec.turnOutput) {
				ec.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				ec.turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
				ec.currentPiStream?.push({
					type: "error",
					reason: (ec.turnOutput.stopReason) as "aborted" | "error",
					error: ec.turnOutput,
				});
			}
			ec.currentPiStream?.end();
			ec.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			if (ctx().activeQuery === sdkQuery) {
				for (const pending of ctx().pendingToolCalls.values()) {
					pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
				}
				ctx().pendingToolCalls.clear();
				ctx().pendingResults.clear();
				if (isReentrant) {
					popContext();
				} else {
					ctx().activeQuery = null;
				}
			}
			sdkQuery.close();
		});

	return stream;
}
