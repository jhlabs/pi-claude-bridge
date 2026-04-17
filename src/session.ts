import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "./convert.js";
import { debug } from "./debug.js";

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	needsRebuild?: boolean;
}

/**
 * Sync pi's context with CC's session file.
 *
 * Two paths:
 *   REUSE — pi's history is in sync with existing session (or only drifted
 *     by a trailing assistant message). Returns existing sessionId.
 *   REBUILD — no session yet, or context diverged (provider switch, compaction,
 *     tree navigation, etc.). Wipes existing session file and writes fresh one.
 */
export function syncSession(
	messages: any[],
	cwd: string,
	state: SessionState | null,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): { sessionId: string | null; state: SessionState | null } {
	const priorMessages = messages.slice(0, -1);

	// REUSE path
	if (state && !state.needsRebuild) {
		const missed = priorMessages.slice(state.cursor);
		const trailingAssistantOnly = missed.length === 1 && missed[0]?.role === "assistant";

		if (missed.length === 0 || trailingAssistantOnly) {
			const newState = { ...state, cursor: priorMessages.length, cwd };
			debug(`session: reuse ${state.sessionId.slice(0, 8)}, cursor=${newState.cursor}`);
			return { sessionId: state.sessionId, state: newState };
		}
	}

	// REBUILD path — clean start
	if (priorMessages.length === 0) {
		debug("session: clean start, no prior messages");
		return { sessionId: null, state: null };
	}

	// Wipe old session if reusing ID (not after abort — rotate to avoid race)
	const preservedState = state && !state.needsRebuild ? state : null;
	if (preservedState) {
		deleteSession(preservedState.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	}

	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preservedState ? { sessionId: preservedState.sessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});

	const { anthropicMessages } = convertPiMessages(priorMessages, customToolNameToSdk);
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length) session.importMessages(repaired);
	session.save();

	const newState: SessionState = {
		sessionId: session.sessionId,
		cursor: priorMessages.length,
		cwd,
	};

	if (!state) {
		debug(`session: first turn, ${priorMessages.length} prior messages → ${session.sessionId.slice(0, 8)}`);
	} else if (preservedState) {
		debug(`session: rebuild (diverged), ${priorMessages.length} messages → ${session.sessionId.slice(0, 8)} (same id)`);
	} else {
		debug(`session: rebuild post-abort, ${priorMessages.length} messages → ${session.sessionId.slice(0, 8)} (rotated from ${state.sessionId.slice(0, 8)})`);
	}

	return { sessionId: session.sessionId, state: newState };
}
