![Tao Gunka - an AI assistant for Grid Editor](.github/banner.png)

# Tao Gunka - An AI Assistant Package for Grid Editor

An AI assistant that lives inside the Grid Editor and actually knows
Grid. It sees what modules are connected, reads your saved configs,
answers from a hardware-verified reference, and builds working
configurations - single action blocks or whole profiles - that you
apply with a click.

The answers come from your own agent, running on your machine:
Claude Code on your Claude subscription, Codex on your ChatGPT
account, or any local OpenAI-compatible model server such as Ollama,
KoboldCpp or LM Studio. This package stores no API key, talks to no
server of its own, and adds no cost beyond what you already run.

## What it does

- **Knows your hardware, live.** Every question starts with a probe
  of the connected chain, so "what CC does this fader send" is
  answered about your actual setup. On the Claude Code backend the
  assistant can also query element values on demand: ask what a knob
  reads right now and it asks the module.
- **Answers Grid questions** from a built-in, hardware-verified
  reference: elements, events, the Lua API, MIDI down to 14-bit and
  NRPN, pressure-sensitive buttons, LEDs, timers, screen drawing,
  and the pitfalls everyone hits once. It knows the product line
  too, Knot included.
- **Reads your saved configs.** Ask "what does my VSN1 profile draw?"
  and it opens the file instead of asking you to paste anything. A
  toggle in the panel controls this, and shows exactly how many files
  it covers.
- **Builds action blocks.** Describe what you want; the assistant
  proposes blocks as cards in the chat. One click adds each block to
  the Editor's action picker, you place it on the element it names,
  and Store. The blocks are plain firmware Lua: once stored, your
  Grid does what they say with the Editor closed, on any computer or
  none - pair it with a Knot and there is no computer at all.
  Cross-module values use the firmware's own module-to-module
  messaging, never this package.
- **Builds whole profiles.** Ask for a complete setup ("turn my BU16
  into a drum pad") and one profile card arrives instead of sixteen
  blocks. Try now pushes the behavior straight into the module's
  memory to test-drive - it lasts until power-off - and Save puts a
  real profile file in your local profile list to load and Store for
  keeps. Loading replaces the module's current config, and the card
  says so.
- **Holds a conversation.** Follow-ups remember the thread, Stop
  interrupts, New chat starts clean, and the whole conversation
  survives an Editor restart. Switch agents mid-conversation and the
  thread carries over. While the stone thinks, it rumbles.

## Setup

1. Install this package in the Grid Editor's package manager and open
   its preferences. The chat is right there.
2. Click **"First time here? Set up your assistant step by step"** (or
   the Setup button next to New chat). The guide walks you through
   connecting your Claude subscription, your ChatGPT subscription, or
   a free local model - every step in plain words, with checkmarks
   that tick themselves as the guide detects your progress, and a
   test question at the end so you know it works.

For the impatient, the short versions:

- **Claude Code**: if you use the Claude desktop app, the CLI is
  already on your machine. Ask the assistant anything and it will
  offer a sign-in button; run `/login` in the terminal it opens and
  pick the subscription sign-in. A Check sign-in button verifies the
  connection and says exactly what is wrong when something is.
- **Codex**: `npm install -g @openai/codex` in a terminal, then ask
  anything and click "Sign in with ChatGPT" when offered.
- **Local**: install Ollama, pull a model, pick Local in the
  dropdown - the guide lists your installed models and a click
  selects one. No sign-in at all, nothing leaves your machine.

Windows, macOS and Linux are supported. On Linux, run the Editor as
the AppImage or deb build: a flatpak Editor is sandboxed away from
the host's agent CLIs (the Local backend still works if the sandbox
allows localhost networking). Gemini appears in the list but Google
has discontinued the Gemini CLI's free individual tier, so its
sign-in currently cannot work.

## What it reads, and when

Nothing is uploaded in bulk. Each question sends your prompt, the
conversation so far, a one-line summary of the connected modules,
and pointers to two places the agent may read on demand: the
built-in Grid reference, and your saved configs in
`Documents\grid-userdata` while the toggle allows it. Reads outside
those places are blocked by the agents' own sandboxes. Everything
else about the exchange is between you and the AI provider you
already have an account with.

Local models are the exception twice over: they cannot open files, so
the reference is pushed to them whole and they only see your configs'
file names, and nothing leaves your machine at all.

One honest limit: the saved files are your last saved snapshots. The
config currently stored on a module lives on the module, and nothing
on disk mirrors it. When you want the assistant to see your latest
state, save the profile first; the assistant will tell you how old a
snapshot is when it matters. On the Claude Code backend it can at
least read the live element values off the connected modules - but
values are not configs, and it knows the difference.

## How it works

The package runs in the Editor's package process and spawns your
agent's CLI headless, prompt on stdin, answer streamed back to the
panel. Live hardware queries go through a loopback-only MCP server
inside the package (bearer-token protected, started and stopped with
the package): it pushes a short Lua script to the modules and the
modules answer through the package channel. Agent-created blocks are
registered through the Editor's package API and behave like any
other block; profiles are written as real profile files your Editor
loads like any other. Cross-module values in generated configs ride
`gis()`, the firmware's own module-to-module messaging, so nothing
the assistant builds needs this package - or the Editor - to keep
working. The full reference the agents work from is
[GRID_CONTEXT.md](GRID_CONTEXT.md).

## The name

Tao Gunka is the stone boss of Ragnarok Online's Comodo caves, best
remembered for a card that doubled your health and turned whoever
found it into the party's wall. This assistant borrows the name in
tribute: a patient stone giant that sits quietly in its cave until
you come asking, and makes your setup considerably harder to kill.
The pixel monster is our own homage, drawn from scratch.

## Development

Add the repo folder as a local package in the Grid Editor's package
manager. Editor-side changes need a Force Restart in the package
manager; panel changes need an Editor restart. The test harness
lives in `test/` - `node test-agent-package.js` runs 70 mock checks
against a fake editor, `--real` exercises the installed Claude CLI.
