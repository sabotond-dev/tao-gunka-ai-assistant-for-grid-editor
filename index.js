// Editor-side half of the Grid Agent package. Runs in the editor's
// package-manager process (Node). The chat panel (a preference
// component in the renderer) sends prompts over a message port; this
// side spawns the user's own AI agent CLI headless, streams the reply
// back, and never touches an API key.
//
// SPIKE build: one backend, Claude Code. The CLI authenticates with
// whatever login it already has (the user's subscription); this
// package only pipes text in and out. Codex CLI / Gemini CLI slots
// are the same shape and come later.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// A short capability brief so config answers are grounded in how Grid
// actually works. The real feature ships a curated pack; the spike
// proves the plumbing with a stub.
const GRID_BRIEF = [
  "You are the Grid Assistant inside Intech Studio's Grid Editor.",
  "Grid is a modular MIDI controller: modules (BU16 buttons, EF44",
  "encoders+faders, PBF4 pots+buttons+faders, VSN1 endless knob with",
  "a 320x240 screen) snap together and are configured in the Grid",
  "Editor by attaching action blocks to element events (Setup, Button,",
  "Encoder, Endless, Draw, Timer). Blocks compile to Lua that runs on",
  "the module. Useful Lua: self:bst() button state (fires on press AND",
  "release, so edge-latch with a self variable), self:est()/epst()",
  "encoder step around 64, gks() sends USB keystrokes, gps() routes to",
  "editor packages, self:ldft/ldaf/ldrr/ldsw draw on the VSN1 screen.",
  "Answer briefly and concretely. If unsure, say so.",
].join(" ");

let controller;
let chatPort;
let packageShutDown = false;

// --- Agent CLI resolution --------------------------------------------
// The Claude desktop app ships versioned CLI builds under
// %APPDATA%\Claude\claude-code\<version>\claude.exe; a standalone
// install puts `claude` on PATH. Env override for tests.

// Returns {cmd, preArgs}. A .js override (tests) runs through the
// current Node executable, since Windows will not spawn script shims
// directly.
//
// The desktop app's bundled CLI lives in TWO places depending on who
// is looking: the MSIX (Microsoft Store) install virtualizes AppData,
// so processes outside the app container - like the Grid Editor - see
// it only under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming.
// Non-store installs use plain %APPDATA%. Scan both, newest version
// wins, PATH `claude` as the final fallback.
function newestCliIn(base) {
  try {
    const versions = fs
      .readdirSync(base)
      .filter((d) => fs.existsSync(path.join(base, d, "claude.exe")))
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    if (versions.length > 0) {
      return path.join(base, versions[0], "claude.exe");
    }
  } catch (e) {
    /* not present */
  }
  return undefined;
}

function resolveAgentCli() {
  const override = process.env.GRID_AGENT_CLI;
  if (override) {
    if (override.endsWith(".js")) {
      return { cmd: process.execPath, preArgs: [override] };
    }
    return { cmd: override, preArgs: [] };
  }

  const bases = [
    path.join(process.env.APPDATA ?? "", "Claude", "claude-code"),
  ];
  try {
    const packagesDir = path.join(
      process.env.LOCALAPPDATA ?? "",
      "Packages",
    );
    for (const entry of fs.readdirSync(packagesDir)) {
      if (/^Claude_/.test(entry)) {
        bases.push(
          path.join(
            packagesDir,
            entry,
            "LocalCache",
            "Roaming",
            "Claude",
            "claude-code",
          ),
        );
      }
    }
  } catch (e) {
    /* no Packages dir (non-Windows or no store apps) */
  }

  for (const base of bases) {
    const cli = newestCliIn(base);
    if (cli) return { cmd: cli, preArgs: [] };
  }
  return { cmd: "claude", preArgs: [] };
}

// --- Chat ------------------------------------------------------------

let activeChild;

function toPanel(msg) {
  chatPort?.postMessage(msg);
}

function stopActiveChat() {
  if (activeChild) {
    try {
      activeChild.kill();
    } catch (e) {}
    activeChild = undefined;
  }
}

function runChat(prompt) {
  stopActiveChat();
  const { cmd, preArgs } = resolveAgentCli();

  // Nested-session env vars from a dev environment confuse the CLI's
  // own bookkeeping; a real editor session does not have them either.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ID;

  let child;
  try {
    child = spawn(
      cmd,
      [
        ...preArgs,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--append-system-prompt",
        GRID_BRIEF,
      ],
      { env, windowsHide: true, cwd: __dirname },
    );
  } catch (e) {
    toPanel({
      type: "chat-error",
      message: `Could not start agent: ${e.message}`,
    });
    return;
  }
  activeChild = child;
  toPanel({ type: "chat-start" });

  // The prompt goes over stdin: no shell, no quoting problems.
  child.stdin.write(prompt);
  child.stdin.end();

  let buffer = "";
  let stderrTail = "";
  let sawText = false;

  child.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (event.type === "assistant") {
        const parts = event.message?.content ?? [];
        for (const part of parts) {
          if (part.type === "text" && part.text) {
            // A signed-out CLI reports it as normal assistant text
            // (hardware-verified), not on stderr.
            if (/not logged in.*\/login/i.test(part.text)) {
              toPanel({ type: "chat-login-needed" });
              sawText = true;
              continue;
            }
            sawText = true;
            toPanel({ type: "chat-chunk", text: part.text });
          }
        }
      } else if (event.type === "result") {
        toPanel({
          type: "chat-done",
          seconds: Math.round((event.duration_ms ?? 0) / 100) / 10,
        });
      }
    }
  });

  child.stderr.on("data", (data) => {
    stderrTail = (stderrTail + data.toString()).slice(-400);
  });

  child.on("error", (e) => {
    if (activeChild === child) activeChild = undefined;
    toPanel({
      type: "chat-error",
      message:
        `Could not start the agent CLI (${e.message}). ` +
        "Is Claude Code installed?",
    });
  });

  child.on("close", (code) => {
    if (activeChild === child) activeChild = undefined;
    if (sawText) return; // normal path already reported chat-done
    const tail = stderrTail.trim();
    if (/log ?in|logged in/i.test(tail)) {
      toPanel({ type: "chat-login-needed" });
    } else {
      toPanel({
        type: "chat-error",
        message: tail || `Agent exited with code ${code} and said nothing`,
      });
    }
  });
}

// --- Package lifecycle -----------------------------------------------

exports.loadPackage = async function (gridController, persistedData) {
  packageShutDown = false;
  controller = gridController;
};

exports.unloadPackage = async function () {
  packageShutDown = true;
  stopActiveChat();
  chatPort?.close();
};

exports.addMessagePort = async function (port, senderId) {
  if (senderId !== "grid-agent-chat") return;
  chatPort = port;
  port.on("message", (e) => {
    const msg = e.data;
    if (msg?.type === "chat" && typeof msg.prompt === "string") {
      runChat(msg.prompt.slice(0, 4000));
    } else if (msg?.type === "chat-stop") {
      stopActiveChat();
      toPanel({ type: "chat-done", stopped: true });
    }
  });
  port.start();
};

// No gps actions in the spike; the package is panel-only.
exports.sendMessage = async function () {};
