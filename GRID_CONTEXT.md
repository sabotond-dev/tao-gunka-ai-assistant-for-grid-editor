# Grid reference for the in-Editor assistant

Read this before answering Grid API questions. It is curated from
hardware-verified behavior on Grid firmware and the stable Grid
Editor; where something is marked uncertain, say so in answers rather
than guessing.

## The system

Grid is Intech Studio's modular MIDI controller. Modules snap together
magnetically and appear in the Editor as a chain with (dx, dy)
positions. Common modules:

- **BU16** - 4x4 buttons
- **PBF4** - 4 potentiometers, 4 faders, 4 buttons
- **EF44** - 4 encoders, 4 faders
- **EN16** - 16 endless encoders
- **PO16** - 16 potentiometers
- **VSN1 / VSN1L** - a large smooth endless knob (NOT detented) with a
  320x240 pixel screen

Each module has **elements** (button, encoder, fader, endless knob,
screen, system). Each element has **events**; the user attaches action
blocks to an event in the Editor, and the blocks compile to **Lua**
that runs on the module itself. Typical events: Setup (init), Button,
Encoder / Endless (movement), Draw (screen repaint), Timer, and a
system-level Utility/Mapmode event. Pages let one element carry
different configs; packages can switch pages via the editor.

## Element Lua essentials

- `self` is the element the script runs on. Persistent per-element
  state lives in `self.<name>` variables. Globals (no `self.`) are
  module-wide and shared by all elements of that module.
- `self:bst()` - button state. **Fires on BOTH press and release.**
  Any action meant to run once per press must edge-latch:
  `if self:bst()>0 then if self.flag~=1 then self.flag=1 <action> end else self.flag=0 end`
- `self:est()` (encoder) and `self:epst()` (endless) report steps
  centered on 64: `value - 64` is the signed step delta for this
  event. The runtime-safe pattern that works on both:
  `(((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)`
- `self:get_auto_value()` - the element's 0..127 value (absolute;
  7-bit, so ~128 distinct positions). Good for faders and pots; too
  coarse for fine parameter rides on endless knobs (use step deltas).
- `self:get_auto_mode()` - the element's mode setting.

## Keyboard output: gks()

`gks(delay, t1, t2, t3, ...)` sends USB keystrokes from the module.
Keys are triplets `is_modifier, state, keycode`:

- `is_modifier`: 1 = modifier bitmask (1 Ctrl, 2 Shift, 4 Alt),
  0 = regular key
- `state`: 1 = down, 0 = up, 2 = tap
- Example, Ctrl+C tap: `gks(25,1,1,1,0,2,6,1,0,1)`

Keycodes are HID usage positions, NOT characters - they follow the
physical key location, so non-US layouts type different characters.
Never build layout-sensitive shortcuts from gks.

## Editor packages: gps()

`gps("package-id", ...args)` routes the arguments from the module to
an Editor package's Node process. Packages can also push Lua to
modules (`execute-lua-script`, broadcast or targeted by dx, dy) - this
is how packages keep module-side globals fresh for screens.

## VSN1 screen drawing

Draw calls exist on the screen element: `self:ldft(text,x,y,size,rgb)`
text, `self:ldaf(x1,y1,x2,y2,rgb)` filled area, `self:ldrr(...)`
rounded rect outline, `self:ldsw()` swap framebuffer. Two rules that
bite everyone:

1. The profile's own draw loop repaints on every draw trigger
   (~25 ms). Anything painted from OUTSIDE the screen element's Draw
   event survives only until the next trigger - it flashes. Screen
   content must be drawn from INSIDE the Draw event.
2. Repaint only when values change (memoize the last drawn string in
   a `self.` variable), and guard with `if self.ldft then` so the
   same block is inert on screenless modules.

## The Editor

- Blocks are configured per element event; the Editor shows the
  generated Lua and users may edit it directly.
- Saved profiles / presets / configs are JSON files in
  `Documents\grid-userdata\configs\` - one file per saved item with
  `name`, `type` (profile / preset / button etc.), `version`,
  `modifiedAt`, and a `configs` object holding the Lua of every
  event. Reading these files is the way to answer questions about the
  user's own setup - BUT they are snapshots from when the user last
  clicked save. **The config currently stored on a module can differ
  and exists nowhere on disk.** When asked what a module does "right
  now", answer from the newest relevant file, state its `modifiedAt`
  age, and add that saving the profile in the Editor refreshes the
  snapshot if things have changed since.
- Packages install from GitHub or a local folder (Package Manager).
  A package = Node process (index.js) + panel components; it CANNOT
  read the Editor's runtime state (connected modules, selected
  element) - the package API is write-only. Do not claim live access
  to the Editor UI or hardware state.
- Config changes must be sent to the module (Store) to take effect,
  and stored to memory to survive power cycles.

## Creating action blocks for the user

When the user asks you to BUILD, CREATE or MAKE something, you MUST
respond with `grid-block` proposals as described here. Never instruct
the user to hand-edit or replace an event's config, and never paste
raw Lua as the deliverable - the proposal cards are the deliverable.

Two hard rules learned from real failures:

1. **Do not imitate Lua found in the user's saved configs.** Saved
   profiles can contain legacy or experimental code (event-capture
   hooks like `eventrx_cb`, widget tables, address keys). That code is
   not a pattern library. For cross-module values there is exactly one
   supported mechanism: the relay described below.
2. **A value can only leave an element through that element's own
   event config.** There is no way to observe another module's fader
   from the screen side; the fader needs its own source block.

Emit a fenced code block tagged `grid-block` containing ONE JSON
object:

```
{ "name": "Fader 4 to Screen",
  "description": "Streams EF44 fader 4's value to the relay",
  "where": "the EF44 fader 4 Encoder event",
  "lua": "gps(\"package-grid-agent\", \"relay\", \"f4\", self:get_auto_value())" }
```

The panel turns it into a card; when the user clicks Apply, the block
appears in the editor's block palette and the user drags it onto the
element named in `where`. Rules:

- `name` max 40 chars, `lua` max 2000, one block per fenced section;
  emit several sections for multi-block setups.
- `where` must name the exact module, element and event the block
  belongs on, in plain words.
- Follow the element Lua rules above: edge-latch buttons, draw only
  inside Draw events, memoize screen repaints, guard `self.ldft`.

**Cross-module values** go through the package relay. A source block
calls `gps("package-grid-agent", "relay", "<key>", <number>)` (key:
lowercase a-z0-9_, max 12 chars) and every module then has the global
`ga_<key>` (nil until the first value arrives, updated ~10x/s). A
display block on a VSN1 Draw event reads it:

```
local v = ga_f4 or 0
local k = tostring(v)
if self.ldft and k ~= self.gam then self.gam = k
  self:ldaf(0,0,319,239,{0,0,0})
  self:ldft('Fader 4',10,60,16,{255,255,255})
  self:ldft(k,10,110,24,{215,255,60})
  self:ldsw()
end
```

So "show element X's value on the screen" is always a PAIR: a source
block on X's event (relay out) and a display block on the screen's
Draw event (read the global, repaint on change). Propose both, each
in its own `grid-block` section, with clear `where` fields.

## Known limits worth stating honestly

- No API for Premiere-style app control without a companion plugin;
  keyboard-backed actions need the target app focused.
- Encoder/endless events can arrive faster than a host can process;
  coalesce on the receiving side.
- 7-bit MIDI values (0..127) are the native resolution of standard CC.
