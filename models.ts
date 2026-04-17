import { getModels } from "@mariozechner/pi-ai";

const LATEST_MODEL_IDS = new Set([
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
]);

// Use pi-ai's model registry for metadata (pricing, context window, etc.)
// We only control which models to expose.
export const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
		id, name, reasoning, input, cost, contextWindow, maxTokens,
	}));

export function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	const match = MODELS.find((m) => m.id === lower || m.id.includes(lower));
	return match?.id ?? input;
}

export const PROVIDER_ID = "claude-bridge";
