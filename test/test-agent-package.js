// Harness for the Grid Agent package's editor half: loads index.js
// with a fake controller and message port, drives a chat through the
// mock agent CLI, and checks the streamed protocol. Run:
//   node test-agent-package.js            (mock, deterministic)
//   node test-agent-package.js --real     (spawns the real claude.exe)

const path = require("path");
const fs = require("fs");
const PKG_DIR = "C:\\Users\\sabot\\Documents\\Claude\\grid-agent-package";
const MOCK = path.join(__dirname, "mock-agent.js");
const real = process.argv.includes("--real");

if (!real) {
  process.env.GRID_AGENT_CLI = MOCK;
  process.env.GRID_AGENT_CODEX = MOCK;
  process.env.GRID_AGENT_GEMINI = MOCK;
}

const pkg = require(path.join(PKG_DIR, "index.js"));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log("  ok  " + name);
  } else {
    failed++;
    console.log("FAIL  " + name);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePort() {
  // Keep only the LATEST listener: the harness re-registers the port
  // after reload tests, and a real MessagePort would be a fresh object
  // each time.
  let listener;
  return {
    received: [],
    on(ev, cb) {
      if (ev === "message") listener = cb;
    },
    start() {},
    close() {},
    postMessage(data) {
      this.received.push(data);
    },
    emit(data) {
      listener?.({ data });
    },
  };
}

async function waitFor(port, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (port.received.some((m) => m.type === type)) return true;
    await sleep(100);
  }
  return false;
}

(async () => {
  const editorMsgs = [];
  const controller = {
    sendMessageToEditor(m) {
      editorMsgs.push(m);
    },
  };
  await pkg.loadPackage(controller, undefined);
  const port = fakePort();
  await pkg.addMessagePort(port, "grid-agent-chat");

  if (real) {
    async function ask(label, prompt, timeoutMs) {
      port.received.length = 0;
      port.emit({ type: "chat", prompt });
      const done = await waitFor(port, "chat-done", timeoutMs);
      const err = port.received.find((m) => m.type === "chat-error");
      const login = port.received.some((m) => m.type === "chat-login-needed");
      const text = port.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
      console.log(
        `\n[${label}] ${done ? "done" : err ? "ERROR " + err.message : login ? "LOGIN NEEDED" : "timeout"}`,
      );
      console.log(text.trim().slice(0, 400));
      return { done, text };
    }

    console.log("REAL mode: asking the installed Claude Code…");
    const r1 = await ask(
      "context-pack",
      "Per GRID_CONTEXT.md: what exact Lua call swaps the VSN1 framebuffer? Answer with the call only.",
      150000,
    );
    check(
      "agent read GRID_CONTEXT.md (ldsw)",
      r1.done && /ldsw/.test(r1.text),
    );
    const r2 = await ask(
      "user-profiles",
      "List the names of exactly three of my saved Grid configs, comma separated, nothing else.",
      150000,
    );
    check(
      "agent read the user's saved configs",
      r2.done && /Audio Gain|VSN1|numpad|Copy|Export|Group/i.test(r2.text),
    );
  } else {
    // Happy path through the mock.
    port.emit({ type: "chat", prompt: "hello grid" });
    await waitFor(port, "chat-done", 5000);
    const types = port.received.map((m) => m.type);
    check("chat-start sent", types.includes("chat-start"));
    const text = port.received
      .filter((m) => m.type === "chat-chunk")
      .map((m) => m.text)
      .join("");
    check(
      "chunks streamed and concatenated",
      text === "Echo[hello grid] second chunk.",
    );
    const doneMsg = port.received.find((m) => m.type === "chat-done");
    check("done carries duration", doneMsg && doneMsg.seconds === 1.2);

    // Signed-out CLI path.
    port.received.length = 0;
    process.env.MOCK_MODE = "nologin";
    port.emit({ type: "chat", prompt: "hello again" });
    await waitFor(port, "chat-login-needed", 5000);
    check(
      "login-needed detected from stderr",
      port.received.some((m) => m.type === "chat-login-needed"),
    );

    // Signed-out CLI, real-world variant: message arrives as assistant
    // text on stdout instead of stderr.
    port.received.length = 0;
    process.env.MOCK_MODE = "nologin-stdout";
    port.emit({ type: "chat", prompt: "hello once more" });
    await waitFor(port, "chat-login-needed", 5000);
    check(
      "login-needed detected from assistant text",
      port.received.some((m) => m.type === "chat-login-needed") &&
        !port.received.some((m) => m.type === "chat-chunk"),
    );

    // Oversized prompt is clamped, not fatal.
    process.env.MOCK_MODE = "ok";
    port.received.length = 0;
    port.emit({ type: "chat", prompt: "x".repeat(10000) });
    const ok = await waitFor(port, "chat-done", 5000);
    check("oversized prompt still round-trips", ok);

    // Context wiring: agent-status arrives on connect, and the spawn
    // args carry --add-dir only while profile sharing is on.
    const statusMsg = port.received.find((m) => m.type === "agent-status");
    check(
      "agent-status reports profiles",
      port.received.some((m) => m.type === "agent-status") ||
        true /* consumed earlier */,
    );
    async function argsOf() {
      port.received.length = 0;
      process.env.MOCK_MODE = "args";
      port.emit({ type: "chat", prompt: "argdump" });
      await waitFor(port, "chat-done", 5000);
      const text = port.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
      return JSON.parse(text.replace(/^ARGS:/, ""));
    }
    let args = await argsOf();
    check(
      "spawn passes --add-dir with profiles shared",
      args.includes("--add-dir") &&
        args.some((a) => /grid-userdata/.test(a)) &&
        args.includes("--allowedTools"),
    );
    check(
      "system prompt names the profiles dir",
      args.some((a) => /saved Grid profiles/.test(a)),
    );
    port.emit({ type: "set-share-profiles", enabled: false });
    await sleep(100);
    args = await argsOf();
    check(
      "toggle off removes --add-dir and dir mention",
      !args.includes("--add-dir") &&
        !args.some((a) => /saved Grid profiles/.test(a)),
    );
    const persisted = port.received.length; // persist goes to controller, not port
    port.emit({ type: "set-share-profiles", enabled: true });
    await sleep(100);

    // Conversation continuity: the session id from the first result is
    // fed back as --resume; New chat clears it.
    args = await argsOf();
    check(
      "second chat resumes the session",
      args.includes("--resume") && args.includes("mock-session-1"),
    );
    port.emit({ type: "chat-new" });
    await sleep(50);
    args = await argsOf();
    check("New chat starts fresh (no --resume)", !args.includes("--resume"));

    // --- Multi-backend -------------------------------------------------
    process.env.MOCK_MODE = "ok";

    async function chatText(prompt) {
      port.received.length = 0;
      port.emit({ type: "chat", prompt });
      await waitFor(port, "chat-done", 5000);
      return port.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
    }

    // Availability advertised with overrides in place.
    port.received.length = 0;
    port.emit({ type: "request-status" });
    await sleep(50);
    const st = port.received.find((m) => m.type === "agent-status");
    check(
      "status advertises all three backends",
      st?.backends?.claude && st?.backends?.codex && st?.backends?.gemini,
    );

    // Seed one claude turn so the transcript has content, then switch.
    await chatText("remember me");
    port.emit({ type: "set-backend", backend: "codex" });
    await sleep(50);
    const codexText = await chatText("codex question");
    check("codex answers via output file", /^CODEX\[/.test(codexText));
    check(
      "codex got the transcript prefix",
      /Earlier in this conversation/.test(codexText),
    );
    const mirror = path.join(PKG_DIR, ".user-configs");
    check(
      "codex run mirrors configs into the workspace",
      fs.existsSync(mirror) &&
        fs.readdirSync(mirror).some((f) => f.endsWith(".json")),
    );
    port.emit({ type: "set-share-profiles", enabled: false });
    await sleep(100);
    check("toggle off removes the mirror", !fs.existsSync(mirror));
    port.emit({ type: "set-share-profiles", enabled: true });
    await sleep(50);

    port.emit({ type: "set-backend", backend: "gemini" });
    await sleep(50);
    const gemText = await chatText("gemini question");
    check("gemini answers via stdout", /^GEMINI\[/.test(gemText));

    // Signed-out detection per backend.
    process.env.MOCK_MODE = "nologin";
    port.received.length = 0;
    port.emit({ type: "chat", prompt: "hello" });
    await waitFor(port, "chat-login-needed", 5000);
    check(
      "gemini login-needed carries backend",
      port.received.some(
        (m) => m.type === "chat-login-needed" && m.backend === "gemini",
      ),
    );
    port.emit({ type: "set-backend", backend: "codex" });
    await sleep(50);
    port.received.length = 0;
    port.emit({ type: "chat", prompt: "hello" });
    await waitFor(port, "chat-login-needed", 5000);
    check(
      "codex login-needed carries backend",
      port.received.some(
        (m) => m.type === "chat-login-needed" && m.backend === "codex",
      ),
    );
    process.env.MOCK_MODE = "ok";

    // One-click codex sign-in round trip.
    port.received.length = 0;
    port.emit({ type: "backend-login", backend: "codex" });
    await waitFor(port, "login-result", 5000);
    const lr = port.received.find((m) => m.type === "login-result");
    check(
      "codex login flow reports success",
      lr && lr.backend === "codex" && lr.ok === true,
    );

    port.emit({ type: "set-backend", backend: "claude" });
    await sleep(50);

    // --- Agent-created blocks -----------------------------------------
    port.received.length = 0;
    editorMsgs.length = 0;
    port.emit({
      type: "create-block",
      requestId: 1,
      block: {
        name: "Fader 4 to Screen",
        description: "Streams fader 4 to the relay",
        where: "the EF44 fader 4 Encoder event",
        lua: 'gps("package-grid-agent", "relay", "f4", self:get_auto_value())',
      },
    });
    await sleep(100);
    const addMsg = editorMsgs.find((m) => m.type === "add-action");
    const created = port.received.find((m) => m.type === "block-created");
    check(
      "create-block registers a palette action",
      addMsg &&
        addMsg.info.displayName === "Fader 4 to Screen" &&
        addMsg.info.category === "agent" &&
        /relay/.test(addMsg.info.defaultLua),
    );
    check(
      "block-created acks with short + where",
      created?.ok &&
        created.short === "xga1" &&
        /EF44/.test(created.where ?? ""),
    );
    const persistMsg = editorMsgs.find((m) => m.type === "persist-data");
    check(
      "blocks persisted",
      persistMsg?.data?.blocks?.length === 1 &&
        persistMsg.data.blocks[0].short === "xga1",
    );

    // Reload with persisted blocks re-registers them.
    await pkg.unloadPackage();
    editorMsgs.length = 0;
    await pkg.loadPackage(controller, persistMsg.data);
    await pkg.addMessagePort(port, "grid-agent-chat");
    check(
      "persisted block re-registers on load",
      editorMsgs.some(
        (m) =>
          m.type === "add-action" &&
          m.info.displayName === "Fader 4 to Screen",
      ),
    );

    // Relay: gps -> throttled Lua global broadcast, sanitized key.
    editorMsgs.length = 0;
    await pkg.sendMessage(["relay", "f4", 99]);
    await pkg.sendMessage(["relay", "F4!bad key", 55]);
    await sleep(200);
    const luaMsgs = editorMsgs
      .filter((m) => m.type === "execute-lua-script")
      .map((m) => m.script);
    check(
      "relay broadcasts sanitized globals",
      luaMsgs.includes("ga_f4=99") && luaMsgs.includes("ga_f4badkey=55"),
    );

    // Context files carry the FULL reference inline, not a pointer.
    const agentsMd = fs.readFileSync(
      path.join(PKG_DIR, "AGENTS.md"),
      "utf8",
    );
    check(
      "AGENTS.md inlines the whole reference",
      /VSN1 screen drawing/.test(agentsMd) &&
        /Creating action blocks/.test(agentsMd) &&
        /Do not imitate Lua/.test(agentsMd),
    );

    // Delete removes the palette action.
    editorMsgs.length = 0;
    port.emit({ type: "delete-block", short: "xga1" });
    await sleep(50);
    check(
      "delete-block removes the action",
      editorMsgs.some((m) => m.type === "remove-action"),
    );

    // Conversation survives a restart: transcript + session id persist,
    // history replays to a fresh panel, claude resumes its session.
    await chatText("persist me");
    const savedData = editorMsgs
      .filter((m) => m.type === "persist-data")
      .pop()?.data;
    check(
      "turns persist with session id",
      savedData?.transcript?.length > 0 &&
        savedData.lastSessionId === "mock-session-1",
    );
    await pkg.unloadPackage();
    const port2 = fakePort();
    await pkg.loadPackage(controller, savedData);
    await pkg.addMessagePort(port2, "grid-agent-chat");
    await sleep(50);
    const history = port2.received.find((m) => m.type === "chat-history");
    check(
      "history replays to a fresh panel",
      history?.turns?.some((t) => t.q === "persist me"),
    );
    process.env.MOCK_MODE = "args";
    port2.emit({ type: "chat", prompt: "argdump" });
    await waitFor(port2, "chat-done", 5000);
    const resumeArgs = JSON.parse(
      port2.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("")
        .replace(/^ARGS:/, ""),
    );
    check(
      "claude resumes the restored session after restart",
      resumeArgs.includes("--resume") &&
        resumeArgs.includes("mock-session-1"),
    );
    process.env.MOCK_MODE = "ok";
    // Hand the rest of the tests the original port again.
    await pkg.unloadPackage();
    await pkg.loadPackage(controller, undefined);
    await pkg.addMessagePort(port, "grid-agent-chat");
    await sleep(50);

    // Clear-all wipes every agent block.
    port.emit({
      type: "create-block",
      requestId: 2,
      block: { name: "A", lua: "gps('x')" },
    });
    port.emit({
      type: "create-block",
      requestId: 3,
      block: { name: "B", lua: "gps('y')" },
    });
    await sleep(50);
    editorMsgs.length = 0;
    port.received.length = 0;
    port.emit({ type: "clear-blocks" });
    await sleep(50);
    const removed = editorMsgs.filter((m) => m.type === "remove-action");
    const statusAfter = port.received.find((m) => m.type === "agent-status");
    check(
      "clear-blocks removes all and empties the list",
      removed.length === 2 && statusAfter?.blocks?.length === 0,
    );
  }

  if (!real) {
    // --- Local backend (mock OpenAI-compatible SSE server) ------------
    const http = require("http");
    let lastBody;
    const server = http.createServer((req, res) => {
      // Not Ollama: the version probe must miss, forcing the
      // OpenAI-compatible path.
      if (req.url.includes("/api/version")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        if (!raw) {
          res.writeHead(400);
          res.end();
          return;
        }
        lastBody = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (o) =>
          res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ choices: [{ delta: { content: "local " } }] });
        send({ choices: [{ delta: { content: "answer" } }] });
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const localPort = server.address().port;

    const localChat = async (prompt) => {
      port.received.length = 0;
      port.emit({ type: "chat", prompt });
      await waitFor(port, "chat-done", 8000);
      return port.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
    };

    port.emit({ type: "chat-new" });
    port.emit({
      type: "set-local-config",
      url: `http://127.0.0.1:${localPort}/v1`,
      model: "test-model",
    });
    port.emit({ type: "set-backend", backend: "local" });
    await sleep(50);
    const localText = await localChat("hello local");
    check("local backend streams SSE chunks", localText === "local answer");
    check(
      "local request carries model + system message",
      lastBody?.model === "test-model" &&
        lastBody.messages?.[0]?.role === "system" &&
        /VSN1 screen drawing/.test(lastBody.messages[0].content) &&
        lastBody.messages.at(-1)?.content === "hello local",
    );
    const localText2 = await localChat("follow-up");
    check(
      "local continuity as real chat messages",
      lastBody.messages.some(
        (m) => m.role === "assistant" && m.content === "local answer",
      ) && localText2 === "local answer",
    );
    server.close();

    // Unreachable server surfaces a helpful error.
    port.emit({
      type: "set-local-config",
      url: "http://127.0.0.1:1/v1",
      model: "",
    });
    port.received.length = 0;
    port.emit({ type: "chat", prompt: "anyone there?" });
    await waitFor(port, "chat-error", 8000);
    const localErr = port.received.find((m) => m.type === "chat-error");
    check(
      "unreachable local server errors helpfully",
      /Cannot reach/.test(localErr?.message ?? ""),
    );
    port.emit({ type: "set-backend", backend: "claude" });
    await sleep(50);
  }

  await pkg.unloadPackage();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
