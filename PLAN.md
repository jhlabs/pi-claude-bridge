# pi-claude-bridge rewrite — Plan v2

## Goal

A pi extension that registers Claude models (including Opus 4.7) as a pi
provider, bridging pi's tool execution to Claude Code via the Agent SDK.
Replace the existing ~1900-line monolith with a well-structured extension we
fully control.

## Architecture

```
pi-claude-bridge/
├── index.ts          # Extension entry: registerProvider, lifecycle hooks
├── models.ts         # Model definitions we control
├── stream.ts         # Core streaming bridge: query() → AssistantMessageEventStream
├── session.ts        # Session sync: import pi history into CC session files
├── convert.ts        # pi messages → Anthropic format (for session import)
├── tools.ts          # Tool name/arg mapping + MCP server builder
├── package.json
├── tsconfig.json
└── test/
    ├── models.test.ts
    ├── convert.test.ts
    └── tools.test.ts
```

---

## File-by-file design

### models.ts (~30 lines)

Use `getModels("anthropic")` from pi-ai (which already includes Opus 4.7 as
of v0.67.6) and filter to latest models. We own the allowlist, pi-ai owns
the metadata (pricing, context window, etc.).

```ts
import { getModels } from "@mariozechner/pi-ai";

const LATEST_MODEL_IDS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

export const MODELS = getModels("anthropic")
  .filter(m => LATEST_MODEL_IDS.has(m.id))
  .map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
    id, name, reasoning, input, cost, contextWindow, maxTokens,
  }));

export function resolveModelId(input: string): string { ... }
```

Adding a new model = adding an ID to the Set. pi-ai provides the metadata.

### tools.ts (~120 lines)

All pi tools are exposed to CC as MCP tools (`mcp__custom-tools__*`). CC's
built-in tools (Read, Write, Edit, Bash, etc.) are **disallowed** — pi owns
tool execution.

```ts
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// SDK → pi: strip MCP prefix and map builtins
const SDK_TO_PI: Record<string, string> = {
  read: "read", write: "write", edit: "edit", bash: "bash",
};

export function mapToolNameToPI(sdkName: string, customMap?: Map<string, string>): string { ... }
export function mapToolNameToSDK(piName: string, customMap?: Map<string, string>): string { ... }
export function mapToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> { ... }

// CC built-in tools we disallow (pi handles these via its own tools)
export const DISALLOWED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
  "NotebookEdit", "EnterWorktree", "ExitWorktree",
  "AskUserQuestion", "TodoRead", "TodoWrite", ...
];

// TypeBox (JSON Schema) → Zod conversion for MCP tool schemas
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> { ... }

// Build MCP server that bridges pi tools to CC SDK
export function buildMcpServer(tools: Tool[], queryCtx: QueryContext): ... { ... }
```

**Key design: all tools go through MCP.** CC sees `mcp__custom-tools__read`,
`mcp__custom-tools__bash`, etc. The MCP handler blocks on a Promise until pi
delivers the tool result. This is the same architecture as the original.

### convert.ts (~100 lines)

Converts pi message history to Anthropic API format for session import.

- `convertPiMessages(messages, customToolNameToSdk)` → `{ anthropicMessages, sanitizedIds }`
- `messageContentToText(content)` → `string`
- `sanitizeToolId(id, cache)` → `string`
- `mapPiToolNameToSdk(name, customMap)` → `string`

Maps pi tool names to SDK names (Read, Write, etc. or MCP-prefixed) for
tool_use blocks in history. Handles user/assistant/toolResult message types.
Drops non-Anthropic thinking blocks (no valid signature).

### session.ts (~150 lines)

Manages session sync between pi's context and CC's session files. Uses
`cc-session-io` for JSONL session file management.

**Why this is needed:** Pi's context can diverge from CC's session in many
ways — provider switching, compaction, tree navigation, branch restore,
forked sessions. We must compare pi's context against what CC already knows
and rebuild when they diverge.

**Two paths (same semantics as original, cleaner code):**

```ts
interface SessionState {
  sessionId: string;
  cursor: number;  // how many pi messages CC has seen
  cwd: string;
  needsRebuild?: boolean;  // set after abort
}

export function syncSession(
  messages: Context["messages"],
  cwd: string,
  state: SessionState | null,
  customToolNameToSdk?: Map<string, string>,
  modelId?: string,
): { sessionId: string | null; state: SessionState | null } {

  const priorMessages = messages.slice(0, -1);

  // REUSE: state exists, no divergence (or only trailing assistant)
  if (state && !state.needsRebuild) {
    const missed = priorMessages.slice(state.cursor);
    if (missed.length === 0 || (missed.length === 1 && missed[0].role === "assistant")) {
      return { sessionId: state.sessionId, state: { ...state, cursor: priorMessages.length } };
    }
  }

  // REBUILD: context diverged, write fresh session file
  if (priorMessages.length === 0) {
    return { sessionId: null, state: null };  // clean start
  }

  // Wipe old session, create new with same ID (or fresh ID after abort)
  const preserveId = state && !state.needsRebuild;
  if (preserveId) deleteSession(state.sessionId, cwd, ...);

  const session = createSession({ projectPath: cwd, ...(preserveId ? { sessionId: state.sessionId } : {}), ... });
  // Import pi messages via convert.ts
  const { anthropicMessages } = convertPiMessages(priorMessages, customToolNameToSdk);
  session.importMessages(repairToolPairing(anthropicMessages));
  session.save();

  return {
    sessionId: session.sessionId,
    state: { sessionId: session.sessionId, cursor: priorMessages.length, cwd },
  };
}
```

### stream.ts (~350 lines) — The core

Bidirectional bridge between pi's `AssistantMessageEventStream` and the Claude
Agent SDK's `query()` generator.

**Per-query state (QueryContext):**

```ts
export class QueryContext {
  activeQuery: ReturnType<typeof query> | null = null;
  currentPiStream: AssistantMessageEventStream | null = null;
  pendingToolCalls = new Map<string, PendingToolCall>();
  pendingResults = new Map<string, McpResult>();
  turnToolCallIds: string[] = [];
  nextHandlerIdx = 0;

  // Per-turn (reset between turns)
  turnOutput: AssistantMessage | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;

  resetTurnState(model: Model<any>): void { ... }
}
```

**Reentrant query isolation:**

Pi subagents share the registered provider. A subagent can invoke Claude while
a parent Claude query is active. We handle this with a context stack:

```ts
let _ctx = new QueryContext();
const contextStack: QueryContext[] = [];

function pushContext(): void {
  contextStack.push(_ctx);
  _ctx = new QueryContext();
}

function popContext(): void {
  _ctx = contextStack.pop()!;
}
```

On fresh query, if `_ctx.activeQuery` is already set, push parent context and
create a fresh child. On completion, pop back to parent.

**Global provider guard:**

Only the first module instance registers the provider. Subagent module loads
skip registration via a `Symbol.for()` global flag. This prevents overwriting
the parent's `streamSimple` reference.

**Two entry paths in streamBridge():**

1. **Tool result delivery** (`activeQuery` exists):
   - Swap in new pi stream
   - Extract tool results from context tail
   - Match to pending MCP handlers by toolCallId, resolve promises
   - Update cursor

2. **Fresh query** (`activeQuery` is null):
   - Push context if reentrant
   - Resolve MCP tools from `context.tools`
   - Sync session via `session.ts`
   - Extract user prompt (text or with images)
   - Build MCP server
   - Start `query()` with options
   - Consume in background via `consumeQuery()`

**consumeQuery() — background generator consumer:**

Iterates the SDK generator, handles all message types:

| SDK message.type | Handling |
|------------------|----------|
| `stream_event` | Dispatch to `processStreamEvent()` |
| `assistant` | Dispatch to `processAssistantMessage()` (fallback) |
| `result` | Handle success/error text if no stream events seen |
| `system` (init) | Capture sessionId |
| `rate_limit_event` | Log / notify user |

**processStreamEvent() — delta mapping:**

Handles all `event.type` values from Anthropic's streaming protocol:

- `message_start` → update usage, init `turnToolCallIds`
- `content_block_start` (text/thinking/tool_use) → push block, emit `*_start`
- `content_block_delta` (text_delta/thinking_delta/input_json_delta/signature_delta) → update block, emit `*_delta`
- `content_block_stop` → finalize block, emit `*_end`. For tool_use: map args
- `message_delta` → update stop reason + usage
- `message_stop` + tool calls → end stream with `done(toolUse)`, MCP handlers block
- `message_stop` without tools → no-op (stream finalized after generator ends)

**processAssistantMessage() — fallback path:**

The SDK may yield a completed `assistant` message after/instead of stream events.
If `turnSawStreamEvent` is false, this is the primary content path. Same
block-by-block processing as stream events but from completed blocks.

**Abort handling:**

```ts
const onAbort = () => {
  wasAborted = true;
  // Drain pending MCP handlers so they don't hang
  for (const pending of ctx.pendingToolCalls.values()) {
    pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] });
  }
  ctx.pendingToolCalls.clear();
  ctx.pendingResults.clear();
  // Mark session dirty — late SDK writes may corrupt the JSONL
  if (sessionState) sessionState.needsRebuild = true;
  // Kill the SDK query
  sdkQuery.interrupt().catch(() => {});
  try { sdkQuery.close(); } catch {}
};
```

On abort completion: emit `error(aborted)` to pi stream. The `needsRebuild`
flag forces a session rotation (fresh ID) on next query, avoiding races with
orphan SDK writes.

**Skills/system prompt forwarding:**

Extract the skills block from pi's system prompt. Rewrite tool references
from `read` to `mcp__custom-tools__read` since CC's tools use the MCP prefix.
Pass as `systemPrompt.append` to the SDK query options.

```ts
function extractSkillsBlock(systemPrompt?: string): string | undefined { ... }
function rewriteSkillsBlock(block: string): string { ... }
```

### index.ts (~60 lines)

Extension entry point:

```ts
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODELS, PROVIDER_ID } from "./models.js";
import { streamBridge } from "./stream.js";

const ACTIVE_KEY = Symbol.for("claude-bridge:active");

export default function(pi: ExtensionAPI) {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const clearSession = () => { resetSessionState(); /* clear global flag if ours */ };
  pi.on("session_start", (event) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") clearSession();
  });
  pi.on("session_shutdown", clearSession);

  // Guard: only first module instance registers
  const g = globalThis as Record<symbol, any>;
  if (!g[ACTIVE_KEY]) {
    g[ACTIVE_KEY] = streamBridge;
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "claude-bridge",
      apiKey: "not-used",
      api: "claude-bridge",
      models: MODELS,
      streamSimple: streamBridge as any,
    });
  }
}
```

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.112",
    "@anthropic-ai/sdk": "^0.73.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "cc-session-io": "^0.3.1",
    "zod": "^3.25.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": ">=0.52.0",
    "@mariozechner/pi-coding-agent": ">=0.66.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^24.0.0"
  }
}
```

## Included (previously considered for omission)

1. **Deferred user messages / steer replay** — Without it, messages typed
   during tool execution are silently dropped. ~30 lines in the completion
   handler.
2. **Debug logging** — `CLAUDE_BRIDGE_DEBUG=1` writes to
   `~/.pi/agent/claude-bridge.log`. Essential for diagnosing bridge issues
   between two complex systems. ~20 lines of infra.
3. **Rate limit notifications** — `piUI.notify()` when Claude rate-limits.
   Without it, Claude just stops responding with no explanation. ~10 lines.

## What we intentionally leave out (v1)

1. **AskClaude tool** — not needed when Claude is the primary provider;
   self-delegation is blocked anyway (~300 lines saved)
2. **Config files** — no claude-bridge.json; only config was deprecated
   `maxHistoryMessages`
3. **Action summary / progress rendering** — AskClaude-specific UI;
   pi handles its own tool progress when Claude is primary provider

## What we keep from the original (learned from adversary review)

1. **Session sync with cc-session-io** — REUSE/REBUILD paths to keep CC's
   session aligned with pi's context through provider switches, compaction,
   tree navigation, etc.
2. **Reentrant query isolation** — QueryContext stack + global provider guard
   for subagent safety
3. **Full streaming event handling** — both processStreamEvent (deltas) and
   processAssistantMessage (fallback), plus result/system/rate_limit handling
4. **Abort cleanup** — drain pending handlers, mark session dirty, rotate
   session ID on next resume
5. **Skills block extraction and rewriting** — tool name rewrite for MCP prefix
6. **TypeBox → Zod conversion** — for MCP tool schemas
7. **All tools via MCP** — no CC built-in tools; pi owns execution

## Implementation order

1. `models.ts` + test — model list and resolver
2. `tools.ts` + test — name/arg mapping, schema conversion, MCP server builder
3. `convert.ts` + test — message format translation
4. `session.ts` — session sync (REUSE/REBUILD)
5. `stream.ts` — core streaming bridge (biggest piece)
6. `index.ts` — extension entry point
7. Manual integration test with pi

## Estimated size

~850 lines total (vs ~1900 original). The reduction comes from dropping
AskClaude (~300 lines), config system (~80 lines), action summary rendering
(~100 lines), compat shims (~50 lines), and verbose inline comments.
The core bridge logic, debug logging, steer replay, and rate limit
notifications are preserved.
