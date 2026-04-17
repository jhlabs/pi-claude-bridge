import { describe, expect, test } from "bun:test";
import {
	convertPiMessages,
	messageContentToText,
	sanitizeToolId,
	toolResultToMcpContent,
} from "./convert.js";

describe("sanitizeToolId", () => {
	test("passes through clean ids unchanged", () => {
		const cache = new Map<string, string>();
		expect(sanitizeToolId("toolu_abc-123", cache)).toBe("toolu_abc-123");
	});

	test("replaces invalid characters with underscores", () => {
		const cache = new Map<string, string>();
		expect(sanitizeToolId("tool.call#1", cache)).toBe("tool_call_1");
	});

	test("caches sanitized ids and returns same value", () => {
		const cache = new Map<string, string>();
		const first = sanitizeToolId("id.with.dots", cache);
		const second = sanitizeToolId("id.with.dots", cache);
		expect(first).toBe(second);
		expect(cache.size).toBe(1);
	});
});

describe("messageContentToText", () => {
	test("returns strings unchanged", () => {
		expect(messageContentToText("hello")).toBe("hello");
	});

	test("returns empty string for non-array non-string", () => {
		expect(messageContentToText(42)).toBe("");
		expect(messageContentToText(null)).toBe("");
	});

	test("extracts text from block array", () => {
		const result = messageContentToText([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]);
		expect(result).toBe("first\nsecond");
	});

	test("returns empty string when no text blocks present (only images)", () => {
		const result = messageContentToText([
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
		expect(result).toBe("");
	});

	test("includes non-text non-image block markers only when text also present", () => {
		const result = messageContentToText([
			{ type: "text", text: "hi" },
			{ type: "tool_use" },
		]);
		expect(result).toContain("hi");
		expect(result).toContain("[tool_use]");
	});
});

describe("convertPiMessages", () => {
	test("converts user string message", () => {
		const { anthropicMessages } = convertPiMessages([
			{ role: "user", content: "hello" },
		]);
		expect(anthropicMessages).toHaveLength(1);
		expect(anthropicMessages[0]).toEqual({ role: "user", content: "hello" });
	});

	test("replaces empty user string with [empty]", () => {
		const { anthropicMessages } = convertPiMessages([
			{ role: "user", content: "" },
		]);
		expect(anthropicMessages[0].content).toBe("[empty]");
	});

	test("converts user content array with text and image", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: "base64data", mimeType: "image/png" },
				],
			},
		]);
		expect(anthropicMessages[0].role).toBe("user");
		expect(anthropicMessages[0].content).toHaveLength(2);
		expect(anthropicMessages[0].content[0]).toEqual({ type: "text", text: "look at this" });
		expect(anthropicMessages[0].content[1].type).toBe("image");
		expect(anthropicMessages[0].content[1].source.media_type).toBe("image/png");
	});

	test("converts assistant message with text and tool_use", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling tool" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
				],
			},
		]);
		expect(anthropicMessages[0].role).toBe("assistant");
		const blocks = anthropicMessages[0].content;
		expect(blocks[0]).toEqual({ type: "text", text: "calling tool" });
		expect(blocks[1].type).toBe("tool_use");
		expect(blocks[1].name).toBe("Read");
		expect(blocks[1].id).toBe("t1");
	});

	test("preserves thinking blocks only for anthropic provider with signature", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "assistant",
				provider: "claude-bridge",
				content: [
					{ type: "thinking", thinking: "pondering", thinkingSignature: "sig123" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		const blocks = anthropicMessages[0].content;
		expect(blocks[0]).toEqual({ type: "thinking", thinking: "pondering", signature: "sig123" });
		expect(blocks[1]).toEqual({ type: "text", text: "answer" });
	});

	test("drops thinking blocks for non-anthropic provider", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "assistant",
				provider: "openai",
				content: [
					{ type: "thinking", thinking: "x", thinkingSignature: "sig" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(anthropicMessages[0].content).toHaveLength(1);
		expect(anthropicMessages[0].content[0].text).toBe("answer");
	});

	test("inserts placeholder when assistant has no compatible content", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "x", thinkingSignature: "" }],
				provider: "openai",
			},
		]);
		expect(anthropicMessages[0].content[0].text).toContain("omitted");
	});

	test("converts toolResult to user tool_result block", () => {
		const { anthropicMessages, sanitizedIds } = convertPiMessages([
			{ role: "toolResult", toolCallId: "call.1", content: "file contents", isError: false },
		]);
		expect(anthropicMessages).toHaveLength(1);
		expect(anthropicMessages[0].role).toBe("user");
		expect(anthropicMessages[0].content[0].type).toBe("tool_result");
		expect(anthropicMessages[0].content[0].tool_use_id).toBe("call_1");
		expect(sanitizedIds.get("call.1")).toBe("call_1");
	});

	test("skips toolResult without toolCallId", () => {
		const { anthropicMessages } = convertPiMessages([
			{ role: "toolResult", content: "x" },
		]);
		expect(anthropicMessages).toHaveLength(0);
	});

	test("reuses sanitized tool id between tool_use and tool_result", () => {
		const { anthropicMessages } = convertPiMessages([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t.1", name: "read", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "t.1", content: "done" },
		]);
		const useId = anthropicMessages[0].content[0].id;
		const resultId = anthropicMessages[1].content[0].tool_use_id;
		expect(useId).toBe(resultId);
	});
});

describe("toolResultToMcpContent", () => {
	test("wraps string as text block", () => {
		expect(toolResultToMcpContent("hello")).toEqual([{ type: "text", text: "hello" }]);
	});

	test("preserves empty string as empty text block", () => {
		expect(toolResultToMcpContent("")).toEqual([{ type: "text", text: "" }]);
	});

	test("extracts text and image blocks", () => {
		const result = toolResultToMcpContent([
			{ type: "text", text: "hi" },
			{ type: "image", data: "d", mimeType: "image/png" },
		]);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: "text", text: "hi" });
		expect(result[1]).toEqual({ type: "image", data: "d", mimeType: "image/png" });
	});

	test("returns fallback empty text block when no valid blocks present", () => {
		const result = toolResultToMcpContent([
			{ type: "unknown" },
		] as any);
		expect(result).toEqual([{ type: "text", text: "" }]);
	});
});
