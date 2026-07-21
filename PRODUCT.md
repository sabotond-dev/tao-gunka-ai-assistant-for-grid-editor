# PRODUCT.md - Tao Gunka

## What it is

Tao Gunka is an AI assistant that lives inside Intech Studio's Grid
Editor as a package. A chat panel in the editor preferences answers
Grid questions, reads the user's saved configs, queries live
hardware, proposes action blocks and whole profiles, and runs on the
user's own AI subscription (Claude Code, Codex) or a local model.
No API keys, no cloud of its own.

## Register

product - the panel is a working tool embedded in a pro audio/MIDI
editor. Design serves the conversation and the hardware workflow.

## Users

Grid owners: musicians, producers, live performers, creative coders.
They sit at a desk with hardware controllers, usually in a dim studio
or stage-side, inside the Grid Editor which is a dark, dense,
instrument-like application. They are technical enough to own a
modular MIDI controller but many are not programmers - the assistant
exists so they never have to write Lua by hand.

## Brand

Intech Studio (Hungarian hardware maker). House kit: Grifter (display)
+ Inter, cream #F0E8E5 / near-black / signal orange #F4511E, 2px
borders, hard offset shadows, dry copy with no hype. The Grid Editor
itself is dark with an editor-green accent rgb(20,206,150); packages
inherit editor CSS vars (--foreground, --foreground-muted). Tao Gunka's
own mark is a grey stone-idol sprite (Ragnarok Online homage): patient,
solid, quietly powerful.

## Tone

Dry, honest, precise. The assistant states limits out loud
(values-not-configs, until-power-off). The UI should feel like part
of an instrument, not a SaaS chat widget.

## Anti-references

- Generic SaaS chat widgets (Intercom bubbles, rounded avatars,
  gradient send buttons)
- AI-product cliches: sparkles emoji, purple gradients, glassmorphism
- Anything that fights the host editor instead of sitting inside it

## Strategic principles

1. The editor is the venue: the panel must read as native to a dark,
   dense pro tool while being visibly better-finished than its
   surroundings.
2. Monospace is meaningful: Lua, values, file names, hardware
   positions are first-class content.
3. Every affordance states its honest scope (experimental, until
   power off, editor-dependent).
