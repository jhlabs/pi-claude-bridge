import { AgentSession, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODELS, PROVIDER_ID } from "./models.js";
import { streamBridge, resetSessionState, setPiUI } from "./stream.js";

const ACTIVE_STREAM_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const COMPACTION_PATCH_KEY = Symbol.for("claude-bridge:compactionPatched");

// Upstream default of AgentSession._checkCompaction skips aborted turns, so a
// user-aborted turn that parked the context near-full never triggers threshold
// compaction — the next prompt then hits API-side overflow cold. Flip the default
// so aborted turns still run the threshold check (overflow check is a no-op for
// aborted messages since their errorMessage doesn't match overflow patterns).
function patchCheckCompaction(): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[COMPACTION_PATCH_KEY]) return;
	const proto = AgentSession.prototype as unknown as {
		_checkCompaction?: (msg: unknown, skipAbortedCheck?: boolean, ...rest: unknown[]) => Promise<void>;
	};
	const original = proto._checkCompaction;
	if (typeof original !== "function") return;
	proto._checkCompaction = async function (msg, skipAbortedCheck = false, ...rest) {
		return original.call(this, msg, skipAbortedCheck, ...rest);
	};
	g[COMPACTION_PATCH_KEY] = true;
}

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	patchCheckCompaction();

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
