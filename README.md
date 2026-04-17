# pi-claude-bridge

A [pi](https://github.com/mariozechner/pi) extension that adds Anthropic's latest Claude models to `pi` via the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview).

Exposes four models to `pi`:

- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

## Install

```sh
pi package install github:jhlabs/pi-claude-bridge
```

Then restart `pi` and pick a Claude model with `/model`.

## Authentication

This bridge uses the `@anthropic-ai/claude-agent-sdk`, which picks up credentials in this order:

1. `ANTHROPIC_API_KEY` environment variable — **recommended**
2. Amazon Bedrock / Google Vertex (via their respective env vars, if configured)
3. Any OAuth credentials already present on disk from a prior `claude` CLI login

**Use an API key.** Get one at [console.anthropic.com](https://console.anthropic.com/). Programmatic use of a personal Claude subscription token is restricted by Anthropic's [Consumer Terms §3.7](https://www.anthropic.com/legal/consumer-terms) and may cause your account to be flagged. Pay-per-use API access is governed by the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), which permits third-party products built on the Agent SDK.

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

## What this extension does

Translates between pi's streaming format and the Claude Agent SDK's `query()` interface:

- Converts pi tool definitions into an MCP server the SDK can call
- Maps pi history (messages, tool calls, tool results) into Anthropic message format
- Strips the SDK's built-in tools (`Read`, `Write`, `Bash`, `WebSearch`, etc.) so pi's own tool set is authoritative
- Preserves thinking blocks and signatures for multi-turn reasoning continuity
- Handles mid-turn steers by deferring user messages until the current tool loop drains

## Troubleshooting

**No models appear after `/model`**

Check that the extension loaded:

```sh
pi package list
```

If it's listed but models don't show, enable debug logs and look for registration:

```sh
export CLAUDE_BRIDGE_DEBUG=1
```

Logs land in `~/.pi/agent/claude-bridge.log`.

**401 / authentication errors**

Confirm `ANTHROPIC_API_KEY` is set and exported in the shell where you launch `pi`.

**Tool calls hang**

Likely a pi-side tool handler isn't returning. Debug logs show which tool is awaiting a result.

## Credits

Built on top of [**pi**](https://github.com/mariozechner/pi) by [Mario Zechner](https://github.com/badlogic) — a clean, fast, and extensible coding agent that makes projects like this one straightforward to build. Pi's extension API, streaming event protocol, and tool abstractions do almost all of the heavy lifting here.

The idea of bridging Claude models into `pi` via the Agent SDK was first implemented by [**Eli Dickinson**](https://github.com/elidickinson) in [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which inspired this project and the `claude-bridge` provider name. This is an independent reimplementation with a different architecture and scope.

The bridge itself is a thin wrapper around Anthropic's [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview).

## Disclaimer

This is an independent, community-built bridge. Not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" is a trademark of Anthropic, PBC.

## License

MIT — see [LICENSE](./LICENSE).
