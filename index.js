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
      `files in "${profilesDir}" (each holds name, type, modifiedAt,`,
      `and the Lua of every event). When a question concerns the`,
      `user's own setup, list and read the relevant files instead of`,
      `asking the user to paste anything. These are the user's LAST`,
      `SAVED snapshots, not necessarily what is stored on the module`,
      `right now: when asked about current state, say which file you`,
      `used and how old it is, and note that saving the profile in`,
      `the Editor refreshes it.`,
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

// Conversation continuity: the CLI names its session in the stream
// events; passing it back with --resume turns one-shot questions into
// a conversation. Cleared by the panel's New chat, or when a resume
// fails (old sessions expire).
let lastSessionId;

// --- Backends --------------------------------------------------------
// Three agents, one contract: the user's own CLI, signed in with the
// user's own account, prompt over stdin (never argv - argv would pass
// user text through cmd.exe), answer back to the panel. Claude Code
// streams and resumes natively; Codex and Gemini answer in one piece
// and get continuity from a package-kept transcript instead.

const BACKENDS = {
  claude: { label: "Claude Code" },
  codex: { label: "Codex (ChatGPT)" },
  gemini: { label: "Gemini" },
};

let backendId = "claude";

// Last few Q/A pairs, prepended for the backends without native
// session resume. Shared across backends so switching mid-chat keeps
// the thread of the conversation.
let transcript = [];

function transcriptPrefixed(prompt) {
  if (transcript.length === 0) return prompt;
  const history = transcript
    .map((t) => `Q: ${t.q}\nA: ${t.a}`)
    .join("\n---\n");
  return `Earlier in this conversation:\n${history}\n===\nNew question: ${prompt}`;
}

function rememberTurn(q, a) {
  if (!a) return;
  transcript.push({ q: q.slice(0, 1000), a: a.slice(0, 2000) });
  if (transcript.length > 6) transcript.shift();
}

// npm-installed CLIs are .cmd shims, which Node refuses to spawn
// directly - route them through cmd.exe. Overrides ending in .js run
// under the current Node (tests).
function resolveNpmCli(overrideEnv, cmdName) {
  const override = process.env[overrideEnv];
  if (override) {
    if (override.endsWith(".js")) {
      return { cmd: process.execPath, preArgs: [override], found: true };
    }
    return { cmd: override, preArgs: [], found: true };
  }
  const shim = path.join(process.env.APPDATA ?? "", "npm", `${cmdName}.cmd`);
  if (fs.existsSync(shim)) {
    return { cmd: "cmd.exe", preArgs: ["/c", shim], found: true };
  }
  return { cmd: "cmd.exe", preArgs: ["/c", cmdName], found: false };
}

function backendAvailability() {
  const claudeResolved = resolveAgentCli();
  return {
    claude: !!process.env.GRID_AGENT_CLI || claudeResolved.cmd !== "claude",
    codex: resolveNpmCli("GRID_AGENT_CODEX", "codex").found,
    gemini: resolveNpmCli("GRID_AGENT_GEMINI", "gemini").found,
  };
}

// Codex's read-only sandbox cannot leave the workspace, so the user's
// configs are mirrored into a folder beside the package before each
// Codex question - same data Claude reads via --add-dir, no wider
// grant. Toggling sharing off deletes the mirror.
const CONFIG_MIRROR = path.join(__dirname, ".user-configs");

function syncConfigMirror() {
  if (!shareProfiles || !profilesDir) return undefined;
  try {
    fs.rmSync(CONFIG_MIRROR, { recursive: true, force: true });
    fs.mkdirSync(CONFIG_MIRROR, { recursive: true });
    for (const f of fs.readdirSync(profilesDir)) {
      if (f.endsWith(".json")) {
        fs.copyFileSync(
          path.join(profilesDir, f),
          path.join(CONFIG_MIRROR, f),
        );
      }
    }
    return CONFIG_MIRROR;
  } catch (e) {
    return undefined;
  }
}

function removeConfigMirror() {
  try {
    fs.rmSync(CONFIG_MIRROR, { recursive: true, force: true });
  } catch (e) {}
}

// Codex and Gemini read their instructions from AGENTS.md / GEMINI.md
// in the working directory - the same brief Claude gets as a system
// prompt, kept fresh whenever the profile toggle changes. Their
// configs path is the in-workspace mirror.
function writeContextFiles() {
  const brief = buildSystemPrompt(
    shareProfiles && profilesDir ? CONFIG_MIRROR : undefined,
  );
  for (const name of ["AGENTS.md", "GEMINI.md"]) {
    try {
      fs.writeFileSync(path.join(__dirname, name), brief + "\n");
    } catch (e) {
      /* read-only install location: the backends just run unbriefed */
    }
  }
}

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
  if (backendId === "codex") return runChatCodex(prompt);
  if (backendId === "gemini") return runChatGemini(prompt);
  return runChatClaude(prompt);
}

function runChatClaude(prompt, isRetry) {
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
  const resumingFrom = lastSessionId;
  if (resumingFrom) {
    args.push("--resume", resumingFrom);
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
  let seenSessionId;
  let fullText = "";

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
      if (event.session_id) seenSessionId = event.session_id;
      if (event.type === "assistant") {
        const parts = event.message?.content ?? [];
        for (const part of parts) {
          if (part.type === "text" && part.text) {
            // A signed-out CLI reports it as normal assistant text
            // (hardware-verified), not on stderr.
            if (/not logged in.*\/login/i.test(part.text)) {
              toPanel({ type: "chat-login-needed", backend: "claude" });
              sawText = true;
              continue;
            }
            sawText = true;
            fullText += part.text;
            toPanel({ type: "chat-chunk", text: part.text });
          }
        }
      } else if (event.type === "result") {
        if (seenSessionId) lastSessionId = seenSessionId;
        rememberTurn(prompt, fullText);
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
      toPanel({ type: "chat-login-needed", backend: "claude" });
      return;
    }
    // A dead --resume target (expired or cleaned-up session) should
    // degrade to a fresh conversation, not an error.
    if (resumingFrom && !isRetry) {
      lastSessionId = undefined;
      runChatClaude(prompt, true);
      return;
    }
    toPanel({
      type: "chat-error",
      message: tail || `Agent exited with code ${code} and said nothing`,
    });
  });
}

// Codex answers arrive via --output-last-message (its stdout is
// progress logs, not the answer): one chunk on completion. The
// read-only sandbox blocks writes and commands but allows file reads,
// so AGENTS.md and the configs stay reachable.
function runChatCodex(prompt) {
  stopActiveChat();
  syncConfigMirror();
  const { cmd, preArgs } = resolveNpmCli("GRID_AGENT_CODEX", "codex");
  const outFile = path.join(
    require("os").tmpdir(),
    `grid-agent-codex-${Date.now()}.txt`,
  );
  let child;
  try {
    child = spawn(
      cmd,
      [
        ...preArgs,
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        outFile,
      ],
      { windowsHide: true, cwd: __dirname },
    );
  } catch (e) {
    toPanel({ type: "chat-error", message: `Could not start Codex: ${e.message}` });
    return;
  }
  activeChild = child;
  toPanel({ type: "chat-start" });
  child.stdin.write(transcriptPrefixed(prompt));
  child.stdin.end();

  let tail = "";
  const keepTail = (d) => {
    tail = (tail + d.toString()).slice(-600);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);

  const killTimer = setTimeout(() => {
    if (activeChild === child) {
      stopActiveChat();
      toPanel({ type: "chat-error", message: "Codex timed out (5 min)" });
    }
  }, CHAT_TIMEOUT_MS);

  child.on("error", (e) => {
    if (activeChild === child) activeChild = undefined;
    toPanel({ type: "chat-error", message: `Could not start Codex: ${e.message}` });
  });

  child.on("close", () => {
    clearTimeout(killTimer);
    if (activeChild === child) activeChild = undefined;
    let answer = "";
    try {
      answer = fs.readFileSync(outFile, "utf8").trim();
      fs.unlinkSync(outFile);
    } catch (e) {
      /* no answer file */
    }
    if (answer) {
      rememberTurn(prompt, answer);
      toPanel({ type: "chat-chunk", text: answer });
      toPanel({ type: "chat-done" });
    } else if (/log ?in|logged ?in|401|auth/i.test(tail)) {
      toPanel({ type: "chat-login-needed", backend: "codex" });
    } else {
      toPanel({
        type: "chat-error",
        message: tail.trim().slice(-300) || "Codex returned nothing",
      });
    }
  });
}

// Gemini streams its answer on stdout in plan (read-only) mode; the
// question rides stdin and -p carries only a fixed instruction, so no
// user text ever passes through cmd.exe argv.
function runChatGemini(prompt) {
  stopActiveChat();
  syncConfigMirror(); // in-workspace mirror, same as codex
  const { cmd, preArgs } = resolveNpmCli("GRID_AGENT_GEMINI", "gemini");
  const args = [
    ...preArgs,
    "-p",
    "Answer the question given on stdin.",
    "--approval-mode",
    "plan",
    "-o",
    "text",
  ];
  let child;
  try {
    child = spawn(cmd, args, { windowsHide: true, cwd: __dirname });
  } catch (e) {
    toPanel({ type: "chat-error", message: `Could not start Gemini: ${e.message}` });
    return;
  }
  activeChild = child;
  toPanel({ type: "chat-start" });
  child.stdin.write(transcriptPrefixed(prompt));
  child.stdin.end();

  let fullText = "";
  let stderrTail = "";
  child.stdout.on("data", (d) => {
    const text = d.toString();
    fullText += text;
    toPanel({ type: "chat-chunk", text });
  });
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-600);
  });

  const killTimer = setTimeout(() => {
    if (activeChild === child) {
      stopActiveChat();
      toPanel({ type: "chat-error", message: "Gemini timed out (5 min)" });
    }
  }, CHAT_TIMEOUT_MS);

  child.on("error", (e) => {
    if (activeChild === child) activeChild = undefined;
    toPanel({ type: "chat-error", message: `Could not start Gemini: ${e.message}` });
  });

  child.on("close", () => {
    clearTimeout(killTimer);
    if (activeChild === child) activeChild = undefined;
    if (fullText.trim()) {
      rememberTurn(prompt, fullText.trim());
      toPanel({ type: "chat-done" });
    } else if (/IneligibleTier|no longer supported/i.test(stderrTail)) {
      // Google retired the Gemini CLI's free individual tier
      // (verified live 2026-07-20); signing in cannot fix this one.
      toPanel({
        type: "chat-error",
        message:
          "Google has discontinued the Gemini CLI's free individual " +
          "tier, so Google-account sign-in no longer works. A Gemini " +
          "API key mode may come later; use Claude Code or Codex for " +
          "now.",
      });
    } else if (/auth|log ?in|credential|sign.?in|oauth/i.test(stderrTail)) {
      toPanel({ type: "chat-login-needed", backend: "gemini" });
    } else {
      toPanel({
        type: "chat-error",
        message: stderrTail.trim().slice(-300) || "Gemini returned nothing",
      });
    }
  });
}

// --- Sign-in from the panel ------------------------------------------
// codex login does all its interaction in the browser, so a plain
// spawn is a one-click sign-in. Claude's /login is an interactive TUI:
// the best one-click is opening a ready terminal running the CLI.

let loginChild;

function runBackendLogin(backend) {
  if (loginChild) return;
  if (backend === "codex") {
    const { cmd, preArgs } = resolveNpmCli("GRID_AGENT_CODEX", "codex");
    let child;
    try {
      child = spawn(cmd, [...preArgs, "login"], { windowsHide: true });
    } catch (e) {
      toPanel({ type: "login-result", backend, ok: false });
      return;
    }
    loginChild = child;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {}
    }, CHAT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      loginChild = undefined;
      toPanel({ type: "login-result", backend, ok: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      loginChild = undefined;
      toPanel({ type: "login-result", backend, ok: code === 0 });
      sendAgentStatus();
    });
    return;
  }
  if (backend === "claude") {
    // Open a terminal already running the CLI; the user types /login.
    const { cmd, preArgs } = resolveAgentCli();
    try {
      spawn("cmd.exe", ["/c", "start", "Claude sign-in", cmd, ...preArgs], {
        windowsHide: true,
        detached: true,
      }).unref();
      toPanel({ type: "login-result", backend, ok: null });
    } catch (e) {
      toPanel({ type: "login-result", backend, ok: false });
    }
  }
}

// --- Package lifecycle -----------------------------------------------

function sendAgentStatus() {
  toPanel({
    type: "agent-status",
    shareProfiles,
    profilesFound: !!profilesDir,
    profileCount: profilesDir ? countProfiles(profilesDir) : 0,
    backend: backendId,
    backends: backendAvailability(),
  });
}

function persistSettings() {
  controller?.sendMessageToEditor({
    type: "persist-data",
    data: { shareProfiles, backend: backendId },
  });
}

exports.loadPackage = async function (gridController, persistedData) {
  packageShutDown = false;
  controller = gridController;
  shareProfiles = persistedData?.shareProfiles !== false;
  if (BACKENDS[persistedData?.backend]) backendId = persistedData.backend;
  profilesDir = findProfilesDir();
  writeContextFiles();
};

exports.unloadPackage = async function () {
  packageShutDown = true;
  stopActiveChat();
  removeConfigMirror();
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
    } else if (msg?.type === "chat-new") {
      stopActiveChat();
      lastSessionId = undefined;
      transcript = [];
    } else if (msg?.type === "backend-login") {
      if (BACKENDS[msg.backend]) runBackendLogin(msg.backend);
    } else if (msg?.type === "set-backend") {
      if (BACKENDS[msg.backend]) {
        backendId = msg.backend;
        persistSettings();
        sendAgentStatus();
      }
    } else if (msg?.type === "set-share-profiles") {
      shareProfiles = !!msg.enabled;
      persistSettings();
      if (!shareProfiles) removeConfigMirror();
      writeContextFiles();
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
