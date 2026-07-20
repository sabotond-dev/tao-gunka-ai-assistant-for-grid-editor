# Tao Gunka

An AI assistant that lives inside the Grid Editor and actually knows
Grid. Ask why your button fires twice and it answers with the
edge-latch fix. Ask what your saved profile does and it reads the
file. Describe a block you want and it builds one you can add to your
config. The name honors a stone-hearted boss from a beloved retro
MMO; like him, it sits quietly in its cave until you come asking.

The answers come from your own agent, running on your machine:
Claude Code on your Claude subscription, Codex on your ChatGPT
account, or any local OpenAI-compatible model server such as Ollama,
KoboldCpp or LM Studio. This package stores no API key, talks to no
server of its own, and adds no cost beyond what you already run.

## What it does

- **Answers Grid questions** from a built-in, hardware-verified
  reference: elements, events, the Lua API, screen drawing, the
  pitfalls everyone hits once.
- **Reads your saved configs.** Ask "what does my VSN1 profile draw?"
  and it opens the file instead of asking you to paste anything. A
  toggle in the panel controls this, and shows exactly how many files
  it covers.
- **Builds action blocks.** Describe what you want; the assistant
  proposes blocks as cards in the chat. One click adds each block to
  the Editor's action picker, you place it on the element it names,
  and Store. Cross-module values (a fader on one module, a screen on
  another) route through the package automatically.
- **Holds a conversation.** Follow-ups remember the thread, Stop
  interrupts a running answer, New chat starts clean. You can switch
  agents mid-conversation and the thread carries over.

## Setup

1. Install this package in the Grid Editor's package manager and open
   its preferences. The chat is right there.
2. Connect an agent, one time:
   - **Claude Code**: if you use the Claude desktop app, the CLI is
     already on your machine. Ask the assistant anything and it will
     offer a sign-in button; run `/login` in the terminal it opens and
     pick the subscription sign-in.
   - **Codex**: `npm install -g @openai/codex` in a terminal, then ask
     anything and click "Sign in with ChatGPT" when offered.
   - **Local**: start your server (Ollama, KoboldCpp, LM Studio),
     pick Local in the dropdown, and set the URL and model in the row
     that appears. No sign-in at all.
3. Pick the agent in the dropdown under the chat. That is the whole
   setup.

Gemini appears in the list but Google has discontinued the Gemini
CLI's free individual tier, so its sign-in currently cannot work.

## What it reads, and when

Nothing is uploaded in bulk. Each question sends your prompt, the
conversation so far, and pointers to two places the agent may read on
demand: the built-in Grid reference, and your saved configs in
`Documents\grid-userdata` while the toggle allows it. Reads outside
those two places are blocked by the agents' own sandboxes. Everything
else about the exchange is between you and the AI provider you
already have an account with.

Local models are the exception twice over: they cannot open files, so
the reference is pushed to them whole and they only see your configs'
file names, and nothing leaves your machine at all.

One honest limit: the files are your last saved snapshots. The config
currently stored on a module lives on the module, and nothing on disk
mirrors it. When you want the assistant to see your latest state,
save the profile first; the assistant will tell you how old a
snapshot is when it matters.

## How it works

The package runs in the Editor's package process and spawns your
agent's CLI headless, prompt on stdin, answer streamed back to the
panel. Agent-created blocks are registered through the Editor's
package API and behave like any other block. Value routing uses a
small relay: source blocks report through the package, and every
module sees the value as a `ga_<key>` Lua global for display blocks
to read. The full reference the agents work from is
[GRID_CONTEXT.md](GRID_CONTEXT.md).

## Development

Add the repo folder as a local package in the Grid Editor's package
manager. Editor-side changes need a Force Restart in the package
manager; panel changes need an Editor restart.
