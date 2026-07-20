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

// The system prompt stays slim: role, honesty rules, and where the
// real context lives. The agent reads GRID_CONTEXT.md (curated Grid
// reference, ships with the package) and the user's saved configs
// on demand with its own file tools.
function buildSystemPrompt(profilesDir) {
  const parts = [
    "You are the Grid Assistant inside Intech Studio's Grid Editor.",
    "Before answering Grid API questions, read GRID_CONTEXT.md in the",
    "working directory - it is the authoritative reference here.",
  ];
  if (profilesDir) {
    parts.push(
      `The user's saved Grid profiles, presets and configs are JSON`,
      `files in "${profilesDir}" (each holds name, type, and the Lua`,
      `of every event). When a question concerns the user's own setup,`,
      `list and read the relevant files instead of asking the user to`,
      `paste anything.`,
    );
  }
  parts.push(
    "You have no live view of connected hardware or the Editor UI -",
    "say so when it matters. Answer briefly and concretely; when the",
    "reference does not cover something, say you are unsure.",
  );
  return parts.join(" ");
}

// The user's saved configs (stable editor writes them here). Checked
// at load; the panel toggle controls whether the agent may read them.
function findProfilesDir() {
  const dir = path.join(
    process.env.USERPROFILE ?? "",
    "Documents",
    "grid-userdata",
    "configs",
  );
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch (e) {
    return undefined;
  }
}

function countProfiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch (e) {
    return 0;
  }
}

const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

let controller;
let chatPort;
let packageShutDown = false;
let profilesDir;
let shareProfiles = true;

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

  const withProfiles = shareProfiles && profilesDir;
  const args = [
    ...preArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Read-only file tools auto-approve so the agent can consult
    // GRID_CONTEXT.md and the user's configs without permission stalls.
    "--allowedTools",
    "Read,Glob,Grep",
    "--append-system-prompt",
    buildSystemPrompt(withProfiles ? profilesDir : undefined),
  ];
  if (withProfiles) {
    args.push("--add-dir", profilesDir);
  }

  let child;
  try {
    child = spawn(cmd, args, { env, windowsHide: true, cwd: __dirname });
  } catch (e) {
    toPanel({
      type: "chat-error",
      message: `Could not start agent: ${e.message}`,
    });
    return;
  }
  activeChild = child;
  toPanel({ type: "chat-start" });

  // Agentic runs can wander; a hung CLI should not wedge the panel.
  const killTimer = setTimeout(() => {
    if (activeChild === child) {
      stopActiveChat();
      toPanel({ type: "chat-error", message: "Agent timed out (5 min)" });
    }
  }, CHAT_TIMEOUT_MS);
  child.on("close", () => clearTimeout(killTimer));

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

function sendAgentStatus() {
  toPanel({
    type: "agent-status",
    shareProfiles,
    profilesFound: !!profilesDir,
    profileCount: profilesDir ? countProfiles(profilesDir) : 0,
  });
}

exports.loadPackage = async function (gridController, persistedData) {
  packageShutDown = false;
  controller = gridController;
  shareProfiles = persistedData?.shareProfiles !== false;
  profilesDir = findProfilesDir();
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
    } else if (msg?.type === "set-share-profiles") {
      shareProfiles = !!msg.enabled;
      controller?.sendMessageToEditor({
        type: "persist-data",
        data: { shareProfiles },
      });
      sendAgentStatus();
    } else if (msg?.type === "request-status") {
      sendAgentStatus();
    }
  });
  port.start();
  sendAgentStatus();
};

// No gps actions in the spike; the package is panel-only.
exports.sendMessage = async function () {};
