# Grid Agent package (spike)

An AI chat that lives inside the Grid Editor. Ask about your setup,
your config, or what a block does, and the answer comes from your own
agent: the package runs your installed Claude Code headless, on your
subscription, on your machine. No API key exists anywhere in it.

## How it works

The chat panel is the package's preference component. Prompts travel
over the package message port to the Node side, which spawns
`claude -p --output-format stream-json` with a Grid capability brief
as the system prompt, and streams the reply back into the panel.

One-time setup: sign the CLI in with `claude setup-token` in any
terminal. The Claude desktop app keeps its own login to itself, so the
CLI needs this once even if the app is signed in.

## Spike status

Proven: panel to CLI round trip with streaming, signed-out detection
(the CLI reports it as assistant text, not an error), prompt clamping,
and CLI resolution from the desktop app's bundled builds with a PATH
fallback.

Next: an MCP server inside the editor exposing live state (connected
modules, selected element's config Lua), read hooks in the Editor to
feed it, curated capability pack, and Codex / Gemini CLI backends in
the same slot.
