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
    "say so when it matters. When the user asks you to BUILD or",
    "CREATE something (a config, a mapping, a screen), propose real",
    "action blocks using the grid-block JSON protocol described in",
    "GRID_CONTEXT.md under 'Creating action blocks'. Answer briefly",
    "and concretely; when the reference does not cover something, say",
    "you are unsure.",
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
  // Every finished turn lands on disk, so closing the editor never
  // loses the conversation.
  persistSettings();
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
// in the working directory, re-read on every run. Claude reliably
// follows the "read GRID_CONTEXT.md" pointer; Codex demonstrably does
// not always - so these files get the ENTIRE reference inlined, not a
// pointer (hardware-tested: pointer-only Codex ignored the reference
// and imitated legacy Lua from a saved profile instead).
function writeContextFiles() {
  const brief = buildSystemPrompt(
    shareProfiles && profilesDir ? CONFIG_MIRROR : undefined,
  );
  let reference = "";
  try {
    reference = fs.readFileSync(
      path.join(__dirname, "GRID_CONTEXT.md"),
      "utf8",
    );
  } catch (e) {
    /* reference missing: ship the brief alone */
  }
  const content = `${brief}\n\n${reference}\n`;
  for (const name of ["AGENTS.md", "GEMINI.md"]) {
    try {
      fs.writeFileSync(path.join(__dirname, name), content);
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

// --- Agent-created action blocks -------------------------------------
// The one config-write path stable exposes: add-action registers new
// block types in the editor's left palette, and the user's drag onto
// an element is the native config commit. The agent proposes a block
// as JSON, the panel shows an Apply card, one click mints it here.
// Definitions persist and re-register on every load.

let agentBlocks = []; // [{short, name, description, where, lua}]
let actionIdByShort = new Map();
let nextActionId = 0;
let nextBlockNum = 1;

function agentBlockIcon() {
  return (
    '<svg width="100%" height="100%" viewBox="0 0 24 24" ' +
    'fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 3c.7 4.8 3.7 7.8 8.5 8.5v1C15.7 13.2 12.7 16.2 12 ' +
    "21c-.7-4.8-3.7-7.8-8.5-8.5v-1C8.3 10.8 11.3 7.8 12 3z\"/>" +
    '<path d="M19 2c.3 1.7 1.3 2.7 3 3-1.7.3-2.7 1.3-3 3-.3-1.7-1.3' +
    '-2.7-3-3 1.7-.3 2.7-1.3 3-3z" opacity="0.7"/></svg>'
  );
}

function registerAgentBlock(block) {
  const actionId = nextActionId++;
  actionIdByShort.set(block.short, actionId);
  controller?.sendMessageToEditor({
    type: "add-action",
    info: {
      actionId,
      short: block.short,
      displayName: block.name,
      rendering: "standard",
      category: "agent",
      color: "#14CE96",
      icon: agentBlockIcon(),
      blockIcon: agentBlockIcon(),
      selectable: true,
      movable: true,
      hideIcon: false,
      type: "single",
      toggleable: true,
      defaultLua: block.lua,
      actionComponent: "grid-agent-block",
    },
  });
}

function sanitizeBlock(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const name = String(raw.name ?? "").trim().slice(0, 40);
  const lua = String(raw.lua ?? "").trim().slice(0, 2000);
  if (!name || !lua) return undefined;
  return {
    short: `xga${nextBlockNum++}`,
    name,
    description: String(raw.description ?? "").trim().slice(0, 300),
    where: String(raw.where ?? "").trim().slice(0, 120),
    lua,
  };
}

function persistBlocks() {
  persistSettings();
}

function createAgentBlock(raw) {
  const block = sanitizeBlock(raw);
  if (!block) return undefined;
  agentBlocks.push(block);
  registerAgentBlock(block);
  persistBlocks();
  controller?.sendMessageToEditor({
    type: "show-message",
    message:
      `New block "${block.name}" - add it with the + action picker` +
      (block.where ? ` on ${block.where}` : ""),
    messageType: "success",
  });
  return block;
}

function deleteAgentBlock(short) {
  const idx = agentBlocks.findIndex((b) => b.short === short);
  if (idx < 0) return;
  agentBlocks.splice(idx, 1);
  const actionId = actionIdByShort.get(short);
  if (actionId !== undefined) {
    controller?.sendMessageToEditor({ type: "remove-action", actionId });
    actionIdByShort.delete(short);
  }
  persistBlocks();
}

// --- Value relay ------------------------------------------------------
// Generated source blocks call
//   gps("package-grid-agent", "relay", "<key>", value)
// and the package broadcasts the value to every module as the Lua
// global ga_<key>, throttled per key. Display blocks read the global
// from inside their Draw event. This is the Premiere Display pattern,
// generalized.

const RELAY_MIN_MS = 100;
const relayState = new Map(); // key -> {pending, timer, last}

function relayValue(key, value) {
  const safeKey = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 12);
  if (!safeKey || !isFinite(value)) return;
  let state = relayState.get(safeKey);
  if (!state) {
    state = {};
    relayState.set(safeKey, state);
  }
  state.pending = value;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (state.pending === state.last) return;
    state.last = state.pending;
    controller?.sendMessageToEditor({
      type: "execute-lua-script",
      script: `ga_${safeKey}=${Number(state.pending)}`,
    });
  }, RELAY_MIN_MS);
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
    blocks: agentBlocks.map((b) => ({ short: b.short, name: b.name })),
  });
}

function persistSettings() {
  controller?.sendMessageToEditor({
    type: "persist-data",
    data: {
      shareProfiles,
      backend: backendId,
      blocks: agentBlocks,
      nextBlockNum,
      transcript,
      lastSessionId,
    },
  });
}

exports.loadPackage = async function (gridController, persistedData) {
  packageShutDown = false;
  controller = gridController;
  shareProfiles = persistedData?.shareProfiles !== false;
  if (BACKENDS[persistedData?.backend]) backendId = persistedData.backend;
  if (Array.isArray(persistedData?.blocks)) {
    agentBlocks = persistedData.blocks.filter(
      (b) => b && b.short && b.name && b.lua,
    );
  }
  nextBlockNum = Number(persistedData?.nextBlockNum) || agentBlocks.length + 1;
  for (const block of agentBlocks) registerAgentBlock(block);
  if (Array.isArray(persistedData?.transcript)) {
    transcript = persistedData.transcript
      .filter((t) => t && typeof t.q === "string" && typeof t.a === "string")
      .slice(-6);
  }
  if (typeof persistedData?.lastSessionId === "string") {
    lastSessionId = persistedData.lastSessionId;
  }
  profilesDir = findProfilesDir();
  writeContextFiles();
};

exports.unloadPackage = async function () {
  packageShutDown = true;
  stopActiveChat();
  for (const actionId of actionIdByShort.values()) {
    controller?.sendMessageToEditor({ type: "remove-action", actionId });
  }
  actionIdByShort.clear();
  nextActionId = 0;
  for (const state of relayState.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  relayState.clear();
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
      persistSettings();
    } else if (msg?.type === "backend-login") {
      if (BACKENDS[msg.backend]) runBackendLogin(msg.backend);
    } else if (msg?.type === "create-block") {
      const block = createAgentBlock(msg.block);
      toPanel({
        type: "block-created",
        requestId: msg.requestId,
        ok: !!block,
        short: block?.short,
        name: block?.name,
        where: block?.where,
      });
      sendAgentStatus();
    } else if (msg?.type === "delete-block") {
      deleteAgentBlock(String(msg.short));
      sendAgentStatus();
    } else if (msg?.type === "clear-blocks") {
      for (const b of [...agentBlocks]) deleteAgentBlock(b.short);
      controller?.sendMessageToEditor({
        type: "show-message",
        message: "All assistant blocks removed from the palette",
        messageType: "success",
      });
      sendAgentStatus();
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
  if (transcript.length > 0) {
    toPanel({ type: "chat-history", turns: transcript });
  }
};

// gps("package-grid-agent", "relay", key, value) from generated
// source blocks lands here.
exports.sendMessage = async function (args) {
  if (!Array.isArray(args)) return;
  if (args[0] === "relay") {
    relayValue(args[1], Number(args[2]));
  }
};
