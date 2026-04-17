import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	DISALLOWED_BUILTIN_TOOLS,
	jsonSchemaToZodShape,
	mapToolArgs,
	mapToolNameToPI,
	mapToolNameToSDK,
	MCP_SERVER_NAME,
	MCP_TOOL_PREFIX,
	resolveMcpTools,
} from "./tools.js";

describe("mapToolNameToPI", () => {
	test("maps built-in SDK names to lowercase pi names", () => {
		expect(mapToolNameToPI("Read")).toBe("read");
		expect(mapToolNameToPI("Write")).toBe("write");
		expect(mapToolNameToPI("Bash")).toBe("bash");
	});

	test("strips MCP prefix", () => {
		expect(mapToolNameToPI(`${MCP_TOOL_PREFIX}my_tool`)).toBe("my_tool");
	});

	test("returns name unchanged when no mapping applies", () => {
		expect(mapToolNameToPI("someUnknown")).toBe("someUnknown");
	});

	test("prefers custom map over built-in", () => {
		const customMap = new Map<string, string>([[`${MCP_TOOL_PREFIX}read`, "my_read"]]);
		expect(mapToolNameToPI(`${MCP_TOOL_PREFIX}read`, customMap)).toBe("my_read");
	});
});

describe("mapToolNameToSDK", () => {
	test("capitalizes built-in pi names", () => {
		expect(mapToolNameToSDK("read")).toBe("Read");
		expect(mapToolNameToSDK("edit")).toBe("Edit");
	});

	test("passes through unknown names unchanged", () => {
		expect(mapToolNameToSDK("my_custom_tool")).toBe("my_custom_tool");
	});

	test("returns empty for empty input", () => {
		expect(mapToolNameToSDK("")).toBe("");
	});

	test("uses custom map when provided", () => {
		const customMap = new Map<string, string>([["my_tool", `${MCP_TOOL_PREFIX}my_tool`]]);
		expect(mapToolNameToSDK("my_tool", customMap)).toBe(`${MCP_TOOL_PREFIX}my_tool`);
	});
});

describe("mapToolArgs", () => {
	test("renames file_path to path for read", () => {
		const result = mapToolArgs("read", { file_path: "/tmp/x" });
		expect(result).toEqual({ path: "/tmp/x" });
	});

	test("renames edit args", () => {
		const result = mapToolArgs("edit", {
			file_path: "/tmp/x",
			old_string: "a",
			new_string: "b",
		});
		expect(result).toEqual({ path: "/tmp/x", oldText: "a", newText: "b" });
	});

	test("adds default bash timeout", () => {
		const result = mapToolArgs("bash", { command: "ls" });
		expect(result.timeout).toBe(120);
	});

	test("preserves explicit bash timeout", () => {
		const result = mapToolArgs("bash", { command: "ls", timeout: 30 });
		expect(result.timeout).toBe(30);
	});

	test("handles undefined args as empty object", () => {
		const result = mapToolArgs("read", undefined);
		expect(result).toEqual({});
	});

	test("passes through unknown tools untouched", () => {
		const result = mapToolArgs("custom_tool", { foo: "bar" });
		expect(result).toEqual({ foo: "bar" });
	});
});

describe("jsonSchemaToZodShape", () => {
	test("returns empty shape for non-object schema", () => {
		expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
	});

	test("returns empty shape when properties missing", () => {
		expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
	});

	test("returns empty shape for null/undefined", () => {
		expect(jsonSchemaToZodShape(null)).toEqual({});
		expect(jsonSchemaToZodShape(undefined)).toEqual({});
	});

	test("converts object schema with required and optional fields", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			required: ["name"],
		});
		const schema = z.object(shape);
		expect(schema.safeParse({ name: "x" }).success).toBe(true);
		expect(schema.safeParse({ age: 30 }).success).toBe(false);
		expect(schema.safeParse({ name: "x", age: 30 }).success).toBe(true);
	});

	test("handles enum properties", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: { color: { type: "string", enum: ["red", "blue"] } },
			required: ["color"],
		});
		const schema = z.object(shape);
		expect(schema.safeParse({ color: "red" }).success).toBe(true);
		expect(schema.safeParse({ color: "green" }).success).toBe(false);
	});

	test("handles array properties", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: { tags: { type: "array", items: { type: "string" } } },
			required: ["tags"],
		});
		const schema = z.object(shape);
		expect(schema.safeParse({ tags: ["a", "b"] }).success).toBe(true);
		expect(schema.safeParse({ tags: [1, 2] }).success).toBe(false);
	});

	test("handles boolean and integer types", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				active: { type: "boolean" },
				count: { type: "integer" },
			},
			required: ["active", "count"],
		});
		const schema = z.object(shape);
		expect(schema.safeParse({ active: true, count: 5 }).success).toBe(true);
		expect(schema.safeParse({ active: "yes", count: 5 }).success).toBe(false);
	});
});

describe("resolveMcpTools", () => {
	test("returns empty when no tools provided", () => {
		const result = resolveMcpTools({});
		expect(result.mcpTools).toEqual([]);
		expect(result.customToolNameToSdk.size).toBe(0);
		expect(result.customToolNameToPi.size).toBe(0);
	});

	test("prefixes tool names with MCP prefix in both maps", () => {
		const result = resolveMcpTools({
			tools: [
				{ name: "my_tool", description: "x", parameters: { type: "object", properties: {} } } as any,
			],
		});
		expect(result.mcpTools).toHaveLength(1);
		expect(result.customToolNameToSdk.get("my_tool")).toBe(`${MCP_TOOL_PREFIX}my_tool`);
		expect(result.customToolNameToPi.get(`${MCP_TOOL_PREFIX}my_tool`)).toBe("my_tool");
	});
});

describe("constants", () => {
	test("MCP_SERVER_NAME matches MCP_TOOL_PREFIX", () => {
		expect(MCP_TOOL_PREFIX).toBe(`mcp__${MCP_SERVER_NAME}__`);
	});

	test("DISALLOWED_BUILTIN_TOOLS includes pi-overlapping tools", () => {
		expect(DISALLOWED_BUILTIN_TOOLS).toContain("Read");
		expect(DISALLOWED_BUILTIN_TOOLS).toContain("Write");
		expect(DISALLOWED_BUILTIN_TOOLS).toContain("Bash");
		expect(DISALLOWED_BUILTIN_TOOLS).toContain("WebSearch");
	});
});
