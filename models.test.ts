import { describe, expect, test } from "bun:test";
import { MODELS, PROVIDER_ID, resolveModelId } from "./models.js";

describe("MODELS", () => {
	test("exposes the four latest Claude models", () => {
		const ids = MODELS.map((m) => m.id).sort();
		expect(ids).toEqual([
			"claude-haiku-4-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-sonnet-4-6",
		]);
	});

	test("each model has required metadata", () => {
		for (const model of MODELS) {
			expect(typeof model.id).toBe("string");
			expect(typeof model.name).toBe("string");
			expect(typeof model.contextWindow).toBe("number");
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.maxTokens).toBe("number");
			expect(Array.isArray(model.input)).toBe(true);
		}
	});

	test("models include cost metadata", () => {
		for (const model of MODELS) {
			expect(model.cost).toBeDefined();
		}
	});
});

describe("resolveModelId", () => {
	test("returns exact match unchanged", () => {
		expect(resolveModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
	});

	test("matches case-insensitively", () => {
		expect(resolveModelId("Claude-Opus-4-7")).toBe("claude-opus-4-7");
	});

	test("matches partial substring", () => {
		expect(resolveModelId("opus-4-7")).toBe("claude-opus-4-7");
		expect(resolveModelId("haiku")).toBe("claude-haiku-4-5");
	});

	test("returns input unchanged when no match found", () => {
		expect(resolveModelId("gpt-4")).toBe("gpt-4");
	});
});

describe("PROVIDER_ID", () => {
	test("is the expected constant", () => {
		expect(PROVIDER_ID).toBe("claude-bridge");
	});
});
