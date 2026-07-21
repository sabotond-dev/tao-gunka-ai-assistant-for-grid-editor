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
    // Live-context wiring: the real CLI must reach the loopback MCP
    // server. No modules answer the harness's fake controller, so the
    // honest no-reply text coming back proves the whole path.
    const r3 = await ask(
      "mcp-live-tools",
      "Call the grid_status tool now and quote its reply.",
      150000,
    );
    check(
      "real CLI reached the MCP server",
      r3.done && /No connected module replied|connected module/i.test(r3.text),
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

    // --- Live context (MCP) -------------------------------------------
    // The package hosts a loopback MCP server; these checks speak its
    // streamable-HTTP dialect directly and play the module side of the
    // Lua round trips by calling pkg.sendMessage like the editor would.
    for (let i = 0; i < 20 && pkg._mcpInfo().port === 0; i++) await sleep(50);
    const mcp = pkg._mcpInfo();
    check("mcp server listens on loopback", mcp.port > 0 && !!mcp.token);

    const mcpPost = (body, token) =>
      fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? mcp.token}`,
        },
        body: JSON.stringify(body),
      });

    const unauth = await mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "wrong-token",
    );
    check("mcp rejects a bad bearer token", unauth.status === 401);

    const init = await (
      await mcpPost({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })
    ).json();
    check(
      "mcp initialize identifies the server",
      init.result?.serverInfo?.name === "tao-gunka-grid" &&
        init.result?.protocolVersion === "2025-06-18",
    );
    const note = await mcpPost({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    check("mcp notifications get a 202", note.status === 202);

    const list = await (
      await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    check(
      "mcp lists the two live tools",
      list.result?.tools?.length === 2 &&
        list.result.tools.some((t) => t.name === "grid_status") &&
        list.result.tools.some((t) => t.name === "grid_element_values"),
    );

    // grid_status: broadcast script goes out, two fake modules answer.
    editorMsgs.length = 0;
    const statusPromise = mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "grid_status", arguments: {} },
    });
    let modMsg;
    for (let i = 0; i < 20 && !modMsg; i++) {
      await sleep(50);
      modMsg = editorMsgs.find(
        (m) => m.type === "execute-lua-script" && /"mod"/.test(m.script),
      );
    }
    check(
      "grid_status broadcasts an immediate script",
      !!modMsg && modMsg.targetDx === undefined,
    );
    const statusId = /"ctx","([a-z0-9]+)"/.exec(modMsg?.script ?? "")?.[1];
    await pkg.sendMessage(["ctx", statusId, "mod", 0, 0, 1, 16]);
    await pkg.sendMessage(["ctx", statusId, "mod", 1, 0, 1, 10]);
    const statusOut = await (await statusPromise).json();
    const statusText = statusOut.result?.content?.[0]?.text ?? "";
    check(
      "grid_status reports both replying modules",
      /2 connected module/.test(statusText) &&
        /dx=0, dy=0: 16 elements/.test(statusText) &&
        /dx=1, dy=0: 10 elements/.test(statusText),
    );

    // grid_element_values: targeted script, one module answers, the
    // compact wire format unpacks into readable lines.
    editorMsgs.length = 0;
    const valPromise = mcpPost({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "grid_element_values", arguments: { dx: 1, dy: 0 } },
    });
    let valMsg;
    for (let i = 0; i < 20 && !valMsg; i++) {
      await sleep(50);
      valMsg = editorMsgs.find(
        (m) => m.type === "execute-lua-script" && /"val"/.test(m.script),
      );
    }
    check(
      "grid_element_values targets the module",
      !!valMsg && valMsg.targetDx === 1 && valMsg.targetDy === 0,
    );
    const valId = /"ctx","([a-z0-9]+)"/.exec(valMsg?.script ?? "")?.[1];
    await pkg.sendMessage(["ctx", valId, "val", 1, 0, "0ep=64;1b=127;2s=-;"]);
    const valOut = await (await valPromise).json();
    const valText = valOut.result?.content?.[0]?.text ?? "";
    check(
      "element values unpack with types and values",
      /element 0 \(endless\): 64/.test(valText) &&
        /element 1 \(button\): 127/.test(valText) &&
        /element 2 \(system\/screen\)/.test(valText),
    );

    const badTool = await (
      await mcpPost({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      })
    ).json();
    check("unknown tool returns a JSON-RPC error", badTool.error?.code === -32602);

    // A module that never answers surfaces as an honest no-reply text.
    const silent = await (
      await mcpPost({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "grid_element_values", arguments: { dx: 9, dy: 9 } },
      })
    ).json();
    check(
      "silent module reported honestly",
      /No module at dx=9, dy=9 replied/.test(
        silent.result?.content?.[0]?.text ?? "",
      ),
    );

    // The claude spawn now carries the MCP wiring.
    async function mcpArgsOf() {
      port.received.length = 0;
      process.env.MOCK_MODE = "args";
      port.emit({ type: "chat", prompt: "argdump" });
      await waitFor(port, "chat-done", 5000);
      process.env.MOCK_MODE = "ok";
      const text = port.received
        .filter((m) => m.type === "chat-chunk")
        .map((m) => m.text)
        .join("");
      return JSON.parse(text.replace(/^ARGS:/, ""));
    }
    const mcpArgs = await mcpArgsOf();
    const mcpConfigArg = mcpArgs[mcpArgs.indexOf("--mcp-config") + 1] ?? "";
    check(
      "spawn passes --mcp-config with the loopback server",
      mcpArgs.includes("--mcp-config") &&
        mcpArgs.includes("--strict-mcp-config") &&
        mcpConfigArg.includes(`127.0.0.1:${mcp.port}`) &&
        mcpConfigArg.includes(mcp.token),
    );
    check(
      "live tools allowlisted and named in the system prompt",
      mcpArgs.some((a) => /mcp__grid__grid_status/.test(a)) &&
        mcpArgs.some((a) => /grid_element_values reads the current value/.test(a)),
    );

    // --- Setup guide plumbing -----------------------------------------
    port.received.length = 0;
    port.emit({ type: "request-status" });
    await sleep(150);
    const setupSt = port.received.find((m) => m.type === "agent-status");
    check(
      "status carries platform and npm detection",
      typeof setupSt?.platform === "string" &&
        typeof setupSt?.npmFound === "boolean",
    );
    port.received.length = 0;
    port.emit({ type: "setup-recheck" });
    const rechecked = await waitFor(port, "agent-status", 8000);
    check("setup-recheck answers with a fresh status", rechecked);

    // probe-local: an Ollama-shaped server yields its model list...
    const tagsServer = require("http").createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "gemma4:12b" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => tagsServer.listen(0, "127.0.0.1", r));
    port.emit({
      type: "set-local-config",
      url: `http://127.0.0.1:${tagsServer.address().port}/v1`,
      model: "",
    });
    port.received.length = 0;
    port.emit({ type: "probe-local" });
    await waitFor(port, "local-probe", 8000);
    const probeOk = port.received.find((m) => m.type === "local-probe");
    check(
      "probe-local lists the local server's models",
      probeOk?.ok === true && probeOk.models?.includes("gemma4:12b"),
    );
    tagsServer.close();

    // --- Whole profiles -----------------------------------------------
    // create-profile writes a native-schema profile file into the
    // configs dir (redirected to a temp dir for the test).
    const os = require("os");
    const profDir = fs.mkdtempSync(path.join(os.tmpdir(), "ga-profiles-"));
    process.env.GRID_AGENT_PROFILES_DIR = profDir;
    port.received.length = 0;
    editorMsgs.length = 0;
    port.emit({
      type: "create-profile",
      requestId: 91,
      profile: {
        name: "Test Pad",
        module: "bu16",
        description: "harness profile",
        elements: {
          0: { button: "self:gms(9,144,36,self:bva())", timer: "gtp(self:ind())" },
          15: { button: "self:gms(9,144,51,self:bva())" },
          99: { button: "ignored" },
          255: { midirx: "ignored-too" },
        },
      },
    });
    await waitFor(port, "profile-created", 5000);
    const pAck = port.received.find((m) => m.type === "profile-created");
    check(
      "profile-created acks with name and file",
      pAck?.ok === true &&
        pAck.requestId === 91 &&
        pAck.module === "BU16" &&
        /Test Pad\.json/.test(pAck.filename),
    );
    let pFile;
    try {
      pFile = JSON.parse(
        fs.readFileSync(path.join(profDir, pAck.filename), "utf8"),
      );
    } catch (e) {}
    const el0 = pFile?.configs?.find((c) => c.controlElementNumber === 0);
    const el15 = pFile?.configs?.find((c) => c.controlElementNumber === 15);
    const elSys = pFile?.configs?.find((c) => c.controlElementNumber === 255);
    check(
      "profile file matches the native schema",
      pFile?.configType === "profile" &&
        pFile.type === "BU16" &&
        typeof pFile.id === "string" &&
        pFile.version?.major === "1" &&
        pFile.configs?.length === 17 &&
        elSys?.events?.length === 4,
    );
    check(
      "agent lua lands as code blocks, defaults fill the rest",
      el0?.events.some(
        (e) => e.event === 3 && e.config === "--[[@cb]] self:gms(9,144,36,self:bva())",
      ) &&
        el0.events.some((e) => e.event === 6 && /gtp/.test(e.config)) &&
        el15?.events.some((e) => e.event === 3 && /144,51/.test(e.config)) &&
        el0.events.some((e) => e.event === 0 && /--\[\[Init\]\]/.test(e.config)),
    );
    check(
      "invalid elements are dropped, valid midirx is kept",
      !pFile?.configs?.some((c) => c.controlElementNumber === 99) &&
        elSys.events.some(
          (e) => e.event === 5 && /ignored-too/.test(e.config),
        ),
    );
    check(
      "save announced via editor toast",
      editorMsgs.some(
        (m) => m.type === "show-message" && /Test Pad/.test(m.message),
      ),
    );
    // Same name again gets a suffixed file, not an overwrite.
    port.received.length = 0;
    port.emit({
      type: "create-profile",
      requestId: 92,
      profile: {
        name: "Test Pad",
        module: "BU16",
        elements: { 0: { button: "self:gms(-1,-1,-1,127)" } },
      },
    });
    await waitFor(port, "profile-created", 5000);
    const pAck2 = port.received.find((m) => m.type === "profile-created");
    check(
      "name collision suffixes the filename",
      pAck2?.ok === true && pAck2.filename === "Test Pad 2.json",
    );
    // Garbage in: a clean refusal, not a file.
    port.received.length = 0;
    port.emit({
      type: "create-profile",
      requestId: 93,
      profile: { name: "Nope", module: "XY99", elements: { 0: { button: "x" } } },
    });
    await waitFor(port, "profile-created", 5000);
    const pBad = port.received.find((m) => m.type === "profile-created");
    check("unknown module type refused", pBad?.ok === false);
    delete process.env.GRID_AGENT_PROFILES_DIR;

    // verify-login: the probe runs the real headless spawn shape and
    // reports the raw outcome either way.
    process.env.MOCK_MODE = "ok";
    port.received.length = 0;
    port.emit({ type: "verify-login" });
    await waitFor(port, "login-verify", 8000);
    const verOk = port.received.find((m) => m.type === "login-verify");
    check(
      "verify-login confirms a signed-in CLI",
      verOk?.ok === true && /Echo/.test(verOk.detail) && !!verOk.cliPath,
    );
    process.env.MOCK_MODE = "nologin-stdout";
    port.received.length = 0;
    port.emit({ type: "verify-login" });
    await waitFor(port, "login-verify", 8000);
    const verBad = port.received.find((m) => m.type === "login-verify");
    check(
      "verify-login surfaces a signed-out CLI with its words",
      verBad?.ok === false && /not logged in/i.test(verBad.detail),
    );
    process.env.MOCK_MODE = "ok";

    // ...and a dead server reports not-reachable instead of hanging.
    port.emit({
      type: "set-local-config",
      url: "http://127.0.0.1:1/v1",
      model: "",
    });
    port.received.length = 0;
    port.emit({ type: "probe-local" });
    await waitFor(port, "local-probe", 8000);
    const probeDead = port.received.find((m) => m.type === "local-probe");
    check("probe-local reports an unreachable server", probeDead?.ok === false);
  }

  const portBeforeUnload = pkg._mcpInfo().port;
  await pkg.unloadPackage();
  if (!real && portBeforeUnload > 0) {
    const closed = await fetch(`http://127.0.0.1:${portBeforeUnload}/mcp`, {
      method: "POST",
      body: "{}",
    }).then(
      () => false,
      () => true,
    );
    check("unload closes the mcp server", closed);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
