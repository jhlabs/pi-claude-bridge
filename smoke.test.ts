import { describe, expect, test } from "bun:test";
import { MODELS, PROVIDER_ID } from "./models.js";

describe("extension entry point", () => {
	test("default export is a function accepting a pi API", async () => {
		const module = await import("./index.js");
		expect(typeof module.default).toBe("function");
		expect(module.default.length).toBe(1);
	});

	test("registers provider when invoked with a pi API stub", async () => {
		const { default: extension } = await import("./index.js");

		const registered: any[] = [];
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const piStub = {
			on: (event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			},
			registerProvider: (id: string, config: unknown) => {
				registered.push({ id, config });
			},
		};

		extension(piStub as any);

		expect(registered).toHaveLength(1);
		expect(registered[0].id).toBe(PROVIDER_ID);
		expect(registered[0].config.models).toEqual(MODELS);
		expect(registered[0].config.api).toBe("claude-bridge");
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	test("sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC env var when invoked", async () => {
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		const { default: extension } = await import("./index.js");
		extension({
			on: () => {},
			registerProvider: () => {},
		} as any);
		expect(`${process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`).toBe("1");
	});

	test("registration is idempotent — second invocation does not re-register", async () => {
		const { default: extension } = await import("./index.js");
		const registered: string[] = [];
		const piStub = {
			on: () => {},
			registerProvider: (id: string) => registered.push(id),
		};
		extension(piStub as any);
		extension(piStub as any);
		expect(registered.length).toBeLessThanOrEqual(1);
	});
});
