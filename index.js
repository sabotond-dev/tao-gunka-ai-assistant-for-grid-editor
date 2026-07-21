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
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PKG_VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch (e) {
    return "0.0.0";
  }
})();

// The system prompt stays slim: role, honesty rules, and where the
// real context lives. The agent reads GRID_CONTEXT.md (curated Grid
// reference, ships with the package) and the user's saved configs
// on demand with its own file tools.
function buildSystemPrompt(profilesDir, liveTools) {
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
  if (liveTools) {
    parts.push(
      "Two live hardware tools are available: grid_status lists the",
      "modules connected right now (position, page, element count) and",
      "grid_element_values reads the current value of every element on",
      "one module. Use them whenever the question concerns current",
      "hardware state. They read live VALUES only - the Lua configs",
      "stored on a module remain unreadable, and you still cannot see",
      "the Editor UI; say so when it matters.",
    );
  } else {
    parts.push(
      "You have no live view of connected hardware or the Editor UI -",
      "say so when it matters.",
    );
  }
  parts.push(
    "When the user asks you to BUILD or",
    "CREATE something (a config, a mapping, a screen), propose real",
    "action blocks using the grid-block JSON protocol described in",
    "GRID_CONTEXT.md under 'Creating action blocks' - or, when the",
    "user wants a COMPLETE setup for a whole module, one grid-profile",
    "as described under 'Creating whole profiles'. Proposed blocks",
    "must keep working with the Editor closed: module-to-module values",
    "go over gis(), never through this package's relay, which is",
    "reserved for computer-side integrations and must be flagged as",
    "Editor-dependent when used. Answer briefly",
    "and concretely; when the reference does not cover something, say",
    "you are unsure.",
  );
  return parts.join(" ");
}

// The user's saved configs (stable editor writes them here). Checked
// at load; the panel toggle controls whether the agent may read them.
function findProfilesDir() {
  const dir =
    process.env.GRID_AGENT_PROFILES_DIR ??
    path.join(os.homedir(), "Documents", "grid-userdata", "configs");
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
  local: { label: "Local (Ollama / Kobold)" },
};

let backendId = "claude";

// Local backend: any OpenAI-compatible server (Ollama, KoboldCpp,
// LM Studio, llama.cpp). Direct HTTP from this process, streaming.
// Local models have no file tools, so the Grid knowledge is pushed
// into the system message instead of read on demand.
let localUrl = "http://localhost:11434/v1";
let localModel = "";

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

// npm-installed CLIs: on Windows they are .cmd shims Node refuses to
// spawn directly (route through cmd.exe); on macOS and Linux they are
// plain executables on PATH. Overrides ending in .js run under the
// current Node (tests).
// GUI apps on macOS (and some Linux desktops) do NOT inherit the
// user's shell PATH - the editor sees only /usr/bin:/bin and friends,
// while Terminal sees homebrew, npm and nvm dirs. So a bare command
// name that works in Terminal is ENOENT here (hit live on a
// colleague's Mac). Resolve Unix CLIs to absolute paths: known
// install locations first, then a login-shell `command -v` as the
// catch-all (loads .zprofile/.zshrc, so nvm and brew answer too).
const shellWhichCache = new Map();
function shellWhich(name) {
  if (shellWhichCache.has(name)) return shellWhichCache.get(name);
  let found;
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const r = spawnSync(shell, ["-ilc", `command -v ${name}`], {
      timeout: 8000,
      encoding: "utf8",
    });
    const line = String(r.stdout ?? "").trim().split("\n").pop();
    if (r.status === 0 && line && line.startsWith("/")) found = line;
  } catch (e) {
    /* shell refused; stay unfound */
  }
  shellWhichCache.set(name, found);
  return found;
}

function findUnixCli(name) {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "local", name), // claude migrate-installer
    path.join(home, ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    path.join(home, ".npm-global", "bin", name),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return shellWhich(name);
}

function resolveNpmCli(overrideEnv, cmdName) {
  const override = process.env[overrideEnv];
  if (override) {
    if (override.endsWith(".js")) {
      return { cmd: process.execPath, preArgs: [override], found: true };
    }
    return { cmd: override, preArgs: [], found: true };
  }
  if (process.platform === "win32") {
    const shim = path.join(process.env.APPDATA ?? "", "npm", `${cmdName}.cmd`);
    if (fs.existsSync(shim)) {
      return { cmd: "cmd.exe", preArgs: ["/c", shim], found: true };
    }
    return { cmd: "cmd.exe", preArgs: ["/c", cmdName], found: false };
  }
  const found = findUnixCli(cmdName);
  if (found) return { cmd: found, preArgs: [], found: true };
  return { cmd: cmdName, preArgs: [], found: false };
}

// npm's presence gates the Codex path in the setup guide. One real
// check (spawn npm --version), cached; the guide's "Check again"
// clears the cache after the user installs Node.
let npmFoundCache;
function npmFound() {
  if (npmFoundCache === undefined) {
    try {
      if (process.platform === "win32") {
        const r = spawnSync("cmd.exe", ["/c", "npm --version"], {
          windowsHide: true,
          timeout: 5000,
        });
        npmFoundCache = r.status === 0;
      } else {
        // Absolute-path search: the editor's own PATH is blind to
        // homebrew/nvm installs on macOS.
        npmFoundCache = !!findUnixCli("npm");
      }
    } catch (e) {
      npmFoundCache = false;
    }
  }
  return npmFoundCache;
}

// The setup guide's local step: is the server there, and which models
// does it offer? Ollama answers /api/tags with names; OpenAI-style
// servers answer /v1/models. Either way the panel gets a list to
// click instead of a name to type.
async function probeLocal() {
  const base = localUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const grab = async (url, pick) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return undefined;
      return pick(await res.json());
    } catch (e) {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  let models = await grab(`${base}/api/tags`, (j) =>
    (j.models ?? []).map((m) => m.name).filter(Boolean),
  );
  if (models === undefined) {
    models = await grab(`${base}/v1/models`, (j) =>
      (j.data ?? []).map((m) => m.id).filter(Boolean),
    );
  }
  toPanel({
    type: "local-probe",
    ok: models !== undefined,
    models: (models ?? []).slice(0, 20),
    url: localUrl,
  });
}

function backendAvailability() {
  // A bare "claude" fallback means nothing was actually found - the
  // resolvers return absolute paths for every real install location
  // (a GUI editor's PATH cannot be trusted, especially on macOS).
  const claudeResolved = resolveAgentCli();
  const claude =
    !!process.env.GRID_AGENT_CLI || claudeResolved.cmd !== "claude";
  return {
    claude,
    codex: resolveNpmCli("GRID_AGENT_CODEX", "codex").found,
    gemini: resolveNpmCli("GRID_AGENT_GEMINI", "gemini").found,
    // Reachability is only knowable at call time; errors say so.
    local: true,
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
function newestCliIn(base, exeName) {
  const exe = exeName ?? "claude.exe";
  try {
    const versions = fs
      .readdirSync(base)
      .filter((d) => fs.existsSync(path.join(base, d, exe)))
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    if (versions.length > 0) {
      return path.join(base, versions[0], exe);
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

  if (process.platform !== "win32") {
    // macOS: the Claude desktop app bundles versioned CLI builds under
    // Application Support, same layout as Windows. Standalone installs
    // land in ~/.local/bin, npm installs on PATH.
    if (process.platform === "darwin") {
      const bundled = newestCliIn(
        path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Claude",
          "claude-code",
        ),
        "claude",
      );
      if (bundled) return { cmd: bundled, preArgs: [] };
    }
    const found = findUnixCli("claude");
    if (found) return { cmd: found, preArgs: [] };
    return { cmd: "claude", preArgs: [] };
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
    /* no Packages dir */
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
  if (activeLocalAbort) {
    try {
      activeLocalAbort.abort();
    } catch (e) {}
    activeLocalAbort = undefined;
  }
}

async function runChat(prompt) {
  // Every question starts hardware-aware: probe (or reuse a fresh
  // cache) before the backend spawns, and hand the summary to it.
  const live = liveSummaryLine(await getLiveModules());
  if (backendId === "codex") return runChatCodex(prompt, live);
  if (backendId === "gemini") return runChatGemini(prompt, live);
  if (backendId === "local") return runChatLocal(prompt, live);
  return runChatClaude(prompt, live);
}

// The system message for tool-less local models: the brief, the full
// reference, and (since the model cannot list files itself) the names
// of the user's saved configs so it can at least ask for the right one.
function localSystemMessage() {
  let content = buildSystemPrompt(undefined);
  try {
    content +=
      "\n\n" +
      fs.readFileSync(path.join(__dirname, "GRID_CONTEXT.md"), "utf8");
  } catch (e) {}
  if (shareProfiles && profilesDir) {
    try {
      const names = fs
        .readdirSync(profilesDir)
        .filter((f) => f.endsWith(".json"))
        .slice(0, 60);
      content +=
        "\n\nYou are running as a local model without file tools, so " +
        "you CANNOT open files. The user's saved configs are named:\n" +
        names.join(", ") +
        "\nWhen a question needs a file's content, ask the user to " +
        "paste the relevant part.";
    } catch (e) {}
  }
  return content;
}

let activeLocalAbort;
// Whether the server speaks Ollama's native /api/chat (bigger context
// window, thinking toggle). undefined = not probed yet; false = plain
// OpenAI-compatible (KoboldCpp, LM Studio, ...).
let localNativeOk;

async function runChatLocal(prompt, live) {
  stopActiveChat();
  const abort = new AbortController();
  activeLocalAbort = abort;
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, CHAT_TIMEOUT_MS);
  toPanel({ type: "chat-start" });

  const messages = [
    {
      role: "system",
      content: localSystemMessage() + (live ? `\n\n${live}` : ""),
    },
  ];
  for (const t of transcript) {
    messages.push({ role: "user", content: t.q });
    messages.push({ role: "assistant", content: t.a });
  }
  messages.push({ role: "user", content: prompt });

  const base = localUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let fullText = "";
  let lastUrl = "";

  // Identify Ollama by its version endpoint once; a 200 on /api/chat
  // alone is not proof (other servers answer any path).
  if (localNativeOk === undefined) {
    try {
      const probe = await fetch(`${base}/api/version`, {
        signal: abort.signal,
      });
      localNativeOk = probe.ok;
    } catch (e) {
      /* unreachable now: leave undefined, the main call reports it */
    }
  }

  // Ollama's OpenAI endpoint is stuck at the model's default context
  // (4k for most), which the Grid reference alone can overflow, and it
  // cannot switch off thinking mode - both of which made a 12B model
  // look broken. The native endpoint fixes both; anything that 404s it
  // gets the standard OpenAI path.
  const attempts = [];
  if (localNativeOk === true) {
    attempts.push({
      native: true,
      url: `${base}/api/chat`,
      body: {
        model: localModel || "local",
        messages,
        stream: true,
        think: false,
        // The reference grew with the v3 knowledge sections; 8k was
        // getting tight with the transcript on top.
        options: { num_ctx: 16384 },
      },
    });
  }
  attempts.push({
    native: false,
    url: `${base}/v1/chat/completions`,
    body: { model: localModel || "local", messages, stream: true },
  });

  try {
    for (const attempt of attempts) {
      lastUrl = attempt.url;
      const res = await fetch(attempt.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt.body),
        signal: abort.signal,
      });
      if (attempt.native && (res.status === 404 || res.status === 405)) {
        localNativeOk = false;
        continue; // not Ollama: use the OpenAI path
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`${res.status}: ${body}`);
      }
      if (attempt.native) localNativeOk = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, "").trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = attempt.native
              ? (parsed.message?.content ?? "")
              : (parsed.choices?.[0]?.delta?.content ?? "");
            if (delta) {
              fullText += delta;
              toPanel({ type: "chat-chunk", text: delta });
            }
          } catch (e) {
            /* keep-alive or non-JSON line */
          }
        }
      }
      break; // streamed to completion
    }
    if (fullText) {
      rememberTurn(prompt, fullText);
      toPanel({ type: "chat-done" });
    } else {
      toPanel({
        type: "chat-error",
        message: "The local model returned nothing",
      });
    }
  } catch (e) {
    if (abort.signal.aborted) {
      if (fullText) rememberTurn(prompt, fullText);
      if (timedOut) {
        toPanel({
          type: "chat-error",
          message: "Local model timed out (5 min)",
        });
      }
      // otherwise: user Stop, already handled by the panel
    } else {
      toPanel({
        type: "chat-error",
        message:
          `Cannot reach ${lastUrl} (${String(e.message).slice(0, 160)}). ` +
          "Is the local server running? Set the URL and model in the " +
          "panel.",
      });
    }
  } finally {
    clearTimeout(killTimer);
    if (activeLocalAbort === abort) activeLocalAbort = undefined;
  }
}

function runChatClaude(prompt, live, isRetry) {
  stopActiveChat();
  const { cmd, preArgs } = resolveAgentCli();

  // Nested-session env vars from a dev environment confuse the CLI's
  // own bookkeeping; a real editor session does not have them either.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ID;

  const withProfiles = shareProfiles && profilesDir;
  const withMcp = mcpPort > 0;
  const args = [
    ...preArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Read-only file tools auto-approve so the agent can consult
    // GRID_CONTEXT.md and the user's configs without permission stalls;
    // the two live-context MCP tools are read-only snapshots too.
    "--allowedTools",
    "Read,Glob,Grep" +
      (withMcp
        ? ",mcp__grid__grid_status,mcp__grid__grid_element_values" +
          ",mcp__grid__grid_module_files,mcp__grid__grid_read_module_file"
        : ""),
    "--append-system-prompt",
    buildSystemPrompt(withProfiles ? profilesDir : undefined, withMcp) +
      (live ? ` ${live}` : ""),
  ];
  if (withProfiles) {
    args.push("--add-dir", profilesDir);
  }
  if (withMcp) {
    // Inline JSON config; --strict-mcp-config keeps the user's own MCP
    // servers out of what is effectively an embedded product.
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          grid: {
            type: "http",
            url: `http://127.0.0.1:${mcpPort}/mcp`,
            headers: { Authorization: `Bearer ${mcpToken}` },
          },
        },
      }),
      "--strict-mcp-config",
    );
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
              toPanel({
                type: "chat-login-needed",
                backend: "claude",
                cliPath: cmd,
              });
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
      toPanel({ type: "chat-login-needed", backend: "claude", cliPath: cmd });
      return;
    }
    // A dead --resume target (expired or cleaned-up session) should
    // degrade to a fresh conversation, not an error.
    if (resumingFrom && !isRetry) {
      lastSessionId = undefined;
      runChatClaude(prompt, live, true);
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
function runChatCodex(prompt, live) {
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
  child.stdin.write(
    (live ? `[${live}]\n` : "") + transcriptPrefixed(prompt),
  );
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
function runChatGemini(prompt, live) {
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
  child.stdin.write(
    (live ? `[${live}]\n` : "") + transcriptPrefixed(prompt),
  );
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

let cachedBlockIcon;
function agentBlockIcon() {
  if (!cachedBlockIcon) {
    try {
      cachedBlockIcon = fs.readFileSync(
        path.join(__dirname, "tao-gunka-menu.svg"),
        "utf8",
      );
    } catch (e) {
      cachedBlockIcon = "<svg/>";
    }
  }
  return cachedBlockIcon;
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

// --- Whole profiles ---------------------------------------------------
// The agent can propose a complete module profile; saving writes a
// file in the exact shape the editor's own save produces (verified
// against real saved profiles and the editor's shipped defaults), so
// it appears in the profile list like any hand-made one and loads
// onto a module through the normal UI.

// Element layout per module type, extracted from the editor's shipped
// per-module default profiles: element index -> allowed events.
// Event numbers: 0 setup, 1 potmeter, 2 encoder, 3 button,
// 4 utility, 5 midirx, 6 timer, 7 endless, 8 draw.
const EVENT_NUMBERS = {
  setup: 0,
  potmeter: 1,
  encoder: 2,
  button: 3,
  utility: 4,
  midirx: 5,
  timer: 6,
  endless: 7,
  draw: 8,
};

function range(n, events) {
  const out = {};
  for (let i = 0; i < n; i++) out[i] = events;
  return out;
}

const MODULE_LAYOUTS = {
  BU16: { ...range(16, [0, 3, 6]), 255: [0, 4, 5, 6] },
  EN16: { ...range(16, [0, 3, 2, 6]), 255: [0, 4, 5, 6] },
  PO16: { ...range(16, [0, 1, 6]), 255: [0, 4, 5, 6] },
  PBF4: {
    ...range(8, [0, 1, 6]),
    8: [0, 3, 6],
    9: [0, 3, 6],
    10: [0, 3, 6],
    11: [0, 3, 6],
    255: [0, 4, 5, 6],
  },
  EF44: {
    0: [0, 3, 2, 6],
    1: [0, 3, 2, 6],
    2: [0, 3, 2, 6],
    3: [0, 3, 2, 6],
    4: [0, 1, 6],
    5: [0, 1, 6],
    6: [0, 1, 6],
    7: [0, 1, 6],
    255: [0, 4, 5, 6],
  },
  TEK2: {
    ...range(8, [0, 3, 6]),
    8: [0, 3, 7, 6],
    9: [0, 3, 7, 6],
    255: [0, 4, 5, 6],
  },
  VSN1L: {
    ...range(8, [0, 3, 6]),
    8: [0, 3, 7, 6],
    9: [0, 3, 6],
    10: [0, 3, 6],
    11: [0, 3, 6],
    12: [0, 3, 6],
    13: [0, 8],
    255: [0, 4, 5, 6],
  },
  VSN1R: {
    ...range(8, [0, 3, 6]),
    8: [0, 3, 7, 6],
    9: [0, 3, 6],
    10: [0, 3, 6],
    11: [0, 3, 6],
    12: [0, 3, 6],
    13: [0, 8],
    255: [0, 4, 5, 6],
  },
};

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const module = String(raw.module ?? "").toUpperCase().trim();
  const layout = MODULE_LAYOUTS[module];
  const name = String(raw.name ?? "").trim().slice(0, 60);
  if (!layout || !name || typeof raw.elements !== "object") return undefined;
  const elements = {};
  let eventCount = 0;
  for (const [key, evs] of Object.entries(raw.elements ?? {})) {
    const idx = Number(key);
    if (!layout[idx] || typeof evs !== "object") continue;
    for (const [evName, lua] of Object.entries(evs)) {
      const evNum = EVENT_NUMBERS[String(evName).toLowerCase()];
      if (evNum === undefined || !layout[idx].includes(evNum)) continue;
      const code = String(lua ?? "").trim().slice(0, 4000);
      if (!code) continue;
      elements[idx] = elements[idx] ?? {};
      elements[idx][evNum] = code;
      eventCount++;
    }
  }
  if (eventCount === 0) return undefined;
  return {
    name,
    module,
    description: String(raw.description ?? "").trim().slice(0, 300),
    elements,
  };
}

function buildProfileFile(p) {
  const layout = MODULE_LAYOUTS[p.module];
  const now = new Date().toISOString();
  const configs = [];
  for (const [idxStr, events] of Object.entries(layout)) {
    const idx = Number(idxStr);
    const eventList = [];
    for (const evNum of events) {
      const lua = p.elements[idx]?.[evNum];
      // The --[[@cb]] marker renders the whole event as one code
      // block in the editor; untouched events get a quiet comment so
      // the profile fully replaces whatever was on the module before.
      eventList.push({
        event: evNum,
        config: lua ? `--[[@cb]] ${lua}` : "--[[@cb]] --[[Init]]",
      });
    }
    configs.push({ controlElementNumber: idx, events: eventList });
  }
  return {
    id: crypto.randomUUID(),
    modifiedAt: now,
    name: p.name,
    description:
      p.description || "Created by the Grid Assistant (Tao Gunka)",
    type: p.module,
    version: { major: "1", minor: "6", patch: "8" },
    configType: "profile",
    configs,
    createdAt: now,
    virtualPath: "",
  };
}

// --- Instant tryout ---------------------------------------------------
// The firmware compiles each event config into an element METHOD
// (ini/bc/pc/ec/epc/tim/ld/map/mrx), and Lua lets immediate script
// reassign them. So a profile can be pushed straight into RAM: active
// instantly, gone at power-off, stored config untouched. Broadcast
// with a per-module guard (element count + element type signature) so
// only the matching module type applies it. EXPERIMENTAL until
// hardware-verified.

const EVENT_HANDLER_SHORTS = {
  0: "ini",
  1: "pc",
  2: "ec",
  3: "bc",
  4: "map",
  5: "mrx",
  6: "tim",
  7: "epc",
  8: "ld",
};

// Guard: element count plus a type probe that tells lookalikes apart
// (BU16/EN16/PO16 all count 16; their element 0 differs).
const MODULE_GUARDS = {
  BU16: "gec()==16 and element[0].bva and not element[0].eva and not element[0].pva",
  EN16: "gec()==16 and element[0].eva",
  PO16: "gec()==16 and element[0].pva",
  PBF4: "gec()==12 and element[0].pva and element[8].bva",
  EF44: "gec()==8 and element[0].eva and element[4].pva",
  TEK2: "gec()==10 and element[8].epva",
  VSN1L: "gec()==14 and element[8].epva",
  VSN1R: "gec()==14 and element[8].epva",
};

function tryoutProfile(raw) {
  const p = sanitizeProfile(raw);
  if (!p) return { ok: false, error: "invalid profile" };
  if (!controller) return { ok: false, error: "editor not connected" };
  const guard = MODULE_GUARDS[p.module];
  let applied = 0;
  for (const [idxStr, events] of Object.entries(p.elements)) {
    for (const [evNum, lua] of Object.entries(events)) {
      const handler = EVENT_HANDLER_SHORTS[evNum];
      if (!handler) continue;
      // Init handlers run once right after being swapped in, the way
      // a fresh profile's setup would.
      const runNow = Number(evNum) === 0 ? ` e:${handler}()` : "";
      controller.sendMessageToEditor({
        type: "execute-lua-script",
        script:
          `if ${guard} then local e=element[${idxStr}] ` +
          `e.${handler}=function(self) ${lua} end${runNow} end`,
      });
      applied++;
    }
  }
  return { ok: applied > 0, module: p.module, applied };
}

function createProfile(raw) {
  const p = sanitizeProfile(raw);
  if (!p) return { ok: false, error: "invalid profile" };
  const dir = findProfilesDir();
  if (!dir) {
    return {
      ok: false,
      error:
        "No grid-userdata configs folder found - open the editor's " +
        "profile view once so it exists, then try again.",
    };
  }
  const file = buildProfileFile(p);
  let base = p.name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "Agent Profile";
  let filename = `${base}.json`;
  for (let n = 2; fs.existsSync(path.join(dir, filename)); n++) {
    filename = `${base} ${n}.json`;
  }
  try {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(file, null, 2));
  } catch (e) {
    return { ok: false, error: `Could not write the file: ${e.message}` };
  }
  controller?.sendMessageToEditor({
    type: "show-message",
    message:
      `Profile "${p.name}" saved - open your profile list, ` +
      `load it onto the ${p.module}, then Store`,
    messageType: "success",
  });
  return { ok: true, name: p.name, module: p.module, filename };
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

// --- Live context (MCP) ----------------------------------------------
// A minimal MCP server over streamable HTTP, hand-rolled on Node's
// http module (packages ship without node_modules). It serves two
// read-only tools backed by immediate-Lua round trips: the package
// pushes a script to the modules (execute-lua-script) and each module
// answers through gps("package-grid-agent","ctx",...), which lands in
// exports.sendMessage below. Loopback only, bearer token per load, so
// no other local process can drive the editor bridge.

let mcpServer;
let mcpPort = 0;
let mcpToken = "";

let ctxSeq = 0;
const pendingCtx = new Map(); // id -> {replies, resolve, timer, single}

// Runs one round trip: send the script (broadcast unless targeted),
// gather module replies until the window closes - or resolve on the
// first reply when `single` (targeted queries have one answerer).
function ctxRequest({ script, targetDx, targetDy, windowMs, single }) {
  return new Promise((resolve) => {
    if (!controller || packageShutDown) {
      resolve(undefined);
      return;
    }
    const id =
      "c" + (ctxSeq++).toString(36) + crypto.randomBytes(2).toString("hex");
    const entry = { replies: [], resolve, single };
    entry.timer = setTimeout(() => {
      pendingCtx.delete(id);
      resolve(entry.replies);
    }, windowMs);
    pendingCtx.set(id, entry);
    const msg = { type: "execute-lua-script", script: script(id) };
    if (typeof targetDx === "number" && typeof targetDy === "number") {
      msg.targetDx = targetDx;
      msg.targetDy = targetDy;
    }
    controller.sendMessageToEditor(msg);
  });
}

function ctxReply(args) {
  const entry = pendingCtx.get(String(args[1]));
  if (!entry) return;
  entry.replies.push(args.slice(2));
  if (entry.single) {
    clearTimeout(entry.timer);
    pendingCtx.delete(String(args[1]));
    entry.resolve(entry.replies);
  }
}

// The module-side scripts. Kept tiny: immediate scripts ride a single
// protocol packet. `element[i]` is the editor-blessed handle table
// (its own widgets read cross-element values through it); probing the
// method (e.pva and e:pva()) is the runtime-safe way to type-detect.
const modInfoScript = (id) =>
  `gps("package-grid-agent","ctx","${id}","mod",gmx(),gmy(),gpc(),gec())`;
const elementValuesScript = (id) =>
  `local r="" for i=0,gec()-1 do local e=element[i] if e then ` +
  `local v=(e.epva and e:epva()) or (e.eva and e:eva()) or ` +
  `(e.pva and e:pva()) or (e.bva and e:bva()) ` +
  `local t=(e.epva and "ep") or (e.eva and "e") or (e.pva and "p") ` +
  `or (e.bva and "b") or "s" ` +
  `r=r..i..t.."="..tostring(v or "-")..";" end end ` +
  `gps("package-grid-agent","ctx","${id}","val",gmx(),gmy(),r)`;

const ELEMENT_TYPE_NAMES = {
  ep: "endless",
  e: "encoder",
  p: "potmeter",
  b: "button",
  s: "system/screen",
};

// Prefetched live context: every question starts with a fresh (or
// recently cached) broadcast probe, so the agent knows what hardware
// is connected without being asked to check. The probe is the same
// modInfoScript round trip grid_status uses.
let liveCache; // { at, modules: [{dx,dy,page,elements}] }
const LIVE_CACHE_MS = 15000;

async function getLiveModules() {
  if (!controller || packageShutDown) return undefined;
  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_MS) {
    return liveCache.modules;
  }
  const replies = await ctxRequest({ script: modInfoScript, windowMs: 700 });
  const modules = (replies ?? [])
    .filter((r) => String(r[0]) === "mod")
    .map((r) => ({
      dx: Number(r[1]),
      dy: Number(r[2]),
      page: Number(r[3]),
      elements: Number(r[4]),
    }));
  liveCache = { at: Date.now(), modules };
  sendAgentStatus();
  return modules;
}

function liveSummaryLine(modules) {
  if (modules === undefined) return "";
  if (modules.length === 0) {
    return (
      "Live hardware probe just now: no module answered - modules may " +
      "be disconnected; do not claim knowledge of connected hardware."
    );
  }
  const parts = modules.map(
    (m) =>
      `(${m.dx},${m.dy}) ${m.elements} elements, active page ${m.page}`,
  );
  return `Live hardware probe just now - connected modules: ${parts.join("; ")}.`;
}

async function toolGridStatus() {
  const replies = await ctxRequest({ script: modInfoScript, windowMs: 700 });
  if (replies === undefined) {
    return "The editor connection is not available, so live hardware cannot be queried.";
  }
  const mods = replies.filter((r) => String(r[0]) === "mod");
  if (mods.length === 0) {
    return (
      "No connected module replied within 700 ms - either no Grid " +
      "modules are connected, or immediate Lua is unavailable right " +
      "now. The user's saved config files on disk are still readable."
    );
  }
  const lines = mods.map(
    (r) =>
      `- module at dx=${r[1]}, dy=${r[2]}: ${r[4]} elements, active page ${r[3]}`,
  );
  return (
    `${mods.length} connected module(s) replied just now:\n` +
    lines.join("\n") +
    "\nUse grid_element_values with a module's dx and dy to read its current element values."
  );
}

async function toolGridElementValues(dx, dy) {
  const replies = await ctxRequest({
    script: elementValuesScript,
    targetDx: dx,
    targetDy: dy,
    windowMs: 900,
    single: true,
  });
  if (replies === undefined) {
    return "The editor connection is not available, so live hardware cannot be queried.";
  }
  const val = replies.find((r) => String(r[0]) === "val");
  if (!val) {
    return (
      `No module at dx=${dx}, dy=${dy} replied within 900 ms. ` +
      "Check the positions with grid_status first."
    );
  }
  const lines = [];
  const re = /(\d+)(ep|e|p|b|s)=([^;]*);/g;
  let m;
  while ((m = re.exec(String(val[3]))) !== null) {
    const kind = ELEMENT_TYPE_NAMES[m[2]] ?? m[2];
    const value = m[3] === "-" ? "no value (not a value element)" : m[3];
    lines.push(`- element ${m[1]} (${kind}): ${value}`);
  }
  if (lines.length === 0) {
    return `The module at dx=${dx}, dy=${dy} replied but reported no elements.`;
  }
  return (
    `Live element values from the module at dx=${val[1]}, dy=${val[2]} ` +
    `(0..127, snapshot taken just now):\n` +
    lines.join("\n")
  );
}

// Module filesystem probes: the firmware exposes gfls (readdir) and
// gfcat (readfile), unused by the editor itself. If stored configs
// turn out to live on that filesystem, these two tools are the road
// to reading what a module ACTUALLY runs - flagged experimental
// until real hardware answers.
function sanitizeModulePath(p) {
  return String(p ?? "/").replace(/[^a-zA-Z0-9_./-]/g, "").slice(0, 120) || "/";
}

const moduleFilesScript = (id, p) =>
  `local t=gfls("${p}") local s="" if type(t)=="table" then ` +
  `for i,v in ipairs(t) do s=s..tostring(v)..";" end ` +
  `else s=tostring(t) end ` +
  `gps("package-grid-agent","ctx","${id}","fs",gmx(),gmy(),s)`;
const moduleReadFileScript = (id, p) =>
  `local c=gfcat("${p}") ` +
  `gps("package-grid-agent","ctx","${id}","fc",gmx(),gmy(),` +
  `string.sub(tostring(c),1,900))`;

async function toolModuleFs(dx, dy, p, script, tag, label) {
  const replies = await ctxRequest({
    script: (id) => script(id, p),
    targetDx: dx,
    targetDy: dy,
    windowMs: 900,
    single: true,
  });
  if (replies === undefined) {
    return "The editor connection is not available, so live hardware cannot be queried.";
  }
  const hit = replies.find((r) => String(r[0]) === tag);
  if (!hit) {
    return (
      `No reply from the module at dx=${dx}, dy=${dy} within 900 ms. ` +
      "Either it is not connected, or this firmware does not expose " +
      `${label} - treat the module filesystem as unavailable and say so.`
    );
  }
  const body = String(hit[3] ?? "");
  return (
    `${label}("${p}") on the module at dx=${hit[1]}, dy=${hit[2]} ` +
    `returned:\n${body || "(empty)"}`
  );
}

const MCP_TOOLS = [
  {
    name: "grid_status",
    description:
      "List the Grid modules connected right now: chain position " +
      "(dx, dy), element count, and the active page. Live hardware " +
      "query answered by the modules themselves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "grid_element_values",
    description:
      "Read the current value (0..127) of every element on one " +
      "connected module, addressed by the dx and dy reported by " +
      "grid_status. Live hardware query.",
    inputSchema: {
      type: "object",
      properties: {
        dx: { type: "integer", description: "module chain position x" },
        dy: { type: "integer", description: "module chain position y" },
      },
      required: ["dx", "dy"],
      additionalProperties: false,
    },
  },
  {
    name: "grid_module_files",
    description:
      "EXPERIMENTAL: list a directory on one module's internal " +
      "filesystem via the firmware's gfls(). Whether stored configs " +
      "are reachable this way is an open question - report what " +
      "comes back honestly, including nothing.",
    inputSchema: {
      type: "object",
      properties: {
        dx: { type: "integer" },
        dy: { type: "integer" },
        path: { type: "string", description: "directory path, default /" },
      },
      required: ["dx", "dy"],
      additionalProperties: false,
    },
  },
  {
    name: "grid_read_module_file",
    description:
      "EXPERIMENTAL: read the first 900 characters of a file on one " +
      "module's internal filesystem via the firmware's gfcat(). Use " +
      "paths discovered with grid_module_files.",
    inputSchema: {
      type: "object",
      properties: {
        dx: { type: "integer" },
        dy: { type: "integer" },
        path: { type: "string" },
      },
      required: ["dx", "dy", "path"],
      additionalProperties: false,
    },
  },
];

async function mcpDispatch(rpc) {
  const reply = (result) => ({ jsonrpc: "2.0", id: rpc.id, result });
  switch (rpc.method) {
    case "initialize":
      return reply({
        protocolVersion: rpc.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "tao-gunka-grid", version: PKG_VERSION },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments ?? {};
      let text;
      if (name === "grid_status") {
        text = await toolGridStatus();
      } else if (name === "grid_element_values") {
        text = await toolGridElementValues(
          Number(args.dx) || 0,
          Number(args.dy) || 0,
        );
      } else if (name === "grid_module_files") {
        text = await toolModuleFs(
          Number(args.dx) || 0,
          Number(args.dy) || 0,
          sanitizeModulePath(args.path),
          moduleFilesScript,
          "fs",
          "readdir",
        );
      } else if (name === "grid_read_module_file") {
        text = await toolModuleFs(
          Number(args.dx) || 0,
          Number(args.dy) || 0,
          sanitizeModulePath(args.path),
          moduleReadFileScript,
          "fc",
          "readfile",
        );
      } else {
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        };
      }
      return reply({ content: [{ type: "text", text }] });
    }
    default:
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
  }
}

function startMcpServer() {
  if (mcpServer) return;
  mcpToken = crypto.randomBytes(16).toString("hex");
  mcpServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${mcpToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (d) => {
      raw += d;
      if (raw.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      let rpc;
      try {
        rpc = JSON.parse(raw);
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      // Notifications get acknowledged and nothing more.
      if (rpc.id === undefined || rpc.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      try {
        const out = await mcpDispatch(rpc);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32603, message: String(e?.message ?? e) },
          }),
        );
      }
    });
  });
  mcpServer.listen(0, "127.0.0.1", () => {
    mcpPort = mcpServer.address().port;
  });
}

function stopMcpServer() {
  for (const entry of pendingCtx.values()) {
    clearTimeout(entry.timer);
    entry.resolve(undefined);
  }
  pendingCtx.clear();
  try {
    mcpServer?.close();
  } catch (e) {}
  mcpServer = undefined;
  mcpPort = 0;
  mcpToken = "";
}

// Harness hook: lets the tests reach the loopback server.
exports._mcpInfo = () => ({ port: mcpPort, token: mcpToken });

// --- Sign-in verification --------------------------------------------
// Runs the exact same headless spawn a chat uses and reports the raw
// outcome. Turns "it still says not logged in" into a diagnosable
// message: which binary ran, what it printed. macOS especially needs
// this - credentials live in the Keychain, granted per binary, so a
// Terminal login and the panel's spawn can disagree.

let verifyChild;

function runLoginVerify() {
  if (verifyChild) return;
  const { cmd, preArgs } = resolveAgentCli();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ID;
  let child;
  try {
    child = spawn(
      cmd,
      [...preArgs, "-p", "--output-format", "stream-json", "--verbose"],
      { env, windowsHide: true, cwd: __dirname },
    );
  } catch (e) {
    toPanel({
      type: "login-verify",
      ok: false,
      cliPath: cmd,
      detail: `Could not start the CLI: ${e.message}`,
    });
    return;
  }
  verifyChild = child;
  child.stdin.write("Reply with the single word OK");
  child.stdin.end();
  let out = "";
  let errTail = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
  });
  child.stderr.on("data", (d) => {
    errTail = (errTail + d.toString()).slice(-300);
  });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch (e) {}
  }, 90000);
  child.on("error", (e) => {
    clearTimeout(timer);
    verifyChild = undefined;
    toPanel({
      type: "login-verify",
      ok: false,
      cliPath: cmd,
      detail: `Could not start the CLI: ${e.message}`,
    });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    verifyChild = undefined;
    let text = "";
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant") {
          for (const part of ev.message?.content ?? []) {
            if (part.type === "text") text += part.text;
          }
        }
      } catch (e) {
        /* not JSON */
      }
    }
    const notLoggedIn = /not logged in/i.test(text + errTail);
    const ok = !notLoggedIn && code === 0 && text.trim().length > 0;
    toPanel({
      type: "login-verify",
      ok,
      cliPath: cmd,
      detail: ok
        ? `The CLI answered: ${text.trim().slice(0, 120)}`
        : (text.trim() || errTail.trim() || `exit code ${code}, no output`)
            .slice(0, 220),
    });
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
      if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", "start", "Claude sign-in", cmd, ...preArgs], {
          windowsHide: true,
          detached: true,
        }).unref();
      } else if (process.platform === "darwin") {
        // Terminal.app ships with every Mac; osascript hands it the
        // CLI as a shell line (single-quoted, so spaces in the
        // Application Support path survive).
        const line = [cmd, ...preArgs]
          .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
          .join(" ");
        spawn(
          "osascript",
          [
            "-e",
            'tell application "Terminal" to activate',
            "-e",
            `tell application "Terminal" to do script ${JSON.stringify(line)}`,
          ],
          { detached: true },
        ).unref();
      } else {
        // Linux: first terminal emulator that exists gets the CLI.
        const terminals = [
          ["x-terminal-emulator", ["-e"]],
          ["gnome-terminal", ["--"]],
          ["konsole", ["-e"]],
          ["xfce4-terminal", ["-x"]],
          ["xterm", ["-e"]],
        ];
        const found = terminals.find(
          ([t]) =>
            spawnSync("which", [t], { windowsHide: true }).status === 0,
        );
        if (!found) {
          toPanel({ type: "login-result", backend, ok: false });
          return;
        }
        spawn(found[0], [...found[1], cmd, ...preArgs], {
          detached: true,
        }).unref();
      }
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
    localUrl,
    localModel,
    platform: process.platform,
    npmFound: npmFound(),
    liveModules: liveCache?.modules,
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
      localUrl,
      localModel,
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
  if (typeof persistedData?.localUrl === "string" && persistedData.localUrl) {
    localUrl = persistedData.localUrl;
  }
  if (typeof persistedData?.localModel === "string") {
    localModel = persistedData.localModel;
  }
  profilesDir = findProfilesDir();
  writeContextFiles();
  startMcpServer();
  // First live probe once the editor and modules have had a moment to
  // settle; the result lands in agent-status for the panel greeting.
  setTimeout(() => {
    if (!packageShutDown) getLiveModules();
  }, 2500);
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
  stopMcpServer();
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
    } else if (msg?.type === "verify-login") {
      runLoginVerify();
    } else if (msg?.type === "create-profile") {
      const result = createProfile(msg.profile);
      toPanel({
        type: "profile-created",
        requestId: msg.requestId,
        ...result,
      });
    } else if (msg?.type === "tryout-profile") {
      const result = tryoutProfile(msg.profile);
      toPanel({
        type: "profile-tryout",
        requestId: msg.requestId,
        ...result,
      });
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
    } else if (msg?.type === "set-local-config") {
      if (typeof msg.url === "string" && msg.url.trim()) {
        localUrl = msg.url.trim();
        localNativeOk = undefined; // new server: re-detect Ollama
      }
      if (typeof msg.model === "string") {
        localModel = msg.model.trim();
      }
      persistSettings();
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
    } else if (msg?.type === "setup-recheck") {
      // The guide's "Check again": re-run the cached environment
      // checks after the user installed something.
      npmFoundCache = undefined;
      shellWhichCache.clear();
      liveCache = undefined;
      sendAgentStatus();
    } else if (msg?.type === "probe-local") {
      probeLocal();
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
  } else if (args[0] === "ctx") {
    ctxReply(args);
  }
};
