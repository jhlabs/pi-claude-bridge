import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODELS, PROVIDER_ID } from "./models.js";
import { streamBridge, resetSessionState, setPiUI } from "./stream.js";

const ACTIVE_STREAM_KEY = Symbol.for("claude-bridge:activeStreamSimple");

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const clearSession = () => {
		resetSessionState();
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_KEY] === streamBridge) {
			g[ACTIVE_STREAM_KEY] = undefined;
		}
	};

	pi.on("session_start", (event, ctx) => {
		setPiUI(ctx.ui);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession();
		}
	});
	pi.on("session_shutdown", clearSession);

	// Guard: only first module instance registers (prevents subagent overwrites)
	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_KEY]) {
		g[ACTIVE_STREAM_KEY] = streamBridge;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: MODELS,
			streamSimple: streamBridge as any,
		});
	}
}
