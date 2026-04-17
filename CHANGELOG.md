# Changelog

## 0.2.0 — 2026-04-17

First public release.

- Exposes `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` via the Claude Agent SDK
- Bridges pi tool definitions to an in-process MCP server so the SDK only sees pi's tools
- Preserves thinking blocks and signatures for multi-turn continuity
- Handles mid-turn steering (user messages arriving during tool execution)
- Registration guarded by a global symbol to prevent subagent re-registration
- Unit tests for message conversion, tool name/arg mapping, JSON-schema-to-zod conversion, model registry, and extension entry point
- MIT licensed

## 0.1.0

Internal pre-release.
