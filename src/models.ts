import { getModels } from "@mariozechner/pi-ai";

const LATEST_MODEL_IDS = new Set([
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
]);

// Claude's 1M context window is an opt-in beta (context-1m-2025-08-07) that isn't
// universally available. 200k is the safe default that works on every account tier,
// and it makes pi-coding-agent's threshold compaction fire around 184k — well before
// a context-overflow API error. Users with confirmed 1M access can override via env.
const CONTEXT_WINDOW_DEFAULT = 200_000;
const envOverride = Number(process.env.CLAUDE_BRIDGE_CONTEXT_WINDOW);
const CONTEXT_WINDOW =
	Number.isFinite(envOverride) && envOverride > 0 ? envOverride : CONTEXT_WINDOW_DEFAULT;

export const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map(({ id, name, reasoning, input, cost, maxTokens }) => ({
		id, name, reasoning, input, cost,
		contextWindow: CONTEXT_WINDOW,
		maxTokens,
	}));

export function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	const match = MODELS.find((m) => m.id === lower || m.id.includes(lower));
	return match?.id ?? input;
}

export const PROVIDER_ID = "claude-bridge";
