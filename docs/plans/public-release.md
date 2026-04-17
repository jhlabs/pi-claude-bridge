# Public Release — pi-claude-bridge v0.2

## Problem Frame

The extension works privately. To publish as an OSS repo we need:
- Automated tests (none today — hand-written by an agent, so regressions go undetected).
- A usable README (current repo has no README at all).
- Package metadata (LICENSE, description, author, repository) — missing.
- A code quality pass (non-null assertions and loose `as any` casts from the TDD-less initial build).
- ToS compliance framing: API-key-first, no Claude Code branding.

## Shaped Spec

**In scope**
- Unit tests for pure modules: `convert.ts`, `tools.ts`, `models.ts`.
- README with install/auth/models/troubleshooting and ToS disclaimer.
- LICENSE (MIT), CHANGELOG.md, package.json metadata fields.
- Remove non-null assertions (`!`) per user rules.
- Remove unnecessary `as any` casts — keep only where SDK types are genuinely dynamic.
- Branding check: no "Claude Code" references in user-facing docs; the code may keep `preset: "claude_code"` because that's an SDK API value, not branding.

**Out of scope**
- Integration tests against a live Anthropic API (would require credentials + cost).
- npm publication (user said "public repo" — GitHub only for now).
- Removing the OAuth fallback from the SDK (we don't control that; we only document the API-key path).

## Plan

Vertical slices — do each, verify, move on.

### Task 1 — Code quality pass (no behavior change)
- Remove every non-null assertion (`!`). Use optional chaining, early return, or explicit narrowing.
- Audit `as any` casts; keep only where the SDK exposes untyped `any` (e.g., `(message as any).event` — the SDK's `SDKMessage` union is not exposed). Replace the rest with proper narrowing.
- Extract a single `getCtx()` helper that narrows `turnOutput` + `currentPiStream` once per use site instead of re-null-checking.

**Acceptance**: `bun x tsc --noEmit` passes with `--strict`. No `!` or `as any` outside clearly-marked SDK bridge points.

### Task 2 — Tests (bun:test)
- `convert.test.ts`: `sanitizeToolId` idempotency + cache reuse; `messageContentToText` string/array/unknown; `convertPiMessages` for user/assistant/tool results including images and thinking blocks; `toolResultToMcpContent` string+array.
- `tools.test.ts`: `mapToolNameToPI`/`mapToolNameToSDK` with custom map, builtin map, MCP prefix strip; `mapToolArgs` renames + bash timeout default; `jsonSchemaToZodShape` for string/number/array/object/enum/required/optional.
- `models.test.ts`: MODELS contains the 4 expected IDs; `resolveModelId` partial matching.
- `smoke.test.ts`: import `./index.js` with a fake `ExtensionAPI` stub; assert `registerProvider` called once with the right shape and models; assert a second import does not register a second time (global guard).

**Acceptance**: `bun test` green, ≥ 25 assertions across the four files.

### Task 3 — README
- Name + one-line positioning.
- Install (settings.json `packages` array).
- Auth: **API key only** — `ANTHROPIC_API_KEY` env var. Explicit note that the SDK may also pick up Claude Code OAuth tokens; warn users that using an OAuth token from a Pro/Max subscription may violate Anthropic Consumer Terms §3.7.
- Models exposed.
- Troubleshooting (debug flag, session log location).
- Disclaimer section: "Not affiliated with Anthropic. 'Claude' is a trademark of Anthropic, PBC."
- Use "Claude" per the Agent SDK branding guidelines; never "Claude Code" or "Claude Code Agent".

### Task 4 — Package metadata
- LICENSE file (MIT, Johannes Herrmann).
- package.json: `description`, `repository` (placeholder URL user will set), `license: "MIT"`, `author`, `keywords`, `homepage`.
- CHANGELOG.md: 0.2.0 entry.
- `.gitignore` already fine.

### Task 5 — Review
- Spec check: README instructions actually produce a working install when followed step-by-step.
- Code quality re-scan: no `!`, no stray `as any`, imports ordered, no dead code.

### Task 6 — Verify
- `bun x tsc --noEmit` clean.
- `bun test` all green.
- Manual smoke: pi still loads the extension, `/model` shows 4 Claude models.

### Task 7 — Hand off for publishing
- User pushes to a new public GitHub repo.
- I **do not** create the GitHub repo or push — that's a user action (blast radius: public visibility).

## Review

Completed 2026-04-17.

- All 20 non-null assertions eliminated. Verified by grep; `bun x tsc --noEmit` with strict clean.
- Remaining `as` casts audited — all legitimate (SDK's opaque `SDKMessage` union, `as const` literals, JSON-schema traversal of `unknown` inputs, zod enum tuple shape).
- 59 tests / 128 assertions pass across `convert.test.ts`, `tools.test.ts`, `models.test.ts`, `smoke.test.ts`.
- README has install, API-key-only auth, model list, troubleshooting, affiliation disclaimer. No "Claude Code" references in user-facing text.
- Package metadata complete: MIT LICENSE, `description`, `author`, `repository`, `homepage`, `bugs`, `keywords`, `scripts` (test + typecheck), bumped to 0.2.0.
- CHANGELOG 0.2.0 entry written.
- `tsconfig.json` added so `bun x tsc --noEmit` works with no flags.

## Verify

- `bun x tsc --noEmit` — clean.
- `bun test` — 59 pass, 0 fail.
- Ready for user to `git push` to a public repo.
